const statusMessageElement = document.getElementById("status-message");
const serverOriginElement = document.getElementById("server-origin");
const portFormElement = document.getElementById("port-form");
const portInputElement = document.getElementById("port-input");
const siteListElement = document.getElementById("site-list");
const rawSettingsElement = document.getElementById("raw-settings");
const refreshOptionsElement = document.getElementById("refresh-options");

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

function setStatus(message, isError) {
  statusMessageElement.textContent = message;
  statusMessageElement.classList.toggle("status-error", isError);
}

function createSiteRow(hostKey, hostState) {
  const row = document.createElement("div");
  row.className = "site-row";

  const meta = document.createElement("div");
  meta.className = "site-meta";

  const host = document.createElement("div");
  host.className = "site-host mono";
  host.textContent = hostKey;

  const info = document.createElement("div");
  info.className = "site-info";
  info.textContent = [
    `enabled: ${(hostState.enabledFileIds || []).length}`,
    `autoRefreshJs: ${hostState.autoRefreshJs === true ? "true" : "false"}`,
    `pendingJs: ${(hostState.pendingJsUpdateIds || []).length}`,
  ].join(" | ");

  meta.appendChild(host);
  meta.appendChild(info);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "button button-danger";
  removeButton.textContent = "Delete";
  removeButton.addEventListener("click", async () => {
    const confirmed = window.confirm(`Delete saved settings for ${hostKey}?`);
    if (!confirmed) {
      return;
    }

    const response = await sendMessage({
      type: "OPTIONS_DELETE_HOST",
      hostKey,
    });

    if (!response || response.ok !== true) {
      setStatus((response && response.error) || "Failed to delete site settings.", true);
      return;
    }

    await refreshModel();
  });

  row.appendChild(meta);
  row.appendChild(removeButton);

  return row;
}

function renderSites(hosts) {
  siteListElement.innerHTML = "";

  const entries = Object.entries(hosts || {}).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "No saved site settings.";
    siteListElement.appendChild(empty);
    return;
  }

  for (const [hostKey, hostState] of entries) {
    siteListElement.appendChild(createSiteRow(hostKey, hostState));
  }
}

function render() {
  if (!model) {
    return;
  }

  serverOriginElement.textContent = model.server.origin;
  portInputElement.value = model.global.port;

  if (model.server.websocketError) {
    setStatus(model.server.websocketError, true);
  } else if (model.server.websocketConnected) {
    setStatus("Connected to local server WebSocket.", false);
  } else {
    setStatus("Waiting for local server WebSocket connection.", false);
  }

  renderSites(model.hosts || {});
  rawSettingsElement.textContent = JSON.stringify(model.rawState || {}, null, 2);
}

async function refreshModel() {
  try {
    const response = await sendMessage({ type: "OPTIONS_GET_MODEL" });
    model = response;
    render();
  } catch (error) {
    setStatus(String(error.message || error), true);
  }
}

portFormElement.addEventListener("submit", async (event) => {
  event.preventDefault();

  const port = Number(portInputElement.value);
  const response = await sendMessage({
    type: "OPTIONS_SET_PORT",
    port,
  });

  if (!response || response.ok !== true) {
    setStatus((response && response.error) || "Unable to update port.", true);
    return;
  }

  await refreshModel();
});

refreshOptionsElement.addEventListener("click", async () => {
  await refreshModel();
});

refreshModel();
