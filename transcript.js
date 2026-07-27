chrome.runtime.sendMessage({
    type: "registerTranscript"
});

const history = document.getElementById("history");
const current = document.getElementById("current");

let lastCompletedEnd = -1;
let ignoreUntilEnd = -1;

document.getElementById("clearBtn").addEventListener("click", () => {
    history.textContent = "";
    current.textContent = "";

    ignoreUntilEnd = lastCompletedEnd;
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "transcript") return;

    try {
        const data = JSON.parse(message.text);

        current.textContent = "";

        for (const seg of data.segments) {

            if (seg.completed) {

    const end = parseFloat(seg.end);

    if (end > lastCompletedEnd) {
        lastCompletedEnd = end;

        if (end > ignoreUntilEnd) {
            history.textContent += seg.text + " ";
        }
    }

    } else {

    current.textContent = seg.text;

    }
        }

        window.scrollTo(0, document.body.scrollHeight);

    } catch (e) {
        console.error(e);
    }
});