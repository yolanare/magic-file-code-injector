const hostValueElement = document.getElementById("host-value");
const serverValueElement = document.getElementById("server-value");
const statusMessageElement = document.getElementById("status-message");
const globalInjectionEnabledElement = document.getElementById("global-injection-enabled");
const injectScopeTypeElement = document.getElementById("inject-scope-type");
const injectScopeRegexRowElement = document.getElementById("inject-scope-regex-row");
const injectScopeRegexElement = document.getElementById("inject-scope-regex");
const injectScopeStatusElement = document.getElementById("inject-scope-status");
const autoRefreshJsElement = document.getElementById("auto-refresh-js");
const pendingJsElement = document.getElementById("pending-js");
const filesListElement = document.getElementById("files-list");
const refreshButtonElement = document.getElementById("refresh-model");
const openOptionsButtonElement = document.getElementById("open-options");
const { sendRuntimeMessage, setStatusMessage } = self.MfciRuntimeUtils;
const { DEFAULT_SCOPE_TYPE, isRegexScope, parseScopeKey, getDefaultRegexForScope } = self.MfciScopeUtils;

let model = null;
let popupFileOrderIds = null;
let popupFileOrderScopeKey = null;

function getCurrentInjectScopeParts() {
  if (model.hostKey) {
    return parseScopeKey(model.hostKey);
  }
  if (model.scope && model.scope.key) {
    return parseScopeKey(model.scope.key);
  }
  return { type: injectScopeTypeElement.value, value: "" };
}

function syncInjectScopeRegexInput() {
  const usesRegex = isRegexScope(injectScopeTypeElement.value);
  injectScopeRegexRowElement.classList.toggle("hidden", !usesRegex);
  if (usesRegex && injectScopeRegexElement.value.trim() === "") {
    injectScopeRegexElement.value = getDefaultRegexForScope(getCurrentInjectScopeParts());
  }
}

function getSelectedInjectScope() {
  syncInjectScopeRegexInput();
  return {
    scopeType: injectScopeTypeElement.value,
    regex: injectScopeRegexElement.value,
  };
}

function setInjectScopeStatus(message) {
  injectScopeStatusElement.classList.toggle("hidden", !message);
  injectScopeStatusElement.textContent = message;
}

function getRenderedInjectScopeRegex(savedScope, scope) {
  if (savedScope && isRegexScope(savedScope.type)) {
    return savedScope.value;
  }
  if (isRegexScope(scope.type)) {
    return scope.regex || model.global.injectScopeRegex || "";
  }
  return "";
}

/**
 * Persist the enabled-file selection for current host then refresh popup model.
 * @param {Set<string>} nextSelection - Next enabled file IDs for the current host.
 * @returns {Promise<void>} Saves selection and reloads popup state.
 */
async function updateEnabledFileSelection(nextSelection) {
  const response = await sendRuntimeMessage({
    type: "POPUP_SET_ENABLED_FILES",
    hostKey: model.hostKey,
    tabId: model.tabId,
    enabledFileIds: Array.from(nextSelection),
  });

  if (!response || response.ok !== true) {
    setStatusMessage(statusMessageElement, (response && response.error) || "Unable to update enabled files.", true);
    return;
  }

  await refreshModel();
}

/**
 * Persist the active injection target and resync current popup model.
 * @param {{scopeType:string,regex:string}} scopeInput - Selected injection scope values.
 * @returns {Promise<void>} Saves scope and reloads popup state.
 */
async function updateInjectScope(scopeInput) {
  const response = await sendRuntimeMessage({
    type: "POPUP_SET_INJECT_SCOPE",
    hostKey: model.hostKey,
    tabId: model.tabId,
    scopeType: scopeInput.scopeType,
    regex: scopeInput.regex,
  });

  if (!response || response.ok !== true) {
    setStatusMessage(statusMessageElement, (response && response.error) || "Unable to update injection scope.", true);
    return;
  }

  await refreshModel();
}

