// chrome.tabCapture.getMediaStreamId SOLO se puede llamar desde acá
// (una página normal de la extensión), no desde el offscreen document.
// Por eso este pedacito se queda en options.js.
function getStreamIdForTab(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
            if (chrome.runtime.lastError || !streamId) {
                reject(
                    chrome.runtime.lastError ||
                    new Error("No se pudo obtener streamId")
                );
                return;
            }

            resolve(streamId);
        });
    });
}

const SYSTEM_AUDIO_VALUE = "__system_audio__";
const NATIVE_HOST_NAME = "com.whisker.backend";
const CARD_FADE_DURATION = 180;
const WINDOW_RESIZE_DURATION = 620;
const CONFIGURATION_RESIZE_DURATION = 360;
const CONFIGURATION_HEADING_GAP = 18;

let expandedWindowBounds = null;
let captureViewVersion = 0;
let captureViewTimer = null;
let windowResizeFrame = null;
let expansionAnimations = [];

function cancelExpansionAnimations() {
    expansionAnimations.forEach((animation) => {
        animation.cancel();
    });

    expansionAnimations = [];
}

function easeInOutCubic(progress) {
    if (progress < 0.5) {
        return 4 * progress * progress * progress;
    }

    return 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function animateWindowSize(
    windowId,
    fromBounds,
    toBounds,
    stateVersion,
    onComplete,
    duration = WINDOW_RESIZE_DURATION
) {
    if (windowResizeFrame) {
        cancelAnimationFrame(windowResizeFrame);
    }

    const startedAt = performance.now();

    function updateFrame(now) {
        if (stateVersion !== captureViewVersion) {
            return;
        }

        const progress = Math.min(
            (now - startedAt) / duration,
            1
        );

        const easedProgress = easeInOutCubic(progress);
        const width = Math.round(
            fromBounds.width +
            (toBounds.width - fromBounds.width) *
            easedProgress
        );
        const height = Math.round(
            fromBounds.height +
            (toBounds.height - fromBounds.height) *
            easedProgress
        );

        chrome.windows.update(
            windowId,
            { width, height },
            () => void chrome.runtime.lastError
        );

        if (progress < 1) {
            windowResizeFrame =
                requestAnimationFrame(updateFrame);
            return;
        }

        windowResizeFrame = null;

        if (onComplete) {
            onComplete();
        }
    }

    windowResizeFrame =
        requestAnimationFrame(updateFrame);
}

function resizeOptionsWindow(
    isCapturing,
    stateVersion,
    onComplete
) {

    if (
        !chrome.windows ||
        !chrome.windows.getCurrent ||
        !chrome.windows.update
    ) {
        if (onComplete) {
            onComplete();
        }
        return;
    }

    chrome.windows.getCurrent((currentWindow) => {
        if (
            stateVersion !== captureViewVersion ||
            chrome.runtime.lastError ||
            !currentWindow ||
            !["normal", "popup"].includes(
                currentWindow.type
            ) ||
            currentWindow.state !== "normal"
        ) {
            if (onComplete) {
                onComplete();
            }
            return;
        }

        if (isCapturing) {
            if (!expandedWindowBounds) {
                expandedWindowBounds = {
                    width: currentWindow.width,
                    height: currentWindow.height,
                };
            }

            requestAnimationFrame(() => {
                if (stateVersion !== captureViewVersion) {
                    return;
                }

                const sessionCard =
                    document.querySelector(".session-card");

                if (!sessionCard) {
                    return;
                }

                const bodyStyles =
                    window.getComputedStyle(document.body);

                const verticalPadding =
                    parseFloat(bodyStyles.paddingTop) +
                    parseFloat(bodyStyles.paddingBottom);

                const windowFrameHeight = Math.max(
                    0,
                    window.outerHeight - window.innerHeight
                );

                const compactHeight = Math.ceil(
                    sessionCard.getBoundingClientRect().height +
                    verticalPadding +
                    windowFrameHeight +
                    2
                );

                animateWindowSize(
                    currentWindow.id,
                    {
                        width: currentWindow.width,
                        height: currentWindow.height,
                    },
                    {
                        width: currentWindow.width,
                        height: compactHeight,
                    },
                    stateVersion,
                    onComplete
                );
            });

            return;
        }

        if (!expandedWindowBounds) {
            if (onComplete) {
                onComplete();
            }
            return;
        }

        const boundsToRestore = expandedWindowBounds;
        expandedWindowBounds = null;

        animateWindowSize(
            currentWindow.id,
            {
                width: currentWindow.width,
                height: currentWindow.height,
            },
            boundsToRestore,
            stateVersion,
            onComplete
        );
    });
}

function setCaptureView(isCapturing) {
    const stateVersion = ++captureViewVersion;

    if (captureViewTimer) {
        clearTimeout(captureViewTimer);
        captureViewTimer = null;
    }

    if (windowResizeFrame) {
        cancelAnimationFrame(windowResizeFrame);
        windowResizeFrame = null;
    }

    cancelExpansionAnimations();

    if (isCapturing) {
        document.body.classList.remove("capture-expanding");
        document.body.classList.remove("capture-collapsing");
        document.body.classList.add("capture-active");

        captureViewTimer = setTimeout(() => {
            if (stateVersion !== captureViewVersion) {
                return;
            }

            const sessionCard =
                document.querySelector(".session-card");

            const expandedSessionTop = sessionCard
                ? sessionCard.getBoundingClientRect().top
                : 0;

            document.body.classList.add(
                "capture-collapsing"
            );

            document.body.classList.add(
                "capture-collapsed"
            );

            requestAnimationFrame(() => {
                if (stateVersion !== captureViewVersion) {
                    return;
                }

                if (sessionCard) {
                    const compactSessionTop =
                        sessionCard.getBoundingClientRect().top;

                    const sessionOffset =
                        expandedSessionTop -
                        compactSessionTop;

                    expansionAnimations.push(
                        sessionCard.animate(
                            [
                                {
                                    transform:
                                        `translateY(${sessionOffset}px)`,
                                },
                                {
                                    transform: "translateY(0)",
                                },
                            ],
                            {
                                duration:
                                    WINDOW_RESIZE_DURATION,
                                fill: "both",
                                easing:
                                    "cubic-bezier(0.65, 0, 0.35, 1)",
                            }
                        )
                    );
                }

                resizeOptionsWindow(
                    true,
                    stateVersion,
                    () => {
                        if (
                            stateVersion !==
                            captureViewVersion
                        ) {
                            return;
                        }

                        cancelExpansionAnimations();

                        document.body.classList.remove(
                            "capture-collapsing"
                        );
                    }
                );
            });
        }, CARD_FADE_DURATION);

        return;
    }

    const sessionCard =
        document.querySelector(".session-card");

    const compactSessionTop = sessionCard
        ? sessionCard.getBoundingClientRect().top
        : 0;

    document.body.classList.remove("capture-collapsing");
    document.body.classList.add("capture-expanding");
    document.body.classList.remove("capture-collapsed");
    document.body.classList.remove("capture-active");

    requestAnimationFrame(() => {
        if (stateVersion !== captureViewVersion) {
            return;
        }

        const fallingCards = [
            {
                element: document.querySelector(".app-header"),
                distance: 90,
                delay: 30,
            },
            {
                element: document.querySelector(".source-card"),
                distance: 130,
                delay: 100,
            },
            {
                element: document.querySelector(
                    ".configuration-card"
                ),
                distance: 170,
                delay: 170,
            },
        ];

        fallingCards.forEach(({
            element,
            distance,
            delay,
        }) => {
            if (!element) {
                return;
            }

            expansionAnimations.push(
                element.animate(
                    [
                        {
                            opacity: 0,
                            transform:
                                `translateY(-${distance}px)`,
                        },
                        {
                            opacity: 1,
                            transform: "translateY(0)",
                        },
                    ],
                    {
                        duration: 480,
                        delay,
                        fill: "both",
                        easing:
                            "cubic-bezier(0.16, 1, 0.3, 1)",
                    }
                )
            );
        });

        if (sessionCard) {
            const expandedSessionTop =
                sessionCard.getBoundingClientRect().top;

            const sessionOffset =
                compactSessionTop - expandedSessionTop;

            expansionAnimations.push(
                sessionCard.animate(
                    [
                        {
                            transform:
                                `translateY(${sessionOffset}px)`,
                        },
                        {
                            transform: "translateY(0)",
                        },
                    ],
                    {
                        duration: WINDOW_RESIZE_DURATION,
                        fill: "both",
                        easing:
                            "cubic-bezier(0.22, 1, 0.36, 1)",
                    }
                )
            );
        }

        resizeOptionsWindow(
            false,
            stateVersion,
            () => {
                if (stateVersion !== captureViewVersion) {
                    return;
                }

                cancelExpansionAnimations();

                document.body.classList.remove(
                    "capture-expanding"
                );
            }
        );
    });
}

function getDisplayStatus(text, color) {
    const normalizedText = String(text)
        .trim()
        .toLowerCase();

    const hasErrorText = [
        "error",
        "falló",
        "fallo",
        "no se pudo",
        "no respondió",
        "no respondio",
        "no se detectó",
        "no se detecto",
        "no está disponible",
        "no esta disponible",
    ].some((fragment) =>
        normalizedText.includes(fragment)
    );

    const isDisconnected =
        normalizedText.includes("desconect") ||
        normalizedText.includes("deteniendo");

    if (hasErrorText || (color === "red" && !isDisconnected)) {
        return {
            text: String(text).trim(),
            isError: true,
        };
    }

    if (isDisconnected || color === "gray") {
        return {
            text: "Desconectado",
            isError: false,
        };
    }

    if (
        normalizedText.includes("iniciando") ||
        normalizedText.includes("conectando") ||
        normalizedText.includes("esperando") ||
        color === "yellow"
    ) {
        return {
            text: "Conectando",
            isError: false,
        };
    }

    if (
        normalizedText.includes("conectado") ||
        normalizedText.includes("capturando") ||
        normalizedText.includes("listo") ||
        color === "green"
    ) {
        return {
            text: "Conectado",
            isError: false,
        };
    }

    return {
        text: "Desconectado",
        isError: false,
    };
}

function fitCompactWindowToStatus() {
    if (
        !document.body.classList.contains(
            "capture-collapsed"
        ) ||
        document.body.classList.contains(
            "capture-collapsing"
        ) ||
        document.body.classList.contains(
            "capture-expanding"
        )
    ) {
        return;
    }

    const stateVersion = captureViewVersion;

    requestAnimationFrame(() => {
        if (stateVersion !== captureViewVersion) {
            return;
        }

        chrome.windows.getCurrent((currentWindow) => {
            if (
                stateVersion !== captureViewVersion ||
                chrome.runtime.lastError ||
                !currentWindow ||
                currentWindow.state !== "normal"
            ) {
                return;
            }

            const sessionCard =
                document.querySelector(".session-card");

            if (!sessionCard) {
                return;
            }

            const bodyStyles =
                window.getComputedStyle(document.body);

            const verticalPadding =
                parseFloat(bodyStyles.paddingTop) +
                parseFloat(bodyStyles.paddingBottom);

            const windowFrameHeight = Math.max(
                0,
                window.outerHeight - window.innerHeight
            );

            const targetHeight = Math.ceil(
                sessionCard.getBoundingClientRect().height +
                verticalPadding +
                windowFrameHeight +
                2
            );

            if (
                Math.abs(
                    currentWindow.height - targetHeight
                ) < 2
            ) {
                return;
            }

            animateWindowSize(
                currentWindow.id,
                {
                    width: currentWindow.width,
                    height: currentWindow.height,
                },
                {
                    width: currentWindow.width,
                    height: targetHeight,
                },
                stateVersion
            );
        });
    });
}

function setConfigurationCollapsed(isCollapsed) {
    const configurationCard =
        document.querySelector(".configuration-card");

    const configurationToggle =
        document.getElementById("configurationToggle");

    if (!configurationCard || !configurationToggle) {
        return;
    }

    configurationCard.classList.toggle(
        "is-collapsed",
        isCollapsed
    );

    configurationToggle.setAttribute(
        "aria-expanded",
        String(!isCollapsed)
    );

    configurationToggle.title = isCollapsed
        ? "Abrir configuración"
        : "Colapsar configuración";
}

function resizeWindowForConfiguration(
    isCollapsed,
    onComplete
) {
    if (
        document.body.classList.contains(
            "capture-collapsed"
        ) ||
        document.body.classList.contains(
            "capture-collapsing"
        ) ||
        document.body.classList.contains(
            "capture-expanding"
        )
    ) {
        if (onComplete) {
            onComplete();
        }
        return;
    }

    const configurationContent =
        document.querySelector(
            ".configuration-content-inner"
        );

    if (!configurationContent) {
        if (onComplete) {
            onComplete();
        }
        return;
    }

    const heightDifference =
        configurationContent.scrollHeight +
        CONFIGURATION_HEADING_GAP;

    const stateVersion = captureViewVersion;

    chrome.windows.getCurrent((currentWindow) => {
        if (
            stateVersion !== captureViewVersion ||
            chrome.runtime.lastError ||
            !currentWindow ||
            !["normal", "popup"].includes(
                currentWindow.type
            ) ||
            currentWindow.state !== "normal"
        ) {
            if (onComplete) {
                onComplete();
            }
            return;
        }

        const targetHeight = Math.max(
            260,
            Math.round(
                currentWindow.height +
                (isCollapsed
                    ? -heightDifference
                    : heightDifference)
            )
        );

        animateWindowSize(
            currentWindow.id,
            {
                width: currentWindow.width,
                height: currentWindow.height,
            },
            {
                width: currentWindow.width,
                height: targetHeight,
            },
            stateVersion,
            onComplete,
            CONFIGURATION_RESIZE_DURATION
        );
    });
}

function setServerStatus(text, color = "gray") {
    const statusEl = document.getElementById("serverStatus");
    const dotEl = document.getElementById("statusDot");
    const displayStatus = getDisplayStatus(text, color);

    if (statusEl) {
        statusEl.lastChild.textContent =
            " Estado: " + displayStatus.text;

        statusEl.classList.toggle(
            "status-error",
            displayStatus.isError
        );
    }

    if (dotEl) {
        dotEl.className = "status-dot " + color;
    }

    fitCompactWindowToStatus();
}

function getSelectedBackend() {
    const selected = document.querySelector(
        'input[name="backend"]:checked'
    );

    return selected ? selected.value : "rocm";
}

function startBackend(backend) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendNativeMessage(
            NATIVE_HOST_NAME,
            {
                action: "start_backend",
                backend,
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(
                        new Error(chrome.runtime.lastError.message)
                    );
                    return;
                }

                if (!response) {
                    reject(
                        new Error("El Native Host no respondió.")
                    );
                    return;
                }

                if (!response.ok) {
                    reject(
                        new Error(
                            response.error ||
                            "No se pudo iniciar el backend."
                        )
                    );
                    return;
                }

                resolve(response);
            }
        );
    });
}

