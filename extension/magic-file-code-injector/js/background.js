const STORAGE_KEY = "magicFileCodeInjectorState";
const DEFAULT_STATE = {
  global: {
    host: "127.0.0.1",
    port: 35888,
  },
  hosts: {},
};

const DEFAULT_HOST_STATE = {
  enabledFileIds: [],
  autoRefreshJs: false,
  pendingJsUpdateIds: [],
  lastError: "",
};

const MANIFEST_ROUTE = "/magic-file-code-injector.manifest.json";

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
const RECONNECT_INTERVAL_MS = 1000;
const RECONNECT_WINDOW_MS = 20000;

/**
 * Deduplicate string lists before persisting state to keep storage deterministic.
 * @param {any} values - List of candidate values to normalize before persistence.
 * @returns {string[]} Deduplicated string list.
 */
function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string")));
}

/**
 * Normalize per-host settings to protect runtime logic from malformed stored values.
 * @param {any} input - Raw value loaded from config, storage, or message payload.
 * @returns {object} Normalized per-host settings object.
 */
function normalizeHostState(input) {
  const source = input && typeof input === "object" ? input : {};

  return {
    enabledFileIds: uniqueStrings(Array.isArray(source.enabledFileIds) ? source.enabledFileIds : []),
    autoRefreshJs: source.autoRefreshJs === true,
    pendingJsUpdateIds: uniqueStrings(Array.isArray(source.pendingJsUpdateIds) ? source.pendingJsUpdateIds : []),
    lastError: typeof source.lastError === "string" ? source.lastError : "",
  };
}

/**
 * Normalize full extension state loaded from storage into a safe in-memory shape.
 * @param {any} input - Raw value loaded from config, storage, or message payload.
 * @returns {object} Normalized full extension state.
 */
function normalizeState(input) {
  const source = input && typeof input === "object" ? input : {};
  const globalState = source.global && typeof source.global === "object" ? source.global : {};

  const host = typeof globalState.host === "string" && globalState.host.trim().length > 0 ? globalState.host.trim() : DEFAULT_STATE.global.host;

  const parsedPort = Number(globalState.port);
  const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : DEFAULT_STATE.global.port;

  const hosts = {};
  if (source.hosts && typeof source.hosts === "object") {
    for (const [hostKey, hostState] of Object.entries(source.hosts)) {
      hosts[hostKey] = normalizeHostState(hostState);
    }
  }

  return {
    global: { host, port },
    hosts,
  };
}

/**
 * Build the dev-server origin used for manifest and file fetches.
 * @param {any} globalState - Global server settings stored by the extension.
 * @returns {string} HTTP origin of local dev server.
 */
function getServerOrigin(globalState) {
  return `http://${globalState.host}:${globalState.port}`;
}

/**
 * Build manifest URL from current global server configuration.
 * @param {any} globalState - Global server settings stored by the extension.
 * @returns {string} Full manifest URL.
 */
function getManifestUrl(globalState) {
  return `${getServerOrigin(globalState)}${MANIFEST_ROUTE}`;
}

/**
 * Normalize LiveReload payload paths so matching against manifest entries is reliable.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @returns {string} Canonical lowercase path used for comparisons.
 */
function normalizeChangedPath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }

  let normalized = value.trim().replace(/\\/g, "/");

  try {
    // LiveReload can send full URLs or relative paths depending on the sender.
    normalized = new URL(normalized).pathname;
  } catch (_error) {
    // Keep original value when not a full URL.
  }

  const hashIndex = normalized.indexOf("#");
  if (hashIndex >= 0) {
    normalized = normalized.slice(0, hashIndex);
  }

  const queryIndex = normalized.indexOf("?");
  if (queryIndex >= 0) {
    normalized = normalized.slice(0, queryIndex);
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  return normalized.toLowerCase();
}

/**
 * Infer file type from a path to decide CSS refresh vs JS reload behavior.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @returns {"css"|"js"|""} File type inferred from path extension.
 */
