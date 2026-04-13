(() => {
  const STORAGE_KEY = "magicFileCodeInjectorState";
  const DEFAULT_STATE = {
    global: {
      host: "127.0.0.1",
      port: 35888,
      injectionEnabled: true,
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

  /**
   * Deduplicate user settings arrays before persistence to keep storage deterministic and compact.
   * @param {any} values - Candidate list of values loaded from storage or messages.
   * @returns {string[]} Deduplicated string list.
   */
  function uniqueStrings(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    return Array.from(new Set(values.filter((value) => typeof value === "string")));
  }

  /**
   * Normalize per-host settings to guard runtime flows from malformed storage payloads.
   * @param {any} input - Raw host state from storage.
   * @returns {object} Safe host state.
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
   * Normalize the complete extension state object loaded from storage.
   * @param {any} input - Raw storage payload.
   * @returns {object} Safe state object.
   */
  function normalizeState(input) {
    const source = input && typeof input === "object" ? input : {};
    const globalState = source.global && typeof source.global === "object" ? source.global : {};

    const host = typeof globalState.host === "string" && globalState.host.trim().length > 0 ? globalState.host.trim() : DEFAULT_STATE.global.host;
    const parsedPort = Number(globalState.port);
    const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : DEFAULT_STATE.global.port;
    const injectionEnabled =
      typeof globalState.injectionEnabled === "boolean" ? globalState.injectionEnabled : DEFAULT_STATE.global.injectionEnabled;

    const hosts = {};
    if (source.hosts && typeof source.hosts === "object") {
      for (const [hostKey, hostState] of Object.entries(source.hosts)) {
        hosts[hostKey] = normalizeHostState(hostState);
      }
    }

    return {
      global: { host, port, injectionEnabled },
      hosts,
    };
  }

  /**
   * Build local server origin from the persisted global state.
   * @param {any} globalState - Global host/port settings.
   * @returns {string} HTTP origin.
   */
  function getServerOrigin(globalState) {
    return `http://${globalState.host}:${globalState.port}`;
  }

  /**
   * Build manifest URL from persisted global state.
   * @param {any} globalState - Global host/port settings.
   * @returns {string} Absolute manifest URL.
   */
  function getManifestUrl(globalState) {
    return `${getServerOrigin(globalState)}${MANIFEST_ROUTE}`;
  }

  /**
   * Normalize changed paths from LiveReload payloads for deterministic comparisons.
   * @param {any} value - Path or URL value.
   * @returns {string} Lower-cased normalized path.
   */
  function normalizeChangedPath(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return "";
    }

    let normalized = value.trim().replace(/\\/g, "/");

    try {
      normalized = new URL(normalized).pathname;
    } catch (_error) {
      // Keep raw value when not a URL.
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
   * Infer file type from changed path extension.
   * @param {any} value - Path-like value.
   * @returns {"css"|"js"|""} File type key.
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
   * Extract a normalized path from one manifest file id (`type:/path/file.ext`).
   * @param {any} fileId - Manifest id.
   * @returns {string} Normalized path or empty string.
   */
  function normalizePathFromFileId(fileId) {
    if (typeof fileId !== "string") {
      return "";
    }

    const separatorIndex = fileId.indexOf(":");
    if (separatorIndex < 0) {
      return "";
    }

    return normalizeChangedPath(fileId.slice(separatorIndex + 1));
  }

  /**
   * Extract hostname as stable settings key for one URL.
   * @param {any} urlValue - URL candidate.
   * @returns {string|null} Host key or null when URL is unsupported.
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
   * Normalize one manifest file entry to a runtime-safe shape.
   * @param {any} file - Raw manifest entry.
   * @returns {object|null} Normalized descriptor or null when invalid.
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
   * Resolve one manifest file path to an absolute URL fetchable by the extension.
   * @param {any} file - Normalized manifest file descriptor.
   * @param {any} origin - Server origin.
   * @returns {string} Absolute URL.
   */
  function resolveFileUrl(file, origin) {
    if (/^https?:\/\//.test(file.path)) {
      return file.path;
    }
    return `${origin}${file.path}`;
  }

  /**
   * Render stable file-id labels for concise browser logs.
   * @param {string[]} fileIds - File IDs list.
   * @returns {string} Human-readable list.
   */
  function formatFileIdList(fileIds) {
    const uniqueIds = uniqueStrings(Array.isArray(fileIds) ? fileIds : []);
    if (uniqueIds.length === 0) {
      return "unknown file";
    }
    if (uniqueIds.length === 1) {
      return uniqueIds[0];
    }
    return uniqueIds.join(", ");
  }

  /**
   * Build one consistent refresh log line for CSS and JS events.
   * @param {"css"|"js"} fileType - File type.
   * @param {string[]} fileIds - Refreshed file IDs.
   * @param {boolean} fullReload - Whether a full page reload was required.
   * @returns {string} Log message.
   */
  function formatRefreshLogMessage(fileType, fileIds, fullReload) {
    const typeLabel = fileType === "js" ? "JS" : "CSS";
    const suffix = fullReload ? " (full page reload)" : "";
    return `[mfci] ${typeLabel} refreshed: ${formatFileIdList(fileIds)}${suffix}`;
  }

  /**
   * Sort host entries to keep deterministic rendering across options/popup refreshes.
   * @param {any} hosts - Host map.
   * @returns {Array<[string, object]>} Sorted host entries.
   */
  function sortedHostEntries(hosts) {
    return Object.entries(hosts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([hostKey, hostState]) => [hostKey, normalizeHostState(hostState)]);
  }

  /**
   * Reduce host state to options-safe fields exposed to the UI.
   * @param {any} hostState - Raw host state.
   * @returns {{enabledFileIds:string[],autoRefreshJs:boolean}} Options-safe host projection.
   */
  function toOptionsHostState(hostState) {
    const normalized = normalizeHostState(hostState);
    return {
      enabledFileIds: normalized.enabledFileIds,
      autoRefreshJs: normalized.autoRefreshJs,
    };
  }

  self.MfciBackgroundUtils = {
    STORAGE_KEY,
    DEFAULT_STATE,
    DEFAULT_HOST_STATE,
    MANIFEST_ROUTE,
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
    formatFileIdList,
    formatRefreshLogMessage,
    sortedHostEntries,
    toOptionsHostState,
  };
})();