function stopBackend() {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendNativeMessage(
            NATIVE_HOST_NAME,
            {
                action: "stop_backend",
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(
                        new Error(chrome.runtime.lastError.message)
                    );
                    return;
                }

                if (!response) {
                    reject(
                        new Error("El Native Host no respondió.")
                    );
                    return;
                }

                if (!response.ok) {
                    reject(
                        new Error(
                            response.error ||
                            "No se pudo detener el backend."
                        )
                    );
                    return;
                }

                resolve(response);
            }
        );
    });
}

/**
 * Actualiza el cartel "Vas a capturar: ...".
 * sourceType es "tab" o "desktop".
 */
function updateTargetTabInfo(sourceType, tabId) {
    const infoEl = document.getElementById("targetTabInfo");

    if (!infoEl) {
        return;
    }

    if (sourceType === "desktop") {
        infoEl.textContent =
            "Vas a capturar: todo el audio del sistema";
        return;
    }

    if (!tabId) {
        infoEl.textContent =
            "Vas a capturar: (ninguna pestaña seleccionada)";
        return;
    }

    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            infoEl.textContent =
                "Vas a capturar: (la pestaña ya no está disponible)";
            return;
        }

        infoEl.textContent =
            "Vas a capturar: " + tab.title;
    });
}

/**
 * Llena el dropdown de fuente: primero la opción de
 * "todo el audio del sistema", después las pestañas
 * abiertas actualmente.
 *
 * No lista las páginas propias de la extensión
 * (options.html, transcript.html, etc).
 */
