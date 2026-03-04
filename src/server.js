const http = require('node:http');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_MANIFEST_ROUTE = '/magic-file-code-injector.manifest.json';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 35888;
const DEFAULT_PROJECT_NAME = 'magic-file-code-injector';
const DEFAULT_LOG_PREFIX = '[mfci-server]';

const DEFAULT_FILE_DEFINITIONS = [
    {
        type: 'css',
        dir: 'css/dist',
        urlPrefix: '/css/dist',
        extensions: ['.css'],
    },
    {
        type: 'js',
        dir: 'js',
        urlPrefix: '/js',
        extensions: ['.js', '.mjs'],
    },
];

const DEFAULT_WATCH_DIRS = ['css/dist', 'js', 'dist'];

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

function getLivereload(cwd) {
    try {
        return require('livereload');
    } catch (_error) {
        const fallbackPath = path.resolve(cwd, 'node_modules', 'livereload');
        return require(fallbackPath);
    }
}

function ensureLeadingSlash(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return '/';
    }
    return value.startsWith('/') ? value : `/${value}`;
}

function normalizePort(value) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
        return parsed;
    }
    return DEFAULT_PORT;
}

function normalizeType(typeValue) {
    return typeValue === 'js' ? 'js' : 'css';
}

function defaultExtensionsForType(typeValue) {
    if (typeValue === 'js') {
        return ['.js', '.mjs'];
    }
    return ['.css'];
}

function defaultUrlPrefixForType(typeValue) {
    if (typeValue === 'js') {
        return '/js';
    }
    return '/css/dist';
}

