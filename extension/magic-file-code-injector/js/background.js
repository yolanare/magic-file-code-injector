// Load pure helpers once so this service-worker file stays focused on side effects and orchestration.
importScripts("background-utils.js");
const {
  STORAGE_KEY,
  DEFAULT_HOST_STATE,
  uniqueStrings,
  normalizeHostState,
  normalizeState,
  getServerOrigin,
  getManifestUrl,
  normalizeChangedPath,
  inferFileTypeFromPath,
  normalizePathFromFileId,
  getHostKey,
  normalizeManifestFile,
  resolveFileUrl,
  formatRefreshLogMessage,
  sortedHostEntries,
  toOptionsHostState,
} = self.MfciBackgroundUtils;

let socketUrl = "";
let socketConnected = false;
let socketError = "";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const SOCKET_EVENT_BATCH_WINDOW_MS = 150;
const FETCH_TIMEOUT_MS = 5000;
const TAB_MESSAGE_TIMEOUT_MS = 3000;
const TAB_RELOAD_TIMEOUT_MS = 3000;
const RUNTIME_MESSAGE_TIMEOUT_MS = 3000;
const SOCKET_EVENT_BATCH_MAX_RUNTIME_MS = 10000;

let offscreenCreatePromise = null;
let initialLoadSyncedTabIds = new Set();
let pendingSocketEvents = [];
let socketBatchTimer = null;
let socketBatchInFlight = false;
let socketBatchStartedAt = 0;
let socketBatchGeneration = 0;

/**
 * Promisify chrome.storage.get for easier async flow handling.
 * @param {any} key - Storage key to read from chrome local storage.
 * @returns {Promise<any>} Stored value for the requested key.
 */
function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(result[key]);
    });
  });
}

/**
 * Promisify chrome.storage.set for easier async flow handling.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @returns {Promise<void>} Resolves when write succeeds.
 */
function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * Promisify chrome.tabs.query to compose tab operations with async/await.
 * @param {any} queryInfo - Chrome tabs query descriptor.
 * @returns {Promise<chrome.tabs.Tab[]>} Matching tabs list.
 */
function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

/**
 * Promisify chrome.tabs.get to retrieve tab context safely.
 * @param {any} tabId - Chrome tab identifier to target.
 * @returns {Promise<chrome.tabs.Tab>} Tab descriptor.
 */
function tabGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(tab);
    });
  });
}

/**
 * Send a message to content script and normalize runtime errors into a result object.
 * @param {any} tabId - Chrome tab identifier to target.
 * @param {any} payload - Message or payload object exchanged between extension components.
 * @returns {Promise<{ok:boolean,error?:string}>} Message delivery result.
 */
function tabSendMessage(tabId, payload) {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: false, error: `tabs.sendMessage timeout after ${TAB_MESSAGE_TIMEOUT_MS}ms.`, timeout: true });
    }, TAB_MESSAGE_TIMEOUT_MS);

    chrome.tabs.sendMessage(tabId, payload, () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);

      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        resolve({ ok: false, error: runtimeError.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}

/**
 * Send a plain browser-console log event to one tab through content script bridge.
 * @param {any} tabId - Chrome tab identifier to target.
 * @param {"info"|"warn"|"error"} level - Log severity for page console.
 * @param {string} message - Human-readable log line.
 * @returns {Promise<void>} Resolves after best-effort message delivery.
 */
async function logToBrowserTabConsole(tabId, level, message) {
  await tabSendMessage(tabId, {
    type: "MFCI_BROWSER_LOG",
    level,
    message,
  });
}

/**
 * Promisify tab reload so JS auto-refresh flows can await completion triggers.
 * @param {any} tabId - Chrome tab identifier to target.
 * @returns {Promise<void>} Resolves once reload command is accepted.
 */
function tabReload(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`tabs.reload timeout after ${TAB_RELOAD_TIMEOUT_MS}ms.`));
    }, TAB_RELOAD_TIMEOUT_MS);

    chrome.tabs.reload(tabId, () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);

      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * Small timing helper used to sequence reload actions.
 * @param {any} ms - Delay duration in milliseconds.
 * @returns {Promise<void>} Resolves after the requested delay.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Send a runtime message with a hard timeout so popup/background flows cannot hang.
 * @param {any} message - Runtime message payload.
 * @param {number} timeoutMs - Timeout duration in milliseconds.
 * @returns {Promise<any>} Response from the receiving extension context.
 */
function runtimeSendMessage(message, timeoutMs = RUNTIME_MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`runtime.sendMessage timeout after ${timeoutMs}ms.`));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);

      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Fetch with a hard timeout so a stalled local request cannot block future refresh batches.
 * @param {string} url - Absolute URL to request.
 * @param {RequestInit} options - Fetch options.
 * @param {number} timeoutMs - Timeout duration in milliseconds.
 * @param {string} label - Human-readable request name for errors.
 * @returns {Promise<Response>} Fetch response.
 */
