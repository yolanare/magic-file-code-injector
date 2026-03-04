(() => {
  const STYLE_ATTR = "data-mfci-style-id";
  const STYLE_HASH_ATTR = "data-mfci-style-hash";
  const SCRIPT_ATTR = "data-mfci-script-id";
  const SCRIPT_HASH_ATTR = "data-mfci-script-hash";

  const executedScriptHashes = new Map();

  function hashString(value) {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16);
  }

  function queryByAttribute(attributeName) {
    return Array.from(document.querySelectorAll(`[${attributeName}]`));
  }

  function getRootNode() {
    return document.head || document.documentElement || document.body;
  }

  function findById(attributeName, fileId) {
    return queryByAttribute(attributeName).find((element) => element.getAttribute(attributeName) === fileId) || null;
  }

  function removeScriptElement(scriptElement) {
    scriptElement.remove();
  }

  function appendHashToUrl(urlValue, contentHash) {
    try {
      const parsedUrl = new URL(urlValue, window.location.href);
      parsedUrl.searchParams.set("mfci_hash", contentHash);
      return parsedUrl.toString();
    } catch (_error) {
      return `${urlValue}${urlValue.includes("?") ? "&" : "?"}mfci_hash=${encodeURIComponent(contentHash)}`;
    }
  }

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

  function logToPageConsole(level, message, context) {
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    if (context && typeof context === "object") {
      console[method](message, context);
      return;
    }
    console[method](message);
  }

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
      logToPageConsole("info", `[MFCI] CSS refreshed: ${file.id}`, {
        path: file.path || "",
        url: file.url || "",
      });
    }
  }

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

    scriptElement.src = appendHashToUrl(sourceUrl, contentHash);
    scriptElement.async = false;

    scriptElement.addEventListener("error", () => {
      notifyScriptError(file.id, "Execution failed. Check CSP and local server availability.");
    });

    rootNode.appendChild(scriptElement);
    executedScriptHashes.set(file.id, contentHash);
    logToPageConsole("info", `[MFCI] JS refreshed: ${file.id}`, {
      path: file.path || "",
      url: sourceUrl,
      scriptType: file.scriptType || "script",
    });
  }

  function removeCssFile(fileId) {
    const styleElement = findById(STYLE_ATTR, fileId);
    if (styleElement) {
      styleElement.remove();
    }
  }

  function removeJsFile(fileId) {
    for (const scriptElement of queryByAttribute(SCRIPT_ATTR)) {
      if (scriptElement.getAttribute(SCRIPT_ATTR) !== fileId) {
        continue;
      }

      removeScriptElement(scriptElement);
    }

    executedScriptHashes.delete(fileId);
  }

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

  function applyState(payload) {
    const files = Array.isArray(payload.files) ? payload.files : [];

    const desiredCssIds = new Set();
    const desiredJsIds = new Set();

    for (const file of files) {
      if (!file || typeof file.id !== "string") {
        continue;
      }

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

    if (message.type === "MFCI_LOG_EVENT") {
      const level = typeof message.level === "string" ? message.level : "info";
      const logMessage = typeof message.message === "string" ? message.message : "[MFCI] Event";
      const context = message.context && typeof message.context === "object" ? message.context : undefined;
      logToPageConsole(level, logMessage, context);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();
