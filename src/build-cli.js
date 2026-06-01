const { runBuild } = require('./build');
const { DEFAULT_CONFIG_FILE, loadRuntimeConfig, resolveBuildConfig } = require('./config-loader');

/**
 * Print CLI usage details so commands remain discoverable without external documentation.
 * @returns {void} Prints usage information to stdout.
 */
function printHelp() {
    console.log(`mfci-build

Usage:
  mfci-build
  mfci-build --config mfci.config.cjs

Options:
  --config <path>   Optional config file path (default lookup: mfci.config.cjs)
  --clean           Clean output directories before build
  --help            Show this help
`);
}

/**
 * Parse CLI flags into a normalized options object used by command execution.
 * @param {string[]} argv - Command-line arguments passed to the CLI entrypoint.
 * @returns {object} Parsed command-line options.
 */
function parseArgs(argv) {
    const takeOptionValue = (index, fallback = '') => {
        const value = argv[index + 1];
        return [typeof value === 'string' && value.length > 0 ? value : fallback, index + 1];
    };

    const parsed = {
        configPath: DEFAULT_CONFIG_FILE,
        clean: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        switch (arg) {
            case '--help':
            case '-h':
                parsed.help = true;
                break;
            case '--clean':
                parsed.clean = true;
                break;
            case '--config': {
                const [configPath, nextIndex] = takeOptionValue(index, parsed.configPath);
                parsed.configPath = configPath;
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
 * Run the build CLI entrypoint with optional command-line overrides.
 * @param {string[]} argv - Command-line arguments passed to the CLI entrypoint.
 * @param {object} runtimeOptions - Runtime overrides used by test harnesses or bin wrappers.
 * @returns {Promise<object|null>} Build result, or null when help is requested.
 * @throws {Error} Propagates config loading or build failures.
 * @example
 * await runBuildCli(['--config', 'mfci.config.cjs', '--clean'], { cwd: process.cwd() });
 */
async function runBuildCli(argv = process.argv.slice(2), runtimeOptions = {}) {
    const cwd = runtimeOptions.cwd || process.cwd();
    const parsed = parseArgs(argv);

    if (parsed.help) {
        printHelp();
        return null;
    }

    const runtimeConfig = loadRuntimeConfig({ cwd, configPath: parsed.configPath });
    const buildConfig = resolveBuildConfig(runtimeConfig);

    // `--clean` is an explicit runtime override for local one-off builds.
    if (parsed.clean) {
        buildConfig.build.clean = true;
    }

    return runBuild(buildConfig, { cwd });
}

module.exports = {
    parseArgs,
    runBuildCli,
};