async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Load and normalize persisted extension state from local storage.
 * @returns {Promise<object>} Normalized state loaded from storage.
 */
async function loadState() {
  const rawState = await storageGet(STORAGE_KEY);
  return normalizeState(rawState);
}

/**
 * Persist normalized extension state to local storage.
 * @param {any} state - Full normalized extension state object.
 * @returns {Promise<void>} Resolves when state is persisted.
 */
async function saveState(state) {
  await storageSet({ [STORAGE_KEY]: normalizeState(state) });
}

/**
 * Return mutable host state, creating defaults when host is seen for the first time.
 * @param {any} state - Full normalized extension state object.
 * @param {any} hostKey - Domain key used to isolate per-site settings.
 * @returns {object} Mutable host state instance.
 */
function getOrCreateHostState(state, hostKey) {
  if (!state.hosts[hostKey]) {
    state.hosts[hostKey] = { ...DEFAULT_HOST_STATE };
  }

  return state.hosts[hostKey];
}

/**
 * Return read-safe host state used by UI even when host has no stored config.
 * @param {any} state - Full normalized extension state object.
 * @param {any} hostKey - Domain key used to isolate per-site settings.
 * @returns {object} Safe host state snapshot for reads.
 */
function getExistingHostState(state, hostKey) {
  if (!hostKey) {
    return { ...DEFAULT_HOST_STATE };
  }

  return state.hosts[hostKey] ? normalizeHostState(state.hosts[hostKey]) : { ...DEFAULT_HOST_STATE };
}

/**
 * Fetch and normalize the current manifest published by the local dev server.
 * @param {any} globalState - Global server settings stored by the extension.
 * @returns {Promise<object>} Manifest with normalized file descriptors.
 */
async function fetchManifest(globalState) {
  const manifestUrl = getManifestUrl(globalState);
  const response = await fetchWithTimeout(manifestUrl, { cache: "no-store" }, FETCH_TIMEOUT_MS, "Manifest request");

  if (!response.ok) {
    throw new Error(`Manifest request failed (${response.status}).`);
  }

  const payload = await response.json();
  const files = Array.isArray(payload.files) ? payload.files.map(normalizeManifestFile).filter(Boolean) : [];

  return {
    origin: getServerOrigin(globalState),
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : "",
    files,
  };
}

/**
 * Fetch file source text for CSS/JS injection payloads.
 * @param {any} url - Absolute URL to fetch.
 * @returns {Promise<string>} Raw file content.
 */
async function fetchFileText(url) {
  const response = await fetchWithTimeout(url, { cache: "no-store" }, FETCH_TIMEOUT_MS, "File request");

  if (!response.ok) {
    throw new Error(`Unable to read ${url} (${response.status}).`);
  }

  return response.text();
}

/**
 * Build the exact payload needed to synchronize one tab with current enabled files.
 * @param {any} state - Full normalized extension state object.
 * @param {any} hostKey - Domain key used to isolate per-site settings.
 * @param {any} hostState - Per-site configuration including enabled files and JS refresh mode.
 * @param {any} options - Optional sync filters used for partial update delivery.
 * @returns {Promise<object>} Payload sent to content script for tab sync.
 */
async function buildSyncPayload(state, hostKey, hostState, options = {}) {
  const manifest = await fetchManifest(state.global);
  const injectionEnabled = state.global.injectionEnabled !== false;

  // Only ship currently enabled files to content scripts to keep injection minimal.
  const activeManifestFiles = manifest.files.filter((file) => hostState.enabledFileIds.includes(file.id));
  const requestedFileIds = uniqueStrings(Array.isArray(options.fileIds) ? options.fileIds : []);
  const requestedSet = new Set(requestedFileIds);
  const requestedFileTypes = uniqueStrings(Array.isArray(options.fileTypes) ? options.fileTypes : []).filter(
    (fileType) => fileType === "css" || fileType === "js"
  );
  const requestedTypeSet = new Set(requestedFileTypes);
  const hasFileIdFilter = requestedSet.size > 0;
  const hasFileTypeFilter = requestedTypeSet.size > 0;
  const isPartialRequest = hasFileIdFilter || hasFileTypeFilter;
  const isPartial = injectionEnabled ? isPartialRequest : false;
  const filesToSync =
    injectionEnabled ?
      isPartialRequest ?
        activeManifestFiles.filter(
          (file) => (!hasFileIdFilter || requestedSet.has(file.id)) && (!hasFileTypeFilter || requestedTypeSet.has(file.type))
        )
      : activeManifestFiles
    : [];

  const files = [];
  for (const file of filesToSync) {
    const url = resolveFileUrl(file, manifest.origin);
    const content = await fetchFileText(url);

    files.push({
      ...file,
      url,
      content,
    });
  }

  return {
    hostKey,
    files,
    partial: isPartial,
    manifestGeneratedAt: manifest.generatedAt,
    pendingJsUpdateIds: hostState.pendingJsUpdateIds,
  };
}

