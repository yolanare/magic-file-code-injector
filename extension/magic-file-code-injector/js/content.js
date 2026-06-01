(() => {
  const STYLE_ATTR = "data-mfci-style-id";
  const STYLE_HASH_ATTR = "data-mfci-style-hash";
  const SCRIPT_ATTR = "data-mfci-script-id";
  const SCRIPT_HASH_ATTR = "data-mfci-script-hash";
  const BACKGROUND_HEARTBEAT_MS = 5000;
  const CONSOLE_LOG_STYLE = "color: #6080c6;";

  const executedScriptHashes = new Map();
  const pendingJsFiles = new Map();
  let pendingJsFlushScheduled = false;

  /**
   * Compute a stable content hash used to skip redundant CSS/JS reinjection.
   * @param {string} value - Source text to hash.
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
   * @param {string} attributeName - DOM attribute used as marker for injected assets.
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
   * @param {string} attributeName - DOM attribute used as marker for injected assets.
   * @param {string} fileId - Stable manifest file identifier (type:path).
   * @returns {Element|null} Previously injected node for a file id.
   */
  function findById(attributeName, fileId) {
    return queryByAttribute(attributeName).find((element) => element.getAttribute(attributeName) === fileId) || null;
  }

  /**
   * Append a cache-busting hash query parameter to force browser fetch refresh.
   * @param {string} urlValue - URL-like value to parse or normalize.
   * @param {string} contentHash - Hash used for cache-busting and change detection.
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
   * @param {string} fileId - Stable manifest file identifier (type:path).
   * @param {string} errorMessage - Human-readable error description sent to background diagnostics.
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
      // Error reporting is best effort; CSS/JS injection should not fail because diagnostics failed.
    }
  }

  /**
   * Return whether DOM parsing is ready enough for user scripts to run.
   * @returns {boolean} True once DOMContentLoaded has fired or is imminent.
   */
  function isDomReadyForJs() {
    return document.readyState === "interactive" || document.readyState === "complete";
  }

  /**
   * Log extension events into page console for developer feedback during live editing.
   * @param {"info"|"log"|"warn"|"error"} level - Log severity level used by page console bridge.
   * @param {string} message - Console message text.
   * @param {object} [context] - Structured log context appended to console events.
   * @returns {void} Writes a formatted log event to page console.
   */
  function logToPageConsole(level, message, context) {
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    const styledMessage = `%c${message}`;
    if (context && typeof context === "object") {
      console[method](styledMessage, CONSOLE_LOG_STYLE, context);
      return;
    }
    console[method](styledMessage, CONSOLE_LOG_STYLE);
  }

  /**
   * Format a stable list of injected file ids for concise page-load logs.
   * @param {string[]} fileIds - File IDs list.
   * @returns {string} Human-readable list.
   */
  function formatFileIdList(fileIds) {
    const uniqueIds = Array.from(new Set((Array.isArray(fileIds) ? fileIds : []).filter(Boolean)));
    if (uniqueIds.length === 0) {
      return "unknown file";
    }
    return uniqueIds.join(", ");
  }

  /**
   * Return whether one sync reason is part of initial/page-load application.
   * @param {string} syncReason - Sync reason used for diagnostics and message tracing.
   * @returns {boolean} True for initial load sync reasons.
   */
  function isLoadSyncReason(syncReason) {
    return syncReason === "content-ready-css" || syncReason === "content-ready-js" || syncReason === "tab-complete";
  }

  /**
   * Log one concise page-load injection summary per type.
   * @param {"css"|"js"} fileType - Injected file type.
   * @param {string[]} fileIds - File IDs injected or already present for this sync.
   * @param {string} syncReason - Sync reason used for diagnostics and message tracing.
   * @returns {void} Writes a summary log for load syncs only.
   */
  function logLoadInjectionSummary(fileType, fileIds, syncReason) {
    if (!isLoadSyncReason(syncReason) || fileIds.length === 0) {
      return;
    }

    const typeLabel = fileType === "js" ? "JS" : "CSS";
    logToPageConsole("info", `[mfci] ${typeLabel} loaded: ${formatFileIdList(fileIds)}`);
  }

  /**
   * Apply or refresh one CSS file in-place without full page reload.
   * @param {any} file - Manifest or build file descriptor currently processed.
   * @param {string} syncReason - Sync reason used for diagnostics and message tracing.
   * @returns {void} Applies or refreshes one CSS file in DOM.
   */
  function applyCssFile(file, syncReason) {
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
      return;
    }

    if (syncReason === "css-change") {
      logToPageConsole("info", `[mfci] CSS unchanged: ${file.id}`);
    }
  }

  /**
   * Inject one JS file as script tag and re-run only when content changed.
   * @param {any} file - Manifest or build file descriptor currently processed.
   * @param {{logRefresh?:boolean}} options - Logging options for load-sync versus hot-refresh flows.
   * @returns {boolean} True when a script element was injected.
   */
  function executeJsFile(file, options = {}) {
    const rootNode = getRootNode();
    if (!rootNode) {
      return false;
    }

    const content = typeof file.content === "string" ? file.content : "";
    const contentHash = hashString(content);

    if (executedScriptHashes.get(file.id) === contentHash) {
      return false;
    }

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
      return false;
    }

    // Real script URLs are more CSP-compatible than inline text or blob URLs on production pages.
    scriptElement.src = appendHashToUrl(sourceUrl, contentHash);
    scriptElement.async = false;

    scriptElement.addEventListener("error", () => {
      notifyScriptError(file.id, "Execution failed. Check CSP and local server availability.");
    });

    rootNode.appendChild(scriptElement);
    executedScriptHashes.set(file.id, contentHash);
    if (options.logRefresh !== false) {
      logToPageConsole("info", `[mfci] JS refreshed: ${file.id} (as ${file.scriptType || "script"})`);
    }
    return true;
  }

  /**
   * Execute queued JS files once DOM parsing is complete enough.
   * @returns {void} Flushes pending JS files when possible.
   */
  function flushPendingJsFiles() {
    if (!isDomReadyForJs()) {
      return;
    }

    const files = Array.from(pendingJsFiles.values());
    pendingJsFiles.clear();

    const loadedIds = [];
    for (const file of files) {
      executeJsFile(file, { logRefresh: false });
      loadedIds.push(file.id);
    }
    logLoadInjectionSummary("js", loadedIds, "content-ready-js");
  }

  /**
   * Queue JS during early page load so CSS can apply first and scripts run after DOM parsing.
   * @param {any} file - Manifest or build file descriptor currently processed.
   * @param {string} syncReason - Sync reason used for diagnostics and message tracing.
   * @returns {void} Queues or executes the JS file depending on DOM readiness.
   */
  function applyJsFile(file, syncReason) {
    if (isDomReadyForJs()) {
      executeJsFile(file, { logRefresh: !isLoadSyncReason(syncReason) });
      return;
    }

    pendingJsFiles.set(file.id, file);
    if (pendingJsFlushScheduled) {
      return;
    }

    pendingJsFlushScheduled = true;
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        pendingJsFlushScheduled = false;
        flushPendingJsFiles();
      },
      { once: true }
    );
  }

  /**
   * Remove an injected JS file by id and clear its execution hash.
   * @param {string} fileId - Stable manifest file identifier (type:path).
   * @returns {void} Removes injected JS nodes and execution cache for one id.
   */
  function removeJsFile(fileId) {
    pendingJsFiles.delete(fileId);

    for (const scriptElement of queryByAttribute(SCRIPT_ATTR)) {
      if (scriptElement.getAttribute(SCRIPT_ATTR) !== fileId) {
        continue;
      }

      scriptElement.remove();
    }

    executedScriptHashes.delete(fileId);
  }

  /**
   * Remove stale injected assets no longer present in desired state.
   * @param {Set<string>} desiredCssIds - Set of CSS file IDs that must remain injected.
   * @param {Set<string>} desiredJsIds - Set of JS file IDs that must remain injected.
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
        pendingJsFiles.delete(fileId);
        scriptElement.remove();
        executedScriptHashes.delete(fileId);
      }
    }

    for (const fileId of pendingJsFiles.keys()) {
      if (!desiredJsIds.has(fileId)) {
        pendingJsFiles.delete(fileId);
      }
    }
  }

  /**
   * Apply full desired file state sent by background script to the current page.
   * @param {object} payload - `MFCI_APPLY_STATE` payload from the background script.
   * @returns {void} Applies background sync payload to current page DOM.
   */
  function applyState(payload) {
    const files = Array.isArray(payload.files) ? payload.files : [];
    const syncReason = typeof payload.reason === "string" ? payload.reason : "";
    const isPartial = payload.partial === true;

    const desiredCssIds = new Set();
    const desiredJsIds = new Set();
    const loadedCssIds = [];
    const immediateJsIds = [];

    for (const file of files) {
      if (!file || typeof file.id !== "string") {
        continue;
      }

      // Keep desired IDs in sets first, then cleanup in one pass to avoid flickering removals.
      if (file.type === "css") {
        desiredCssIds.add(file.id);
        applyCssFile(file, syncReason);
        loadedCssIds.push(file.id);
        continue;
      }

      if (file.type === "js") {
        desiredJsIds.add(file.id);
        applyJsFile(file, syncReason);
        if (isDomReadyForJs()) {
          immediateJsIds.push(file.id);
        }
      }
    }

    logLoadInjectionSummary("css", loadedCssIds, syncReason);
    logLoadInjectionSummary("js", immediateJsIds, syncReason);

    if (isPartial) {
      // Partial sync applies only changed files and keeps existing injected state untouched.
      return;
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
        // The next interval can retry after Chrome recreates the extension context.
      }
    };

    sendHeartbeat();
    setInterval(sendHeartbeat, BACKGROUND_HEARTBEAT_MS);
  }

  /**
   * Ask background for the current state as soon as the content script starts.
   * @returns {void} Sends a best-effort initial sync request.
   */
  function requestInitialSync() {
    try {
      chrome.runtime.sendMessage({ type: "MFCI_CONTENT_READY" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // Initial sync is best effort; later heartbeat or popup interactions can recover.
    }
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

  requestInitialSync();
  startBackgroundHeartbeat();
})();
