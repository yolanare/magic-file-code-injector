const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG_FILE = 'mfci.config.cjs';
const DEFAULT_TEMPLATE = require('./mfci.config.cjs');

/**
 * Check plain objects only so merge logic does not recurse into arrays or special instances.
 * @param {any} value - Candidate value to validate as plain object.
 * @returns {boolean} True when the value is a plain object.
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-clone JSON-like config values to avoid mutating shared defaults between runs.
 * @param {any} value - Value to clone recursively.
 * @returns {any} Cloned value.
 */
function cloneConfigValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => cloneConfigValue(entry));
    }

    if (!isPlainObject(value)) {
        return value;
    }

    const clone = {};
    for (const [key, entry] of Object.entries(value)) {
        clone[key] = cloneConfigValue(entry);
    }

    return clone;
}

/**
 * Merge config layers with object-depth merge and array replacement semantics.
 * @param {any} baseValue - Base config value.
 * @param {any} overrideValue - Override config value.
 * @returns {any} Merged config value.
 */
function mergeConfigValue(baseValue, overrideValue) {
    if (overrideValue === undefined) {
        return cloneConfigValue(baseValue);
    }

    if (Array.isArray(baseValue) || Array.isArray(overrideValue)) {
        return cloneConfigValue(overrideValue);
    }

    if (!isPlainObject(baseValue) || !isPlainObject(overrideValue)) {
        return cloneConfigValue(overrideValue);
    }

    const merged = cloneConfigValue(baseValue);
    for (const [key, value] of Object.entries(overrideValue)) {
        merged[key] = mergeConfigValue(merged[key], value);
    }

    return merged;
}

/**
 * Load a project-level config file when present.
 * @param {string} configPath - Config path relative to cwd.
 * @param {string} cwd - Working directory used to resolve config path.
 * @returns {object} Parsed config object, or empty object when file is missing.
 */
function loadConfigFromFile(configPath, cwd) {
    const resolvedPath = path.resolve(cwd, configPath);
    if (!fs.existsSync(resolvedPath)) {
        return {};
    }

    delete require.cache[resolvedPath];
    const loaded = require(resolvedPath);
    return isPlainObject(loaded) ? loaded : {};
}

/**
 * Build the runtime config from template defaults + project config + explicit CLI overrides.
 * @param {object} options - Loader options.
 * @param {string} options.cwd - Working directory used for file resolution.
 * @param {string} [options.configPath] - Config path relative to cwd.
 * @param {object} [options.overrides] - Final overrides (highest precedence).
 * @returns {object} Fully merged runtime config.
 */
function loadRuntimeConfig(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const configPath = options.configPath ?? DEFAULT_CONFIG_FILE;
    const fileConfig = loadConfigFromFile(configPath, cwd);
    const merged = mergeConfigValue(DEFAULT_TEMPLATE, fileConfig);
    return mergeConfigValue(merged, options.overrides ?? {});
}

/**
 * Extract build section from the full runtime config while keeping it clone-safe.
 * @param {any} runtimeConfig - Full merged runtime config.
 * @returns {object} Build section only.
 */
function resolveBuildConfig(runtimeConfig) {
    if (!runtimeConfig || typeof runtimeConfig !== 'object') {
        return {};
    }

    return {
        rootDir: runtimeConfig.rootDir,
        build: cloneConfigValue(runtimeConfig.build || {}),
    };
}

module.exports = {
    DEFAULT_CONFIG_FILE,
    cloneConfigValue,
    loadRuntimeConfig,
    resolveBuildConfig,
};