function populateSourceTabDropdown(
    sourceType,
    selectedTabId
) {
    const dropdown =
        document.getElementById("sourceTabDropdown");

    if (!dropdown) {
        return;
    }

    chrome.tabs.query({}, (tabs) => {
        dropdown.innerHTML = "";

        const emptyOption =
            document.createElement("option");

        emptyOption.value = "";
        emptyOption.textContent =
            "-- Elegí una fuente --";

        dropdown.appendChild(emptyOption);

        const systemAudioOption =
            document.createElement("option");

        systemAudioOption.value = SYSTEM_AUDIO_VALUE;
        systemAudioOption.textContent =
            "🖥️ Todo el audio del sistema";

        if (sourceType === "desktop") {
            systemAudioOption.selected = true;
        }

        dropdown.appendChild(systemAudioOption);

        const ownPrefix =
            `chrome-extension://${chrome.runtime.id}`;

        tabs.forEach((tab) => {
            if (
                tab.url &&
                tab.url.startsWith(ownPrefix)
            ) {
                return;
            }

            const option =
                document.createElement("option");

            option.value = String(tab.id);

            const audibleTag =
                tab.audible ? "🔊 " : "";

            option.textContent =
                audibleTag +
                (tab.title || tab.url || "(sin título)");

            if (
                sourceType === "tab" &&
                selectedTabId &&
                tab.id === selectedTabId
            ) {
                option.selected = true;
            }

            dropdown.appendChild(option);
        });
    });
}

