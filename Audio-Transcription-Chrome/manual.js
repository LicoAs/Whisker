chrome.runtime.sendMessage({ type: "registerTranscript" });

let leftChannel = "client";
let rightChannel = "lep";
let activeChannel = "client"; // el valor coincide con leftChannel o rightChannel
let isHolding = false;
let lastCompletedEnd = -1;
let lastWrittenChannel = null;

const leftHistory = document.getElementById("leftHistory");
const leftCurrent = document.getElementById("leftCurrent");
const rightHistory = document.getElementById("rightHistory");
const rightCurrent = document.getElementById("rightCurrent");
const leftColumn = document.getElementById("leftColumn");
const rightColumn = document.getElementById("rightColumn");
const leftLabel = document.getElementById("leftLabel");
const rightLabel = document.getElementById("rightLabel");
const hint = document.getElementById("hint");
const holdOverlay = document.getElementById("holdOverlay");
const holdBtn = document.getElementById("holdBtn");

function labelFor(channel) {
    return channel === "client" ? "Client" : "LEP";
}

function setActiveChannel(channel) {
    activeChannel = channel;
    leftColumn.classList.toggle("active", channel === leftChannel);
    rightColumn.classList.toggle("active", channel === rightChannel);
}

function setHold(value) {
    isHolding = value;
    holdOverlay.style.display = value ? "flex" : "none";
    holdBtn.textContent = value ? "Reanudar (HOLD)" : "HOLD";
    holdBtn.classList.toggle("holding", value);
}

// Lee el orden de columnas elegido en options.html (Client/LEP o LEP/Client).
// Por default, si todavía no se eligió nada, queda Client a la izquierda.
chrome.storage.local.get(["manualLeftChannel", "manualRightChannel"], (result) => {
    if (result.manualLeftChannel) leftChannel = result.manualLeftChannel;
    if (result.manualRightChannel) rightChannel = result.manualRightChannel;

    leftLabel.textContent = labelFor(leftChannel);
    rightLabel.textContent = labelFor(rightChannel);
    hint.textContent = `← ${labelFor(leftChannel)} | ${labelFor(rightChannel)} → | H = Hold`;

    setActiveChannel(leftChannel);
});

document.getElementById("clearBtn").addEventListener("click", () => {
    leftHistory.textContent = "";
    leftCurrent.textContent = "";
    rightHistory.textContent = "";
    rightCurrent.textContent = "";
    lastWrittenChannel = null;
});

holdBtn.addEventListener("click", () => setHold(!isHolding));

leftColumn.addEventListener("click", () => setActiveChannel(leftChannel));
rightColumn.addEventListener("click", () => setActiveChannel(rightChannel));

document.addEventListener("keydown", (event) => {
    // Si el foco está en un input/textarea (por ejemplo a futuro, edición
    // manual de texto), no interceptamos las teclas.
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (event.key === "ArrowLeft") {
        setActiveChannel(leftChannel);
    } else if (event.key === "ArrowRight") {
        setActiveChannel(rightChannel);
    } else if (event.key === "h" || event.key === "H") {
        setHold(!isHolding);
    }
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "transcript") return;

    // En HOLD no procesamos nada nuevo: el texto gris de la columna que
    // haya quedado activa se queda tal cual estaba, a propósito (para
    // tenerlo a mano si el HOLD fue corto).
    if (isHolding) return;

    try {
        const data = JSON.parse(message.text);

        const isActiveLeft = activeChannel === leftChannel;
        const currentEl = isActiveLeft ? leftCurrent : rightCurrent;
        const historyEl = isActiveLeft ? leftHistory : rightHistory;

        // Limpiamos el "gris" de la columna activa antes de repintar.
        currentEl.textContent = "";

        for (const seg of data.segments) {
            if (seg.completed) {
                const end = parseFloat(seg.end);
                if (end > lastCompletedEnd) {
                    lastCompletedEnd = end;
                    const separator = (lastWrittenChannel !== null && lastWrittenChannel !== activeChannel) ? "\n\n" : "";
                    historyEl.textContent += separator + seg.text + " ";
                    lastWrittenChannel = activeChannel;
                }
            } else {
                currentEl.textContent = seg.text;
            }
        }
    } catch (e) {
        console.error(e);
    }
});
