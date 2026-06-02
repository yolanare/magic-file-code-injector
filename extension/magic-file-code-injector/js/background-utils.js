(() => {
  if (!self.MfciScopeUtils && typeof importScripts === "function") {
    importScripts("scope-utils.js");
  }

  if (!self.MfciScopeUtils) {
    throw new Error("[mfci] scope-utils.js must be loaded before background-utils.js.");
  }

  const {
    DEFAULT_SCOPE_TYPE,
    normalizeScopeType,
    normalizeScopeRegex,
    normalizeStoredScopeKey,
    parseScopeKey,
    getDefaultScopeRegex,
    testScopeRegex,
    getScopeSpecificity,
  } = self.MfciScopeUtils;

  const STORAGE_KEY = "magicFileCodeInjectorState";
  const DEFAULT_STATE = {
    global: {
      host: "127.0.0.1",
      port: 35888,
      injectionEnabled: true,
      injectScopeType: DEFAULT_SCOPE_TYPE,
      injectScopeRegex: "",
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
  const PORT_ERROR = "Port must be a number between 1 and 65535.";

  /**
   * Deduplicate user settings arrays before persistence to keep storage deterministic and compact.
   * @param {unknown} values - Candidate list of values loaded from storage or messages.
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
   * @param {unknown} input - Raw host state from storage.
   * @returns {object} Safe host state.
   */
  function normalizeHostState(input) {
    const source = input && typeof input === "object" ? input : {};

    return {
      enabledFileIds: uniqueStrings(source.enabledFileIds),
      autoRefreshJs: source.autoRefreshJs === true,
      pendingJsUpdateIds: uniqueStrings(source.pendingJsUpdateIds),
      lastError: typeof source.lastError === "string" ? source.lastError : "",
    };
  }

  /**
   * Merge duplicate target states produced by legacy-key normalization.
   * @param {object} currentState - Existing normalized host state.
   * @param {object} nextState - Next normalized host state.
   * @returns {object} Merged host state.
   */
  function mergeHostStates(currentState, nextState) {
    const current = normalizeHostState(currentState);
    const next = normalizeHostState(nextState);
    return {
      enabledFileIds: uniqueStrings([...current.enabledFileIds, ...next.enabledFileIds]),
      autoRefreshJs: current.autoRefreshJs || next.autoRefreshJs,
      pendingJsUpdateIds: uniqueStrings([...current.pendingJsUpdateIds, ...next.pendingJsUpdateIds]),
      lastError: next.lastError || current.lastError,
    };
  }

  const normalizeInjectScopeType = normalizeScopeType;
  const normalizeInjectScopeRegex = normalizeScopeRegex;

  function validatePort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ?
        { ok: true, port, error: "" }
      : { ok: false, port: DEFAULT_STATE.global.port, error: PORT_ERROR };
  }

  /**
   * Normalize the complete extension state object loaded from storage.
   * @param {unknown} input - Raw storage payload.
   * @returns {object} Safe state object.
   */
  function normalizeState(input) {
    const source = input && typeof input === "object" ? input : {};
    const globalState = source.global && typeof source.global === "object" ? source.global : {};

    const host = typeof globalState.host === "string" && globalState.host.trim().length > 0 ? globalState.host.trim() : DEFAULT_STATE.global.host;
    const port = validatePort(globalState.port).port;
    const injectionEnabled =
      typeof globalState.injectionEnabled === "boolean" ? globalState.injectionEnabled : DEFAULT_STATE.global.injectionEnabled;
    const injectScopeType = normalizeInjectScopeType(globalState.injectScopeType);
    const injectScopeRegex = normalizeInjectScopeRegex(globalState.injectScopeRegex);

    const hosts = {};
    if (source.hosts && typeof source.hosts === "object") {
      for (const [hostKey, hostState] of Object.entries(source.hosts)) {
        const normalizedHostKey = normalizeStoredScopeKey(hostKey);
        if (!normalizedHostKey) {
          continue;
        }
        hosts[normalizedHostKey] = hosts[normalizedHostKey] ? mergeHostStates(hosts[normalizedHostKey], hostState) : normalizeHostState(hostState);
      }
    }

    return {
      global: { host, port, injectionEnabled, injectScopeType, injectScopeRegex },
      hosts,
    };
  }

  /**
   * Build local server origin from the persisted global state.
   * @param {{host:string,port:number}} globalState - Global host/port settings.
   * @returns {string} HTTP origin.
   */
  function getServerOrigin(globalState) {
    return `http://${globalState.host}:${globalState.port}`;
  }

  /**
   * Build manifest URL from persisted global state.
   * @param {{host:string,port:number}} globalState - Global host/port settings.
   * @returns {string} Absolute manifest URL.
   */
  function getManifestUrl(globalState) {
    return `${getServerOrigin(globalState)}${MANIFEST_ROUTE}`;
  }

  /**
   * Normalize changed paths from LiveReload payloads for deterministic comparisons.
   * @param {unknown} value - Path or URL value.
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
   * @param {unknown} value - Path-like value.
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
   * @param {unknown} fileId - Manifest id.
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
   * @param {string} urlValue - URL candidate.
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
   * Resolve a broad domain key without a public-suffix dependency.
   * @param {string} hostname - URL hostname.
   * @returns {string} Last-two-label domain fallback, or the host itself for IP/localhost-like values.
   */
  function getDomainKey(hostname) {
    const normalizedHost = String(hostname || "").toLowerCase();
    if (!normalizedHost || normalizedHost === "localhost" || /^[\d.:]+$/.test(normalizedHost)) {
      return normalizedHost;
    }

    const labels = normalizedHost.split(".").filter(Boolean);
    if (labels.length <= 2) {
      return normalizedHost;
    }

    return labels.slice(-2).join(".");
  }

  /**
   * Normalize page paths so homepage targeting remains distinct from whole-domain targeting.
   * @param {unknown} pathname - URL pathname.
   * @returns {string} Stable page path.
   */
  function normalizePagePathname(pathname) {
    const normalizedPath = typeof pathname === "string" && pathname.length > 0 ? pathname : "/";
    return normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  }

  /**
   * Resolve a page key from hostname + path, intentionally excluding query/hash noise.
   * @param {URL} parsedUrl - Parsed tab URL.
   * @returns {string} Page scope value displayed as `host/path`.
   */
  function getPageKey(parsedUrl) {
    const pathname = normalizePagePathname(parsedUrl.pathname);
    return `${parsedUrl.hostname.toLowerCase()}${pathname}`;
  }

  function createScopeDetails(type, key, context, status = {}) {
    return {
      type,
      key,
      label: context.labels[type],
      labels: context.labels,
      regex: context.regexPattern,
      defaultRegex: context.defaultRegex,
      valid: status.valid !== false,
      matchesCurrentUrl: status.matches !== false,
      error: status.error || "",
    };
  }

  const SCOPE_DETAIL_FACTORIES = {
    domain: (context) => createScopeDetails("domain", `domain:${context.domainKey}`, context),
    page: (context) => createScopeDetails("page", `page:${context.pageKey}`, context),
    subdomain: (context) => ({
      ...createScopeDetails("subdomain", `subdomain:${context.hostname}`, context),
      legacyKey: context.hostname,
    }),
    regex: (context, options) => {
      const status = testScopeRegex(context.regexPattern, context.urlValue);
      if (options.requireMatch && (!status.valid || !status.matches)) {
        return null;
      }

      return createScopeDetails("regex", status.valid ? `regex:${context.regexPattern}` : "", context, status);
    },
  };

  /**
   * Resolve the configured injection scope for a tab URL.
   * @param {string} urlValue - Absolute tab URL.
   * @param {object} globalState - Normalized global extension settings.
   * @param {{requireMatch?:boolean}} options - Whether regex scopes must match the current URL.
   * @returns {object|null} Scope details, or null for unsupported tab URLs / unmatched regex.
   */
  function getInjectScopeDetails(urlValue, globalState, options = {}) {
    let parsedUrl;
    try {
      parsedUrl = new URL(urlValue);
    } catch (_error) {
      return null;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const domainKey = getDomainKey(hostname);
    const pageKey = getPageKey(parsedUrl);
    const defaultRegex = getDefaultScopeRegex(domainKey);
    const regexPattern = normalizeInjectScopeRegex(globalState && globalState.injectScopeRegex) || defaultRegex;

    const labels = {
      domain: `domain (${domainKey})`,
      subdomain: `subdomain (${hostname})`,
      page: `page (${pageKey})`,
      regex: "regex",
    };

    const scopeType = normalizeInjectScopeType(globalState && globalState.injectScopeType);
    return SCOPE_DETAIL_FACTORIES[scopeType]({ urlValue, hostname, domainKey, pageKey, labels, regexPattern, defaultRegex }, options);
  }

  const SCOPE_URL_MATCHERS = {
    domain: (scope, context) => scope.value.toLowerCase() === getDomainKey(context.hostname),
    subdomain: (scope, context) => scope.value.toLowerCase() === context.hostname,
    page: (scope, context) => scope.value.toLowerCase() === getPageKey(context.parsedUrl).toLowerCase(),
    regex: (scope, context) => testScopeRegex(scope.value, context.urlValue).matches,
  };

  /**
   * Check whether a saved scope key matches one tab URL.
   * @param {string} scopeKey - Saved scope key.
   * @param {string} urlValue - Absolute tab URL.
   * @returns {boolean} True when the scope applies to the URL.
   */
  function injectScopeKeyMatchesUrl(scopeKey, urlValue) {
    let parsedUrl;
    try {
      parsedUrl = new URL(urlValue);
    } catch (_error) {
      return false;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return false;
    }

    const scope = parseScopeKey(scopeKey);
    const hostname = parsedUrl.hostname.toLowerCase();
    return SCOPE_URL_MATCHERS[scope.type](scope, { hostname, parsedUrl, urlValue });
  }

  /**
   * Pick the saved injection target that should control one URL.
   * @param {string} urlValue - Absolute tab URL.
   * @param {Record<string, object>} hosts - Saved target map.
   * @returns {string} Best matching saved key, or empty string.
   */
  function getBestMatchingHostKey(urlValue, hosts) {
    const entries = Object.keys(hosts && typeof hosts === "object" ? hosts : {})
      .filter((scopeKey) => injectScopeKeyMatchesUrl(scopeKey, urlValue))
      .map((scopeKey) => ({
        scopeKey,
        specificity: getScopeSpecificity(parseScopeKey(scopeKey).type),
      }))
      .sort((left, right) => right.specificity - left.specificity || left.scopeKey.localeCompare(right.scopeKey));

    return entries.length > 0 ? entries[0].scopeKey : "";
  }

  /**
   * Normalize one manifest file entry to a runtime-safe shape.
   * @param {unknown} file - Raw manifest entry.
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
   * @param {{path:string}} file - Normalized manifest file descriptor.
   * @param {string} origin - Server origin.
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
    const uniqueIds = uniqueStrings(fileIds);
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
   * @param {Record<string, object>} hosts - Host map.
   * @returns {Array<[string, object]>} Sorted host entries.
   */
  function sortedHostEntries(hosts) {
    return Object.entries(hosts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([hostKey, hostState]) => [hostKey, normalizeHostState(hostState)]);
  }

  /**
   * Reduce host state to options-safe fields exposed to the UI.
   * @param {unknown} hostState - Raw host state.
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
    DEFAULT_HOST_STATE,
    uniqueStrings,
    normalizeHostState,
    normalizeState,
    normalizeInjectScopeType,
    normalizeInjectScopeRegex,
    validatePort,
    getServerOrigin,
    getManifestUrl,
    normalizeChangedPath,
    inferFileTypeFromPath,
    normalizePathFromFileId,
    getHostKey,
    getInjectScopeDetails,
    parseInjectScopeKey: parseScopeKey,
    getBestMatchingHostKey,
    normalizeManifestFile,
    resolveFileUrl,
    formatRefreshLogMessage,
    sortedHostEntries,
    toOptionsHostState,
  };
})();
