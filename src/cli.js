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
    const takeOptionValue = (index, fallback = '') => {
        const value = argv[index + 1];
        return [typeof value === 'string' && value.length > 0 ? value : fallback, index + 1];
    };

    const parsed = {
        configPath: DEFAULT_CONFIG_FILE,
        host: '',
        port: null,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        switch (arg) {
            case '--help':
            case '-h':
                parsed.help = true;
                break;
            case '--config': {
                const [configPath, nextIndex] = takeOptionValue(index, parsed.configPath);
                parsed.configPath = configPath;
                index = nextIndex;
                break;
            }
            case '--host': {
                const [host, nextIndex] = takeOptionValue(index, '');
                parsed.host = host;
                index = nextIndex;
                break;
            }
            case '--port': {
                const [rawPort, nextIndex] = takeOptionValue(index, '');
                parsed.port = rawPort ? Number(rawPort) : null;
                index = nextIndex;
                break;
            }
            default:
                break;
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
