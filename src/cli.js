const fs = require('node:fs');
const path = require('node:path');
const { startDevServer } = require('./server');

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

function loadConfigFromFile(configPath, cwd) {
    const resolvedPath = path.resolve(cwd, configPath);
    if (!fs.existsSync(resolvedPath)) {
        return {};
    }

    delete require.cache[resolvedPath];
    const loaded = require(resolvedPath);
    return loaded && typeof loaded === 'object' ? loaded : {};
}

function runCli(argv = process.argv.slice(2), runtimeOptions = {}) {
    const cwd = runtimeOptions.cwd || process.cwd();
    const parsed = parseArgs(argv);

    if (parsed.help) {
        printHelp();
        return null;
    }

    const config = loadConfigFromFile(parsed.configPath, cwd);

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
