// Load pure helpers once so this service-worker file stays focused on side effects and orchestration.
importScripts("js/background-utils.js");
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

let socket = null;
let socketUrl = "";
let socketConnected = false;
let socketError = "";
let reconnectTimer = null;
let reconnectUntil = 0;
let connectionLossLogged = false;

const LR_PROTOCOLS = [
  "http://livereload.com/protocols/official-7",
  "http://livereload.com/protocols/official-8",
  "http://livereload.com/protocols/official-9",
];
const RECONNECT_INTERVAL_MS = 2000;
const RECONNECT_WINDOW_MS = 20000;
const SOCKET_EVENT_BATCH_WINDOW_MS = 150;

let pendingSocketEvents = [];
let socketBatchTimer = null;
let socketBatchInFlight = false;

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
    chrome.tabs.sendMessage(tabId, payload, () => {
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
  if (typeof tabId !== "number") {
    return;
  }

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
    chrome.tabs.reload(tabId, () => {
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
  const response = await fetch(manifestUrl, { cache: "no-store" });

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
  const response = await fetch(url, { cache: "no-store" });

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

  // Only ship currently enabled files to content scripts to keep injection minimal.
  const activeManifestFiles = manifest.files.filter((file) => hostState.enabledFileIds.includes(file.id));
  const requestedFileIds = uniqueStrings(Array.isArray(options.fileIds) ? options.fileIds : []);
  const requestedSet = new Set(requestedFileIds);
  const isPartial = requestedSet.size > 0;
  const filesToSync = isPartial ? activeManifestFiles.filter((file) => requestedSet.has(file.id)) : activeManifestFiles;

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
 * Stop the current reconnect loop and reset retry window metadata.
 * @returns {void} Clears reconnect timer state.
 */
function stopReconnectLoop() {
  if (!reconnectTimer) {
    return;
  }

  clearInterval(reconnectTimer);
  reconnectTimer = null;
  reconnectUntil = 0;
}

/**
 * Log one connection-loss event and ignore duplicate `error`/`close` cascades for the same outage.
 * @param {string} reason - Human-readable reason for diagnostics.
 * @returns {void} Writes one warning line when outage starts.
 */
function logConnectionLoss(reason) {
  if (connectionLossLogged) {
    return;
  }

  connectionLossLogged = true;
  logToBrowserConsole(
    "warn",
    `[mfci] WebSocket connection lost (${reason}). Retrying every ${RECONNECT_INTERVAL_MS / 1000}s for up to 20s.`
  );
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
 * Retry WebSocket connection at regular intervals for a fixed time window.
 * @returns {void} Starts or keeps an active reconnect loop.
 */
function scheduleReconnect() {
  if (socketConnected) {
    stopReconnectLoop();
    return;
  }

  const now = Date.now();
  if (reconnectUntil <= now) {
    reconnectUntil = now + RECONNECT_WINDOW_MS;
  }

  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setInterval(() => {
    if (socketConnected) {
      stopReconnectLoop();
      return;
    }

    if (Date.now() >= reconnectUntil) {
      socketError = "WebSocket reconnect timeout (20s).";
      logToBrowserConsole("warn", "[mfci] Reconnect attempts stopped after 20s.");
      stopReconnectLoop();
      return;
    }

    connectSocket().catch(() => {});
  }, RECONNECT_INTERVAL_MS);

  // Try once immediately instead of waiting for the first interval tick.
  connectSocket().catch(() => {});
}

/**
 * Connect to LiveReload WebSocket and wire handshake plus event listeners.
 * @returns {Promise<void>} Completes when socket setup is initialized.
 */
async function connectSocket() {
  const state = await loadState();
  const nextSocketUrl = `ws://${state.global.host}:${state.global.port}/livereload`;

  if (socket && socketUrl === nextSocketUrl && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (socket) {
    socket.close();
    socket = null;
  }

  socketConnected = false;
  socketUrl = nextSocketUrl;
  socketError = "";

  socket = new WebSocket(nextSocketUrl);

  socket.addEventListener("open", () => {
    socketConnected = true;
    socketError = "";
    stopReconnectLoop();
    connectionLossLogged = false;

    // Always log successful connection establishment for developer visibility.
    logToBrowserConsole("log", "[mfci] WebSocket connection established.");

    try {
      // LiveReload handshake: required so the server starts sending reload notifications.
      socket.send(
        JSON.stringify({
          command: "hello",
          protocols: LR_PROTOCOLS,
          ver: "3.0.0",
        })
      );
    } catch (_error) {
      // Ignore handshake failures and keep listening.
    }
  });

  socket.addEventListener("error", () => {
    socketConnected = false;
    socketError = "WebSocket connection failed.";
    logConnectionLoss("error");
    scheduleReconnect();
  });

  socket.addEventListener("close", () => {
    socketConnected = false;
    logConnectionLoss("close");
    scheduleReconnect();
  });

  socket.addEventListener("message", (event) => {
    handleSocketMessage(event.data);
  });
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
    return;
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

  const events = pendingSocketEvents;
  pendingSocketEvents = [];

  try {
    const state = await loadState();
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
    socketBatchInFlight = false;
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

  await connectSocket();
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
      case "POPUP_SET_PORT":
      case "OPTIONS_SET_PORT":
        return updatePort(message);
      case "OPTIONS_DELETE_HOST":
        return deleteHostSettings(message);
      case "POPUP_FORCE_SYNC":
        // Manual refresh should also force a new WebSocket connection attempt.
        await connectSocket();
        await applyToCurrentTab("manual-sync");
        return { ok: true };
      case "MFCI_KEEPALIVE":
        // Content scripts ping periodically so background can recover WS after service-worker sleeps/timeouts.
        if (!socketConnected) {
          await connectSocket().catch(() => {});
        }
        return { ok: true };
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

    // Important: clear pending JS markers before sync to prevent state overwrite races.
    await clearPendingUpdatesForHost(hostKey);
    await syncTab(tabId, "tab-complete");
  })().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  connectSocket().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  connectSocket().catch(() => {});
});

connectSocket().catch(() => {});
