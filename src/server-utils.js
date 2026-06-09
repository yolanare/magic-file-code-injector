const path = require('node:path');

/**
 * Check non-empty string values before normalization.
 * @param {any} value - Candidate value.
 * @returns {boolean} True when value is a non-empty string.
 */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Keep config normalization on plain objects and reject arrays/null.
 * @param {any} value - Candidate object.
 * @returns {object} Plain object or empty object.
 */
function normalizeObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]' ? value : {};
}

/**
 * Resolve relative relationship once to avoid recomputing absolute paths in inclusion checks.
 * @param {string} basePath - Base directory.
 * @param {string} targetPath - Candidate path.
 * @returns {string} Relative path from base to target.
 */
function resolveRelativePath(basePath, targetPath) {
    return path.relative(path.resolve(basePath), path.resolve(targetPath));
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
 * Normalize path separators to web format for URLs and logs.
 * @param {string} value - Raw path value.
 * @returns {string} Path with POSIX separators.
 */
function toForwardSlashes(value) {
    return String(value ?? '')
        .split(path.sep)
        .join('/');
}

/**
 * Map a changed path to a reload category used by logging and extension sync.
 * @param {string} filePath - Filesystem path.
 * @returns {"html"|"css"|"js"|"asset"} Reload category.
 */
function inferReloadType(filePath) {
    const extension = path.extname(String(filePath ?? '')).toLowerCase();
    return (
        extension === '.html' ? 'html'
        : extension === '.css' ? 'css'
        : extension === '.js' || extension === '.mjs' ? 'js'
        : 'asset'
    );
}

/**
 * Path containment check that rejects exact equality.
 * @param {string} basePath - Base directory.
 * @param {string} targetPath - Candidate path.
 * @returns {boolean} True when target is strictly inside base.
 */
function isPathInside(basePath, targetPath) {
    const relativePath = resolveRelativePath(basePath, targetPath);
    return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/**
 * Path containment check that accepts equality.
 * @param {string} basePath - Base directory.
 * @param {string} targetPath - Candidate path.
 * @returns {boolean} True when target equals or is inside base.
 */
function isPathInsideOrSame(basePath, targetPath) {
    const relativePath = resolveRelativePath(basePath, targetPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * Check whether a path inside a root contains a dot-prefixed file or directory.
 * @param {string} basePath - Root directory used to resolve path segments.
 * @param {string} targetPath - Candidate path inside the root.
 * @returns {boolean} True when one relative path segment starts with a dot.
 */
function hasDotPathSegment(basePath, targetPath) {
    const relativePath = resolveRelativePath(basePath, targetPath);
    return relativePath.split(path.sep).some((segment) => segment.startsWith('.'));
}

module.exports = {
    isNonEmptyString,
    normalizeObject,
    normalizePort,
    toForwardSlashes,
    inferReloadType,
    isPathInside,
    isPathInsideOrSame,
    hasDotPathSegment,
};
