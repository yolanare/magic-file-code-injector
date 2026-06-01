const http = require('node:http');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const livereload = require('livereload');
const { normalizeBuildConfig, runBuild } = require('./build');
const { formatLogLine, formatPath, supportsColor } = require('./log-format');
const DEFAULT_TEMPLATE = require('./mfci.config.cjs');
const {
    isNonEmptyString,
    normalizeObject,
    normalizePort,
    toForwardSlashes,
    inferReloadType,
    isPathInside,
    isPathInsideOrSame,
} = require('./server-utils');

const INTERNAL_MANIFEST_ROUTE = '/magic-file-code-injector.manifest.json';
const INTERNAL_PROJECT_NAME = 'magic-file-code-injector';
const INTERNAL_LOG_PREFIX = '[mfci]';
const REFRESH_BATCH_WINDOW_MS = 150;

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

/**
 * Normalize dev-server config for deterministic runtime behavior.
 * @param {object} inputConfig - Runtime config object.
 * @param {object} options - Runtime options.
 * @returns {object} Normalized server config.
 * @example
 * const config = normalizeConfig({ rootDir: 'dev-mfci', port: 35888 }, { cwd: process.cwd() });
 */
function normalizeConfig(inputConfig = {}, options = {}) {
    const cwd = options.cwd || process.cwd();
    const useColor = typeof options.useColor === 'boolean' ? options.useColor : supportsColor();

    const source = normalizeObject(inputConfig);
    const host = isNonEmptyString(source.host) ? source.host.trim() : DEFAULT_TEMPLATE.host;
    const port = normalizePort(source.port, DEFAULT_TEMPLATE.port);
    const rootDir = path.resolve(cwd, isNonEmptyString(source.rootDir) ? source.rootDir.trim() : DEFAULT_TEMPLATE.rootDir);

    const devRoot = path.resolve(rootDir, 'dev');
    const buildRoot = path.resolve(rootDir, 'build');
    const devDirs = {
        html: path.resolve(devRoot, 'html'),
        css: path.resolve(devRoot, 'css'),
        js: path.resolve(devRoot, 'js'),
        modules: path.resolve(devRoot, 'modules'),
    };
    const buildDirs = {
        root: buildRoot,
        html: path.resolve(buildRoot, 'html'),
        css: path.resolve(buildRoot, 'css'),
        js: path.resolve(buildRoot, 'js'),
        modules: path.resolve(buildRoot, 'modules'),
        merge: path.resolve(buildRoot, 'merge'),
    };

    const watchDirs = Object.values(devDirs).filter((directory) => fs.existsSync(directory));

    return {
        cwd,
        host,
        port,
        rootDir,
        devDirs,
        buildDirs,
        watchDirs,
        useColor,
        logPrefix: INTERNAL_LOG_PREFIX,
        projectName: INTERNAL_PROJECT_NAME,
        manifestRoute: INTERNAL_MANIFEST_ROUTE,
    };
}

/**
 * Build the extension watch list for LiveReload.
 * @param {any} buildConfig - Normalized build config.
 * @returns {string[]} Extension list without leading dots.
 */
function collectWatchedExtensions(buildConfig) {
    const extensions = new Set(['html', 'css', 'js', 'mjs']);

    for (const languageKey of ['html', 'sass', 'js']) {
        for (const extension of buildConfig.languages[languageKey].extensions) {
            extensions.add(
                String(extension ?? '')
                    .toLowerCase()
                    .replace(/^\./, '')
            );
        }
    }

    return Array.from(extensions).filter(Boolean);
}

/**
 * Render filesystem paths in gray for readable server logs.
 * @param {any} config - Normalized server config.
 * @param {string} inputPath - Path to render.
 * @returns {string} Relative formatted path.
 */
function formatServerPath(config, inputPath) {
    const absolutePath = path.resolve(String(inputPath ?? ''));
    const relativePath = toForwardSlashes(path.relative(config.cwd, absolutePath) || '.');
    return formatPath(relativePath, { useColor: config.useColor });
}

/**
 * Emit one structured dev-server log line.
 * @param {any} config - Normalized server config.
 * @param {"info"|"success"|"warn"|"error"} level - Log level.
 * @param {string} message - Log message.
 * @returns {void} Writes one line.
 */
function logServer(config, level, message) {
    const line = formatLogLine({
        prefix: config.logPrefix,
        level,
        message: String(message ?? ''),
        useColor: config.useColor,
    });

    if (level === 'error') {
        console.error(line);
        return;
    }

    console.log(line);
}