/**
 * Split one manifest URL path into file name + parent folder for clearer display.
 * @param {string} inputPath - Manifest path (for example `/js/test.js`).
 * @param {string} fallbackName - Fallback label when path parsing fails.
 * @returns {{fileName:string,parentPath:string}} Display-safe parts.
 */
function resolveFileDisplayParts(inputPath, fallbackName) {
  const sourcePath = typeof inputPath === "string" ? inputPath : "";
  const sanitized = sourcePath.split("?")[0].split("#")[0];
  const normalized = sanitized.startsWith("/") ? sanitized : `/${sanitized}`;
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length === 0) {
    return {
      fileName: typeof fallbackName === "string" && fallbackName.length > 0 ? fallbackName : "unknown",
      parentPath: "/",
    };
  }

  const fileName = segments[segments.length - 1] || "unknown";
  const parentSegments = segments.slice(0, -1);

  // Manifest paths for modules are served as /css/modules/... or /js/modules/...,
  // but the UI should show the logical module path without the served-type prefix.
  const normalizedParentSegments =
    parentSegments.length >= 2 && (parentSegments[0] === "css" || parentSegments[0] === "js") && parentSegments[1] === "modules" ?
      parentSegments.slice(1)
    : parentSegments;

  const parentPath = normalizedParentSegments.length > 0 ? `/${normalizedParentSegments.join("/")}/` : "/";

  return { fileName, parentPath };
}

/**
 * Render one popup file row with toggle behavior bound to host settings.
 * @param {object} file - Manifest or build file descriptor currently processed.
 * @param {Set<string>} enabledFileIds - Enabled file IDs for the current host.
 * @returns {HTMLElement} Popup row bound to one manifest file.
 */
function createFileRow(file, enabledFileIds) {
  const row = document.createElement("label");
  row.className = "file-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = enabledFileIds.has(file.id);
  checkbox.disabled = !model.hostKey;
  checkbox.addEventListener("change", async () => {
    const nextSelection = new Set(enabledFileIds);

    if (checkbox.checked) {
      nextSelection.add(file.id);
    } else {
      nextSelection.delete(file.id);
    }

    await updateEnabledFileSelection(nextSelection);
  });

  const meta = document.createElement("div");
  meta.className = "file-meta";

  const displayParts = resolveFileDisplayParts(file.path, file.label);

  const label = document.createElement("div");
  label.className = "file-label";
  label.textContent = displayParts.fileName;

  const pathValue = document.createElement("div");
  pathValue.className = "file-path";
  pathValue.textContent = displayParts.parentPath;
  pathValue.title = typeof file.path === "string" ? file.path : "";

  meta.appendChild(label);
  meta.appendChild(pathValue);

  const badge = document.createElement("span");
  const badgeType = file.type === "js" && file.scriptType === "module" ? "js-module" : file.type;
  badge.className = `file-badge file-badge-${badgeType}`;
  badge.textContent = badgeType;

  row.appendChild(checkbox);
  row.appendChild(meta);
  row.appendChild(badge);

  return row;
}

/**
 * Render one warning row for a file ID still enabled in host settings but not found in current manifest.
 * @param {string} fileId - Stable manifest file identifier (type:path).
 * @param {Set<string>} enabledFileIds - Enabled file IDs for the current host.
 * @returns {HTMLElement} Warning row for a missing enabled file.
 */
function createMissingFileRow(fileId, enabledFileIds) {
  const row = document.createElement("label");
  row.className = "file-row file-row-missing";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  checkbox.disabled = !model.hostKey;
  checkbox.addEventListener("change", async () => {
    // Missing entries can only be removed from host settings from this row.
    if (checkbox.checked) {
      return;
    }

    const nextSelection = new Set(enabledFileIds);
    nextSelection.delete(fileId);
    await updateEnabledFileSelection(nextSelection);
  });

  const meta = document.createElement("div");
  meta.className = "file-meta";

  const label = document.createElement("div");
  label.className = "file-label";
  label.textContent = fileId;

  const pathValue = document.createElement("div");
  pathValue.className = "file-path";
  pathValue.textContent = "not found on current local server";

  meta.appendChild(label);
  meta.appendChild(pathValue);

  const badge = document.createElement("span");
  badge.className = "file-badge file-badge-warning";
  badge.textContent = "missing";

  row.appendChild(checkbox);
  row.appendChild(meta);
  row.appendChild(badge);

  return row;
}

