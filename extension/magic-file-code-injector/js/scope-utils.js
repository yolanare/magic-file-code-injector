(() => {
  const DEFAULT_SCOPE_TYPE = "page";
  const LEGACY_SCOPE_TYPE = "subdomain";
  const REGEX_SCOPE_TYPE = "regex";
  const SCOPE_TYPES = ["domain", "subdomain", "page", REGEX_SCOPE_TYPE];
  const SCOPE_TYPE_SET = new Set(SCOPE_TYPES);
  const SCOPE_SPECIFICITY = {
    domain: 10,
    subdomain: 20,
    regex: 30,
    page: 40,
  };

  /**
   * Normalize a persisted or user-selected scope type.
   * @param {unknown} value - Raw scope type.
   * @returns {"domain"|"subdomain"|"page"|"regex"} Safe scope type.
   */
  function normalizeScopeType(value) {
    return SCOPE_TYPE_SET.has(value) ? value : DEFAULT_SCOPE_TYPE;
  }

  function isRegexScope(type) {
    return normalizeScopeType(type) === REGEX_SCOPE_TYPE;
  }

  /**
   * Normalize a custom regex pattern used as an injection target key.
   * @param {unknown} value - Raw regex value.
   * @returns {string} Trimmed regex pattern.
   */
  function normalizeScopeRegex(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  /**
   * Parse one saved scope key, keeping bare legacy hostnames as subdomain scopes.
   * @param {unknown} scopeKey - Saved scope key.
   * @returns {{type:string,value:string}} Parsed scope parts.
   */
  function parseScopeKey(scopeKey) {
    const key = typeof scopeKey === "string" ? scopeKey.trim() : "";
    const separatorIndex = key.indexOf(":");
    if (separatorIndex < 0) {
      return { type: LEGACY_SCOPE_TYPE, value: key };
    }

    const type = key.slice(0, separatorIndex);
    const value = key.slice(separatorIndex + 1);
    return SCOPE_TYPE_SET.has(type) ? { type, value } : { type: LEGACY_SCOPE_TYPE, value: key };
  }

  /**
   * Build a normalized scope key from editable scope parts.
   * @param {unknown} type - Scope type.
   * @param {unknown} value - Scope value.
   * @returns {string} Saved scope key, or empty string when value is empty.
   */
  function buildScopeKey(type, value) {
    const scopeValue = normalizeScopeRegex(value);
    return scopeValue ? `${normalizeScopeType(type)}:${scopeValue}` : "";
  }

  /**
   * Normalize saved target keys to the explicit `type:value` format.
   * @param {unknown} scopeKey - Saved target key.
   * @returns {string} Normalized target key.
   */
  function normalizeStoredScopeKey(scopeKey) {
    const scope = parseScopeKey(scopeKey);
    return buildScopeKey(scope.type, scope.value);
  }

  /**
   * Escape a literal string for use inside a generated regular expression.
   * @param {string} value - Literal value to escape.
   * @returns {string} Regex-safe literal.
   */
  function escapeRegexLiteral(value) {
    return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  }

  function unescapeRegexLiteral(value) {
    return value.replace(/\\([\\^$.*+?()[\]{}|/])/g, "$1");
  }

  function getDomainValue(hostname) {
    const host = hostname.toLowerCase();
    if (!host || host === "localhost" || /^[\d.:]+$/.test(host)) {
      return host;
    }

    const labels = host.split(".").filter(Boolean);
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
  }

  function getPlainScopeValue(scope) {
    const value = normalizeScopeRegex(scope.value);
    return isRegexScope(scope.type) ? unescapeRegexLiteral(value) : value;
  }

  function getScopeUrlLikeParts(scope) {
    const value = getPlainScopeValue(scope);
    try {
      const parsedUrl = new URL(value);
      return { host: parsedUrl.hostname.toLowerCase(), page: `${parsedUrl.hostname.toLowerCase()}${parsedUrl.pathname || "/"}` };
    } catch (_error) {
      const valueWithoutProtocol = value.replace(/^https?:\/\//, "");
      const host = valueWithoutProtocol.split(/[/?#]/)[0].toLowerCase();
      const pathStart = valueWithoutProtocol.indexOf("/");
      const path = pathStart >= 0 ? valueWithoutProtocol.slice(pathStart).split(/[?#]/)[0] || "/" : "/";
      return { host, page: `${host}${path}` };
    }
  }

  /**
   * Build the default regex target from a broad domain key.
   * @param {string} domainKey - Broad domain key, for example `domain.com`.
   * @returns {string} Default regex pattern.
   */
  function getDefaultScopeRegex(domainKey) {
    return domainKey ? escapeRegexLiteral(`${domainKey}/`) : "";
  }

  /**
   * Suggest a regex from an existing scope value without needing URL context.
   * @param {{type:string,value:string}} scope - Scope parts.
   * @returns {string} Suggested regex pattern.
   */
  function getDefaultRegexForScope(scope) {
    const value = isRegexScope(scope.type) ? normalizeScopeRegex(scope.value) : getScopeValueForType(scope, scope.type);
    if (!value) {
      return "";
    }

    if (isRegexScope(scope.type)) {
      return value;
    }

    return scope.type === "domain" || scope.type === "subdomain" ?
        escapeRegexLiteral(`${value}/`)
      : escapeRegexLiteral(value);
  }

  function getScopeValueForType(scope, targetType) {
    const type = normalizeScopeType(targetType);
    if (isRegexScope(type)) {
      return isRegexScope(scope.type) ? normalizeScopeRegex(scope.value) : getDefaultRegexForScope(scope);
    }

    const parts = getScopeUrlLikeParts(scope);
    if (type === "domain") {
      return getDomainValue(parts.host);
    }
    if (type === "subdomain") {
      return parts.host;
    }
    return parts.page;
  }

  /**
   * Test one regex pattern without leaking RegExp state between calls.
   * @param {string} pattern - Candidate regex pattern.
   * @param {string} value - Value tested against the regex.
   * @returns {{valid:boolean,matches:boolean,error:string}} Regex status.
   */
  function testScopeRegex(pattern, value = "") {
    if (!pattern) {
      return { valid: false, matches: false, error: "Regex is required." };
    }

    try {
      const regex = new RegExp(pattern);
      return { valid: true, matches: regex.test(value), error: "" };
    } catch (error) {
      return { valid: false, matches: false, error: String(error.message || error) };
    }
  }

  /**
   * Validate editable scope fields and return the normalized storage key.
   * @param {unknown} type - Editable scope type.
   * @param {unknown} value - Editable scope value.
   * @returns {{ok:boolean,key:string,error:string}} Validation result.
   */
  function validateScopeFields(type, value) {
    const normalizedType = normalizeScopeType(type);
    const key = buildScopeKey(normalizedType, value);
    if (!key) {
      return { ok: false, key: "", error: "Target value is required." };
    }

    if (isRegexScope(normalizedType)) {
      const regexStatus = testScopeRegex(normalizeScopeRegex(value));
      if (!regexStatus.valid) {
        return { ok: false, key: "", error: regexStatus.error };
      }
    }

    return { ok: true, key, error: "" };
  }

  /**
   * Return matching priority for one scope type.
   * @param {string} type - Scope type.
   * @returns {number} Specificity score.
   */
  function getScopeSpecificity(type) {
    return SCOPE_SPECIFICITY[type] || 0;
  }

  self.MfciScopeUtils = {
    DEFAULT_SCOPE_TYPE,
    LEGACY_SCOPE_TYPE,
    REGEX_SCOPE_TYPE,
    SCOPE_TYPES,
    isRegexScope,
    normalizeScopeType,
    normalizeScopeRegex,
    parseScopeKey,
    buildScopeKey,
    normalizeStoredScopeKey,
    getDefaultScopeRegex,
    getDefaultRegexForScope,
    getScopeValueForType,
    testScopeRegex,
    validateScopeFields,
    getScopeSpecificity,
  };
})();
