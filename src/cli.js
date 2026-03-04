const fs = require('node:fs');
const path = require('node:path');
const { startDevServer } = require('./server');

/**
 * Print CLI usage details so commands remain discoverable without external documentation.
 * @returns {void} Prints usage information to stdout.
 */
function printHelp() {
    console.log(`mfci-dev-server

Usage:
  mfci-dev-server
  mfci-dev-server --config mfci.config.cjs

Options:
  --config <path>   Optional config file path (default lookup: mfci.config.cjs)
  --host <value>    Override host from config
  --port <number>   Override port from config
  --help            Show this help
`);
}

/**
 * Parse CLI flags into a normalized options object used by command execution.
 * @param {any} argv - Command-line arguments passed to the CLI entrypoint.
 * @returns {object} Parsed command-line options.
 */
function parseArgs(argv) {
    const parsed = {
        configPath: 'mfci.config.cjs',
        host: '',
        port: null,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
            continue;
        }

        if (arg === '--config') {
            parsed.configPath = argv[index + 1] || parsed.configPath;
            index += 1;
            continue;
        }

        if (arg === '--host') {
            parsed.host = argv[index + 1] || '';
            index += 1;
            continue;
        }

        if (arg === '--port') {
            const rawPort = argv[index + 1];
            parsed.port = rawPort ? Number(rawPort) : null;
            index += 1;
            continue;
        }
    }

    return parsed;
}

/**
 * Load and validate a local config module when present.
 * @param {any} configPath - Path to the configuration file relative to cwd.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @returns {object} Loaded config object or empty object when file is absent.
 */
function loadConfigFromFile(configPath, cwd) {
    const resolvedPath = path.resolve(cwd, configPath);
    if (!fs.existsSync(resolvedPath)) {
        return {};
    }

    delete require.cache[resolvedPath];
    const loaded = require(resolvedPath);
    return loaded && typeof loaded === 'object' ? loaded : {};
}

/**
 * Run the dev-server CLI entrypoint with optional command-line overrides.
 * @param {any} argv - Command-line arguments passed to the CLI entrypoint.
 * @param {any} runtimeOptions - Runtime overrides used by test harnesses or bin wrappers.
 * @returns {object|null} Running server handles, or null when help is requested.
 */
function runCli(argv = process.argv.slice(2), runtimeOptions = {}) {
    const cwd = runtimeOptions.cwd || process.cwd();
    const parsed = parseArgs(argv);

    if (parsed.help) {
        printHelp();
        return null;
    }

    const config = loadConfigFromFile(parsed.configPath, cwd);

    // CLI arguments take precedence over config file values.
    if (parsed.host) {
        config.host = parsed.host;
    }

    if (parsed.port !== null) {
        config.port = parsed.port;
    }

    return startDevServer(config, {
        cwd,
        registerSignalHandlers: true,
    });
}

module.exports = {
    parseArgs,
    runCli,
};
