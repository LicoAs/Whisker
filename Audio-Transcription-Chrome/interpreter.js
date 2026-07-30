chrome.runtime.sendMessage({ type: "registerTranscript" });

let columnLangLeft = "es";
let columnLangRight = "en";

chrome.storage.local.get(["columnLangLeft", "columnLangRight"], (result) => {
    if (result.columnLangLeft) columnLangLeft = result.columnLangLeft;
    if (result.columnLangRight) columnLangRight = result.columnLangRight;
    document.getElementById("leftLabel").textContent = columnLangLeft.toUpperCase();
    document.getElementById("rightLabel").textContent = columnLangRight.toUpperCase();
});

const leftHistory = document.getElementById("leftHistory");
const leftCurrent = document.getElementById("leftCurrent");
const rightHistory = document.getElementById("rightHistory");
const rightCurrent = document.getElementById("rightCurrent");

let lastCompletedEndLeft = -1;
let ignoreUntilEndLeft = -1;
let lastCompletedEndRight = -1;
let ignoreUntilEndRight = -1;
let lastSegmentLanguage = null;

document.getElementById("clearBtn").addEventListener("click", () => {
    leftHistory.textContent = "";
    leftCurrent.textContent = "";
    rightHistory.textContent = "";
    rightCurrent.textContent = "";
    ignoreUntilEndLeft = lastCompletedEndLeft;
    ignoreUntilEndRight = lastCompletedEndRight;
    lastSegmentLanguage = null;
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "transcript") return;

    try {
        const data = JSON.parse(message.text);

        leftCurrent.textContent = "";
        rightCurrent.textContent = "";

        for (const seg of data.segments) {
            const isLeft = seg.language === columnLangLeft;
            const isRight = seg.language === columnLangRight;
            if (!isLeft && !isRight) continue; // idioma que no coincide con ninguna columna: se ignora por ahora

            if (seg.completed) {
                const end = parseFloat(seg.end);
                if (isLeft && end > lastCompletedEndLeft) {
                    lastCompletedEndLeft = end;
                    if (end > ignoreUntilEndLeft) {
                        const separator = (lastSegmentLanguage !== null && lastSegmentLanguage !== seg.language) ? "\n\n" : "";
                        leftHistory.textContent += separator + seg.text + " ";
                        lastSegmentLanguage = seg.language;
                    }
                } else if (isRight && end > lastCompletedEndRight) {
                    lastCompletedEndRight = end;
                    if (end > ignoreUntilEndRight) {
                        const separator = (lastSegmentLanguage !== null && lastSegmentLanguage !== seg.language) ? "\n\n" : "";
                        rightHistory.textContent += separator + seg.text + " ";
                        lastSegmentLanguage = seg.language;
                    }
                }
            } else {
                if (isLeft) leftCurrent.textContent = seg.text;
                else if (isRight) rightCurrent.textContent = seg.text;
            }
        }
    } catch (e) {
        console.error(e);
    }
});