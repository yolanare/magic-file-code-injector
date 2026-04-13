const path = require("node:path");

/**
 * Ensure route-like values always start with "/" so URL matching stays deterministic.
 * @param {any} value - Raw route candidate.
 * @returns {string} Normalized route path.
 */
function ensureLeadingSlash(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "/";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

/**
 * Validate and normalize a port value to avoid invalid runtime binding.
 * @param {any} value - Raw port candidate.
 * @param {number} fallbackPort - Port used when value is invalid.
 * @returns {number} Safe port.
 */
function normalizePort(value, fallbackPort) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return fallbackPort;
}

/**
 * Collapse file type values to the supported set used by manifest and injection flows.
 * @param {any} typeValue - Candidate file type value.
 * @returns {"html"|"css"|"js"} Supported file type key.
 */
function normalizeType(typeValue) {
  if (typeValue === "html") {
    return "html";
  }
  if (typeValue === "js") {
    return "js";
  }
  return "css";
}

/**
 * Provide extension defaults per file type so config can stay minimal.
 * @param {any} typeValue - Candidate file type value.
 * @returns {string[]} Default extension list.
 */
function defaultExtensionsForType(typeValue) {
  if (typeValue === "html") {
    return [".html"];
  }
  if (typeValue === "js") {
    return [".js", ".mjs"];
  }
  return [".css"];
}

/**
 * Provide serving URL defaults per file type to keep extension paths predictable.
 * @param {any} typeValue - Candidate file type value.
 * @returns {string} Default URL prefix.
 */
function defaultUrlPrefixForType(typeValue) {
  if (typeValue === "html") {
    return "/html";
  }
  if (typeValue === "js") {
    return "/js";
  }
  return "/css";
}

/**
 * Normalize path separators to web format for manifest URLs across operating systems.
 * @param {string} value - Raw path value.
 * @returns {string} Path with POSIX separators.
 */
function toForwardSlashes(value) {
  return String(value || "").split(path.sep).join("/");
}

/**
 * Map a changed path to a reload category used for logging and LiveReload signaling.
 * @param {any} filePath - Filesystem path.
 * @returns {"html"|"css"|"js"|"asset"} Reload category.
 */
function inferReloadType(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".html") {
    return "html";
  }
  if (extension === ".css") {
    return "css";
  }
  if (extension === ".js" || extension === ".mjs") {
    return "js";
  }
  return "asset";
}

/**
 * Protect against path traversal by ensuring a target stays inside the configured root.
 * @param {any} basePath - Base directory.
 * @param {any} targetPath - Candidate path.
 * @returns {boolean} True when target is strictly inside basePath.
 */
function isPathInside(basePath, targetPath) {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

/**
 * Variant of path containment check that also accepts the exact same path.
 * @param {any} basePath - Base directory.
 * @param {any} targetPath - Candidate path.
 * @returns {boolean} True when target equals or is inside basePath.
 */
function isPathInsideOrSame(basePath, targetPath) {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

module.exports = {
  ensureLeadingSlash,
  normalizePort,
  normalizeType,
  defaultExtensionsForType,
  defaultUrlPrefixForType,
  toForwardSlashes,
  inferReloadType,
  isPathInside,
  isPathInsideOrSame,
};
