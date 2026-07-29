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

function setServerStatus(text, color = "gray") {
  const statusEl = document.getElementById("serverStatus");
  const dotEl = document.getElementById("statusDot");
  if (statusEl) statusEl.lastChild.textContent = " Estado: " + text;
  if (dotEl) dotEl.className = "status-dot " + color;
}

function updateTargetTabInfo(tabId) {
  const infoEl = document.getElementById("targetTabInfo");
  if (!infoEl) return;

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

function toggleCaptureButtons(isCapturing) {
  const startButton = document.getElementById("startCapture");
  const stopButton = document.getElementById("stopCapture");
  const useServerCheckbox = document.getElementById("useServerCheckbox");
  const useVadCheckbox = document.getElementById("useVadCheckbox");
  const languageDropdown = document.getElementById("languageDropdown");
  const taskDropdown = document.getElementById("taskDropdown");
  const modelSizeDropdown = document.getElementById("modelSizeDropdown");

  startButton.disabled = isCapturing;
  stopButton.disabled = !isCapturing;
  useServerCheckbox.disabled = isCapturing;
  useVadCheckbox.disabled = isCapturing;
  modelSizeDropdown.disabled = isCapturing;
  languageDropdown.disabled = isCapturing;
  taskDropdown.disabled = isCapturing;
  startButton.classList.toggle("disabled", isCapturing);
  stopButton.classList.toggle("disabled", !isCapturing);
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
  const useServerCheckbox = document.getElementById("useServerCheckbox");
  const useVadCheckbox = document.getElementById("useVadCheckbox");
  const languageDropdown = document.getElementById("languageDropdown");
  const taskDropdown = document.getElementById("taskDropdown");
  const modelSizeDropdown = document.getElementById("modelSizeDropdown");

  // Mostrar qué pestaña quedó armada
  chrome.storage.local.get("currentTabId", ({ currentTabId }) => {
    updateTargetTabInfo(currentTabId);
  });

  // Si clickeás el ícono en otra pestaña mientras options.html sigue abierta,
  // actualizamos el cartel sin que haga falta recargar.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.currentTabId) {
      updateTargetTabInfo(changes.currentTabId.newValue);
    }
  });

  // Restaurar preferencias guardadas
  chrome.storage.local.get(
    ["useServerState", "useVadState", "selectedLanguage", "selectedTask", "selectedModelSize"],
    (result) => {
      if (result.useServerState !== undefined) useServerCheckbox.checked = result.useServerState;
      if (result.useVadState !== undefined) useVadCheckbox.checked = result.useVadState;
      if (result.selectedLanguage !== undefined) languageDropdown.value = result.selectedLanguage;
      if (result.selectedTask !== undefined) taskDropdown.value = result.selectedTask;
      if (result.selectedModelSize !== undefined) modelSizeDropdown.value = result.selectedModelSize;
    }
  );

  useServerCheckbox.addEventListener("change", () => {
    chrome.storage.local.set({ useServerState: useServerCheckbox.checked });
  });
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

  startButton.addEventListener("click", async () => {
    if (startButton.disabled) return;

    chrome.storage.local.get("currentTabId", async ({ currentTabId }) => {
      if (!currentTabId) {
        setServerStatus("no se detectó pestaña a capturar", "red");
        return;
      }

      let host = "localhost";
      let port = "9090";
      if (useServerCheckbox.checked) {
        host = "boxerab--aavaaz-live-livetranscriber-web.modal.run";
        port = "";
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
          streamId,
          host,
          port,
          language: languageDropdown.value || null,
          task: taskDropdown.value,
          modelSize: modelSizeDropdown.value,
          useVad: useVadCheckbox.checked,
        },
      });
    });
  });

  stopButton.addEventListener("click", () => {
    if (stopButton.disabled) return;
    chrome.runtime.sendMessage({ type: "offscreen-stop" });
  });
});
