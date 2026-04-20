const path = require('node:path');

const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    gray: '\x1b[90m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
};

const LEVEL_STYLE = {
    info: { label: 'INFO', color: ANSI.cyan },
    success: { label: 'OK', color: ANSI.green },
    warn: { label: 'WARN', color: ANSI.yellow },
    error: { label: 'ERROR', color: ANSI.red },
};

/**
 * Decide once if ANSI colors should be enabled for terminal logs.
 * @returns {boolean} True when color output should be used.
 */
function supportsColor() {
    if (process.env.NO_COLOR) {
        return false;
    }
    if (typeof process.env.FORCE_COLOR === 'string') {
        return process.env.FORCE_COLOR !== '0';
    }
    return Boolean(process.stdout && process.stdout.isTTY);
}

/**
 * Apply one ANSI style sequence to a text fragment.
 * @param {string} value - Raw text to decorate.
 * @param {string} ansiCode - ANSI escape sequence for the style.
 * @param {boolean} enabled - Whether styling is active.
 * @returns {string} Styled text or original value.
 */
function applyStyle(value, ansiCode, enabled) {
    if (!enabled) {
        return value;
    }
    return `${ansiCode}${value}${ANSI.reset}`;
}

/**
 * Normalize path separators for stable, readable log output.
 * @param {string} value - Filesystem path to normalize.
 * @returns {string} Path using forward slashes.
 */
function toPosixPath(value) {
    return String(value ?? '')
        .split(path.sep)
        .join('/');
}

/**
 * Format file paths in gray so noisy path details stay readable but secondary.
 * @param {string} value - Path to print in logs.
 * @param {object} options - Formatting options.
 * @returns {string} Styled path value.
 */
function formatPath(value, options = {}) {
    const useColor = typeof options.useColor === 'boolean' ? options.useColor : supportsColor();
    return applyStyle(toPosixPath(value), ANSI.gray, useColor);
}

/**
 * Build one structured log line with prefix + severity level.
 * @param {object} options - Log rendering options.
 * @returns {string} Structured and optionally colorized log line.
 */
function formatLogLine(options = {}) {
    const level = LEVEL_STYLE[options.level] ? options.level : 'info';
    const levelStyle = LEVEL_STYLE[level];
    const prefix = String(options.prefix || '[log]');
    const message = String(options.message || '');
    const useColor = typeof options.useColor === 'boolean' ? options.useColor : supportsColor();

    // Keep prefix low-contrast so the actionable part is the level + message.
    const styledPrefix = applyStyle(prefix, ANSI.gray, useColor);
    const styledLevel = applyStyle(levelStyle.label, levelStyle.color, useColor);
    return `${styledPrefix} ${styledLevel} ${message}`.trim();
}

module.exports = {
    supportsColor,
    formatPath,
    formatLogLine,
};
