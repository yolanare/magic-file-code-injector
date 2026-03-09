const hostValueElement = document.getElementById("host-value");
const serverValueElement = document.getElementById("server-value");
const statusMessageElement = document.getElementById("status-message");
const autoRefreshJsElement = document.getElementById("auto-refresh-js");
const pendingJsElement = document.getElementById("pending-js");
const filesListElement = document.getElementById("files-list");
const refreshButtonElement = document.getElementById("refresh-model");
const openOptionsButtonElement = document.getElementById("open-options");
const { sendRuntimeMessage, setStatusMessage } = self.MfciRuntimeUtils;

let model = null;

/**
 * Persist the enabled-file selection for current host then refresh popup model.
 * @param {Set<string>} nextSelection - Next enabled file IDs for the current host.
 * @returns {Promise<void>} Saves selection and reloads popup state.
 */
async function updateEnabledFileSelection(nextSelection) {
  await sendRuntimeMessage({
    type: "POPUP_SET_ENABLED_FILES",
    hostKey: model.hostKey,
    tabId: model.tabId,
    enabledFileIds: Array.from(nextSelection),
  });

  await refreshModel();
}

/**
 * Render one popup file row with toggle behavior bound to host settings.
 * @param {any} file - Manifest or build file descriptor currently processed.
 * @param {any} enabledFileIds - Enabled file IDs for the current host.
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

  const label = document.createElement("div");
  label.className = "file-label";
  label.textContent = file.label;

  const pathValue = document.createElement("div");
  pathValue.className = "file-path";
  pathValue.textContent = file.path;

  meta.appendChild(label);
  meta.appendChild(pathValue);

  const badge = document.createElement("span");
  badge.className = "file-badge";
  badge.textContent = file.type === "js" && file.scriptType === "module" ? "js-module" : file.type;

  row.appendChild(checkbox);
  row.appendChild(meta);
  row.appendChild(badge);

  return row;
}

/**
 * Render one warning row for a file ID still enabled in host settings but not found in current manifest.
 * @param {any} fileId - Stable manifest file identifier (type:path).
 * @param {any} enabledFileIds - Enabled file IDs for the current host.
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
 * Render status text with error styling support.
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @param {any} isError - True when status should be rendered with error styling.
 * @returns {void} Updates status area content and error style.
 */
function setStatus(message, isError) {
  setStatusMessage(statusMessageElement, message, isError);
}

/**
 * Render popup/options UI from current model state.
 * @returns {void} Renders current model into UI.
 */
function render() {
  if (!model) {
    return;
  }

  hostValueElement.textContent = model.hostKey || "No active web page";
  serverValueElement.textContent = model.server.origin;

  const serverProblems = [];
  if (model.server.error) {
    serverProblems.push(model.server.error);
  }
  if (model.server.websocketError) {
    serverProblems.push(model.server.websocketError);
  }

  if (serverProblems.length > 0) {
    setStatus(serverProblems.join(" "), true);
  } else if (model.server.websocketConnected) {
    setStatus("Connected to local server.", false);
  } else {
    setStatus("Waiting for local server WebSocket connection.", false);
  }

  const hostState = model.hostState || {
    enabledFileIds: [],
    autoRefreshJs: false,
    pendingJsUpdateIds: [],
    lastError: "",
  };

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
    setStatus(hostState.lastError, true);
  }

  const files = model.manifest && Array.isArray(model.manifest.files) ? model.manifest.files : [];
  const enabledFileIds = new Set(hostState.enabledFileIds || []);
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

  for (const file of files) {
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
    setStatus(String(error.message || error), true);
  }
}

autoRefreshJsElement.addEventListener("change", async () => {
  if (!model || !model.hostKey) {
    return;
  }

  await sendRuntimeMessage({
    type: "POPUP_SET_AUTO_REFRESH_JS",
    hostKey: model.hostKey,
    autoRefreshJs: autoRefreshJsElement.checked,
  });

  await refreshModel();
});

refreshButtonElement.addEventListener("click", async () => {
  await sendRuntimeMessage({ type: "POPUP_FORCE_SYNC" });
  await refreshModel();
});

openOptionsButtonElement.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

/**
 * Initialize popup state by forcing one connection/sync cycle, then loading the latest model.
 * @returns {Promise<void>} Completes after startup sync attempt and model refresh.
 */
async function initializePopup() {
  try {
    await sendRuntimeMessage({ type: "POPUP_FORCE_SYNC" });
  } catch (_error) {
    // Ignore startup sync failures here; refreshModel renders the actual status message.
  }

  await refreshModel();
}

initializePopup();
