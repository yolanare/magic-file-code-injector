const hostValueElement = document.getElementById("host-value");
const serverValueElement = document.getElementById("server-value");
const statusMessageElement = document.getElementById("status-message");
const autoRefreshJsElement = document.getElementById("auto-refresh-js");
const pendingJsElement = document.getElementById("pending-js");
const filesListElement = document.getElementById("files-list");
const refreshButtonElement = document.getElementById("refresh-model");
const openOptionsButtonElement = document.getElementById("open-options");

let model = null;

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

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

function setStatus(message, isError) {
  statusMessageElement.textContent = message;
  statusMessageElement.classList.toggle("status-error", isError);
}

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