/**
 * Recursively list files from one directory.
 * @param {string} directoryPath - Directory path.
 * @returns {Promise<string[]>} Discovered files.
 */
async function walkDirectory(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walkDirectory(fullPath)));
            continue;
        }

        if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

/**
 * Infer script mode so module files keep correct execution semantics in page injection.
 * @param {string} urlPath - Manifest/public URL path.
 * @returns {"script"|"module"} Script mode.
 */
function inferScriptType(urlPath) {
    if (urlPath.endsWith('.mjs') || urlPath.endsWith('.module.js')) {
        return 'module';
    }
    return 'script';
}

/**
 * Resolve MIME type for static file responses.
 * @param {string} filePath - Static file path.
 * @returns {string} MIME type.
 */
function getMimeType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return MIME_TYPES[extension] || 'application/octet-stream';
}

/**
 * Resolve served type from file extension.
 * @param {string} extension - Lowercased file extension.
 * @returns {"css"|"js"|""} Served type key.
 */
function inferServedTypeFromExtension(extension) {
    if (extension === '.css') {
        return 'css';
    }
    if (extension === '.js' || extension === '.mjs') {
        return 'js';
    }
    return '';
}

/**
 * Resolve served relative path from one build output.
 * @param {any} config - Normalized server config.
 * @param {string} absolutePath - Absolute build output path.
 * @param {"css"|"js"} servedType - Served type inferred from extension.
 * @returns {string} Relative URL path fragment.
 */
function resolveServedRelativePath(config, absolutePath, servedType) {
    const normalizedPath = path.resolve(absolutePath);

    if (isPathInside(config.buildDirs.modules, normalizedPath)) {
        const relativeModulesPath = toForwardSlashes(path.relative(config.buildDirs.modules, normalizedPath));
        return `modules/${relativeModulesPath}`;
    }

    if (servedType === 'css' && isPathInside(config.buildDirs.css, normalizedPath)) {
        return toForwardSlashes(path.relative(config.buildDirs.css, normalizedPath));
    }

    if (servedType === 'js' && isPathInside(config.buildDirs.js, normalizedPath)) {
        return toForwardSlashes(path.relative(config.buildDirs.js, normalizedPath));
    }

    return toForwardSlashes(path.relative(config.buildDirs.root, normalizedPath));
}

/**
 * Convert one build output path to public URL path.
 * @param {string} fsPath - Absolute filesystem path.
 * @param {any} config - Normalized server config.
 * @returns {string} Public URL path.
 */
function toUrlPath(fsPath, config) {
    const absolutePath = path.resolve(fsPath);
    if (!isPathInside(config.buildDirs.root, absolutePath)) {
        return absolutePath;
    }

    const extension = path.extname(absolutePath).toLowerCase();
    const servedType = inferServedTypeFromExtension(extension);
    if (!servedType) {
        return absolutePath;
    }

    const relativePath = resolveServedRelativePath(config, absolutePath, servedType);
    return `/${servedType}/${relativePath}`;
}

/**
 * Resolve one requested route path to the matching build output path.
 * @param {any} config - Normalized server config.
 * @param {"css"|"js"} servedType - Requested served type from route prefix.
 * @param {string} relativePath - Relative route path after `/css/` or `/js/`.
 * @returns {string|null} Resolved absolute build file path, or null when invalid.
 */
function resolveRequestedAbsolutePath(config, servedType, relativePath) {
    const relative = String(relativePath ?? '').replace(/^\/+/, '');
    if (!relative) {
        return null;
    }

    if (relative.startsWith('modules/')) {
        const modulesRelative = relative.slice('modules/'.length);
        const modulesAbsolutePath = path.resolve(config.buildDirs.modules, modulesRelative);
        if (!isPathInside(config.buildDirs.modules, modulesAbsolutePath)) {
            return null;
        }
        return modulesAbsolutePath;
    }

    const baseDir = servedType === 'css' ? config.buildDirs.css : config.buildDirs.js;
    const absolutePath = path.resolve(baseDir, relative);
    if (!isPathInside(baseDir, absolutePath)) {
        return null;
    }
    return absolutePath;
}

/**
 * Resolve LiveReload payload path from one filesystem output path.
 * @param {any} config - Normalized server config.
 * @param {string} filePath - Output path.
 * @returns {string} LiveReload payload path.
 */
function toLiveReloadPath(config, filePath) {
    const absolutePath = path.resolve(String(filePath ?? ''));
    if (!isPathInside(config.buildDirs.root, absolutePath)) {
        return absolutePath;
    }
    return toUrlPath(absolutePath, config);
}

