const hostValueElement = document.getElementById("host-value");
const serverValueElement = document.getElementById("server-value");
const statusMessageElement = document.getElementById("status-message");
const autoRefreshJsElement = document.getElementById("auto-refresh-js");
const pendingJsElement = document.getElementById("pending-js");
const filesListElement = document.getElementById("files-list");
const refreshButtonElement = document.getElementById("refresh-model");
const openOptionsButtonElement = document.getElementById("open-options");

let model = null;

/**
 * Send a runtime message and return a Promise for UI-friendly async handling.
 * @param {any} payload - Message or payload object exchanged between extension components.
 * @returns {Promise<any>} Response payload from background script.
 */
function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      // Normalize callback-style Chrome APIs into Promise flow for predictable async UI updates.
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

    await sendMessage({
      type: "POPUP_SET_ENABLED_FILES",
      hostKey: model.hostKey,
      tabId: model.tabId,
      enabledFileIds: Array.from(nextSelection),
    });

    await refreshModel();
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
 * Render status text with error styling support.
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @param {any} isError - True when status should be rendered with error styling.
 * @returns {void} Updates status area content and error style.
 */
function setStatus(message, isError) {
  statusMessageElement.textContent = message;
  statusMessageElement.classList.toggle("status-error", isError);
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

  filesListElement.innerHTML = "";

  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "No CSS/JS files found on the local manifest.";
    filesListElement.appendChild(empty);
    return;
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
    const response = await sendMessage({ type: "POPUP_GET_MODEL" });
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

  await sendMessage({
    type: "POPUP_SET_AUTO_REFRESH_JS",
    hostKey: model.hostKey,
    autoRefreshJs: autoRefreshJsElement.checked,
  });

  await refreshModel();
});

refreshButtonElement.addEventListener("click", async () => {
  await sendMessage({ type: "POPUP_FORCE_SYNC" });
  await refreshModel();
});

openOptionsButtonElement.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshModel();
