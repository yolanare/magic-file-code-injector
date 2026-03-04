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

const LR_PROTOCOLS = [
  "http://livereload.com/protocols/official-7",
  "http://livereload.com/protocols/official-8",
  "http://livereload.com/protocols/official-9",
];

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string")));
}

function normalizeHostState(input) {
  const source = input && typeof input === "object" ? input : {};

  return {
    enabledFileIds: uniqueStrings(Array.isArray(source.enabledFileIds) ? source.enabledFileIds : []),
    autoRefreshJs: source.autoRefreshJs === true,
    pendingJsUpdateIds: uniqueStrings(Array.isArray(source.pendingJsUpdateIds) ? source.pendingJsUpdateIds : []),
    lastError: typeof source.lastError === "string" ? source.lastError : "",
  };
}

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

function getServerOrigin(globalState) {
  return `http://${globalState.host}:${globalState.port}`;
}

function getManifestUrl(globalState) {
  return `${getServerOrigin(globalState)}${MANIFEST_ROUTE}`;
}

function normalizeChangedPath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }

  let normalized = value.trim().replace(/\\/g, "/");

  try {
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function logToTabConsole(tabId, message, context = null, level = "info") {
  await tabSendMessage(tabId, {
    type: "MFCI_LOG_EVENT",
    level,
    message,
    context: context && typeof context === "object" ? context : undefined,
  });
}

function formatChangedFileSummary(fileId, affectedIds) {
  if (typeof fileId === "string" && fileId.length > 0) {
    return fileId;
  }

  if (Array.isArray(affectedIds) && affectedIds.length === 1) {
    return affectedIds[0];
  }

  if (Array.isArray(affectedIds) && affectedIds.length > 1) {
    return `${affectedIds.length} files`;
  }

  return "unknown file";
}

async function loadState() {
  const rawState = await storageGet(STORAGE_KEY);
  return normalizeState(rawState);
}

async function saveState(state) {
  await storageSet({ [STORAGE_KEY]: normalizeState(state) });
}

function getOrCreateHostState(state, hostKey) {
  if (!state.hosts[hostKey]) {
    state.hosts[hostKey] = { ...DEFAULT_HOST_STATE };
  }

  return state.hosts[hostKey];
}

function getExistingHostState(state, hostKey) {
  if (!hostKey) {
    return { ...DEFAULT_HOST_STATE };
  }

  return state.hosts[hostKey] ? normalizeHostState(state.hosts[hostKey]) : { ...DEFAULT_HOST_STATE };
}

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

function resolveFileUrl(file, origin) {
  if (/^https?:\/\//.test(file.path)) {
    return file.path;
  }

  return `${origin}${file.path}`;
}

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

async function fetchFileText(url) {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Unable to read ${url} (${response.status}).`);
  }

  return response.text();
}

async function buildSyncPayload(state, hostKey, hostState) {
  const manifest = await fetchManifest(state.global);

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

async function getActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  return tabs.length > 0 ? tabs[0] : null;
}

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

async function clearPendingUpdatesForHost(hostKey) {
  const state = await loadState();
  const hostState = state.hosts[hostKey];

  if (!hostState || hostState.pendingJsUpdateIds.length === 0) {
    return;
  }

  hostState.pendingJsUpdateIds = [];
  await saveState(state);
}

async function applyToCurrentTab(reason) {
  const activeTab = await getActiveTab();
  if (!activeTab || typeof activeTab.id !== "number") {
    return;
  }

  await syncTab(activeTab.id, reason);
}

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

function sortedHostEntries(hosts) {
  return Object.entries(hosts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hostKey, hostState]) => [hostKey, normalizeHostState(hostState)]);
}

function toOptionsHostState(hostState) {
  const normalized = normalizeHostState(hostState);
  return {
    enabledFileIds: normalized.enabledFileIds,
    autoRefreshJs: normalized.autoRefreshJs,
  };
}

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

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  reconnectTimer = setTimeout(() => {
    connectSocket().catch(() => {
      scheduleReconnect();
    });
  }, 2000);
}

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

    try {
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
  });

  socket.addEventListener("close", () => {
    socketConnected = false;
    scheduleReconnect();
  });

  socket.addEventListener("message", async (event) => {
    await handleSocketMessage(event.data);
  });
}

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
      const cssMessage = `[MFCI] CSS change detected (${formatChangedFileSummary(fileId, [])}). Refreshing styles.`;
      const cssContext = { hostKey, fileType, fileId: fileId || null };
      console.info(cssMessage, { tabId: tab.id, ...cssContext });
      await logToTabConsole(tab.id, cssMessage, cssContext, "info");
      await syncTab(tab.id, "css-change");
      continue;
    }

    if (hostState.autoRefreshJs) {
      const reloadMessage = `[MFCI] JS change detected (${formatChangedFileSummary(fileId, affectedJsIds)}). Auto-refresh is enabled, triggering full page reload.`;
      const reloadContext = { hostKey, fileType, fileId: fileId || null, affectedJsIds };
      console.info(reloadMessage, { tabId: tab.id, ...reloadContext });
      await logToTabConsole(tab.id, reloadMessage, reloadContext, "info");
      await delay(50);
      await tabReload(tab.id).catch(() => {});
      continue;
    }

    const pendingMessage = `[MFCI] JS change detected (${formatChangedFileSummary(fileId, affectedJsIds)}). Auto-refresh is disabled, update pending until manual reload.`;
    const pendingContext = { hostKey, fileType, fileId: fileId || null, affectedJsIds };
    console.info(pendingMessage, { tabId: tab.id, ...pendingContext });
    await logToTabConsole(tab.id, pendingMessage, pendingContext, "info");

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

async function updateAutoRefresh(message) {
  const state = await loadState();
  const hostState = getOrCreateHostState(state, message.hostKey);

  hostState.autoRefreshJs = message.autoRefreshJs === true;
  await saveState(state);

  return { ok: true };
}

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

  const hostKey = tab && tab.url ? getHostKey(tab.url) : null;
  if (!hostKey) {
    return;
  }

  clearPendingUpdatesForHost(hostKey).catch(() => {});
  syncTab(tabId, "tab-complete").catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  connectSocket().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  connectSocket().catch(() => {});
});

connectSocket().catch(() => {});