/**
 * Sort manifest files once per popup lifetime so enabled files start first without live reordering on toggles.
 * @param {object[]} files - Manifest file descriptors.
 * @param {Set<string>} enabledFileIds - Enabled file IDs for the current host.
 * @returns {object[]} Files ordered for the current popup instance.
 */
function getPopupOrderedFiles(files, enabledFileIds) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  const scopeKey = model && model.hostKey ? model.hostKey : "";
  if (!popupFileOrderIds || popupFileOrderScopeKey !== scopeKey) {
    const enabledFiles = files.filter((file) => enabledFileIds.has(file.id));
    const disabledFiles = files.filter((file) => !enabledFileIds.has(file.id));
    const orderedFiles = [...enabledFiles, ...disabledFiles];
    popupFileOrderIds = orderedFiles.map((file) => file.id);
    popupFileOrderScopeKey = scopeKey;
    return orderedFiles;
  }

  const filesById = new Map(files.map((file) => [file.id, file]));
  const orderedFiles = [];
  const renderedIds = new Set();

  for (const fileId of popupFileOrderIds) {
    const file = filesById.get(fileId);
    if (!file) {
      continue;
    }

    orderedFiles.push(file);
    renderedIds.add(fileId);
  }

  for (const file of files) {
    if (renderedIds.has(file.id)) {
      continue;
    }

    orderedFiles.push(file);
    popupFileOrderIds.push(file.id);
  }

  return orderedFiles;
}

/**
 * Render injection-scope controls from current popup model.
 * @returns {void} Updates select labels, regex field and scope diagnostics.
 */
function renderInjectScopeControls() {
  const scope = model.scope || {};
  const labels = scope.labels || {};
  const savedScope = model.hostKey ? parseScopeKey(model.hostKey) : null;

  for (const option of Array.from(injectScopeTypeElement.options)) {
    option.textContent = labels[option.value] || option.value;
  }

  injectScopeTypeElement.value = (savedScope && savedScope.type) || scope.type || model.global.injectScopeType || DEFAULT_SCOPE_TYPE;
  injectScopeRegexElement.value = getRenderedInjectScopeRegex(savedScope, scope);

  syncInjectScopeRegexInput();

  if (!isRegexScope(injectScopeTypeElement.value)) {
    setInjectScopeStatus("");
    return;
  }

  if (!scope.valid) {
    setInjectScopeStatus(scope.error || "Enter a valid regex to target pages.");
    return;
  }

  if (!scope.matchesCurrentUrl) {
    setInjectScopeStatus("Regex does not match this page.");
    return;
  }

  setInjectScopeStatus("");
}

/**
 * Render popup/options UI from current model state.
 * @returns {void} Renders current model into UI.
 */