function normalizeFileDefinition(definition, cwd) {
    const source = definition && typeof definition === 'object' ? definition : {};
    const type = normalizeType(source.type);
    const dir =
        typeof source.dir === 'string' && source.dir.trim().length > 0 ? source.dir.trim()
        : type === 'js' ? 'js'
        : 'css/dist';
    const urlPrefix = ensureLeadingSlash(
        typeof source.urlPrefix === 'string' && source.urlPrefix.trim().length > 0 ?
            source.urlPrefix.trim()
        :   defaultUrlPrefixForType(type)
    );
    const extensions =
        Array.isArray(source.extensions) && source.extensions.length > 0 ?
            source.extensions
        :   defaultExtensionsForType(type);

    return {
        type,
        dir,
        fsRoot: path.resolve(cwd, dir),
        urlPrefix,
        extensions: new Set(
            extensions
                .map((extension) =>
                    String(extension || '')
                        .trim()
                        .toLowerCase()
                )
                .filter(Boolean)
                .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`))
        ),
    };
}

function normalizeConfig(inputConfig = {}, options = {}) {
    const cwd = options.cwd || process.cwd();
    const source = inputConfig && typeof inputConfig === 'object' ? inputConfig : {};

    const host =
        typeof source.host === 'string' && source.host.trim().length > 0 ?
            source.host.trim()
        :   process.env.LR_HOST || process.env.MFCI_HOST || DEFAULT_HOST;

    const port = normalizePort(source.port || process.env.LR_PORT || process.env.MFCI_PORT || DEFAULT_PORT);
    const manifestRoute = ensureLeadingSlash(
        typeof source.manifestRoute === 'string' && source.manifestRoute.trim().length > 0 ?
            source.manifestRoute.trim()
        :   DEFAULT_MANIFEST_ROUTE
    );
    const projectName =
        typeof source.project === 'string' && source.project.trim().length > 0 ?
            source.project.trim()
        :   DEFAULT_PROJECT_NAME;
    const logPrefix =
        typeof source.logPrefix === 'string' && source.logPrefix.trim().length > 0 ?
            source.logPrefix.trim()
        :   DEFAULT_LOG_PREFIX;

    const fileDefinitionsInput =
        Array.isArray(source.files) && source.files.length > 0 ? source.files : DEFAULT_FILE_DEFINITIONS;
    const fileDefinitions = fileDefinitionsInput.map((definition) => normalizeFileDefinition(definition, cwd));

    const watchDefinitionsInput =
        Array.isArray(source.watch) && source.watch.length > 0 ? source.watch : DEFAULT_WATCH_DIRS;
    const watchDirs = watchDefinitionsInput
        .map((directory) => String(directory || '').trim())
        .filter(Boolean)
        .map((directory) => path.resolve(cwd, directory))
        .filter((directory) => fs.existsSync(directory));

    return {
        cwd,
        host,
        port,
        manifestRoute,
        projectName,
        logPrefix,
        fileDefinitions,
        watchDirs,
    };
}

function inferReloadType(filePath) {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    if (extension === '.css') {
        return 'css';
    }
    if (extension === '.js' || extension === '.mjs') {
        return 'js';
    }
    return 'asset';
}

function isPathInside(basePath, targetPath) {
    const relativePath = path.relative(basePath, targetPath);
    return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function toForwardSlashes(value) {
    return value.split(path.sep).join('/');
}

function toUrlPath(fsPath, definition) {
    const relativePath = toForwardSlashes(path.relative(definition.fsRoot, fsPath));
    return `${definition.urlPrefix}/${relativePath}`;
}

function inferScriptType(urlPath) {
    if (urlPath.endsWith('.mjs') || urlPath.endsWith('.module.js')) {
        return 'module';
    }
    return 'script';
}

function getMimeType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return MIME_TYPES[extension] || 'application/octet-stream';
}

async function walkDirectory(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    const absolutePaths = [];

    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            absolutePaths.push(...(await walkDirectory(fullPath)));
            continue;
        }

        if (entry.isFile()) {
            absolutePaths.push(fullPath);
        }
    }

    return absolutePaths;
}

function buildDescriptor(definition, absolutePath) {
    const normalizedPath = path.resolve(absolutePath);
    const extension = path.extname(normalizedPath).toLowerCase();

    if (!definition.extensions.has(extension)) {
        return null;
    }

    if (!isPathInside(definition.fsRoot, normalizedPath)) {
        return null;
    }

    const urlPath = toUrlPath(normalizedPath, definition);
    const descriptor = {
        id: `${definition.type}:${urlPath}`,
        type: definition.type,
        path: urlPath,
        label: path.basename(urlPath),
    };

    if (definition.type === 'js') {
        descriptor.scriptType = inferScriptType(urlPath);
    }

    return descriptor;
}

async function buildManifest(config) {
    const files = [];

    for (const definition of config.fileDefinitions) {
        const discoveredFiles = await walkDirectory(definition.fsRoot);

        for (const absolutePath of discoveredFiles) {
            const descriptor = buildDescriptor(definition, absolutePath);
            if (descriptor) {
                files.push(descriptor);
            }
        }
    }

    files.sort((left, right) => {
        const leftKey = `${left.type}:${left.path}`;
        const rightKey = `${right.type}:${right.path}`;
        return leftKey.localeCompare(rightKey);
    });

    return {
        version: 1,
        project: config.projectName,
        generatedAt: new Date().toISOString(),
        files,
    };
}

function writeJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload, null, 2));
}

function writeText(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(payload);
}

function createHttpServer(config) {
    return http.createServer(async (req, res) => {
        try {
            const requestUrl = new URL(req.url || '/', `http://${config.host}:${config.port}`);
            const pathname = decodeURIComponent(requestUrl.pathname);

            if (pathname === config.manifestRoute) {
                const manifest = await buildManifest(config);
                writeJson(res, 200, manifest);
                return;
            }

            const definition = config.fileDefinitions.find(
                (item) => pathname === item.urlPrefix || pathname.startsWith(`${item.urlPrefix}/`)
            );
            if (!definition) {
                writeText(res, 404, 'Not Found');
                return;
            }

            const relativePath = pathname.slice(definition.urlPrefix.length).replace(/^\/+/, '');
            if (!relativePath) {
                writeText(res, 400, 'Directory listing is disabled.');
                return;
            }

            const absolutePath = path.resolve(definition.fsRoot, relativePath);
            if (!isPathInside(definition.fsRoot, absolutePath)) {
                writeText(res, 400, 'Invalid path.');
                return;
            }

            const stats = await fsPromises.stat(absolutePath).catch(() => null);
            if (!stats || !stats.isFile()) {
                writeText(res, 404, 'Not Found');
                return;
            }

            const data = await fsPromises.readFile(absolutePath);
            res.writeHead(200, {
                'Content-Type': getMimeType(absolutePath),
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(data);
        } catch (error) {
            writeText(res, 500, `Server error: ${error.message}`);
        }
    });
}

function startDevServer(inputConfig = {}, options = {}) {
    const config = normalizeConfig(inputConfig, options);
    const livereload = getLivereload(config.cwd);

    if (config.watchDirs.length === 0) {
        throw new Error(
            `${config.logPrefix} No watch directory found. Configure "watch" or create the expected directories.`
        );
    }

    const httpServer = createHttpServer(config);

    const lrServer = livereload.createServer({
        host: config.host,
        port: config.port,
        applyCSSLive: true,
        server: httpServer,
    });

    const originalRefresh = lrServer.refresh.bind(lrServer);
    lrServer.refresh = (filePath) => {
        const reloadType = inferReloadType(filePath);
        console.log(`${config.logPrefix} Live change detected (${reloadType}): ${filePath}`);
        return originalRefresh(filePath);
    };

    for (const watchDir of config.watchDirs) {
        lrServer.watch(watchDir);
        console.log(`${config.logPrefix} Watching ${watchDir}`);
    }

    console.log(`${config.logPrefix} HTTP + WS running on http://${config.host}:${config.port}`);
    console.log(`${config.logPrefix} Manifest endpoint: http://${config.host}:${config.port}${config.manifestRoute}`);
    console.log(`${config.logPrefix} WebSocket endpoint: ws://${config.host}:${config.port}/livereload`);

    const close = () => {
        try {
            lrServer.close();
        } catch (_error) {
            // Ignore shutdown errors.
        }
    };

    if (options.registerSignalHandlers !== false) {
        process.on('SIGINT', () => {
            close();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            close();
            process.exit(0);
        });
    }

    return {
        close,
        config,
        lrServer,
        httpServer,
    };
}

module.exports = {
    DEFAULT_MANIFEST_ROUTE,
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_PROJECT_NAME,
    DEFAULT_LOG_PREFIX,
    DEFAULT_FILE_DEFINITIONS,
    DEFAULT_WATCH_DIRS,
    normalizeConfig,
    startDevServer,
};