function inferFileTypeFromPath(value) {
  const normalized = normalizeChangedPath(value);

  if (normalized.endsWith(".css")) {
    return "css";
  }

  if (normalized.endsWith(".js") || normalized.endsWith(".mjs")) {
    return "js";
  }

  return "";
}

/**
 * Extract a stable host key from a tab URL for per-domain settings storage.
 * @param {any} urlValue - URL-like value to parse or normalize.
 * @returns {string|null} Host key for persisted settings, or null for unsupported URLs.
 */
function getHostKey(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname;
  } catch (_error) {
    return null;
  }
}

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
 * Normalize raw manifest entries into extension-ready file descriptors.
 * @param {any} file - Manifest or build file descriptor currently processed.
 * @returns {object|null} Normalized manifest file or null when invalid.
 */
function normalizeManifestFile(file) {
  if (!file || typeof file !== "object") {
    return null;
  }

  const type = file.type === "css" || file.type === "js" ? file.type : null;
  const pathValue = typeof file.path === "string" && file.path.length > 0 ? file.path : null;

  if (!type || !pathValue) {
    return null;
  }

  const id = typeof file.id === "string" && file.id.length > 0 ? file.id : `${type}:${pathValue}`;
  const normalizedPath = /^https?:\/\//.test(pathValue) ? pathValue : pathValue.startsWith("/") ? pathValue : `/${pathValue}`;

  const normalized = {
    id,
    type,
    path: normalizedPath,
    label: typeof file.label === "string" && file.label.length > 0 ? file.label : normalizedPath.split("/").pop() || id,
  };

  if (type === "js") {
    normalized.scriptType = file.scriptType === "module" ? "module" : "script";
  }

  return normalized;
}

/**
 * Resolve a manifest file path to an absolute URL fetchable by background script.
 * @param {any} file - Manifest or build file descriptor currently processed.
 * @param {any} origin - Server origin used to resolve absolute file URLs.
 * @returns {string} Absolute file URL.
 */
