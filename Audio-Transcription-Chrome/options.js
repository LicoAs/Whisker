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
const WINDOW_RESIZE_DURATION = 620;
const CONFIGURATION_RESIZE_DURATION = 360;
const CONFIGURATION_OVERFLOW_GRACE = 80;
const CONFIGURATION_HEADING_GAP = 18;
const OPTIONS_FALLBACK_CONTENT_WIDTH = 420;
const COMPACT_BODY_HORIZONTAL_PADDING = 32;
const COMPACT_BODY_VERTICAL_PADDING = 48;
const COMPACT_CARD_HORIZONTAL_INSET = 38;
const COMPACT_SESSION_HEADING_GAP = 12;
const COMPACT_TOGGLE_ROW_GAP = 24;
const SWEET_SPOT_WIDTH_BUFFER = 19;
const WINDOW_FIT_TOLERANCE = 2;
const BACKEND_INDICATOR_TEXT_DELAY = 150;
const BACKEND_INDICATOR_MOTION_DURATION = 300;
const DELAYED_TOOLTIP_DELAY = 1500;
const TOOLTIP_VIEWPORT_MARGIN = 12;
const TOOLTIP_ANCHOR_GAP = 8;

let expandedWindowBounds = null;
let captureViewVersion = 0;
let captureViewIsCapturing = false;
let windowResizeFrame = null;
let windowResizeAnimationVersion = 0;
let expansionAnimations = [];
let detachedCaptureCards = [];
let configurationOverflowTimer = null;
let backendIndicatorTextTimer = null;
let backendIndicatorMotionTimer = null;
let delayedTooltipTimer = null;
let delayedTooltipAnchor = null;

function cancelExpansionAnimations() {
    expansionAnimations.forEach((animation) => {
        animation.cancel();
    });

    expansionAnimations = [];
}

function endConfigurationResizeMask() {
    if (configurationOverflowTimer) {
        clearTimeout(configurationOverflowTimer);
        configurationOverflowTimer = null;
    }

    document.body.classList.remove(
        "configuration-resizing"
    );

    const configurationToggle =
        document.getElementById("configurationToggle");

    if (configurationToggle) {
        configurationToggle.dataset.animating = "false";
    }
}

function beginConfigurationResizeMask() {
    endConfigurationResizeMask();

    document.body.classList.add(
        "configuration-resizing"
    );

    configurationOverflowTimer = setTimeout(
        endConfigurationResizeMask,
        CONFIGURATION_RESIZE_DURATION +
            CONFIGURATION_OVERFLOW_GRACE
    );
}

function clearDetachedCaptureCards() {
    detachedCaptureCards.forEach((element) => {
        [
            "display",
            "position",
            "top",
            "left",
            "width",
            "height",
            "margin",
            "z-index",
            "pointer-events",
            "will-change",
        ].forEach((property) => {
            element.style.removeProperty(property);
        });
    });

    detachedCaptureCards = [];
}

function detachCaptureCardsForCollapse() {
    const cardDefinitions = [
        {
            element: document.querySelector(".app-header"),
            distance: 90,
            delay: 170,
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
            delay: 30,
        },
    ].filter(({ element }) => Boolean(element));

    const snapshots = cardDefinitions.map((definition) => ({
        ...definition,
        rect: definition.element.getBoundingClientRect(),
    }));

    snapshots.forEach(({ element, rect }) => {
        element.style.display = "block";
        element.style.position = "fixed";
        element.style.top = `${rect.top}px`;
        element.style.left = `${rect.left}px`;
        element.style.width = `${rect.width}px`;
        element.style.height = `${rect.height}px`;
        element.style.margin = "0";
        element.style.zIndex = "10";
        element.style.pointerEvents = "none";
        element.style.willChange = "transform, opacity";
    });

    detachedCaptureCards = snapshots.map(
        ({ element }) => element
    );

    return snapshots;
}

