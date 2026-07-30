// Placeholder: por ahora solo muestra el texto crudo que llega.
// El diseño/lógica definitiva de esta vista se arma en una sesión futura.
const outputEl = document.getElementById("translateOutput");

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "transcript") {
    const line = document.createElement("div");
    line.textContent = message.text;
    outputEl.appendChild(line);
  }
});