function toggleCaptureButtons(isCapturing) {
    setCaptureView(isCapturing);

    const startButton =
        document.getElementById("startCapture");

    const stopButton =
        document.getElementById("stopCapture");

    const useVadCheckbox =
        document.getElementById("useVadCheckbox");

    const languageDropdown =
        document.getElementById("languageDropdown");

    const taskDropdown =
        document.getElementById("taskDropdown");

    const modelSizeDropdown =
        document.getElementById("modelSizeDropdown");

    const sourceTabDropdown =
        document.getElementById("sourceTabDropdown");

    const refreshTabsButton =
        document.getElementById("refreshTabsButton");

    const columnOrderDropdown =
        document.getElementById("columnOrderDropdown");

    const backendRadios =
        document.querySelectorAll(
            'input[name="backend"]'
        );

    startButton.disabled = isCapturing;
    stopButton.disabled = !isCapturing;

    useVadCheckbox.disabled = isCapturing;
    modelSizeDropdown.disabled = isCapturing;
    languageDropdown.disabled = isCapturing;
    taskDropdown.disabled = isCapturing;
    sourceTabDropdown.disabled = isCapturing;
    refreshTabsButton.disabled = isCapturing;

    backendRadios.forEach((radio) => {
        radio.disabled = isCapturing;
    });

    startButton.classList.toggle(
        "disabled",
        isCapturing
    );

    stopButton.classList.toggle(
        "disabled",
        !isCapturing
    );

    const isInterpreterMode =
        taskDropdown.value === "interpreter_auto" ||
        taskDropdown.value === "interpreter_manual";

    columnOrderDropdown.disabled =
        isCapturing || !isInterpreterMode;
}

