const { runBuild } = require("./build");
const { DEFAULT_CONFIG_FILE, loadRuntimeConfig, resolveBuildConfig } = require("./config-loader");

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
 * @param {any} argv - Command-line arguments passed to the CLI entrypoint.
 * @returns {object} Parsed command-line options.
 */
function parseArgs(argv) {
  const parsed = {
    configPath: DEFAULT_CONFIG_FILE,
    clean: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--clean") {
      parsed.clean = true;
      continue;
    }

    if (arg === "--config") {
      parsed.configPath = argv[index + 1] || parsed.configPath;
      index += 1;
      continue;
    }
  }

  return parsed;
}

/**
 * Run the build CLI entrypoint with optional command-line overrides.
 * @param {any} argv - Command-line arguments passed to the CLI entrypoint.
 * @param {any} runtimeOptions - Runtime overrides used by test harnesses or bin wrappers.
 * @returns {Promise<object|null>} Build result, or null when help is requested.
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
    buildConfig.clean = true;
  }

  return runBuild(buildConfig, { cwd });
}

module.exports = {
  parseArgs,
  runBuildCli,
};