function resolveFileUrl(file, origin) {
  if (/^https?:\/\//.test(file.path)) {
    return file.path;
  }

  return `${origin}${file.path}`;
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
 * @returns {Promise<object>} Payload sent to content script for tab sync.
 */
async function buildSyncPayload(state, hostKey, hostState) {
  const manifest = await fetchManifest(state.global);

  // Only ship currently enabled files to content scripts to keep injection minimal.
  const activeManifestFiles = manifest.files.filter((file) => hostState.enabledFileIds.includes(file.id));

  const files = [];
  for (const file of activeManifestFiles) {
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
 * @returns {Promise<void>} Completes after best-effort tab synchronization.
 */
async function syncTab(tabId, reason) {
  let tab;
  try {
    tab = await tabGet(tabId);
  } catch (_error) {
    return;
  }

  const hostKey = tab && tab.url ? getHostKey(tab.url) : null;
  if (!hostKey) {
    return;
  }

  const state = await loadState();
  const hasStoredHostState = Boolean(state.hosts[hostKey]);
  const hostState = hasStoredHostState ? normalizeHostState(state.hosts[hostKey]) : { ...DEFAULT_HOST_STATE };

  try {
    const payload = await buildSyncPayload(state, hostKey, hostState);
    if (hasStoredHostState) {
      // Keep error state clean once a successful sync occurred for this host.
      state.hosts[hostKey].lastError = "";
      await saveState(state);
    }

    await tabSendMessage(tabId, {
      type: "MFCI_APPLY_STATE",
      reason,
      ...payload,
    });
  } catch (error) {
    if (hasStoredHostState) {
      state.hosts[hostKey].lastError = String(error.message || error);
      await saveState(state);
    }
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
 * Sort host entries for deterministic options-page rendering.
 * @param {any} hosts - Map of host states keyed by domain.
 * @returns {Array<[string,object]>} Host entries sorted by domain.
 */
function sortedHostEntries(hosts) {
  return Object.entries(hosts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostKey, hostState]) => [hostKey, normalizeHostState(hostState)]);
}

/**
 * Project host state to the subset exposed by options UI.
 * @param {any} hostState - Per-site configuration including enabled files and JS refresh mode.
 * @returns {object} Host state projection used by options UI.
 */
function toOptionsHostState(hostState) {
  const normalized = normalizeHostState(hostState);
  return {
    enabledFileIds: normalized.enabledFileIds,
    autoRefreshJs: normalized.autoRefreshJs,
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
  logToBrowserConsole("warn", `[mfci] WebSocket connection lost (${reason}).`);
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
    const wasDisconnected = connectionLossLogged;

    socketConnected = true;
    socketError = "";
    stopReconnectLoop();
    connectionLossLogged = false;

    if (wasDisconnected) {
      logToBrowserConsole("log", "[mfci] WebSocket connection restored.");
    }

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

  socket.addEventListener("message", async (event) => {
    await handleSocketMessage(event.data);
  });
}

/**
 * Handle LiveReload events and trigger CSS sync or JS reload/pending flows per tab.
 * @param {any} rawMessage - Raw WebSocket message payload from LiveReload server.
 * @returns {Promise<void>} Completes after LiveReload event processing.
 */
async function handleSocketMessage(rawMessage) {
  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch (_error) {
    return;
  }

  if (!payload || typeof payload !== "object") {
    return;
  }

  const state = await loadState();

  let fileId = "";
  let fileType = "";
  let manifest = null;

  if (payload.type === "file-changed") {
    fileId = typeof payload.fileId === "string" ? payload.fileId : "";
    fileType = payload.fileType === "css" || payload.fileType === "js" ? payload.fileType : "";
  } else if (payload.command === "reload") {
    const changedPath = typeof payload.path === "string" ? payload.path : "";
    fileType = inferFileTypeFromPath(changedPath);

    if (fileType) {
      try {
        manifest = await fetchManifest(state.global);
      } catch (_error) {
        manifest = null;
      }

      if (manifest) {
        const normalizedChangedPath = normalizeChangedPath(changedPath);
        // Match incoming changed path against current manifest paths to resolve the exact file id when possible.
        for (const candidate of manifest.files) {
          if (candidate.type !== fileType) {
            continue;
          }

          const normalizedManifestPath = normalizeChangedPath(candidate.path);
          if (
            normalizedChangedPath === normalizedManifestPath ||
            normalizedChangedPath.endsWith(normalizedManifestPath)
          ) {
            fileId = candidate.id;
            break;
          }
        }
      }
    }
  }

  if (!fileType) {
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

    let affectedJsIds = [];
    let isAffected = false;

    if (fileId) {
      isAffected = hostState.enabledFileIds.includes(fileId);
      if (isAffected && fileType === "js") {
        affectedJsIds = [fileId];
      }
    } else {
      const enabledIdsForType = hostState.enabledFileIds.filter((enabledId) => {
        if (enabledId.startsWith(`${fileType}:`)) {
          return true;
        }

        return manifestTypeById.get(enabledId) === fileType;
      });

      isAffected = enabledIdsForType.length > 0;
      if (fileType === "js") {
        affectedJsIds = enabledIdsForType;
      }
    }

    if (!isAffected) {
      continue;
    }

    if (fileType === "css") {
      await syncTab(tab.id, "css-change");
      continue;
    }

    if (hostState.autoRefreshJs) {
      await delay(50);
      // Full reload is required for JS because script tags can have side effects not safely hot-swappable.
      await tabReload(tab.id).catch(() => {});
      continue;
    }

    for (const pendingId of affectedJsIds) {
      if (!hostState.pendingJsUpdateIds.includes(pendingId)) {
        hostState.pendingJsUpdateIds.push(pendingId);
        stateChanged = true;
      }
    }
  }

  if (stateChanged) {
    await saveState(state);
  }
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

  if (typeof message.tabId === "number") {
    await syncTab(message.tabId, "selection-change");
  } else {
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
        await applyToCurrentTab("manual-sync");
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