function render() {
  hostValueElement.textContent = model.hostKey || (model.scope && model.scope.label) || "No active web page";
  serverValueElement.textContent = model.server.origin;
  globalInjectionEnabledElement.checked = model.global.injectionEnabled !== false;
  renderInjectScopeControls();

  const serverProblems = [];
  if (model.server.error) {
    serverProblems.push(model.server.error);
  }
  if (model.server.websocketError) {
    serverProblems.push(model.server.websocketError);
  }

  if (serverProblems.length > 0) {
    setStatusMessage(statusMessageElement, serverProblems.join(" "), true);
  } else if (model.global.injectionEnabled === false) {
    setStatusMessage(statusMessageElement, "Injection disabled globally.", false);
  } else if (model.server.websocketConnected) {
    setStatusMessage(statusMessageElement, "Connected to local server.", false);
  } else {
    setStatusMessage(statusMessageElement, "Waiting for local server WebSocket connection.", false);
  }

  const hostState = model.hostState;

  autoRefreshJsElement.checked = hostState.autoRefreshJs;
  autoRefreshJsElement.disabled = !model.hostKey;

  if (hostState.pendingJsUpdateIds.length > 0) {
    pendingJsElement.classList.remove("hidden");
    pendingJsElement.textContent = `${hostState.pendingJsUpdateIds.length} JS update(s) pending. Reload the page to apply.`;
  } else {
    pendingJsElement.classList.add("hidden");
    pendingJsElement.textContent = "";
  }

  if (hostState.lastError) {
    setStatusMessage(statusMessageElement, hostState.lastError, true);
  }

  const files = model.manifest && Array.isArray(model.manifest.files) ? model.manifest.files : [];
  const enabledFileIds = new Set(hostState.enabledFileIds);
  const orderedFiles = getPopupOrderedFiles(files, enabledFileIds);
  const manifestIdSet = new Set(files.map((file) => file.id));
  const missingEnabledFileIds =
    model.manifest && Array.isArray(model.manifest.files) ?
      hostState.enabledFileIds.filter((fileId) => !manifestIdSet.has(fileId))
    : [];

  filesListElement.innerHTML = "";

  if (files.length === 0 && missingEnabledFileIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "No CSS/JS files found on the local manifest.";
    filesListElement.appendChild(empty);
    return;
  }

  for (const missingFileId of missingEnabledFileIds) {
    filesListElement.appendChild(createMissingFileRow(missingFileId, enabledFileIds));
  }

  for (const file of orderedFiles) {
    filesListElement.appendChild(createFileRow(file, enabledFileIds));
  }
}

/**
 * Refresh UI model from background script then re-render.
 * @returns {Promise<void>} Fetches fresh model and triggers render.
 */
async function refreshModel() {
  try {
    const response = await sendRuntimeMessage({ type: "POPUP_GET_MODEL" });
    model = response;
    render();
  } catch (error) {
    setStatusMessage(statusMessageElement, String(error.message || error), true);
  }
}

injectScopeTypeElement.addEventListener("change", async () => {
  await updateInjectScope(getSelectedInjectScope());
});

injectScopeRegexElement.addEventListener("change", async () => {
  await updateInjectScope(getSelectedInjectScope());
});

injectScopeRegexElement.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  await updateInjectScope(getSelectedInjectScope());
});

autoRefreshJsElement.addEventListener("change", async () => {
  if (!model || !model.hostKey) {
    return;
  }

  const response = await sendRuntimeMessage({
    type: "POPUP_SET_AUTO_REFRESH_JS",
    hostKey: model.hostKey,
    autoRefreshJs: autoRefreshJsElement.checked,
  });

  if (!response || response.ok !== true) {
    setStatusMessage(statusMessageElement, (response && response.error) || "Unable to update JS auto-refresh.", true);
    return;
  }

  await refreshModel();
});

globalInjectionEnabledElement.addEventListener("change", async () => {
  await sendRuntimeMessage({
    type: "POPUP_SET_GLOBAL_INJECTION",
    injectionEnabled: globalInjectionEnabledElement.checked,
  });

  await refreshModel();
});

refreshButtonElement.addEventListener("click", async () => {
  try {
    const response = await sendRuntimeMessage({ type: "POPUP_FORCE_SYNC" });
    if (!response || response.ok !== true) {
      setStatusMessage(statusMessageElement, (response && response.error) || "Unable to refresh extension state.", true);
      return;
    }
    await refreshModel();
  } catch (error) {
    setStatusMessage(statusMessageElement, String(error.message || error), true);
  }
});

openOptionsButtonElement.addEventListener("click", async () => {
  try {
    await sendRuntimeMessage({ type: "POPUP_OPEN_OPTIONS" });
    window.close();
  } catch (error) {
    setStatusMessage(statusMessageElement, String(error.message || error), true);
  }
});

/**
 * Initialize popup state without forcing a WebSocket reconnect.
 * @returns {Promise<void>} Completes after best-effort active-tab sync and model refresh.
 */
async function initializePopup() {
  try {
    await sendRuntimeMessage({ type: "POPUP_OPENED" });
  } catch (_error) {
    // Ignore startup sync failures here; refreshModel renders the actual status message.
  }

  await refreshModel();
}

initializePopup();
