// chrome.tabCapture.getMediaStreamId SOLO se puede llamar desde acá
// (una página normal de la extensión), no desde el offscreen document.
// Por eso este pedacito se queda en options.js.
function getStreamIdForTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        reject(chrome.runtime.lastError || new Error("No se pudo obtener streamId"));
        return;
      }
      resolve(streamId);
    });
  });
}

const SYSTEM_AUDIO_VALUE = "__system_audio__";

function setServerStatus(text, color = "gray") {
  const statusEl = document.getElementById("serverStatus");
  const dotEl = document.getElementById("statusDot");
  if (statusEl) statusEl.lastChild.textContent = " Estado: " + text;
  if (dotEl) dotEl.className = "status-dot " + color;
}

/**
 * Actualiza el cartel "Vas a capturar: ...". sourceType es "tab" o "desktop".
 */
function updateTargetTabInfo(sourceType, tabId) {
  const infoEl = document.getElementById("targetTabInfo");
  if (!infoEl) return;

  if (sourceType === "desktop") {
    infoEl.textContent = "Vas a capturar: todo el audio del sistema";
    return;
  }

  if (!tabId) {
    infoEl.textContent = "Vas a capturar: (ninguna pestaña seleccionada)";
    return;
  }

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      infoEl.textContent = "Vas a capturar: (la pestaña ya no está disponible)";
      return;
    }
    infoEl.textContent = "Vas a capturar: " + tab.title;
  });
}

/**
 * Llena el dropdown de fuente: primero la opción de "todo el audio del
 * sistema", después las pestañas abiertas actualmente. No lista las
 * páginas propias de la extensión (options.html, transcript.html, etc).
 */
function populateSourceTabDropdown(sourceType, selectedTabId) {
  const dropdown = document.getElementById("sourceTabDropdown");
  if (!dropdown) return;

  chrome.tabs.query({}, (tabs) => {
    dropdown.innerHTML = "";

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "-- Elegí una fuente --";
    dropdown.appendChild(emptyOption);

    const systemAudioOption = document.createElement("option");
    systemAudioOption.value = SYSTEM_AUDIO_VALUE;
    systemAudioOption.textContent = "🖥️ Todo el audio del sistema";
    if (sourceType === "desktop") {
      systemAudioOption.selected = true;
    }
    dropdown.appendChild(systemAudioOption);

    const ownPrefix = `chrome-extension://${chrome.runtime.id}`;

    tabs.forEach((tab) => {
      if (tab.url && tab.url.startsWith(ownPrefix)) return;

      const option = document.createElement("option");
      option.value = String(tab.id);
      const audibleTag = tab.audible ? "🔊 " : "";
      option.textContent = audibleTag + (tab.title || tab.url || "(sin título)");
      if (sourceType === "tab" && selectedTabId && tab.id === selectedTabId) {
        option.selected = true;
      }
      dropdown.appendChild(option);
    });
  });
}

function toggleCaptureButtons(isCapturing) {
  const startButton = document.getElementById("startCapture");
  const stopButton = document.getElementById("stopCapture");
  const useVadCheckbox = document.getElementById("useVadCheckbox");
  const languageDropdown = document.getElementById("languageDropdown");
  const taskDropdown = document.getElementById("taskDropdown");
  const modelSizeDropdown = document.getElementById("modelSizeDropdown");
  const sourceTabDropdown = document.getElementById("sourceTabDropdown");
  const refreshTabsButton = document.getElementById("refreshTabsButton");
  const columnLangLeftDropdown = document.getElementById("columnLangLeftDropdown");
  const columnLangRightDropdown = document.getElementById("columnLangRightDropdown");

  startButton.disabled = isCapturing;
  stopButton.disabled = !isCapturing;
  useVadCheckbox.disabled = isCapturing;
  modelSizeDropdown.disabled = isCapturing;
  languageDropdown.disabled = isCapturing;
  taskDropdown.disabled = isCapturing;
  sourceTabDropdown.disabled = isCapturing;
  refreshTabsButton.disabled = isCapturing;
  startButton.classList.toggle("disabled", isCapturing);
  stopButton.classList.toggle("disabled", !isCapturing);
  columnLangLeftDropdown.disabled = isCapturing;
  columnLangRightDropdown.disabled = isCapturing;
}

// Mensajes que llegan desde offscreen.js (a través del runtime, sin pasar
// por background.js) para actualizar la UI.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "status-update") {
    setServerStatus(message.text, message.color);
  } else if (message.type === "capture-stopped") {
    toggleCaptureButtons(false);
  }
});