/**
 * Repuebla el selector único "Orden de columnas"
 * según el modo Interpreter elegido.
 */
function populateColumnOrderOptions(
    task,
    columnOrderDropdown
) {
    const isAuto =
        task === "interpreter_auto";

    const isManual =
        task === "interpreter_manual";

    columnOrderDropdown.innerHTML = "";

    if (!isAuto && !isManual) {
        const emptyOption =
            document.createElement("option");

        emptyOption.value = "";
        emptyOption.textContent =
            "-- Elegí un modo Interpreter --";

        columnOrderDropdown.appendChild(
            emptyOption
        );

        columnOrderDropdown.disabled = true;
        return;
    }

    columnOrderDropdown.disabled = false;

    const options = isAuto
        ? [
            {
                value: "es_en",
                label: "ES / EN",
            },
            {
                value: "en_es",
                label: "EN / ES",
            },
        ]
        : [
            {
                value: "client_lep",
                label: "Client / LEP",
            },
            {
                value: "lep_client",
                label: "LEP / Client",
            },
        ];

    options.forEach(({ value, label }) => {
        const opt =
            document.createElement("option");

        opt.value = value;
        opt.textContent = label;

        columnOrderDropdown.appendChild(opt);
    });

    const storageKey = isAuto
        ? "columnOrderAuto"
        : "columnOrderManual";

    chrome.storage.local.get(
        [storageKey],
        (result) => {
            const value =
                result[storageKey] ||
                options[0].value;

            columnOrderDropdown.value = value;

            applyColumnOrder(task, value);
        }
    );
}