/**
 * Build one manifest descriptor for one served file.
 * @param {any} config - Normalized server config.
 * @param {string} absolutePath - Candidate file path.
 * @returns {object|null} Manifest descriptor or null.
 */
function buildDescriptor(config, absolutePath) {
    const normalizedPath = path.resolve(absolutePath);
    if (!isPathInside(config.buildDirs.root, normalizedPath)) {
        return null;
    }

    const extension = path.extname(normalizedPath).toLowerCase();
    const servedType = inferServedTypeFromExtension(extension);
    if (!servedType) {
        return null;
    }

    const urlPath = toUrlPath(normalizedPath, config);
    const descriptor = {
        id: `${servedType}:${urlPath}`,
        type: servedType,
        path: urlPath,
        label: path.basename(urlPath),
    };

    if (servedType === 'js') {
        descriptor.scriptType = inferScriptType(urlPath);
    }

    return descriptor;
}

/**
 * Build extension manifest from all CSS/JS files found under `build`.
 * @param {any} config - Normalized server config.
 * @returns {Promise<object>} Manifest payload.
 */
async function buildManifest(config) {
    const files = [];
    const discoveredFiles = await walkDirectory(config.buildDirs.root);

    for (const absolutePath of discoveredFiles) {
        const descriptor = buildDescriptor(config, absolutePath);
        if (descriptor) {
            files.push(descriptor);
        }
    }

    files.sort((left, right) => left.path.localeCompare(right.path));

    return {
        version: 1,
        project: config.projectName,
        generatedAt: new Date().toISOString(),
        files,
    };
}

/**
 * Write a JSON HTTP response with no-cache and CORS headers.
 * @param {any} res - Node response object.
 * @param {number} statusCode - HTTP status code.
 * @param {any} payload - JSON payload.
 * @returns {void} Sends response.
 */
function writeJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload, null, 2));
}

/**
 * Write a text HTTP response with no-cache and CORS headers.
 * @param {any} res - Node response object.
 * @param {number} statusCode - HTTP status code.
 * @param {string} payload - Text payload.
 * @returns {void} Sends response.
 */
function writeText(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(payload);
}

/**
 * Resolve served type from one request pathname.
 * @param {string} pathname - Decoded request pathname.
 * @returns {"css"|"js"|""} Served type.
 */
function resolveServedTypeFromPathname(pathname) {
    if (pathname === '/css' || pathname.startsWith('/css/')) {
        return 'css';
    }
    if (pathname === '/js' || pathname.startsWith('/js/')) {
        return 'js';
    }
    return '';
}

/**
 * Create HTTP server exposing manifest and served build files.
 * @param {any} config - Normalized server config.
 * @param {() => Promise<object>} getManifest - Lazy manifest getter.
 * @returns {import("node:http").Server} HTTP server.
 */