document.addEventListener("DOMContentLoaded", function () {
  const startButton = document.getElementById("startCapture");
  const stopButton = document.getElementById("stopCapture");
  const useVadCheckbox = document.getElementById("useVadCheckbox");
  const languageDropdown = document.getElementById("languageDropdown");
  const taskDropdown = document.getElementById("taskDropdown");
  const modelSizeDropdown = document.getElementById("modelSizeDropdown");
  const sourceTabDropdown = document.getElementById("sourceTabDropdown");
  const columnLangLeftDropdown = document.getElementById("columnLangLeftDropdown");
  const columnLangRightDropdown = document.getElementById("columnLangRightDropdown");

  // Mostrar qué fuente quedó armada, y poblar el selector
  chrome.storage.local.get(["sourceType", "currentTabId"], ({ sourceType, currentTabId }) => {
    updateTargetTabInfo(sourceType, currentTabId);
    populateSourceTabDropdown(sourceType, currentTabId);
  });

  document.getElementById("refreshTabsButton").addEventListener("click", () => {
    chrome.storage.local.get(["sourceType", "currentTabId"], ({ sourceType, currentTabId }) => {
      populateSourceTabDropdown(sourceType, currentTabId);
    });
  });

  sourceTabDropdown.addEventListener("change", (event) => {
    const value = event.target.value;
    if (!value) return;

    if (value === SYSTEM_AUDIO_VALUE) {
      chrome.storage.local.set({ sourceType: "desktop" });
      return;
    }

    chrome.storage.local.set({ sourceType: "tab", currentTabId: Number(value) });
  });

  // Si clickeás el ícono en otra pestaña mientras options.html sigue abierta
  // (eso guarda sourceType: "tab" y el currentTabId nuevo), o si cambiás la
  // fuente desde acá, actualizamos el cartel sin que haga falta recargar.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.currentTabId || changes.sourceType) {
      chrome.storage.local.get(["sourceType", "currentTabId"], ({ sourceType, currentTabId }) => {
        updateTargetTabInfo(sourceType, currentTabId);
      });
    }
  });

  // Restaurar preferencias guardadas
  chrome.storage.local.get(
    ["useVadState", "selectedLanguage", "selectedTask", "selectedModelSize", "columnLangLeft", "columnLangRight"],
    (result) => {
      if (result.useVadState !== undefined) useVadCheckbox.checked = result.useVadState;
      if (result.selectedLanguage !== undefined) languageDropdown.value = result.selectedLanguage || "";
      if (result.selectedTask !== undefined) taskDropdown.value = result.selectedTask;
      if (result.selectedModelSize !== undefined) modelSizeDropdown.value = result.selectedModelSize;
      if (result.columnLangLeft !== undefined) columnLangLeftDropdown.value = result.columnLangLeft;
      if (result.columnLangRight !== undefined) columnLangRightDropdown.value = result.columnLangRight;
    }
  );

  useVadCheckbox.addEventListener("change", () => {
    chrome.storage.local.set({ useVadState: useVadCheckbox.checked });
  });
  languageDropdown.addEventListener("change", () => {
    chrome.storage.local.set({ selectedLanguage: languageDropdown.value || null });
  });
  taskDropdown.addEventListener("change", () => {
    chrome.storage.local.set({ selectedTask: taskDropdown.value });
  });
  modelSizeDropdown.addEventListener("change", () => {
    chrome.storage.local.set({ selectedModelSize: modelSizeDropdown.value });
  });
  columnLangLeftDropdown.addEventListener("change", () => {
    chrome.storage.local.set({ columnLangLeft: columnLangLeftDropdown.value });
  });
  columnLangRightDropdown.addEventListener("change", () => {
    chrome.storage.local.set({ columnLangRight: columnLangRightDropdown.value });
  });

  startButton.addEventListener("click", async () => {
    if (startButton.disabled) return;

    const host = "localhost";
    const port = "9090";

    const commonOptions = {
      host,
      port,
      language: languageDropdown.value || null,
      task: taskDropdown.value === "interpreter" ? "transcribe" : taskDropdown.value,
      modelSize: modelSizeDropdown.value,
      useVad: useVadCheckbox.checked,
    };

    chrome.storage.local.get(["sourceType", "currentTabId"], async ({ sourceType, currentTabId }) => {
      if (sourceType === "desktop") {
        // El picker nativo de Chrome lo va a mostrar el offscreen document
        // al llamar getDisplayMedia() ahí adentro.
        toggleCaptureButtons(true);
        setServerStatus("conectando...", "yellow");

        chrome.runtime.sendMessage({
          type: "offscreen-start",
          data: {
            ...commonOptions,
            sourceType: "desktop",
          },
        });
        return;
      }

      // Modo normal: capturar una pestaña específica.
      if (!currentTabId) {
        setServerStatus("no se detectó una fuente para capturar", "red");
        return;
      }

      toggleCaptureButtons(true);
      setServerStatus("conectando...", "yellow");

      let streamId;
      try {
        streamId = await getStreamIdForTab(currentTabId);
      } catch (error) {
        console.error("No se pudo obtener el streamId:", error);
        setServerStatus("error al capturar audio", "red");
        toggleCaptureButtons(false);
        return;
      }

      // Ya no capturamos acá: le pedimos al offscreen document que arranque,
      // pasándole el streamId ya obtenido.
      chrome.runtime.sendMessage({
        type: "offscreen-start",
        data: {
          ...commonOptions,
          streamId,
          sourceType: "tab",
        },
      });
    });
  });

  stopButton.addEventListener("click", () => {
    if (stopButton.disabled) return;
    chrome.runtime.sendMessage({ type: "offscreen-stop" });
  });
});