function getExpandedContentWindowHeight() {
    const appShell = document.querySelector(".app-shell");

    if (!appShell) {
        return 0;
    }

    const bodyStyles = window.getComputedStyle(document.body);
    const expandedPaddingTop = parseFloat(
        bodyStyles.getPropertyValue(
            "--expanded-body-padding-top"
        )
    );
    const expandedPaddingBottom = parseFloat(
        bodyStyles.getPropertyValue(
            "--expanded-body-padding-bottom"
        )
    );
    const windowFrameHeight = Math.max(
        0,
        window.outerHeight - window.innerHeight
    );

    return Math.ceil(
        appShell.getBoundingClientRect().height +
        (Number.isFinite(expandedPaddingTop)
            ? expandedPaddingTop
            : parseFloat(bodyStyles.paddingTop)) +
        (Number.isFinite(expandedPaddingBottom)
            ? expandedPaddingBottom
            : parseFloat(bodyStyles.paddingBottom)) +
        windowFrameHeight +
        WINDOW_FIT_TOLERANCE
    );
}

function getCompactContentWindowHeight() {
    const sessionCard =
        document.querySelector(".session-card");

    if (!sessionCard) {
        return 0;
    }

    const windowFrameHeight = Math.max(
        0,
        window.outerHeight - window.innerHeight
    );

    return Math.ceil(
        sessionCard.getBoundingClientRect().height +
        COMPACT_BODY_VERTICAL_PADDING +
        windowFrameHeight +
        WINDOW_FIT_TOLERANCE
    );
}

function clearSessionExpansionStyles() {
    const sessionCard =
        document.querySelector(".session-card");

    if (!sessionCard) {
        return;
    }

    [
        "transform",
        "position",
        "z-index",
        "will-change",
        "opacity",
    ].forEach((property) => {
        sessionCard.style.removeProperty(property);
    });
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
    duration = WINDOW_RESIZE_DURATION,
    onProgress
) {
    if (windowResizeFrame) {
        cancelAnimationFrame(windowResizeFrame);
    }

    const animationVersion =
        ++windowResizeAnimationVersion;

    const startedAt = performance.now();
    let latestAppliedProgress = -1;

    function updateFrame(now) {
        if (
            stateVersion !== captureViewVersion ||
            animationVersion !==
                windowResizeAnimationVersion
        ) {
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
            () => {
                const updateError =
                    chrome.runtime.lastError;

                if (
                    stateVersion !== captureViewVersion ||
                    animationVersion !==
                        windowResizeAnimationVersion ||
                    easedProgress < latestAppliedProgress
                ) {
                    return;
                }

                latestAppliedProgress = easedProgress;

                if (!updateError && onProgress) {
                    onProgress(easedProgress);
                }

                if (progress === 1 && onComplete) {
                    onComplete();
                }
            }
        );

        if (progress < 1) {
            windowResizeFrame =
                requestAnimationFrame(updateFrame);
            return;
        }

        windowResizeFrame = null;
    }

    windowResizeFrame =
        requestAnimationFrame(updateFrame);
}

function resizeOptionsWindow(
    isCapturing,
    stateVersion,
    onComplete,
    onProgress,
    targetExpandedHeight = 0
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

                const compactHeight =
                    getCompactContentWindowHeight();

                if (!compactHeight) {
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
                        height: compactHeight,
                    },
                    stateVersion,
                    onComplete,
                    WINDOW_RESIZE_DURATION,
                    onProgress
                );
            });

            return;
        }

        const available = getAvailableScreenBounds();
        const storedExpandedBounds = expandedWindowBounds || {
            width: currentWindow.width,
            height: currentWindow.height,
        };
        const boundsToRestore = {
            ...storedExpandedBounds,
            height: Math.min(
                targetExpandedHeight > 0
                    ? targetExpandedHeight
                    : storedExpandedBounds.height,
                available.height
            ),
        };
        expandedWindowBounds = null;

        animateWindowSize(
            currentWindow.id,
            {
                width: currentWindow.width,
                height: currentWindow.height,
            },
            boundsToRestore,
            stateVersion,
            onComplete,
            WINDOW_RESIZE_DURATION,
            onProgress
        );
    });
}