/**
 * Traduce el valor elegido en el selector único
 * ("es_en", "client_lep", etc.) a las claves
 * de storage que ya leen interpreter.js y manual.js.
 */
function applyColumnOrder(task, value) {
    if (!value) {
        return;
    }

    const [left, right] =
        value.split("_");

    if (task === "interpreter_auto") {
        chrome.storage.local.set({
            columnLangLeft: left,
            columnLangRight: right,
            columnOrderAuto: value,
        });

    } else if (
        task === "interpreter_manual"
    ) {
        chrome.storage.local.set({
            manualLeftChannel: left,
            manualRightChannel: right,
            columnOrderManual: value,
        });
    }
}

// Mensajes que llegan desde offscreen.js
// para actualizar la UI.
chrome.runtime.onMessage.addListener(
    (message) => {
        if (
            message.type === "status-update"
        ) {
            setServerStatus(
                message.text,
                message.color
            );

        } else if (
            message.type === "capture-stopped"
        ) {
            toggleCaptureButtons(false);
        }
    }
);

document.addEventListener(
    "DOMContentLoaded",
    function () {
        const startButton =
            document.getElementById("startCapture");

        const stopButton =
            document.getElementById("stopCapture");

        const useVadCheckbox =
            document.getElementById(
                "useVadCheckbox"
            );

        const languageDropdown =
            document.getElementById(
                "languageDropdown"
            );

        const taskDropdown =
            document.getElementById(
                "taskDropdown"
            );

        const modelSizeDropdown =
            document.getElementById(
                "modelSizeDropdown"
            );

        const sourceTabDropdown =
            document.getElementById(
                "sourceTabDropdown"
            );

        const columnOrderDropdown =
            document.getElementById(
                "columnOrderDropdown"
            );

        const backendRadios =
            document.querySelectorAll(
                'input[name="backend"]'
            );

        const configurationToggle =
            document.getElementById(
                "configurationToggle"
            );

        chrome.storage.local.get(
            ["configurationCollapsed"],
            ({ configurationCollapsed }) => {
                const isCollapsed =
                    Boolean(configurationCollapsed);

                setConfigurationCollapsed(
                    isCollapsed
                );

                if (isCollapsed) {
                    requestAnimationFrame(() => {
                        resizeWindowForConfiguration(true);
                    });
                }
            }
        );

        configurationToggle.addEventListener(
            "click",
            () => {
                if (
                    configurationToggle.dataset
                        .animating === "true"
                ) {
                    return;
                }

                const configurationCard =
                    document.querySelector(
                        ".configuration-card"
                    );

                const isCollapsed =
                    !configurationCard.classList.contains(
                        "is-collapsed"
                    );

                setConfigurationCollapsed(isCollapsed);

                configurationToggle.dataset.animating =
                    "true";

                resizeWindowForConfiguration(
                    isCollapsed,
                    () => {
                        configurationToggle.dataset.animating =
                            "false";
                    }
                );

                chrome.storage.local.set({
                    configurationCollapsed: isCollapsed,
                });
            }
        );

        // Mostrar qué fuente quedó armada
        // y poblar el selector.
        chrome.storage.local.get(
            [
                "sourceType",
                "currentTabId",
            ],
            ({
                sourceType,
                currentTabId,
            }) => {
                updateTargetTabInfo(
                    sourceType,
                    currentTabId
                );

                populateSourceTabDropdown(
                    sourceType,
                    currentTabId
                );
            }
        );

        document
            .getElementById(
                "refreshTabsButton"
            )
            .addEventListener(
                "click",
                () => {
                    chrome.storage.local.get(
                        [
                            "sourceType",
                            "currentTabId",
                        ],
                        ({
                            sourceType,
                            currentTabId,
                        }) => {
                            populateSourceTabDropdown(
                                sourceType,
                                currentTabId
                            );
                        }
                    );
                }
            );

        sourceTabDropdown.addEventListener(
            "change",
            (event) => {
                const value =
                    event.target.value;

                if (!value) {
                    return;
                }

                if (
                    value === SYSTEM_AUDIO_VALUE
                ) {
                    chrome.storage.local.set({
                        sourceType: "desktop",
                    });

                    return;
                }

                chrome.storage.local.set({
                    sourceType: "tab",
                    currentTabId: Number(value),
                });
            }
        );

        chrome.storage.onChanged.addListener(
            (changes, areaName) => {
                if (areaName !== "local") {
                    return;
                }

                if (
                    changes.currentTabId ||
                    changes.sourceType
                ) {
                    chrome.storage.local.get(
                        [
                            "sourceType",
                            "currentTabId",
                        ],
                        ({
                            sourceType,
                            currentTabId,
                        }) => {
                            updateTargetTabInfo(
                                sourceType,
                                currentTabId
                            );
                        }
                    );
                }
            }
        );

        // Restaurar preferencias guardadas.
        chrome.storage.local.get(
            [
                "useVadState",
                "selectedLanguage",
                "selectedTask",
                "selectedModelSize",
                "selectedBackend",
            ],
            (result) => {
                if (
                    result.useVadState !== undefined
                ) {
                    useVadCheckbox.checked =
                        result.useVadState;
                }

                if (
                    result.selectedLanguage !==
                    undefined
                ) {
                    languageDropdown.value =
                        result.selectedLanguage || "";
                }

                if (
                    result.selectedTask !==
                    undefined
                ) {
                    taskDropdown.value =
                        result.selectedTask;
                }

                if (
                    result.selectedModelSize !==
                    undefined
                ) {
                    modelSizeDropdown.value =
                        result.selectedModelSize;
                }

                const selectedBackend =
                    result.selectedBackend ||
                    "rocm";

                const selectedBackendRadio =
                    document.querySelector(
                        `input[name="backend"][value="${selectedBackend}"]`
                    );

                if (selectedBackendRadio) {
                    selectedBackendRadio.checked =
                        true;
                }

                populateColumnOrderOptions(
                    taskDropdown.value,
                    columnOrderDropdown
                );
            }
        );

        backendRadios.forEach(
            (radio) => {
                radio.addEventListener(
                    "change",
                    () => {
                        if (radio.checked) {
                            chrome.storage.local.set({
                                selectedBackend:
                                    radio.value,
                            });
                        }
                    }
                );
            }
        );

        useVadCheckbox.addEventListener(
            "change",
            () => {
                chrome.storage.local.set({
                    useVadState:
                        useVadCheckbox.checked,
                });
            }
        );

        languageDropdown.addEventListener(
            "change",
            () => {
                chrome.storage.local.set({
                    selectedLanguage:
                        languageDropdown.value ||
                        null,
                });
            }
        );

        taskDropdown.addEventListener(
            "change",
            () => {
                chrome.storage.local.set({
                    selectedTask:
                        taskDropdown.value,
                });

                populateColumnOrderOptions(
                    taskDropdown.value,
                    columnOrderDropdown
                );
            }
        );

        modelSizeDropdown.addEventListener(
            "change",
            () => {
                chrome.storage.local.set({
                    selectedModelSize:
                        modelSizeDropdown.value,
                });
            }
        );

        columnOrderDropdown.addEventListener(
            "change",
            () => {
                applyColumnOrder(
                    taskDropdown.value,
                    columnOrderDropdown.value
                );
            }
        );

        startButton.addEventListener(
            "click",
            async () => {
                if (startButton.disabled) {
                    return;
                }

                const host = "localhost";
                const port = "9090";

                const selectedBackend =
                    getSelectedBackend();

                const commonOptions = {
                    host,
                    port,
                    backend: selectedBackend,
                    language:
                        languageDropdown.value ||
                        null,

                    task:
                        taskDropdown.value ===
                            "interpreter_auto" ||
                        taskDropdown.value ===
                            "interpreter_manual"
                            ? "transcribe"
                            : taskDropdown.value,

                    modelSize:
                        modelSizeDropdown.value,

                    useVad:
                        useVadCheckbox.checked,
                };

                chrome.storage.local.get(
                    [
                        "sourceType",
                        "currentTabId",
                    ],
                    async ({
                        sourceType,
                        currentTabId,
                    }) => {
                        if (
                            sourceType !== "desktop" &&
                            !currentTabId
                        ) {
                            setServerStatus(
                                "no se detectó una fuente para capturar",
                                "red"
                            );

                            return;
                        }

                        toggleCaptureButtons(true);

                        setServerStatus(
                            `iniciando backend ${selectedBackend}...`,
                            "yellow"
                        );

                        try {
                            const backendResponse =
                                await startBackend(
                                    selectedBackend
                                );

                            console.log(
                                "Backend iniciado:",
                                backendResponse
                            );

                        } catch (error) {
                            console.error(
                                "No se pudo iniciar el backend:",
                                error
                            );

                            setServerStatus(
                                "error al iniciar backend: " +
                                error.message,
                                "red"
                            );

                            toggleCaptureButtons(false);
                            return;
                        }

                        setServerStatus(
                            "conectando...",
                            "yellow"
                        );

                        if (
                            sourceType === "desktop"
                        ) {
                            chrome.runtime.sendMessage({
                                type: "offscreen-start",

                                data: {
                                    ...commonOptions,
                                    sourceType: "desktop",
                                },
                            });

                            return;
                        }

                        let streamId;

                        try {
                            streamId =
                                await getStreamIdForTab(
                                    currentTabId
                                );

                        } catch (error) {
                            console.error(
                                "No se pudo obtener el streamId:",
                                error
                            );

                            setServerStatus(
                                "error al capturar audio",
                                "red"
                            );

                            toggleCaptureButtons(false);
                            return;
                        }

                        chrome.runtime.sendMessage({
                            type: "offscreen-start",

                            data: {
                                ...commonOptions,
                                streamId,
                                sourceType: "tab",
                            },
                        });
                    }
                );
            }
        );

        stopButton.addEventListener(
            "click",
            async () => {
                if (stopButton.disabled) {
                    return;
                }

                stopButton.disabled = true;

                chrome.runtime.sendMessage({
                    type: "offscreen-stop",
                });

                setServerStatus(
                    "deteniendo backend...",
                    "yellow"
                );

                try {
                    const response =
                        await stopBackend();

                    console.log(
                        "Backend detenido:",
                        response
                    );

                    setServerStatus(
                        "desconectado",
                        "red"
                    );

                } catch (error) {
                    console.error(
                        "No se pudo detener el backend:",
                        error
                    );

                    setServerStatus(
                        "captura detenida, error al cerrar backend",
                        "red"
                    );
                }

                toggleCaptureButtons(false);
            }
        );
    }
);