/**
 * Return current active tab in the focused window.
 * @returns {Promise<chrome.tabs.Tab|null>} Active tab or null when unavailable.
 */
async function getActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  return tabs.length > 0 ? tabs[0] : null;
}

/**
 * Synchronize one tab with current host configuration and manifest content.
 * @param {any} tabId - Chrome tab identifier to target.
 * @param {any} reason - Sync reason used for diagnostics and message tracing.
 * @param {any} options - Optional sync filters used for partial update delivery.
 * @returns {Promise<boolean>} True when sync payload is delivered to content script.
 */
async function syncTab(tabId, reason, options = {}) {
  let tab;
  try {
    tab = await tabGet(tabId);
  } catch (_error) {
    return false;
  }

  const hostKey = tab && tab.url ? getHostKey(tab.url) : null;
  if (!hostKey) {
    return false;
  }

  const state = await loadState();
  const hasStoredHostState = Boolean(state.hosts[hostKey]);
  const hostState = hasStoredHostState ? normalizeHostState(state.hosts[hostKey]) : { ...DEFAULT_HOST_STATE };

  try {
    const payload = await buildSyncPayload(state, hostKey, hostState, options);
    if (hasStoredHostState) {
      // Keep error state clean once a successful sync occurred for this host.
      state.hosts[hostKey].lastError = "";
      await saveState(state);
    }

    const delivery = await tabSendMessage(tabId, {
      type: "MFCI_APPLY_STATE",
      reason,
      ...payload,
    });
    return delivery.ok === true;
  } catch (error) {
    if (hasStoredHostState) {
      state.hosts[hostKey].lastError = String(error.message || error);
      await saveState(state);
    }
    return false;
  }
}

/**
 * Clear deferred JS update markers once a page reload applied them.
 * @param {any} hostKey - Domain key used to isolate per-site settings.
 * @returns {Promise<void>} Completes after pending JS markers are cleared.
 */
async function clearPendingUpdatesForHost(hostKey) {
  const state = await loadState();
  const hostState = state.hosts[hostKey];

  if (!hostState || hostState.pendingJsUpdateIds.length === 0) {
    return;
  }

  hostState.pendingJsUpdateIds = [];
  await saveState(state);
}

/**
 * Convenience helper to sync active tab after UI-driven setting changes.
 * @param {any} reason - Sync reason used for diagnostics and message tracing.
 * @returns {Promise<void>} Completes after active tab sync attempt.
 */
async function applyToCurrentTab(reason) {
  const activeTab = await getActiveTab();
  if (!activeTab || typeof activeTab.id !== "number") {
    return;
  }

  await syncTab(activeTab.id, reason);
}

/**
 * Synchronize all regular web tabs to apply global extension state changes immediately.
 * @param {any} reason - Sync reason used for diagnostics and message tracing.
 * @returns {Promise<void>} Completes after best-effort sync across all tabs.
 */
async function applyToAllTabs(reason) {
  const tabs = await tabsQuery({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (typeof tab.id !== "number") {
      continue;
    }
    await syncTab(tab.id, reason);
  }
}

/**
 * Apply global-enable refresh using the same per-type behavior as LiveReload events.
 * CSS updates are synced in place; JS triggers full reload only when auto-refresh is enabled.
 * @param {any} state - Full normalized extension state object.
 * @returns {Promise<void>} Completes after best-effort refresh dispatch.
 */
async function applyGlobalEnableWithRefreshFlow(state) {
  let manifest = null;
  try {
    manifest = await fetchManifest(state.global);
  } catch (_error) {
    manifest = null;
  }

  const manifestTypeById = new Map((manifest ? manifest.files : []).map((file) => [file.id, file.type]));
  const tabs = await tabsQuery({ url: ["http://*/*", "https://*/*"] });
  let stateChanged = false;

  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !tab.url) {
      continue;
    }

    const hostKey = getHostKey(tab.url);
    if (!hostKey) {
      continue;
    }

    const hostState = state.hosts[hostKey];
    if (!hostState || hostState.enabledFileIds.length === 0) {
      continue;
    }

    const cssFileIds = [];
    const jsFileIds = [];

    for (const fileId of hostState.enabledFileIds) {
      const typeFromManifest = manifestTypeById.get(fileId);
      const typeFromId = fileId.startsWith("css:") ? "css" : fileId.startsWith("js:") ? "js" : "";
      const fileType = typeFromManifest || typeFromId;

      if (fileType === "css") {
        cssFileIds.push(fileId);
        continue;
      }

      if (fileType === "js") {
        jsFileIds.push(fileId);
      }
    }

    if (cssFileIds.length > 0) {
      const synced = await syncTab(tab.id, "css-change", { fileIds: cssFileIds });
      if (synced) {
        await logToBrowserTabConsole(tab.id, "info", formatRefreshLogMessage("css", cssFileIds, false));
      }
    }

    if (jsFileIds.length === 0) {
      continue;
    }

    if (!hostState.autoRefreshJs) {
      for (const pendingId of jsFileIds) {
        if (!hostState.pendingJsUpdateIds.includes(pendingId)) {
          hostState.pendingJsUpdateIds.push(pendingId);
          stateChanged = true;
        }
      }
      continue;
    }

    // Full reload is required for JS because script tags can have side effects not safely hot-swappable.
    await delay(50);
    await tabReload(tab.id).catch(() => {});
    await logToBrowserTabConsole(tab.id, "info", formatRefreshLogMessage("js", jsFileIds, true));
  }

  if (stateChanged) {
    await saveState(state);
  }
}

