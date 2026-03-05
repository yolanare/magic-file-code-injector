const { startDevServer } = require('./server');
const { DEFAULT_CONFIG_FILE, loadRuntimeConfig } = require('./config-loader');

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
        configPath: DEFAULT_CONFIG_FILE,
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

    // CLI flags are intentionally applied last to keep local one-off overrides explicit.
    const config = loadRuntimeConfig({
        cwd,
        configPath: parsed.configPath,
        overrides: {
            ...(parsed.host ? { host: parsed.host } : {}),
            ...(parsed.port !== null ? { port: parsed.port } : {}),
        },
    });

    return startDevServer(config, {
        cwd,
        registerSignalHandlers: true,
    });
}

module.exports = {
    parseArgs,
    runCli,
};