function setCaptureView(isCapturing) {
    if (isCapturing === captureViewIsCapturing) {
        return;
    }

    captureViewIsCapturing = isCapturing;

    endConfigurationResizeMask();

    const stateVersion = ++captureViewVersion;

    if (windowResizeFrame) {
        cancelAnimationFrame(windowResizeFrame);
        windowResizeFrame = null;
    }

    windowResizeAnimationVersion += 1;

    cancelExpansionAnimations();
    clearDetachedCaptureCards();
    clearSessionExpansionStyles();

    if (isCapturing) {
        const sessionCard =
            document.querySelector(".session-card");

        document.body.classList.remove("capture-expanding");
        document.body.classList.remove("capture-collapsing");
        document.body.classList.remove("capture-collapsed");
        document.body.classList.remove("capture-active");

        if (sessionCard) {
            document.body.style.setProperty(
                "--session-card-locked-width",
                `${sessionCard.getBoundingClientRect().width}px`
            );
        }

        const expandedSessionTop = sessionCard
            ? sessionCard.getBoundingClientRect().top
            : 0;

        const risingCards =
            detachCaptureCardsForCollapse();

        document.body.classList.add("capture-active");
        document.body.classList.add("capture-collapsing");
        document.body.classList.add("capture-collapsed");

        let sessionOffset = 0;

        if (sessionCard) {
            const compactSessionTop =
                sessionCard.getBoundingClientRect().top;

            sessionOffset =
                expandedSessionTop - compactSessionTop;

            sessionCard.style.transform =
                `translateY(${sessionOffset}px)`;
            sessionCard.style.position = "relative";
            sessionCard.style.zIndex = "20";
            sessionCard.style.willChange = "transform";
            sessionCard.style.opacity = "1";
            sessionCard.getBoundingClientRect();
        }

        risingCards.forEach(({
            element,
            distance,
            delay,
        }) => {
            expansionAnimations.push(
                element.animate(
                    [
                        {
                            opacity: 1,
                            transform: "translateY(0)",
                        },
                        {
                            opacity: 0,
                            transform:
                                `translateY(-${distance}px)`,
                        },
                    ],
                    {
                        duration: 480,
                        delay,
                        fill: "both",
                        easing:
                            "cubic-bezier(0.7, 0, 0.84, 0)",
                    }
                )
            );
        });

        resizeOptionsWindow(
            true,
            stateVersion,
            () => {
                if (stateVersion !== captureViewVersion) {
                    return;
                }

                cancelExpansionAnimations();
                clearDetachedCaptureCards();
                clearSessionExpansionStyles();

                document.body.classList.remove(
                    "capture-collapsing"
                );
            },
            (progress) => {
                if (!sessionCard) {
                    return;
                }

                sessionCard.style.transform =
                    `translateY(${sessionOffset * (1 - progress)}px)`;
            }
        );

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

    const expandedContentWindowHeight =
        getExpandedContentWindowHeight();

    let sessionOffset = 0;

    if (sessionCard) {
        const expandedSessionTop =
            sessionCard.getBoundingClientRect().top;

        sessionOffset =
            compactSessionTop - expandedSessionTop;

        sessionCard.style.transform =
            `translateY(${sessionOffset}px)`;
        sessionCard.style.position = "relative";
        sessionCard.style.zIndex = "20";
        sessionCard.style.willChange = "transform";
        sessionCard.style.opacity = "1";

        // Mantiene la tarjeta en su lugar compacto desde
        // el primer frame, antes de agrandar la ventana.
        sessionCard.getBoundingClientRect();
    }

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

        resizeOptionsWindow(
            false,
            stateVersion,
            () => {
                if (stateVersion !== captureViewVersion) {
                    return;
                }

                clearSessionExpansionStyles();
                cancelExpansionAnimations();

                document.body.classList.remove(
                    "capture-expanding"
                );

                document.body.style.removeProperty(
                    "--session-card-locked-width"
                );
            },
            (progress) => {
                if (!sessionCard) {
                    return;
                }

                sessionCard.style.transform =
                    `translateY(${sessionOffset * (1 - progress)}px)`;
            },
            expandedContentWindowHeight
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

function fitWindowToStatus() {
    if (
        document.body.classList.contains(
            "capture-collapsing"
        ) ||
        document.body.classList.contains(
            "capture-expanding"
        ) ||
        !chrome.windows ||
        !chrome.windows.getCurrent ||
        !chrome.windows.update
    ) {
        return;
    }

    const isCompact =
        document.body.classList.contains(
            "capture-collapsed"
        );

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
                !["normal", "popup"].includes(
                    currentWindow.type
                ) ||
                currentWindow.state !== "normal"
            ) {
                return;
            }

            const contentHeight = isCompact
                ? getCompactContentWindowHeight()
                : getExpandedContentWindowHeight();

            if (!contentHeight) {
                return;
            }

            const available = getAvailableScreenBounds();
            const targetHeight = Math.min(
                contentHeight,
                available.height
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

function setConfigurationCollapsed(
    isCollapsed,
    animate = true
) {
    const configurationCard =
        document.querySelector(".configuration-card");

    const configurationToggle =
        document.getElementById("configurationToggle");

    if (!configurationCard || !configurationToggle) {
        return;
    }

    configurationCard.classList.toggle(
        "collapse-without-animation",
        !animate
    );

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

    if (!animate) {
        configurationCard.getBoundingClientRect();
        configurationCard.classList.remove(
            "collapse-without-animation"
        );
    }
}

function getAvailableScreenBounds() {
    const left = Number.isFinite(screen.availLeft)
        ? screen.availLeft
        : 0;

    const top = Number.isFinite(screen.availTop)
        ? screen.availTop
        : 0;

    return {
        left,
        top,
        width: screen.availWidth,
        height: screen.availHeight,
    };
}

function clampWindowPosition(
    value,
    availableStart,
    windowSize,
    availableSize
) {
    const safeValue = Number.isFinite(value)
        ? value
        : availableStart;

    const availableEnd = Math.max(
        availableStart,
        availableStart + availableSize - windowSize
    );

    return Math.min(
        Math.max(safeValue, availableStart),
        availableEnd
    );
}

function measureUnwrappedTextWidth(
    element,
    textOverride
) {
    if (!element) {
        return 0;
    }

    const styles = window.getComputedStyle(element);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
        return element.scrollWidth;
    }

    context.font = [
        styles.fontStyle,
        styles.fontVariant,
        styles.fontWeight,
        styles.fontSize,
        styles.fontFamily,
    ].join(" ");

    const text = String(
        typeof textOverride === "string"
            ? textOverride
            : element.textContent
    ).trim();
    const letterSpacing = parseFloat(
        styles.letterSpacing
    );

    const extraLetterSpacing = Number.isFinite(
        letterSpacing
    )
        ? Math.max(0, text.length - 1) *
            letterSpacing
        : 0;

    return Math.ceil(
        context.measureText(text).width +
        extraLetterSpacing
    );
}

function getTooltipText(element) {
    if (element.tagName === "SELECT") {
        const selectedOption =
            element.options[element.selectedIndex];

        return selectedOption
            ? selectedOption.textContent.trim()
            : "";
    }

    return element.textContent.trim();
}

function isTooltipTextTruncated(element, text) {
    if (element.tagName === "SELECT") {
        const styles = window.getComputedStyle(element);

        const availableWidth =
            element.clientWidth -
            parseFloat(styles.paddingLeft) -
            parseFloat(styles.paddingRight);

        return (
            measureUnwrappedTextWidth(element, text) >
            availableWidth + 1
        );
    }

    return element.scrollWidth > element.clientWidth + 1;
}

function hideDelayedTooltip() {
    if (delayedTooltipTimer) {
        clearTimeout(delayedTooltipTimer);
        delayedTooltipTimer = null;
    }

    const tooltip =
        document.getElementById("delayedTooltip");

    if (delayedTooltipAnchor) {
        delayedTooltipAnchor.removeAttribute(
            "aria-describedby"
        );
    }

    delayedTooltipAnchor = null;

    if (!tooltip) {
        return;
    }

    tooltip.classList.remove("is-visible");
    tooltip.setAttribute("aria-hidden", "true");
    tooltip.hidden = true;
}

function showDelayedTooltip(anchor) {
    const tooltip =
        document.getElementById("delayedTooltip");

    if (!tooltip || !anchor.isConnected) {
        return;
    }

    const text = getTooltipText(anchor);

    if (!text || !isTooltipTextTruncated(anchor, text)) {
        return;
    }

    delayedTooltipAnchor = anchor;
    tooltip.textContent = text;
    tooltip.hidden = false;
    tooltip.setAttribute("aria-hidden", "false");
    tooltip.classList.remove("is-visible");
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    const maximumLeft = Math.max(
        TOOLTIP_VIEWPORT_MARGIN,
        window.innerWidth -
            tooltipRect.width -
            TOOLTIP_VIEWPORT_MARGIN
    );

    const left = Math.min(
        Math.max(
            anchorRect.left,
            TOOLTIP_VIEWPORT_MARGIN
        ),
        maximumLeft
    );

    let top =
        anchorRect.bottom + TOOLTIP_ANCHOR_GAP;

    if (
        top + tooltipRect.height >
        window.innerHeight - TOOLTIP_VIEWPORT_MARGIN
    ) {
        top =
            anchorRect.top -
            tooltipRect.height -
            TOOLTIP_ANCHOR_GAP;
    }

    top = Math.max(top, TOOLTIP_VIEWPORT_MARGIN);

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
    anchor.setAttribute(
        "aria-describedby",
        "delayedTooltip"
    );

    requestAnimationFrame(() => {
        if (delayedTooltipAnchor === anchor) {
            tooltip.classList.add("is-visible");
        }
    });
}

function scheduleDelayedTooltip(anchor) {
    hideDelayedTooltip();

    const text = getTooltipText(anchor);

    if (!text || !isTooltipTextTruncated(anchor, text)) {
        return;
    }

    delayedTooltipTimer = setTimeout(() => {
        delayedTooltipTimer = null;
        showDelayedTooltip(anchor);
    }, DELAYED_TOOLTIP_DELAY);
}

function initializeDelayedTooltips() {
    [
        document.getElementById("sourceTabDropdown"),
        document.getElementById("targetTabInfo"),
    ].forEach((anchor) => {
        if (!anchor) {
            return;
        }

        anchor.addEventListener("mouseenter", () => {
            scheduleDelayedTooltip(anchor);
        });

        anchor.addEventListener(
            "mouseleave",
            hideDelayedTooltip
        );

        anchor.addEventListener(
            "mousedown",
            hideDelayedTooltip
        );
    });

    window.addEventListener("blur", hideDelayedTooltip);
    window.addEventListener("resize", hideDelayedTooltip);

    document.addEventListener(
        "scroll",
        hideDelayedTooltip,
        true
    );
}

function getSweetSpotWindowWidth(windowFrameWidth) {
    const sessionTitleGroup = document.querySelector(
        ".session-card .card-heading > div"
    );

    const status =
        document.getElementById("serverStatus");

    const vadCopy = document.querySelector(
        ".configuration-card .toggle-copy"
    );

    const vadToggle =
        document.getElementById("useVadCheckbox");

    if (
        !sessionTitleGroup ||
        !status ||
        !vadCopy ||
        !vadToggle
    ) {
        return Math.ceil(
            OPTIONS_FALLBACK_CONTENT_WIDTH +
            COMPACT_BODY_HORIZONTAL_PADDING +
            windowFrameWidth
        );
    }

    const sessionTitleWidth = Math.max(
        ...Array.from(sessionTitleGroup.children)
            .map((element) =>
                measureUnwrappedTextWidth(element)
            )
    );

    const sessionRowWidth =
        sessionTitleWidth +
        status.getBoundingClientRect().width +
        COMPACT_SESSION_HEADING_GAP;

    const vadCopyWidth = Math.max(
        ...Array.from(vadCopy.children)
            .map((element) =>
                measureUnwrappedTextWidth(element)
            )
    );

    const vadRowWidth =
        vadCopyWidth +
        vadToggle.getBoundingClientRect().width +
        COMPACT_TOGGLE_ROW_GAP;

    return Math.ceil(
        Math.max(sessionRowWidth, vadRowWidth) +
        COMPACT_CARD_HORIZONTAL_INSET +
        COMPACT_BODY_HORIZONTAL_PADDING +
        windowFrameWidth +
        SWEET_SPOT_WIDTH_BUFFER
    );
}

function fitOptionsWindowToContent() {
    if (
        document.body.classList.contains(
            "capture-collapsed"
        ) ||
        document.body.classList.contains(
            "capture-collapsing"
        ) ||
        document.body.classList.contains(
            "capture-expanding"
        ) ||
        !chrome.windows ||
        !chrome.windows.getCurrent ||
        !chrome.windows.update
    ) {
        return;
    }

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
            return;
        }

        const available = getAvailableScreenBounds();

        const windowFrameWidth = Math.max(
            0,
            currentWindow.width - window.innerWidth
        );

        const idealWidth = getSweetSpotWindowWidth(
            windowFrameWidth
        );

        const targetWidth = Math.min(
            idealWidth,
            available.width
        );

        const targetLeft = clampWindowPosition(
            currentWindow.left,
            available.left,
            targetWidth,
            available.width
        );

        chrome.windows.update(
            currentWindow.id,
            {
                width: targetWidth,
                left: targetLeft,
            },
            () => {
                if (
                    stateVersion !== captureViewVersion ||
                    chrome.runtime.lastError
                ) {
                    return;
                }

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        if (
                            stateVersion !==
                            captureViewVersion
                        ) {
                            return;
                        }

                        window.scrollTo(0, 0);

                        const idealHeight =
                            getExpandedContentWindowHeight();

                        if (!idealHeight) {
                            return;
                        }

                        const targetHeight = Math.min(
                            idealHeight,
                            available.height
                        );

                        const targetTop =
                            clampWindowPosition(
                                currentWindow.top,
                                available.top,
                                targetHeight,
                                available.height
                            );

                        chrome.windows.update(
                            currentWindow.id,
                            {
                                height: targetHeight,
                                top: targetTop,
                            },
                            () => void chrome.runtime.lastError
                        );
                    });
                });
            }
        );
    });
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

        const idealHeight = Math.max(
            260,
            Math.round(
                currentWindow.height +
                (isCollapsed
                    ? -heightDifference
                    : heightDifference)
            )
        );

        const available = getAvailableScreenBounds();

        const targetHeight = Math.min(
            idealHeight,
            available.height
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

    fitWindowToStatus();
}