/**
 * Build popup view-model with host state, manifest state and server connectivity status.
 * @returns {Promise<object>} Popup-ready view model.
 */
async function buildPopupModel() {
  const state = await loadState();
  const activeTab = await getActiveTab();

  const hostKey = activeTab && activeTab.url ? getHostKey(activeTab.url) : null;
  const hostState = getExistingHostState(state, hostKey);

  let manifest = null;
  let serverError = "";

  try {
    const fetchedManifest = await fetchManifest(state.global);
    manifest = {
      generatedAt: fetchedManifest.generatedAt,
      files: fetchedManifest.files,
    };
  } catch (error) {
    serverError = String(error.message || error);
  }

  return {
    ok: true,
    tabId: activeTab && typeof activeTab.id === "number" ? activeTab.id : null,
    hostKey,
    global: state.global,
    hostState,
    manifest,
    server: {
      origin: getServerOrigin(state.global),
      websocketConnected: socketConnected,
      websocketError: socketError,
      error: serverError,
    },
  };
}

/**
 * Build options view-model with server info and all saved host settings.
 * @returns {Promise<object>} Options page view model.
 */
async function buildOptionsModel() {
  const state = await loadState();
  const entries = sortedHostEntries(state.hosts);

  const hosts = {};
  for (const [hostKey, hostState] of entries) {
    hosts[hostKey] = toOptionsHostState(hostState);
  }

  return {
    ok: true,
    global: state.global,
    hosts,
    server: {
      origin: getServerOrigin(state.global),
      websocketConnected: socketConnected,
      websocketError: socketError,
    },
  };
}

/**
 * Mirror extension runtime logs to page consoles so developers can see them in regular DevTools.
 * @param {"log"|"warn"|"error"} level - Log severity for console output.
 * @param {string} message - Human-readable log message.
 * @returns {void} Writes log in service worker and broadcasts to web-page consoles.
 */
function logToBrowserConsole(level, message) {
  const method = level === "warn" ? "warn" : level === "error" ? "error" : "log";
  console[method](message);

  tabsQuery({ url: ["http://*/*", "https://*/*"] })
    .then((tabs) => Promise.all(
      tabs
        .filter((tab) => typeof tab.id === "number")
        .map((tab) =>
          tabSendMessage(tab.id, {
            type: "MFCI_BROWSER_LOG",
            level,
            message,
          })
        )
    ))
    .catch(() => {});
}

/**
 * Read whether the offscreen LiveReload context already exists.
 * @returns {Promise<boolean>} True when an offscreen document is available.
 */
async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }

  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  return false;
}

/**
 * Create the offscreen document that owns the long-lived WebSocket.
 * @returns {Promise<boolean>} True when offscreen ownership is ready.
 */
async function ensureOffscreenDocument() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    socketConnected = false;
    socketError = "Offscreen documents are not supported by this browser.";
    return false;
  }

  if (await hasOffscreenDocument()) {
    return true;
  }

  if (!offscreenCreatePromise) {
    offscreenCreatePromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason?.IFRAME_SCRIPTING || "IFRAME_SCRIPTING"],
        justification: "Keep the local LiveReload WebSocket alive while the extension service worker sleeps.",
      })
      .then(() => true)
      .catch((error) => {
        socketConnected = false;
        socketError = String(error.message || error);
        return false;
      })
      .finally(() => {
        offscreenCreatePromise = null;
      });
  }

  return offscreenCreatePromise;
}

