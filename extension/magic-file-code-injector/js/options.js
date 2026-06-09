const statusMessageElement = document.getElementById("status-message");
const serverOriginElement = document.getElementById("server-origin");
const portFormElement = document.getElementById("port-form");
const portInputElement = document.getElementById("port-input");
const siteListElement = document.getElementById("site-list");
const refreshOptionsElement = document.getElementById("refresh-options");
const { sendRuntimeMessage, setStatusMessage } = self.MfciRuntimeUtils;
const { SCOPE_TYPES, isRegexScope, parseScopeKey, getDefaultRegexForScope, getScopeValueForType, validateScopeFields } = self.MfciScopeUtils;

let model = null;

function setInlineError(element, message) {
  element.classList.toggle("hidden", !message);
  element.textContent = message;
}

function getEditedScopeValue(scope, scopeType, input) {
  return isRegexScope(scopeType) ? input.value : getScopeValueForType(scope, scopeType);
}

function getEditedScopeKey(scope, scopeType, input) {
  return validateScopeFields(scopeType, getEditedScopeValue(scope, scopeType, input)).key;
}

/**
 * Render the enabled-file list shown in options for one host.
 * @param {string[]} enabledFileIds - Enabled file IDs for the current host.
 * @returns {HTMLElement} Rendered block listing enabled files.
 */
function createEnabledFilesBlock(enabledFileIds) {
  const block = document.createElement("div");
  block.className = "enabled-files";

  const title = document.createElement("div");
  title.className = "enabled-files-title";
  title.textContent = "Enabled files";
  block.appendChild(title);

  if (enabledFileIds.length === 0) {
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
 * Render editable injection target controls for one saved settings row.
 * @param {string} hostKey - Saved scope key.
 * @returns {HTMLElement} Editable scope form.
 */
function createScopeEditor(hostKey) {
  const scope = parseScopeKey(hostKey);
  let savedScopeKey = hostKey;
  const form = document.createElement("form");
  form.className = "scope-editor";

  const select = document.createElement("select");
  select.className = "select";
  for (const scopeType of SCOPE_TYPES) {
    select.add(new Option(scopeType, scopeType));
  }
  select.value = scope.type;

  const input = document.createElement("input");
  input.className = "input mono";
  input.type = "text";
  input.value = isRegexScope(scope.type) ? scope.value : "";
  input.placeholder = "https://.*\\.domain\\.com/.*";
  input.classList.toggle("hidden", !isRegexScope(scope.type));

  const saveButton = document.createElement("button");
  saveButton.className = "button";
  saveButton.type = "submit";
  saveButton.textContent = "Save";
  saveButton.classList.add("hidden");

  const status = document.createElement("div");
  status.className = "status status-error hidden";

  function syncScopeEditor() {
    const usesRegex = isRegexScope(select.value);
    input.classList.toggle("hidden", !usesRegex);
    if (usesRegex && input.value.trim() === "") {
      input.value = getDefaultRegexForScope(scope);
    }

    saveButton.classList.toggle("hidden", getEditedScopeKey(scope, select.value, input) === savedScopeKey);
    setInlineError(status, "");
  }

  select.addEventListener("change", () => {
    syncScopeEditor();
  });
  input.addEventListener("input", syncScopeEditor);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const validation = validateScopeFields(select.value, getEditedScopeValue(scope, select.value, input));
    if (!validation.ok) {
      setInlineError(status, validation.error);
      return;
    }

    select.disabled = true;
    input.disabled = true;
    saveButton.disabled = true;
    setInlineError(status, "");

    try {
      const response = await sendRuntimeMessage({
        type: "OPTIONS_RENAME_HOST",
        hostKey: savedScopeKey,
        nextHostKey: validation.key,
      });

      if (!response || response.ok !== true) {
        setInlineError(status, (response && response.error) || "Failed to update injection target.");
        return;
      }

      savedScopeKey = validation.key;
      saveButton.classList.add("hidden");
    } catch (error) {
      setInlineError(status, String(error.message || error));
      return;
    } finally {
      select.disabled = false;
      input.disabled = false;
      saveButton.disabled = false;
    }

    await refreshModel();
  });

  form.appendChild(select);
  form.appendChild(input);
  form.appendChild(saveButton);
  form.appendChild(status);
  syncScopeEditor();
  return form;
}

/**
 * Render one host settings row with deletion action in options UI.
 * @param {string} hostKey - Domain key used to isolate per-site settings.
 * @param {object} hostState - Per-site configuration including enabled files and JS refresh mode.
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

    const response = await sendRuntimeMessage({
      type: "OPTIONS_DELETE_HOST",
      hostKey,
    });

    if (!response || response.ok !== true) {
      setStatusMessage(statusMessageElement, (response && response.error) || "Failed to delete site settings.", true);
      return;
    }

    delete model.hosts[hostKey];
    row.remove();
    if (Object.keys(model.hosts).length === 0) {
      renderSites(model.hosts);
    }
  });

  top.appendChild(meta);
  top.appendChild(removeButton);

  row.appendChild(top);
  row.appendChild(createScopeEditor(hostKey));
  row.appendChild(createEnabledFilesBlock(hostState.enabledFileIds));

  return row;
}

/**
 * Render all saved host settings in options UI.
 * @param {Record<string, object>} hosts - Map of host states keyed by domain.
 * @returns {void} Renders complete host settings list.
 */
function renderSites(hosts) {
  siteListElement.innerHTML = "";

  const entries = Object.entries(hosts).sort(([left], [right]) => left.localeCompare(right));
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
  serverOriginElement.textContent = model.server.origin;
  portInputElement.value = model.global.port;

  if (model.server.websocketError) {
    setStatusMessage(statusMessageElement, model.server.websocketError, true);
  } else if (model.server.websocketConnected) {
    setStatusMessage(statusMessageElement, "Connected to local server WebSocket.", false);
  } else {
    setStatusMessage(statusMessageElement, "Waiting for local server WebSocket connection.", false);
  }

  renderSites(model.hosts);
}

/**
 * Refresh UI model from background script then re-render.
 * @returns {Promise<void>} Fetches fresh model and triggers render.
 */
async function refreshModel() {
  try {
    const response = await sendRuntimeMessage({ type: "OPTIONS_GET_MODEL" });
    model = response;
    render();
  } catch (error) {
    setStatusMessage(statusMessageElement, String(error.message || error), true);
  }
}

portFormElement.addEventListener("submit", async (event) => {
  event.preventDefault();

  const port = Number(portInputElement.value);
  const response = await sendRuntimeMessage({
    type: "OPTIONS_SET_PORT",
    port,
  });

  if (!response || response.ok !== true) {
    setStatusMessage(statusMessageElement, (response && response.error) || "Unable to update port.", true);
    return;
  }

  await refreshModel();
});

refreshOptionsElement.addEventListener("click", async () => {
  await refreshModel();
});

refreshModel();
