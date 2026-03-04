(() => {
  const STYLE_ATTR = "data-mfci-style-id";
  const STYLE_HASH_ATTR = "data-mfci-style-hash";
  const SCRIPT_ATTR = "data-mfci-script-id";
  const SCRIPT_HASH_ATTR = "data-mfci-script-hash";
  const BACKGROUND_HEARTBEAT_MS = 5000;

  const executedScriptHashes = new Map();

  /**
   * Compute a stable content hash used to skip redundant CSS/JS reinjection.
   * @param {any} value - Raw value to sanitize or normalize before runtime usage.
   * @returns {string} Stable hex hash used to detect content changes.
   */
  function hashString(value) {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16);
  }

  /**
   * Find injected elements by marker attribute for cleanup/update operations.
   * @param {any} attributeName - DOM attribute used as marker for injected assets.
   * @returns {Element[]} Matching DOM nodes carrying the requested marker attribute.
   */
  function queryByAttribute(attributeName) {
    return Array.from(document.querySelectorAll(`[${attributeName}]`));
  }

  /**
   * Return the preferred DOM root where injected style/script tags should be attached.
   * @returns {HTMLElement|null} Preferred injection root in current document.
   */
  function getRootNode() {
    return document.head || document.documentElement || document.body;
  }

  /**
   * Find a previously injected element by file id marker.
   * @param {any} attributeName - DOM attribute used as marker for injected assets.
   * @param {any} fileId - Stable manifest file identifier (type:path).
   * @returns {Element|null} Previously injected node for a file id.
   */
  function findById(attributeName, fileId) {
    return queryByAttribute(attributeName).find((element) => element.getAttribute(attributeName) === fileId) || null;
  }

  /**
   * Remove an injected script element from the page.
   * @param {any} scriptElement - Injected script DOM element to remove.
   * @returns {void} Removes the provided script node from DOM.
   */
  function removeScriptElement(scriptElement) {
    scriptElement.remove();
  }

  /**
   * Append a cache-busting hash query parameter to force browser fetch refresh.
   * @param {any} urlValue - URL-like value to parse or normalize.
   * @param {any} contentHash - Hash used for cache-busting and change detection.
   * @returns {string} URL with `mfci_hash` cache-busting query parameter.
   */
  function appendHashToUrl(urlValue, contentHash) {
    try {
      const parsedUrl = new URL(urlValue, window.location.href);
      parsedUrl.searchParams.set("mfci_hash", contentHash);
      return parsedUrl.toString();
    } catch (_error) {
      return `${urlValue}${urlValue.includes("?") ? "&" : "?"}mfci_hash=${encodeURIComponent(contentHash)}`;
    }
  }

  /**
   * Report JS injection errors back to background script for user-visible diagnostics.
   * @param {any} fileId - Stable manifest file identifier (type:path).
   * @param {any} errorMessage - Human-readable error description sent to background diagnostics.
   * @returns {void} Best-effort error notification to background script.
   */
  function notifyScriptError(fileId, errorMessage) {
    try {
      chrome.runtime.sendMessage({
        type: "MFCI_JS_INJECTION_ERROR",
        fileId,
        error: errorMessage,
      });
    } catch (_error) {
      // No-op
    }
  }

  /**
   * Log extension events into page console for developer feedback during live editing.
   * @param {any} level - Log severity level used by page console bridge.
   * @param {any} message - Runtime message payload received from UI/content/background.
   * @param {any} context - Structured log context appended to console events.
   * @returns {void} Writes a formatted log event to page console.
   */
  function logToPageConsole(level, message, context) {
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    if (context && typeof context === "object") {
      console[method](message, context);
      return;
    }
    console[method](message);
  }

  /**
   * Apply or refresh one CSS file in-place without full page reload.
   * @param {any} file - Manifest or build file descriptor currently processed.
   * @returns {void} Applies or refreshes one CSS file in DOM.
   */
  function applyCssFile(file) {
    const rootNode = getRootNode();
    if (!rootNode) {
      return;
    }

    const content = typeof file.content === "string" ? file.content : "";
    const contentHash = hashString(content);

    let styleElement = findById(STYLE_ATTR, file.id);
    if (!styleElement) {
      styleElement = document.createElement("style");
      styleElement.setAttribute(STYLE_ATTR, file.id);
      rootNode.appendChild(styleElement);
    }

    if (styleElement.getAttribute(STYLE_HASH_ATTR) !== contentHash) {
      styleElement.textContent = content;
      styleElement.setAttribute(STYLE_HASH_ATTR, contentHash);
      logToPageConsole("info", `[mfci] CSS refreshed: ${file.id}`);
    }
  }

  /**
   * Inject one JS file as script tag and re-run only when content changed.
   * @param {any} file - Manifest or build file descriptor currently processed.
   * @returns {void} Injects one JS file in DOM when content changed.
   */
  function executeJsFile(file) {
    const rootNode = getRootNode();
    if (!rootNode) {
      return;
    }

    const content = typeof file.content === "string" ? file.content : "";
    const contentHash = hashString(content);

    if (executedScriptHashes.get(file.id) === contentHash) {
      return;
    }

    // Remove previous tag first to force browser re-evaluation when the content hash changes.
    removeJsFile(file.id);

    const scriptElement = document.createElement("script");
    scriptElement.setAttribute(SCRIPT_ATTR, file.id);
    scriptElement.setAttribute(SCRIPT_HASH_ATTR, contentHash);

    if (file.scriptType === "module") {
      scriptElement.type = "module";
    }

    const sourceUrl = typeof file.url === "string" && file.url.length > 0 ? file.url : "";
    if (!sourceUrl) {
      notifyScriptError(file.id, "Missing JavaScript URL.");
      return;
    }

    // Use a real script URL (not inline text/blob) to stay compatible with strict CSP policies.
    scriptElement.src = appendHashToUrl(sourceUrl, contentHash);
    scriptElement.async = false;

    scriptElement.addEventListener("error", () => {
      notifyScriptError(file.id, "Execution failed. Check CSP and local server availability.");
    });

    rootNode.appendChild(scriptElement);
    executedScriptHashes.set(file.id, contentHash);
    logToPageConsole("info", `[mfci] JS refreshed: ${file.id} (as ${file.scriptType || "script"})`);
  }

  /**
   * Remove an injected CSS file by id.
   * @param {any} fileId - Stable manifest file identifier (type:path).
   * @returns {void} Removes one injected CSS node by id.
   */
  function removeCssFile(fileId) {
    const styleElement = findById(STYLE_ATTR, fileId);
    if (styleElement) {
      styleElement.remove();
    }
  }

  /**
   * Remove an injected JS file by id and clear its execution hash.
   * @param {any} fileId - Stable manifest file identifier (type:path).
   * @returns {void} Removes injected JS nodes and execution cache for one id.
   */
  function removeJsFile(fileId) {
    for (const scriptElement of queryByAttribute(SCRIPT_ATTR)) {
      if (scriptElement.getAttribute(SCRIPT_ATTR) !== fileId) {
        continue;
      }

      removeScriptElement(scriptElement);
    }

    executedScriptHashes.delete(fileId);
  }

  /**
   * Remove stale injected assets no longer present in desired state.
   * @param {any} desiredCssIds - Set of CSS file IDs that must remain injected.
   * @param {any} desiredJsIds - Set of JS file IDs that must remain injected.
   * @returns {void} Removes injected assets not present in desired sets.
   */
  function cleanupFiles(desiredCssIds, desiredJsIds) {
    for (const styleElement of queryByAttribute(STYLE_ATTR)) {
      const fileId = styleElement.getAttribute(STYLE_ATTR);
      if (!desiredCssIds.has(fileId)) {
        styleElement.remove();
      }
    }

    for (const scriptElement of queryByAttribute(SCRIPT_ATTR)) {
      const fileId = scriptElement.getAttribute(SCRIPT_ATTR);
      if (!desiredJsIds.has(fileId)) {
        removeScriptElement(scriptElement);
        executedScriptHashes.delete(fileId);
      }
    }
  }

  /**
   * Apply full desired file state sent by background script to the current page.
   * @param {any} payload - Message or payload object exchanged between extension components.
   * @returns {void} Applies background sync payload to current page DOM.
   */
  function applyState(payload) {
    const files = Array.isArray(payload.files) ? payload.files : [];

    const desiredCssIds = new Set();
    const desiredJsIds = new Set();

    for (const file of files) {
      if (!file || typeof file.id !== "string") {
        continue;
      }

      // Keep desired IDs in sets first, then cleanup in one pass to avoid flickering removals.
      if (file.type === "css") {
        desiredCssIds.add(file.id);
        applyCssFile(file);
        continue;
      }

      if (file.type === "js") {
        desiredJsIds.add(file.id);
        executeJsFile(file);
      }
    }

    cleanupFiles(desiredCssIds, desiredJsIds);
  }

  /**
   * Periodically ping background script so it can keep/recover WebSocket connectivity without popup interaction.
   * @returns {void} Starts low-frequency keepalive pings.
   */
  function startBackgroundHeartbeat() {
    const sendHeartbeat = () => {
      try {
        chrome.runtime.sendMessage({ type: "MFCI_KEEPALIVE" }, () => {
          // Ignore closed-service-worker errors; next ping will wake and retry.
          void chrome.runtime.lastError;
        });
      } catch (_error) {
        // No-op
      }
    };

    sendHeartbeat();
    setInterval(sendHeartbeat, BACKGROUND_HEARTBEAT_MS);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }

    if (message.type === "MFCI_APPLY_STATE") {
      try {
        applyState(message);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error.message || error) });
      }

      return true;
    }

    if (message.type === "MFCI_BROWSER_LOG") {
      const level = typeof message.level === "string" ? message.level : "info";
      const logMessage = typeof message.message === "string" ? message.message : "[mfci] Event";
      logToPageConsole(level, logMessage);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  startBackgroundHeartbeat();
})();
