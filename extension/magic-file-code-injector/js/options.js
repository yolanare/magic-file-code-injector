const statusMessageElement = document.getElementById("status-message");
const serverOriginElement = document.getElementById("server-origin");
const portFormElement = document.getElementById("port-form");
const portInputElement = document.getElementById("port-input");
const siteListElement = document.getElementById("site-list");
const refreshOptionsElement = document.getElementById("refresh-options");

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
 * Render the enabled-file list shown in options for one host.
 * @param {any} enabledFileIds - Enabled file IDs for the current host.
 * @returns {HTMLElement} Rendered block listing enabled files.
 */
function createEnabledFilesBlock(enabledFileIds) {
  const block = document.createElement("div");
  block.className = "enabled-files";

  const title = document.createElement("div");
  title.className = "enabled-files-title";
  title.textContent = "Enabled files";
  block.appendChild(title);

  if (!enabledFileIds || enabledFileIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "enabled-files-empty";
    empty.textContent = "No file enabled.";
    block.appendChild(empty);
    return block;
  }

  const list = document.createElement("ul");
  list.className = "enabled-files-list";

  for (const fileId of enabledFileIds) {
    const item = document.createElement("li");
    item.className = "mono";
    item.textContent = fileId;
    list.appendChild(item);
  }

  block.appendChild(list);
  return block;
}

/**
 * Render one host settings row with deletion action in options UI.
 * @param {any} hostKey - Domain key used to isolate per-site settings.
 * @param {any} hostState - Per-site configuration including enabled files and JS refresh mode.
 * @returns {HTMLElement} Rendered row for one host settings entry.
 */
function createSiteRow(hostKey, hostState) {
  const row = document.createElement("div");
  row.className = "site-row";

  const top = document.createElement("div");
  top.className = "site-row-top";

  const meta = document.createElement("div");
  meta.className = "site-meta";

  const host = document.createElement("div");
  host.className = "site-host mono";
  host.textContent = hostKey;

  const info = document.createElement("div");
  info.className = "site-info";
  info.textContent = `autoRefreshJs: ${hostState.autoRefreshJs === true ? "true" : "false"}`;

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

  top.appendChild(meta);
  top.appendChild(removeButton);

  row.appendChild(top);
  row.appendChild(createEnabledFilesBlock(hostState.enabledFileIds || []));

  return row;
}

/**
 * Render all saved host settings in options UI.
 * @param {any} hosts - Map of host states keyed by domain.
 * @returns {void} Renders complete host settings list.
 */
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

/**
 * Render popup/options UI from current model state.
 * @returns {void} Renders current model into UI.
 */
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
}

/**
 * Refresh UI model from background script then re-render.
 * @returns {Promise<void>} Fetches fresh model and triggers render.
 */
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