function createHttpServer(config, getManifest) {
    return http.createServer(async (req, res) => {
        try {
            const requestUrl = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);
            const pathname = decodeURIComponent(requestUrl.pathname);

            if (pathname === config.manifestRoute) {
                const manifest = await getManifest();
                writeJson(res, 200, manifest);
                return;
            }

            const servedType = resolveServedTypeFromPathname(pathname);
            if (!servedType) {
                writeText(res, 404, 'Not Found');
                return;
            }

            const routePrefix = `/${servedType}`;
            const relativePath = pathname.slice(routePrefix.length).replace(/^\/+/, '');
            if (!relativePath) {
                writeText(res, 400, 'Directory listing is disabled.');
                return;
            }

            const absolutePath = resolveRequestedAbsolutePath(config, servedType, relativePath);
            if (!absolutePath) {
                writeText(res, 400, 'Invalid path.');
                return;
            }

            const stats = await fsPromises.stat(absolutePath).catch(() => null);
            if (!stats || !stats.isFile()) {
                writeText(res, 404, 'Not Found');
                return;
            }

            const extension = path.extname(absolutePath).toLowerCase();
            const matchesType = (servedType === 'css' && extension === '.css') || (servedType === 'js' && (extension === '.js' || extension === '.mjs'));
            if (!matchesType) {
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

/**
 * Check whether one path belongs to one watched source directory.
 * @param {string} filePath - Candidate path.
 * @param {any} config - Normalized server config.
 * @returns {boolean} True when path is inside watched dev folders.
 */
function isBuildSourcePath(filePath, config) {
    if (!filePath) {
        return false;
    }

    const absolutePath = path.resolve(filePath);
    return Object.values(config.devDirs).some((directory) => isPathInsideOrSame(directory, absolutePath));
}

/**
 * Check whether a changed build output should be sent as extension refresh signal.
 * @param {string} filePath - Build output path.
 * @param {any} config - Normalized server config.
 * @returns {boolean} True when output belongs to build and is CSS/JS.
 */
function isExtensionRefreshableOutput(filePath, config) {
    const absolutePath = path.resolve(String(filePath ?? ''));
    const extension = path.extname(absolutePath).toLowerCase();
    return (extension === '.css' || extension === '.js' || extension === '.mjs') && isPathInsideOrSame(config.buildDirs.root, absolutePath);
}

/**
 * Start HTTP + LiveReload services and bind build/reload workflow.
 * @param {object} inputConfig - Runtime config object.
 * @param {object} options - Runtime options.
 * @returns {object} Running handles.
 * @throws {Error} Throws when no watchable dev directory exists or the HTTP/WS server cannot start.
 * @example
 * const server = startDevServer({ rootDir: 'dev-mfci', port: 35888 }, { cwd: process.cwd() });
 */
function startDevServer(inputConfig = {}, options = {}) {
    const config = normalizeConfig(inputConfig, options);
    const buildConfig = normalizeBuildConfig(inputConfig, { cwd: config.cwd });
    const watchedExtensions = collectWatchedExtensions(buildConfig);
    let manifestCache = null;

    if (config.watchDirs.length === 0) {
        throw new Error(
            `${config.logPrefix} No watch directory found. Create at least one source directory under ${config.rootDir}/dev (html, css, js or modules).`
        );
    }

    const getManifest = async () => {
        if (!manifestCache) {
            manifestCache = await buildManifest(config);
        }
        return manifestCache;
    };

    const httpServer = createHttpServer(config, getManifest);
    const lrServer = livereload.createServer({
        host: config.host,
        port: config.port,
        applyCSSLive: true,
        exts: watchedExtensions,
        server: httpServer,
    });

    const buildRuntime = {
        isRunning: false,
        pendingSourcePaths: new Set(),
        pendingGeneralReason: '',
    };

    const pendingRefreshByPath = new Map();
    let refreshBatchTimer = null;
    let outputRefreshBatchInFlight = false;
    let originalRefresh = null;

    /**
     * Log one refresh signal line.
     * @param {string} filePath - Output file path.
     * @param {"html"|"css"|"js"|"asset"} reloadType - Reload type.
     * @returns {void} Writes one log line.
     */
    function logRefreshSignal(filePath, reloadType) {
        if (reloadType === 'css') {
            logServer(config, 'success', `CSS hot refresh signal sent: ${formatServerPath(config, filePath)}`);
            return;
        }

        if (reloadType === 'js') {
            logServer(config, 'success', `JS refresh signal sent: ${formatServerPath(config, filePath)}`);
            return;
        }

        if (reloadType === 'html') {
            logServer(config, 'success', `HTML refresh signal sent: ${formatServerPath(config, filePath)}`);
            return;
        }

        logServer(config, 'info', `Refresh signal sent (${reloadType}): ${formatServerPath(config, filePath)}`);
    }

    /**
     * Queue one output refresh path for debounced signal dispatch.
     * @param {string} filePath - Output path to refresh.
     * @returns {void} Stores path and schedules flush.
     */
    function queueOutputRefresh(filePath) {
        const absolutePath = path.resolve(filePath);
        pendingRefreshByPath.set(absolutePath, inferReloadType(absolutePath));
        scheduleRefreshBatchFlush();
    }

    /**
     * Schedule debounced refresh flush once.
     * @returns {void}
     */
    function scheduleRefreshBatchFlush() {
        if (refreshBatchTimer) {
            clearTimeout(refreshBatchTimer);
        }

        refreshBatchTimer = setTimeout(() => {
            refreshBatchTimer = null;
            void flushRefreshBatch();
        }, REFRESH_BATCH_WINDOW_MS);
    }

    /**
     * Flush queued refresh signals.
     * @returns {Promise<void>} Completes when queue is flushed.
     */
    async function flushRefreshBatch() {
        if (outputRefreshBatchInFlight) {
            return;
        }

        if (pendingRefreshByPath.size === 0) {
            return;
        }

        outputRefreshBatchInFlight = true;
        const batchEntries = Array.from(pendingRefreshByPath.entries()).sort(([left], [right]) => left.localeCompare(right));
        pendingRefreshByPath.clear();

        try {
            for (const [filePath, reloadType] of batchEntries) {
                logRefreshSignal(filePath, reloadType);
                originalRefresh(toLiveReloadPath(config, filePath));
            }
        } finally {
            outputRefreshBatchInFlight = false;
            if (pendingRefreshByPath.size > 0) {
                scheduleRefreshBatchFlush();
            }
        }
    }

    /**
     * Run build queue from one source-triggered reason.
     * @param {string} reason - Build reason.
     * @param {string} sourcePath - Optional source path.
     * @returns {Promise<void>} Resolves after queue flush.
     */
    async function runBuildFromDevServer(reason, sourcePath) {
        const normalizedSourcePath = typeof sourcePath === 'string' && sourcePath.length > 0 ? path.resolve(sourcePath) : '';

        if (reason === 'source-change' && normalizedSourcePath) {
            buildRuntime.pendingSourcePaths.add(normalizedSourcePath);
        } else {
            buildRuntime.pendingGeneralReason = reason;
        }

        if (buildRuntime.isRunning) {
            return;
        }

        buildRuntime.isRunning = true;

        try {
            do {
                let runReason = buildRuntime.pendingGeneralReason || reason;
                let runSourcePath = '';

                if (buildRuntime.pendingSourcePaths.size > 0) {
                    const nextSourcePath = buildRuntime.pendingSourcePaths.values().next().value;
                    buildRuntime.pendingSourcePaths.delete(nextSourcePath);
                    runReason = 'source-change';
                    runSourcePath = nextSourcePath;
                } else {
                    buildRuntime.pendingGeneralReason = '';
                }

                const buildResult = await runBuild(inputConfig, {
                    cwd: config.cwd,
                    useColor: config.useColor,
                    logger: () => {},
                    changedSourcePath: runSourcePath,
                });
                if (buildResult.changedOutputs.length > 0) {
                    manifestCache = null;
                }

                if (runReason === 'source-change' && runSourcePath) {
                    logServer(config, 'success', `Build done: ${formatServerPath(config, runSourcePath)}`);
                } else {
                    logServer(config, 'success', `Build done (${runReason}): ${buildResult.stats.total} file(s)`);
                }

                if (runReason === 'source-change') {
                    for (const outputPath of buildResult.changedOutputs) {
                        if (isExtensionRefreshableOutput(outputPath, config)) {
                            queueOutputRefresh(outputPath);
                        }
                    }
                }
            } while (buildRuntime.pendingSourcePaths.size > 0 || buildRuntime.pendingGeneralReason);
        } catch (error) {
            const message = String(error && error.message ? error.message : error);
            logServer(config, 'error', `Build failed: ${message}`);
        } finally {
            buildRuntime.isRunning = false;
        }
    }

    originalRefresh = lrServer.refresh.bind(lrServer);
    lrServer.refresh = (filePath) => {
        if (isBuildSourcePath(filePath, config)) {
            // LiveReload watches source files, but the extension must receive built CSS/JS output paths.
            runBuildFromDevServer('source-change', filePath).catch(() => {});
            return;
        }
        return originalRefresh(filePath);
    };

    for (const watchDir of config.watchDirs) {
        lrServer.watch(watchDir);
        logServer(config, 'info', `Watching ${formatServerPath(config, watchDir)}`);
    }

    logServer(config, 'success', `HTTP + WS running on http://${config.host}:${config.port}`);
    logServer(config, 'info', `Manifest endpoint: http://${config.host}:${config.port}${config.manifestRoute}`);
    logServer(config, 'info', `WebSocket endpoint: ws://${config.host}:${config.port}/livereload`);
    logServer(config, 'info', `Watching extensions: ${watchedExtensions.join(', ')}`);

    runBuildFromDevServer('startup', '').catch(() => {});

    const close = () => {
        try {
            if (refreshBatchTimer) {
                clearTimeout(refreshBatchTimer);
                refreshBatchTimer = null;
            }
            lrServer.close();
        } catch (_error) {
            // Signal handlers can race with partial startup or prior close; shutdown stays best effort.
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
        buildConfig,
        lrServer,
        httpServer,
    };
}

module.exports = {
    DEFAULT_HOST: DEFAULT_TEMPLATE.host,
    DEFAULT_PORT: DEFAULT_TEMPLATE.port,
    DEFAULT_ROOT_DIR: DEFAULT_TEMPLATE.rootDir,
    normalizeConfig,
    startDevServer,
};
