// El streamId ya viene calculado desde options.js (chrome.tabCapture
// no está disponible dentro del offscreen document).
async function captureTabAudio(streamId) {
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

function generateUUID() {
  let dt = new Date().getTime();
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (dt + Math.random() * 16) % 16 | 0;
    dt = Math.floor(dt / 16);
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  return uuid;
}

let audioContext = null;
let preNode = null;
let socket = null;
let isServerReady = false;
let currentStream = null;

const WORKLET_URL = chrome.runtime.getURL('audiopreprocessor.js');

async function initAudioWorklet(stream) {
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

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

// En vez de tocar el DOM (acá no hay UI visible), avisamos el estado
// por mensaje para que options.js actualice el cartel.
function reportStatus(text, color = "gray") {
  chrome.runtime.sendMessage({ type: "status-update", text, color });
}

async function startRecord(option) {
  reportStatus("conectando...", "yellow");

  let stream;
  try {
    stream = await captureTabAudio(option.streamId);
  } catch (error) {
    console.error("No se pudo capturar la pestaña:", error);
    reportStatus("error al capturar audio", "red");
    return;
  }

  const uuid = generateUUID();

  if (stream) {
    currentStream = stream;
    stream.oninactive = () => {
      cleanupAudio();
      reportStatus("desconectado", "red");
    };

    try {
      await initAudioWorklet(stream);
    } catch (error) {
      console.error("Failed to initialize AudioWorklet:", error);
      reportStatus("error al iniciar el audio", "red");
      return;
    }

    const wsUrl = option.port
      ? `ws://${option.host}:${option.port}/`
      : `wss://${option.host}/ws`;
    socket = new WebSocket(wsUrl);
    isServerReady = false;
    let language = option.language;

    socket.onopen = function () {
      reportStatus("conectado, esperando servidor...", "yellow");
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
        reportStatus("servidor ocupado: " + data["message"], "yellow");
        stopCaptureFlow();
        return;
      }

      if (isServerReady === false) {
        isServerReady = true;
        reportStatus("escuchando", "green");
        // La creación de la pestaña de transcript la pedimos a background.js,
        // porque desde el offscreen document no conviene manejar pestañas.
        chrome.runtime.sendMessage({ type: "open-transcript-tab" });
        return;
      }

      if (language === null) {
        language = data["language"];
        return;
      }

      if (data["message"] === "DISCONNECT") {
        reportStatus("desconectado por el servidor", "red");
        chrome.runtime.sendMessage({ type: "capture-stopped" });
        return;
      }

      chrome.runtime.sendMessage({
        type: "transcript",
        text: event.data,
      });
    };

    socket.onclose = () => {
      reportStatus("desconectado", "red");
      cleanupAudio();
    };

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      reportStatus("error de conexión", "red");
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
  chrome.runtime.sendMessage({ type: "capture-stopped" });
  reportStatus("desconectado", "red");
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "offscreen-start") {
    startRecord(message.data);
  } else if (message.type === "offscreen-stop") {
    stopCaptureFlow();
  }
});
