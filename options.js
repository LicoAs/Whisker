/**
 * Pide a Chrome un "streamId" para capturar el audio de una pestaña
 * específica (targetTabId), sin importar si esa pestaña está activa
 * o no en este momento.
 */
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

/**
 * Captura audio de una pestaña puntual usando su streamId.
 * @param {number} tabId - La pestaña de la que queremos el audio.
 * @returns {Promise<MediaStream>}
 */
async function captureTabAudio(tabId) {
  const streamId = await getStreamIdForTab(tabId);
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
}


/**
 * Sends a message to a specific tab in Google Chrome.
 */
function sendMessageToTab(tabId, data) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, data, (response) => {
      resolve(response);
    });
  });
}

function generateUUID() {
  let dt = new Date().getTime();
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = (dt + Math.random() * 16) % 16 | 0;
    dt = Math.floor(dt / 16);
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  return uuid;
}

// Global variables for audio processing
let audioContext = null;
let preNode = null;
let socket = null;
let isServerReady = false;
let currentStream = null;
let currentOptions = null;

// AudioWorklet URL - make sure this path matches your manifest.json
const WORKLET_URL = chrome.runtime.getURL('audiopreprocessor.js');

async function initAudioWorklet(stream) {
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  try {
    await audioContext.audioWorklet.addModule(WORKLET_URL);
    preNode = new AudioWorkletNode(audioContext, 'audiopreprocessor');
    const mediaStream = audioContext.createMediaStreamSource(stream);

    mediaStream.connect(preNode);
    preNode.connect(audioContext.destination);
    preNode.port.onmessage = (event) => {
      const audio16k = event.data; // Float32Array @ 16 kHz
      if (socket && socket.readyState === WebSocket.OPEN && isServerReady) {
        socket.send(audio16k);
      }
    };
  } catch (error) {
    console.error("Error initializing AudioWorklet:", error);
    throw error;
  }
}

function cleanupAudio() {
  if (preNode) {
    preNode.port.onmessage = null;
    preNode.disconnect();
    preNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }
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

/**
 * Starts recording audio from the captured tab.
 * @param {Object} option - The options object containing the currentTabId.
 */
async function startRecord(option) {
  currentOptions = option;
  setServerStatus("conectando...", "yellow");

  let stream;
  try {
    stream = await captureTabAudio(option.currentTabId);
  } catch (error) {
    console.error("No se pudo capturar la pestaña:", error);
    setServerStatus("error al capturar audio", "red");
    return;
  }

  const uuid = generateUUID();

  if (stream) {
    currentStream = stream;
    stream.oninactive = () => {
      cleanupAudio();
      setServerStatus("desconectado", "red");
    };

    try {
      await initAudioWorklet(stream);
    } catch (error) {
      console.error("Failed to initialize AudioWorklet:", error);
      setServerStatus("error al iniciar el audio", "red");
      return;
    }

    const wsUrl = option.port
      ? `ws://${option.host}:${option.port}/`
      : `wss://${option.host}/ws`;
    socket = new WebSocket(wsUrl);
    isServerReady = false;
    let language = option.language;

    socket.onopen = function () {
      setServerStatus("conectado, esperando servidor...", "yellow");
      socket.send(
        JSON.stringify({
          uid: uuid,
          language: option.language,
          task: option.task,
          model: option.modelSize,
          use_vad: option.useVad,
        })
      );
    };

    socket.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      if (data["uid"] !== uuid) return;

      if (data["status"] === "WAIT") {
        setServerStatus("servidor ocupado: " + data["message"], "yellow");
        stopCaptureFlow();
        return;
      }

      if (isServerReady === false) {
        isServerReady = true;
        setServerStatus("escuchando", "green");
        chrome.tabs.create({
          url: `chrome-extension://${chrome.runtime.id}/transcript.html`,
          pinned: true,
          active: false,
        });
        return;
      }

      if (language === null) {
        language = data["language"];
        return;
      }

      if (data["message"] === "DISCONNECT") {
        setServerStatus("desconectado por el servidor", "red");
        toggleCaptureButtons(false);
        return;
      }

      chrome.runtime.sendMessage({
        type: "transcript",
        text: event.data,
      });
    };

    socket.onclose = () => {
      setServerStatus("desconectado", "red");
      cleanupAudio();
    };

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      setServerStatus("error de conexión", "red");
      cleanupAudio();
    };
  }
}

function stopCaptureFlow() {
  if (socket) {
    socket.close();
    socket = null;
  }
  cleanupAudio();
  toggleCaptureButtons(false);
  setServerStatus("desconectado", "red");
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

      await startRecord({
        currentTabId,
        host,
        port,
        language: languageDropdown.value || null,
        task: taskDropdown.value,
        modelSize: modelSizeDropdown.value,
        useVad: useVadCheckbox.checked,
      });
    });
  });

  stopButton.addEventListener("click", () => {
    if (stopButton.disabled) return;
    stopCaptureFlow();
  });
});