function getSelectedBackend() {
    const selected = document.querySelector(
        'input[name="backend"]:checked'
    );

    return selected ? selected.value : "rocm";
}

function setBackendIndicator(
    backend,
    animate = true
) {
    const segmentedOptions =
        document.querySelector(".segmented-options");

    if (!segmentedOptions) {
        return;
    }

    const validBackends = [
        "cpu",
        "cuda",
        "vulkan",
        "rocm",
    ];

    if (!validBackends.includes(backend)) {
        backend = "rocm";
    }

    if (backendIndicatorTextTimer) {
        clearTimeout(backendIndicatorTextTimer);
        backendIndicatorTextTimer = null;
    }

    if (backendIndicatorMotionTimer) {
        clearTimeout(backendIndicatorMotionTimer);
        backendIndicatorMotionTimer = null;
    }

    const updateActiveLabel = () => {
        segmentedOptions
            .querySelectorAll(".radio-option")
            .forEach((option) => {
                const input = option.querySelector(
                    'input[name="backend"]'
                );

                option.classList.toggle(
                    "indicator-text-active",
                    Boolean(
                        input &&
                        input.value === backend
                    )
                );
            });
    };

    if (!animate) {
        segmentedOptions.classList.remove(
            "indicator-ready",
            "indicator-moving"
        );

        segmentedOptions.dataset.backend = backend;
        updateActiveLabel();
        return;
    }

    segmentedOptions.classList.add(
        "indicator-ready",
        "indicator-moving"
    );

    segmentedOptions
        .querySelectorAll(".indicator-text-active")
        .forEach((option) => {
            option.classList.remove(
                "indicator-text-active"
            );
        });

    segmentedOptions.dataset.backend = backend;

    backendIndicatorTextTimer = setTimeout(() => {
        updateActiveLabel();
        backendIndicatorTextTimer = null;
    }, BACKEND_INDICATOR_TEXT_DELAY);

    backendIndicatorMotionTimer = setTimeout(() => {
        segmentedOptions.classList.remove(
            "indicator-moving"
        );

        backendIndicatorMotionTimer = null;
    }, BACKEND_INDICATOR_MOTION_DURATION);
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

        initializeDelayedTooltips();

        chrome.storage.local.get(
            ["configurationCollapsed"],
            ({ configurationCollapsed }) => {
                const isCollapsed =
                    Boolean(configurationCollapsed);

                setConfigurationCollapsed(
                    isCollapsed,
                    false
                );

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        fitOptionsWindowToContent();
                    });
                });
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

                beginConfigurationResizeMask();
                setConfigurationCollapsed(isCollapsed);

                configurationToggle.dataset.animating =
                    "true";

                resizeWindowForConfiguration(
                    isCollapsed,
                    () => {
                        endConfigurationResizeMask();
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

                setBackendIndicator(
                    selectedBackendRadio
                        ? selectedBackend
                        : "rocm",
                    false
                );

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const segmentedOptions =
                            document.querySelector(
                                ".segmented-options"
                            );

                        if (segmentedOptions) {
                            segmentedOptions.classList.add(
                                "indicator-ready"
                            );
                        }
                    });
                });

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
                            setBackendIndicator(
                                radio.value
                            );

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