/**
 * Drop the current offscreen document so a broken message bridge can be rebuilt.
 * @returns {Promise<void>} Completes after best-effort offscreen cleanup.
 */
async function closeOffscreenDocument() {
  if (chrome.offscreen && chrome.offscreen.closeDocument && (await hasOffscreenDocument())) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

/**
 * Update the service-worker snapshot exposed in popup/options UI.
 * @param {any} message - Offscreen status message.
 * @returns {void} Updates current connection state.
 */
function updateSocketStatus(message) {
  socketConnected = message.connected === true;
  socketError = typeof message.error === "string" ? message.error : "";
  socketUrl = typeof message.url === "string" ? message.url : socketUrl;
}

/**
 * Ask the offscreen document to own or refresh the LiveReload WebSocket.
 * @param {any} options - Optional connection context (startup/manual/reconnect).
 * @returns {Promise<void>} Completes after the offscreen context acknowledged the request.
 */
async function connectSocket(options = {}) {
  const reason = typeof options.reason === "string" ? options.reason : "auto";
  const forceReconnect = options.forceReconnect === true;
  const state = await loadState();
  const nextSocketUrl = `ws://${state.global.host}:${state.global.port}/livereload`;

  socketUrl = nextSocketUrl;

  if (!(await ensureOffscreenDocument())) {
    return;
  }

  const connectMessage = {
    type: "MFCI_OFFSCREEN_CONNECT",
    target: "offscreen",
    url: nextSocketUrl,
    reason,
    forceReconnect,
  };

  let response;
  try {
    response = await runtimeSendMessage(connectMessage);
  } catch (_error) {
    await closeOffscreenDocument();
    if (!(await ensureOffscreenDocument())) {
      return;
    }
    await delay(50);
    response = await runtimeSendMessage(connectMessage);
  }

  if (response && typeof response === "object") {
    updateSocketStatus(response);
  }
}

/**
 * Keep offscreen WebSocket ownership alive after service-worker wakeups.
 * @param {any} options - Keepalive context from tab/content events.
 * @returns {Promise<void>} Ensures the offscreen context has the current socket URL.
 */
async function ensureSocketConnection(options = {}) {
  const trigger = typeof options.trigger === "string" ? options.trigger : "keepalive";
  await connectSocket({ reason: trigger === "tab-complete" ? "startup" : "keepalive" });
}

/**
 * Parse one LiveReload payload into a normalized refresh event queued for batch processing.
 * @param {any} payload - Parsed WebSocket payload emitted by LiveReload server.
 * @returns {{fileType:"css"|"js",fileId:string,normalizedChangedPath:string}|null} Normalized refresh event.
 */
function parseSocketRefreshEvent(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (payload.type === "file-changed") {
    const fileType = payload.fileType === "css" || payload.fileType === "js" ? payload.fileType : "";
    if (!fileType) {
      return null;
    }

    return {
      fileType,
      fileId: typeof payload.fileId === "string" ? payload.fileId : "",
      normalizedChangedPath: "",
    };
  }

  if (payload.command !== "reload") {
    return null;
  }

  const changedPath = typeof payload.path === "string" ? payload.path : "";
  const fileType = inferFileTypeFromPath(changedPath);
  if (!fileType) {
    return null;
  }

  return {
    fileType,
    fileId: "",
    normalizedChangedPath: normalizeChangedPath(changedPath),
  };
}

/**
 * Resolve the file id for one socket event using the current manifest when path-only events are received.
 * @param {{fileType:"css"|"js",fileId:string,normalizedChangedPath:string}} event - Normalized refresh event.
 * @param {any} manifest - Latest manifest payload fetched from dev server.
 * @returns {{fileType:"css"|"js",fileId:string,normalizedChangedPath:string}} Event with best-effort resolved file id.
 */
function resolveSocketEventFileId(event, manifest) {
  if (event.fileId || !manifest || !event.normalizedChangedPath) {
    return event;
  }

  for (const candidate of manifest.files) {
    if (candidate.type !== event.fileType) {
      continue;
    }

    const normalizedManifestPath = normalizeChangedPath(candidate.path);
    if (
      event.normalizedChangedPath === normalizedManifestPath ||
      event.normalizedChangedPath.endsWith(normalizedManifestPath)
    ) {
      return {
        ...event,
        fileId: candidate.id,
      };
    }
  }

  return event;
}

/**
 * Resolve which enabled file ids are affected for one host by one refresh event.
 * @param {any} hostState - Per-site configuration including enabled files and JS refresh mode.
 * @param {{fileType:"css"|"js",fileId:string,normalizedChangedPath:string}} event - Normalized refresh event.
 * @param {Map<string,string>} manifestTypeById - Manifest type lookup keyed by file id.
 * @returns {string[]} Enabled file ids impacted by the event for this host.
 */
function getAffectedIdsForHostEvent(hostState, event, manifestTypeById) {
  if (event.fileId) {
    return hostState.enabledFileIds.includes(event.fileId) ? [event.fileId] : [];
  }

  if (!event.normalizedChangedPath) {
    return [];
  }

  let enabledIdsForType = hostState.enabledFileIds.filter((enabledId) => {
    if (enabledId.startsWith(`${event.fileType}:`)) {
      return true;
    }

    return manifestTypeById.get(enabledId) === event.fileType;
  });

  // Prefer path-based matching to avoid refreshing unrelated enabled files of the same type.
  const matchedByPath = enabledIdsForType.filter((enabledId) => {
    const normalizedEnabledPath = normalizePathFromFileId(enabledId);
    return (
      event.normalizedChangedPath === normalizedEnabledPath ||
      event.normalizedChangedPath.endsWith(normalizedEnabledPath)
    );
  });

  return matchedByPath;
}

/**
 * Queue a delayed flush to group multiple socket events saved within a short window.
 * @returns {void} Schedules one batch processing pass.
 */
function scheduleSocketEventFlush() {
  if (socketBatchInFlight) {
    const batchAgeMs = socketBatchStartedAt ? Date.now() - socketBatchStartedAt : 0;
    if (socketBatchStartedAt && batchAgeMs < SOCKET_EVENT_BATCH_MAX_RUNTIME_MS) {
      return;
    }

    socketBatchGeneration += 1;
    socketBatchInFlight = false;
    socketBatchStartedAt = 0;
  }

  if (socketBatchTimer) {
    clearTimeout(socketBatchTimer);
  }

  socketBatchTimer = setTimeout(() => {
    socketBatchTimer = null;
    void flushSocketEventBatch();
  }, SOCKET_EVENT_BATCH_WINDOW_MS);
}

/**
 * Process queued socket events as one batch and apply one aggregated refresh per tab/file type.
 * @returns {Promise<void>} Completes after tab sync/reload actions are dispatched.
 */
async function flushSocketEventBatch() {
  if (socketBatchInFlight || pendingSocketEvents.length === 0) {
    return;
  }

  socketBatchInFlight = true;
  socketBatchStartedAt = Date.now();
  socketBatchGeneration += 1;
  const batchGeneration = socketBatchGeneration;

  const events = pendingSocketEvents;
  pendingSocketEvents = [];

  try {
    const state = await loadState();
    if (state.global.injectionEnabled === false) {
      return;
    }

    const needManifest = events.some((event) => !event.fileId || event.normalizedChangedPath);

    let manifest = null;
    if (needManifest) {
      try {
        manifest = await fetchManifest(state.global);
      } catch (_error) {
        manifest = null;
      }
    }

    const resolvedEvents = uniqueStrings(
      events
        .map((event) => resolveSocketEventFileId(event, manifest))
        .filter((event) => event.fileType === "css" || event.fileType === "js")
        .map((event) => `${event.fileType}|${event.fileId}|${event.normalizedChangedPath}`)
    ).map((key) => {
      const [fileType, fileId, normalizedChangedPath] = key.split("|");
      return {
        fileType,
        fileId,
        normalizedChangedPath,
      };
    });

    if (resolvedEvents.length === 0) {
      return;
    }

    const tabs = await tabsQuery({ url: ["http://*/*", "https://*/*"] });
    const manifestTypeById = new Map((manifest ? manifest.files : []).map((file) => [file.id, file.type]));
    let stateChanged = false;

    for (const tab of tabs) {
      if (typeof tab.id !== "number" || !tab.url) {
        continue;
      }

      const hostKey = getHostKey(tab.url);
      if (!hostKey) {
        continue;
      }

      const hostState = state.hosts[hostKey];
      if (!hostState) {
        continue;
      }

      const affectedIdsByType = {
        css: new Set(),
        js: new Set(),
      };

      for (const event of resolvedEvents) {
        const affectedIds = getAffectedIdsForHostEvent(hostState, event, manifestTypeById);
        for (const affectedId of affectedIds) {
          affectedIdsByType[event.fileType].add(affectedId);
        }
      }

      for (const fileType of ["css", "js"]) {
        const affectedIds = Array.from(affectedIdsByType[fileType]);
        if (affectedIds.length === 0) {
          continue;
        }

        if (fileType === "css") {
          const synced = await syncTab(tab.id, "css-change", { fileIds: affectedIds });
          if (synced) {
            await logToBrowserTabConsole(tab.id, "info", formatRefreshLogMessage("css", affectedIds, false));
          }
          continue;
        }

        if (!hostState.autoRefreshJs) {
          for (const pendingId of affectedIds) {
            if (!hostState.pendingJsUpdateIds.includes(pendingId)) {
              hostState.pendingJsUpdateIds.push(pendingId);
              stateChanged = true;
            }
          }
          continue;
        }

        // Full reload is required for JS because script tags can have side effects not safely hot-swappable.
        await delay(50);
        await tabReload(tab.id).catch(() => {});
        await logToBrowserTabConsole(tab.id, "info", formatRefreshLogMessage("js", affectedIds, true));
      }
    }

    if (stateChanged) {
      await saveState(state);
    }
  } finally {
    if (batchGeneration !== socketBatchGeneration) {
      return;
    }

    socketBatchInFlight = false;
    socketBatchStartedAt = 0;
    if (pendingSocketEvents.length > 0) {
      scheduleSocketEventFlush();
    }
  }
}

/**
 * Parse and queue one raw LiveReload message; real refresh actions run in batched flushes.
 * @param {any} rawMessage - Raw WebSocket message payload from LiveReload server.
 * @returns {void} Adds supported events to batch queue.
 */
function handleSocketMessage(rawMessage) {
  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch (_error) {
    return;
  }

  const event = parseSocketRefreshEvent(payload);
  if (!event) {
    return;
  }

  pendingSocketEvents.push(event);
  scheduleSocketEventFlush();
}

/**
 * Persist enabled files for a host and re-sync impacted tab(s).
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @returns {Promise<object>} Mutation result for enabled file settings.
 */
async function updateHostFileSelection(message) {
  const state = await loadState();
  const hostState = getOrCreateHostState(state, message.hostKey);

  hostState.enabledFileIds = uniqueStrings(Array.isArray(message.enabledFileIds) ? message.enabledFileIds : []);
  hostState.pendingJsUpdateIds = hostState.pendingJsUpdateIds.filter((fileId) => hostState.enabledFileIds.includes(fileId));

  await saveState(state);

  let synced = false;
  if (typeof message.tabId === "number") {
    synced = await syncTab(message.tabId, "selection-change");
  }

  if (!synced) {
    // Fallback to currently active tab to keep CSS/JS toggle behavior immediate from popup.
    await applyToCurrentTab("selection-change");
  }

  return { ok: true };
}

/**
 * Persist JS auto-refresh preference for one host.
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @returns {Promise<object>} Mutation result for auto-refresh setting.
 */
async function updateAutoRefresh(message) {
  const state = await loadState();
  const hostState = getOrCreateHostState(state, message.hostKey);

  hostState.autoRefreshJs = message.autoRefreshJs === true;
  await saveState(state);

  return { ok: true };
}

/**
 * Persist the global injection toggle.
 * - Disable: remove injected assets immediately on all tabs.
 * - Enable: apply refresh flow by type (CSS partial sync, JS reload only when auto-refresh is enabled).
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @returns {Promise<object>} Mutation result for global injection setting.
 */
async function updateGlobalInjectionEnabled(message) {
  const nextValue = message.injectionEnabled === true;
  const state = await loadState();

  state.global.injectionEnabled = nextValue;
  await saveState(state);

  if (!nextValue) {
    await applyToAllTabs("global-injection-disabled");
    return { ok: true };
  }

  await applyGlobalEnableWithRefreshFlow(state);

  return { ok: true };
}

/**
 * Update global server port, reconnect socket and resync active tab.
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @returns {Promise<object>} Mutation result for global port setting.
 */
async function updatePort(message) {
  const parsedPort = Number(message.port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return {
      ok: false,
      error: "Port must be a number between 1 and 65535.",
    };
  }

  const state = await loadState();
  state.global.port = parsedPort;
  await saveState(state);

  await connectSocket({ reason: "manual" });
  await applyToCurrentTab("port-change");

  return { ok: true };
}

/**
 * Delete one host configuration and resync matching open tabs.
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @returns {Promise<object>} Mutation result for host settings deletion.
 */
async function deleteHostSettings(message) {
  const hostKey = typeof message.hostKey === "string" ? message.hostKey.trim() : "";
  if (!hostKey) {
    return { ok: false, error: "Host key is required." };
  }

  const state = await loadState();
  if (!state.hosts[hostKey]) {
    return { ok: true };
  }

  delete state.hosts[hostKey];
  await saveState(state);

  const tabs = await tabsQuery({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !tab.url) {
      continue;
    }

    if (getHostKey(tab.url) !== hostKey) {
      continue;
    }

    await syncTab(tab.id, "host-settings-deleted");
  }

  return { ok: true };
}

/**
 * Store and expose last injection error per host for UI diagnostics.
 * @param {any} sender - Chrome message sender used to infer source tab/host.
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @returns {Promise<object>} Mutation result for host error state update.
 */
async function recordInjectionError(sender, message) {
  if (!sender || !sender.tab || !sender.tab.url) {
    return { ok: true };
  }

  const hostKey = getHostKey(sender.tab.url);
  if (!hostKey) {
    return { ok: true };
  }

  const fileId = typeof message.fileId === "string" ? message.fileId : "unknown";
  const errorMessage = typeof message.error === "string" ? message.error : "Unknown script error.";

  const state = await loadState();
  const hostState = getOrCreateHostState(state, hostKey);
  hostState.lastError = `${fileId}: ${errorMessage}`;
  await saveState(state);

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.target === "offscreen") {
    return false;
  }

  (async () => {
    switch (message && message.type) {
      case "POPUP_GET_MODEL":
        return buildPopupModel();
      case "OPTIONS_GET_MODEL":
        return buildOptionsModel();
      case "POPUP_SET_ENABLED_FILES":
        return updateHostFileSelection(message);
      case "POPUP_SET_AUTO_REFRESH_JS":
        return updateAutoRefresh(message);
      case "POPUP_SET_GLOBAL_INJECTION":
        return updateGlobalInjectionEnabled(message);
      case "POPUP_SET_PORT":
      case "OPTIONS_SET_PORT":
        return updatePort(message);
      case "OPTIONS_DELETE_HOST":
        return deleteHostSettings(message);
      case "MFCI_OFFSCREEN_SOCKET_STATUS":
        updateSocketStatus(message);
        return { ok: true };
      case "MFCI_OFFSCREEN_SOCKET_MESSAGE":
        handleSocketMessage(message.data);
        return { ok: true };
      case "MFCI_OFFSCREEN_LOG":
        logToBrowserConsole(message.level, message.message);
        return { ok: true };
      case "POPUP_OPENED":
        await connectSocket({ reason: "keepalive" }).catch((error) => {
          socketConnected = false;
          socketError = String(error.message || error);
        });
        await applyToCurrentTab("popup-open");
        return { ok: true };
      case "POPUP_FORCE_SYNC":
        // Manual refresh should also force a new WebSocket connection attempt.
        await connectSocket({ reason: "manual", forceReconnect: true }).catch((error) => {
          socketConnected = false;
          socketError = String(error.message || error);
        });
        await applyToCurrentTab("manual-sync");
        return { ok: true };
      case "MFCI_KEEPALIVE":
        // Keepalive actively repairs dropped WebSocket sessions without popup interaction.
        await ensureSocketConnection({ trigger: "keepalive" });
        return { ok: true };
      case "MFCI_CONTENT_READY":
        ensureSocketConnection({ trigger: "content-ready" }).catch(() => {});
        if (sender && sender.tab && typeof sender.tab.id === "number") {
          if (initialLoadSyncedTabIds.has(sender.tab.id)) {
            return { ok: true };
          }

          initialLoadSyncedTabIds.add(sender.tab.id);
          const hostKey = getHostKey(sender.tab.url || "");
          if (hostKey) {
            await clearPendingUpdatesForHost(hostKey);
          }

          const cssSynced = await syncTab(sender.tab.id, "content-ready-css", { fileTypes: ["css"] });
          const jsSynced = await syncTab(sender.tab.id, "content-ready-js", { fileTypes: ["js"] });
          return { ok: cssSynced || jsSynced };
        }
        return { ok: false, error: "Missing sender tab." };
      case "MFCI_JS_INJECTION_ERROR":
        return recordInjectionError(sender, message);
      default:
        return { ok: false, error: "Unknown message type." };
    }
  })()
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    initialLoadSyncedTabIds.delete(tabId);
    return;
  }

  if (changeInfo.status !== "complete") {
    return;
  }

  (async () => {
    // Read tab again to avoid missing URL snapshots from the onUpdated payload.
    const latestTab = await tabGet(tabId).catch(() => null);
    const hostKey = getHostKey((latestTab && latestTab.url) || (tab && tab.url) || "");
    if (!hostKey) {
      return;
    }

    // A tab reload should be enough to recover from stale/suspended WebSocket state.
    await ensureSocketConnection({ trigger: "tab-complete" });

    if (initialLoadSyncedTabIds.has(tabId)) {
      return;
    }
    initialLoadSyncedTabIds.add(tabId);

    // Important: clear pending JS markers before sync to prevent state overwrite races.
    await clearPendingUpdatesForHost(hostKey);
    await syncTab(tabId, "tab-complete");
  })().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  initialLoadSyncedTabIds.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  connectSocket({ reason: "startup" }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  connectSocket({ reason: "startup" }).catch(() => {});
});

connectSocket({ reason: "startup" }).catch(() => {});
