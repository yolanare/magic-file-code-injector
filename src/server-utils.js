const path = require('node:path');

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
    return String(value || '')
        .split(path.sep)
        .join('/');
}

/**
 * Map a changed path to a reload category used by logging and extension sync.
 * @param {string} filePath - Filesystem path.
 * @returns {"html"|"css"|"js"|"asset"} Reload category.
 */
function inferReloadType(filePath) {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    if (extension === '.html') {
        return 'html';
    }
    if (extension === '.css') {
        return 'css';
    }
    if (extension === '.js' || extension === '.mjs') {
        return 'js';
    }
    return 'asset';
}

/**
 * Path containment check that rejects exact equality.
 * @param {string} basePath - Base directory.
 * @param {string} targetPath - Candidate path.
 * @returns {boolean} True when target is strictly inside base.
 */
function isPathInside(basePath, targetPath) {
    const relativePath = path.relative(path.resolve(basePath), path.resolve(targetPath));
    return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/**
 * Path containment check that accepts equality.
 * @param {string} basePath - Base directory.
 * @param {string} targetPath - Candidate path.
 * @returns {boolean} True when target equals or is inside base.
 */
function isPathInsideOrSame(basePath, targetPath) {
    const relativePath = path.relative(path.resolve(basePath), path.resolve(targetPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

module.exports = {
    normalizePort,
    toForwardSlashes,
    inferReloadType,
    isPathInside,
    isPathInsideOrSame,
};
