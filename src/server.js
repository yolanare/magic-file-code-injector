const http = require('node:http');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const livereload = require('livereload');
const { normalizeBuildConfig, runBuild, exportOutputFileAsHtml } = require('./build');
const { formatLogLine, formatPath, supportsColor } = require('./log-format');
const DEFAULT_TEMPLATE = require('./mfci.config.cjs');
const {
    normalizePort,
    normalizeType,
    defaultExtensionsForType,
    defaultUrlPrefixForType,
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
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

/**
 * Normalize one file definition into a safe runtime descriptor used by HTTP serving and manifest generation.
 * @param {any} definition - Normalized or raw file definition describing exposed source files.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @returns {object} Runtime-safe file definition with resolved paths.
 */
function normalizeFileDefinition(definition, cwd) {
    const source = definition || {};
    const type = normalizeType(source.type);
    const rootDir =
        typeof source.rootDir === 'string' && source.rootDir.trim().length > 0 ? source.rootDir.trim()
        : type === 'html' ? 'html'
        : type === 'js' ? 'js'
        : 'css';
    const publicDir =
        typeof source.publicDir === 'string' && source.publicDir.trim().length > 0 ?
            source.publicDir.trim()
        :   path.join(rootDir, 'public');
    const urlPrefix = defaultUrlPrefixForType(type);
    const extensions =
        Array.isArray(source.extensions) && source.extensions.length > 0 ?
            source.extensions
        :   defaultExtensionsForType(type);
    const fsRoot = path.resolve(cwd, publicDir);
    const watchRoot = path.resolve(cwd, rootDir);

    return {
        type,
        rootDir,
        publicDir,
        watchRoot,
        fsRoot,
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

/**
 * Normalize full server config so downstream code can run without repeated guards.
 * @param {any} inputConfig - Raw configuration object provided by caller or config file.
 * @param {any} options - Runtime options that override or complement loaded config.
 * @returns {object} Fully normalized server configuration.
 */
function normalizeConfig(inputConfig = {}, options = {}) {
    const defaults = DEFAULT_TEMPLATE;
    const cwd = options.cwd || process.cwd();
    const source = inputConfig || {};
    const useColor = typeof options.useColor === 'boolean' ? options.useColor : supportsColor();

    const host =
        typeof source.host === 'string' && source.host.trim().length > 0 ?
            source.host.trim()
        :   defaults.host;

    const port = normalizePort(source.port ?? defaults.port, defaults.port);
    // These values are intentionally internal to avoid expanding the public config surface.
    const manifestRoute = INTERNAL_MANIFEST_ROUTE;
    const projectName = INTERNAL_PROJECT_NAME;
    const logPrefix = INTERNAL_LOG_PREFIX;

    const fileDefinitionsInput = Array.isArray(source.files) && source.files.length > 0 ? source.files : defaults.files;
    const fileDefinitions = fileDefinitionsInput.map((definition) => normalizeFileDefinition(definition, cwd));

    const watchDirs = Array.from(new Set(fileDefinitions.map((definition) => definition.watchRoot)))
        .filter((directory) => fs.existsSync(directory));

    return {
        cwd,
        host,
        port,
        manifestRoute,
        projectName,
        logPrefix,
        useColor,
        fileDefinitions,
        watchDirs,
    };
}

/**
 * Resolve build config from server input so dev-server can trigger the same pipeline as `mfci-build`.
 * @param {any} inputConfig - Raw configuration object provided by caller or config file.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @returns {object} Normalized build configuration.
 */
function normalizeServerBuildConfig(inputConfig, cwd) {
    const source = inputConfig || {};
    const buildSection = source.build && typeof source.build === 'object' ? source.build : {};
    return normalizeBuildConfig(buildSection, { cwd });
}

/**
 * Build the watched extension list for LiveReload so source files in `css/dev` and `js/dev` trigger rebuilds.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {any} buildConfig - Normalized runtime configuration for the current subsystem.
 * @returns {string[]} Extension list without dots (for example `scss`, `ts`, `css`, `js`).
 */
function collectWatchedExtensions(config, buildConfig) {
    const extensions = new Set();

    // Output extensions exposed to the extension UI/manifest.
    for (const definition of config.fileDefinitions) {
        for (const extension of definition.extensions) {
            extensions.add(String(extension || '').toLowerCase().replace(/^\./, ''));
        }
    }

    // Build source extensions that must trigger recompilation.
    for (const extension of buildConfig.sass.extensions) {
        extensions.add(String(extension || '').toLowerCase().replace(/^\./, ''));
    }
    for (const extension of buildConfig.js.extensions) {
        extensions.add(String(extension || '').toLowerCase().replace(/^\./, ''));
    }
    for (const extension of buildConfig.html.extensions) {
        extensions.add(String(extension || '').toLowerCase().replace(/^\./, ''));
    }

    return Array.from(extensions).filter(Boolean);
}

/**
 * Check whether a changed file belongs to dev build sources that should trigger recompilation.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @param {any} buildConfig - Normalized runtime configuration for the current subsystem.
 * @returns {boolean} True when path is inside configured HTML, Sass or JS source directories.
 */
function isBuildSourcePath(filePath, buildConfig) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        return false;
    }

    const absolutePath = path.resolve(filePath);
    return (
        isPathInsideOrSame(buildConfig.html.srcDir, absolutePath) ||
        isPathInsideOrSame(buildConfig.sass.srcDir, absolutePath) ||
        isPathInsideOrSame(buildConfig.js.srcDir, absolutePath)
    );
}

/**
 * Check whether a changed file belongs to build outputs generated from dev sources.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @param {any} buildConfig - Normalized runtime configuration for the current subsystem.
 * @returns {boolean} True when path is inside configured HTML, Sass or JS output directories.
 */
function isBuildOutputPath(filePath, buildConfig) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        return false;
    }

    const absolutePath = path.resolve(filePath);
    return (
        isPathInsideOrSame(buildConfig.html.outDir, absolutePath) ||
        isPathInsideOrSame(buildConfig.sass.outDir, absolutePath) ||
        isPathInsideOrSame(buildConfig.js.outDir, absolutePath)
    );
}

/**
 * Check whether a changed path belongs to one configured public directory exposed to the extension.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @returns {boolean} True when path is inside one configured `files[].publicDir`.
 */
function isConfiguredPublicPath(filePath, config) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        return false;
    }

    const absolutePath = path.resolve(filePath);
    return config.fileDefinitions.some((definition) => isPathInsideOrSame(definition.fsRoot, absolutePath));
}

/**
 * Derive a scoped build config from one source change to avoid rebuilding unrelated asset types.
 * @param {any} buildConfig - Normalized runtime configuration for the current subsystem.
 * @param {any} sourcePath - Filesystem path or changed path used by the current operation.
 * @returns {object} Build config narrowed to the changed source type when possible.
 */
function createScopedBuildConfig(buildConfig, sourcePath) {
    const scoped = {
        ...buildConfig,
        html: { ...buildConfig.html },
        sass: { ...buildConfig.sass },
        js: { ...buildConfig.js },
        copy: Array.isArray(buildConfig.copy) ? buildConfig.copy.map((task) => ({ ...task })) : [],
    };

    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
        return scoped;
    }

    const absolutePath = path.resolve(sourcePath);
    const isHtmlSource = isPathInsideOrSame(scoped.html.srcDir, absolutePath);
    const isSassSource = isPathInsideOrSame(scoped.sass.srcDir, absolutePath);
    const isJsSource = isPathInsideOrSame(scoped.js.srcDir, absolutePath);

    if (isHtmlSource && !isSassSource && !isJsSource) {
        scoped.sass.enabled = false;
        scoped.js.enabled = false;
    } else if (isSassSource && !isJsSource && !isHtmlSource) {
        scoped.html.enabled = false;
        scoped.js.enabled = false;
    } else if (isJsSource && !isSassSource && !isHtmlSource) {
        scoped.html.enabled = false;
        scoped.sass.enabled = false;
    }

    return scoped;
}

/**
 * Render filesystem paths in gray to keep log hierarchy focused on the action/result.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {any} inputPath - Filesystem path or changed path used by the current operation.
 * @returns {string} Styled relative path for terminal output.
 */
function formatServerPath(config, inputPath) {
    const absolutePath = path.resolve(String(inputPath || ''));
    const relativePath = toForwardSlashes(path.relative(config.cwd, absolutePath) || '.');
    return formatPath(relativePath, { useColor: config.useColor });
}

/**
 * Emit one structured dev-server log line with level and prefix styling.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {'info'|'success'|'warn'|'error'} level - Severity level for hierarchy and colors.
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @returns {void} Writes one formatted line to stdout/stderr.
 */
function logServer(config, level, message) {
    const line = formatLogLine({
        prefix: config.logPrefix,
        level,
        message: String(message || ''),
        useColor: config.useColor,
    });

    if (level === 'error') {
        console.error(line);
        return;
    }

    console.log(line);
}

/**
 * Convert a filesystem path to its public URL path used by the extension.
 * @param {any} fsPath - Filesystem path that must be converted to public URL form.
 * @param {any} definition - Normalized or raw file definition describing exposed source files.
 * @returns {string} Public URL path for a file.
 */
function toUrlPath(fsPath, definition) {
    const relativePath = toForwardSlashes(path.relative(definition.fsRoot, fsPath));
    return `${definition.urlPrefix}/${relativePath}`;
}

/**
 * Resolve the path sent through LiveReload so the extension can match the exact manifest file.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {any} filePath - Absolute filesystem path of the refreshed file.
 * @returns {string} LiveReload path payload (prefer public URL path when file is exposed).
 */
function toLiveReloadPath(config, filePath) {
    const absolutePath = path.resolve(String(filePath || ''));

    for (const definition of config.fileDefinitions) {
        if (!isPathInside(definition.fsRoot, absolutePath)) {
            continue;
        }

        return toUrlPath(absolutePath, definition);
    }

    return absolutePath;
}

/**
 * Infer script mode so module files keep correct execution semantics in the page.
 * @param {any} urlPath - Public URL path used to infer script mode.
 * @returns {"script"|"module"} Script mode for browser injection.
 */
function inferScriptType(urlPath) {
    if (urlPath.endsWith('.mjs') || urlPath.endsWith('.module.js')) {
        return 'module';
    }
    return 'script';
}

/**
 * Resolve response content-type for static file serving.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @returns {string} HTTP content-type value.
 */
function getMimeType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return MIME_TYPES[extension] || 'application/octet-stream';
}

/**
 * Recursively list files to build the manifest and locate build inputs.
 * @param {any} directoryPath - Directory path to scan recursively.
 * @returns {Promise<string[]>} Absolute file paths discovered recursively.
 */
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

/**
 * Build a manifest file descriptor only when file extension and path safety checks pass.
 * @param {any} definition - Normalized or raw file definition describing exposed source files.
 * @param {any} absolutePath - Absolute filesystem path of the current file candidate.
 * @returns {object|null} Manifest descriptor or null when file is not eligible.
 */
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

/**
 * Assemble and sort the manifest consumed by popup/options and content injection.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @returns {Promise<object>} Manifest payload consumed by extension UI and sync.
 */
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

/**
 * Write a JSON HTTP response with no-cache and CORS headers expected by the extension.
 * @param {any} res - Node HTTP response object to write to.
 * @param {any} statusCode - HTTP status code to send.
 * @param {any} payload - Message or payload object exchanged between extension components.
 * @returns {void} Writes response payload and closes the stream.
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
 * @param {any} res - Node HTTP response object to write to.
 * @param {any} statusCode - HTTP status code to send.
 * @param {any} payload - Message or payload object exchanged between extension components.
 * @returns {void} Writes response payload and closes the stream.
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
 * Create the HTTP server that serves manifest and file contents to the extension.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @returns {import("node:http").Server} HTTP server instance.
 */
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
            // Path traversal guard: block requests escaping the configured root.
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

/**
 * Start HTTP + LiveReload services and register watchers used by the extension workflow.
 * @param {any} inputConfig - Raw configuration object provided by caller or config file.
 * @param {any} options - Runtime options that override or complement loaded config.
 * @returns {object} Running server handles and normalized config.
 */
function startDevServer(inputConfig = {}, options = {}) {
    const config = normalizeConfig(inputConfig, options);
    const buildConfig = normalizeServerBuildConfig(inputConfig, config.cwd);
    const watchedExtensions = collectWatchedExtensions(config, buildConfig);
    const buildRuntime = {
        isRunning: false,
        pendingSourcePaths: new Set(),
        pendingGeneralReason: "",
    };
    const pendingRefreshLogs = [];
    const pendingOutputRefreshByPath = new Map();
    let refreshBatchTimer = null;
    let outputRefreshBatchInFlight = false;

    if (config.watchDirs.length === 0) {
        throw new Error(
            `${config.logPrefix} No watch directory found. Configure "files[].rootDir" or create the expected directories.`
        );
    }

    const httpServer = createHttpServer(config);

    const lrServer = livereload.createServer({
        host: config.host,
        port: config.port,
        applyCSSLive: true,
        exts: watchedExtensions,
        server: httpServer,
    });

    /**
     * Log refresh actions immediately or queue them while a build run is active.
     * @param {'info'|'success'|'warn'|'error'} level - Severity level for hierarchy and colors.
     * @param {string} message - Refresh message to print in terminal.
     * @returns {void} Logs now or stores for post-build flush.
     */
    function logRefreshAction(level, message) {
        if (buildRuntime.isRunning) {
            pendingRefreshLogs.push({ level, message });
            return;
        }

        logServer(config, level, message);
    }

    /**
     * Print queued refresh logs after build completion so CLI output reads in natural order.
     * @returns {void} Flushes queued refresh lines.
     */
    function flushRefreshLogs() {
        if (pendingRefreshLogs.length === 0) {
            return;
        }

        for (const entry of pendingRefreshLogs.splice(0)) {
            logServer(config, entry.level, entry.message);
        }
    }

    /**
     * Log one refresh signal line with type-specific wording.
     * @param {string} filePath - Absolute filesystem path of the refreshed file.
     * @param {"html"|"css"|"js"|"asset"} reloadType - Refresh category derived from output extension.
     * @returns {void} Writes one refresh log line.
     */
    function logRefreshSignal(filePath, reloadType) {
        if (reloadType === 'html') {
            logRefreshAction('success', `HTML refresh signal sent: ${formatServerPath(config, filePath)}`);
            return;
        }

        if (reloadType === 'css') {
            logRefreshAction('success', `CSS hot refresh signal sent: ${formatServerPath(config, filePath)}`);
            return;
        }

        if (reloadType === 'js') {
            logRefreshAction(
                'success',
                `JS refresh signal sent: ${formatServerPath(config, filePath)} (extension may trigger full reload)`
            );
            return;
        }

        logRefreshAction('info', `Refresh signal sent (${reloadType}): ${formatServerPath(config, filePath)}`);
    }

    /**
     * Flush queued output refreshes once the debounce window elapsed and no build is currently running.
     * @returns {void} Sends refresh events to LiveReload for queued output files.
     */
    async function flushOutputRefreshBatch() {
        if (outputRefreshBatchInFlight) {
            scheduleOutputRefreshBatch();
            return;
        }

        if (pendingOutputRefreshByPath.size === 0) {
            return;
        }

        if (buildRuntime.isRunning) {
            scheduleOutputRefreshBatch();
            return;
        }

        outputRefreshBatchInFlight = true;
        const batchEntries = Array.from(pendingOutputRefreshByPath.entries()).sort(([left], [right]) => left.localeCompare(right));
        pendingOutputRefreshByPath.clear();

        try {
            for (const [filePath, reloadType] of batchEntries) {
                try {
                    await exportOutputFileAsHtml(buildConfig, filePath, {
                        cwd: config.cwd,
                        logger: () => {},
                        useColor: config.useColor,
                    });
                } catch (error) {
                    const message = String(error && error.message ? error.message : error);
                    logRefreshAction('warn', `HTML export skipped for ${formatServerPath(config, filePath)}: ${message}`);
                }

                logRefreshSignal(filePath, reloadType);
                originalRefresh(toLiveReloadPath(config, filePath));
            }
        } finally {
            outputRefreshBatchInFlight = false;
            if (pendingOutputRefreshByPath.size > 0) {
                scheduleOutputRefreshBatch();
            }
        }
    }

    /**
     * Schedule one debounced flush for queued output refresh events.
     * @returns {void} Arms refresh debounce timer when not already pending.
     */
    function scheduleOutputRefreshBatch() {
        if (refreshBatchTimer) {
            return;
        }

        refreshBatchTimer = setTimeout(() => {
            refreshBatchTimer = null;
            void flushOutputRefreshBatch();
        }, REFRESH_BATCH_WINDOW_MS);
    }

    /**
     * Queue one output refresh event and debounce real signal emission.
     * @param {string} filePath - Output file path that triggered LiveReload.
     * @returns {void} Stores event and schedules batch flush.
     */
    function queueOutputRefresh(filePath) {
        const absolutePath = path.resolve(filePath);
        pendingOutputRefreshByPath.set(absolutePath, inferReloadType(absolutePath));
        scheduleOutputRefreshBatch();
    }

    /**
     * Queue build execution to avoid overlapping runs when multiple source events happen quickly.
     * @param {any} reason - Sync reason used for diagnostics and message tracing.
     * @param {any} sourcePath - Filesystem path or changed path used by the current operation.
     * @returns {Promise<void>} Resolves after build queue is drained.
     */
    async function runBuildFromDevServer(reason, sourcePath) {
        const normalizedSourcePath =
            typeof sourcePath === 'string' && sourcePath.length > 0 ? path.resolve(sourcePath) : '';

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

                const sourceLabel = runSourcePath || '(startup)';

                const scopedBuildConfig = createScopedBuildConfig(buildConfig, runSourcePath);
                const buildResult = await runBuild(scopedBuildConfig, {
                    cwd: config.cwd,
                    logger: () => {},
                    useColor: config.useColor,
                    changedSourcePath: runSourcePath,
                });
                const sourceDetails =
                    sourceLabel === '(startup)' ? sourceLabel : formatServerPath(config, sourceLabel);
                if (runReason === 'source-change' && sourceLabel !== '(startup)') {
                    logServer(config, 'success', `Build done: ${sourceDetails}`);
                } else {
                    const totalBuilt = buildResult && buildResult.stats ? buildResult.stats.total : 0;
                    logServer(config, 'success', `Build done (${runReason}): ${totalBuilt} file(s) from ${sourceDetails}`);
                }
                flushRefreshLogs();
            } while (buildRuntime.pendingSourcePaths.size > 0 || buildRuntime.pendingGeneralReason);
        } catch (error) {
            const message = String(error && error.message ? error.message : error);
            logServer(config, 'error', `Build failed: ${message}`);
            flushRefreshLogs();
        } finally {
            buildRuntime.isRunning = false;
        }
    }

    const originalRefresh = lrServer.refresh.bind(lrServer);
    // Wrap refresh to keep an explicit audit trail of what triggered the reload.
    lrServer.refresh = (filePath) => {
        // Source files in `css/dev` and `js/dev` should trigger build first, then output changes will trigger refresh.
        if (isBuildSourcePath(filePath, buildConfig)) {
            runBuildFromDevServer('source-change', filePath).catch(() => {});
            return;
        }

        // Log refresh actions in terminal so developers can correlate file updates with browser behavior.
        if (isBuildOutputPath(filePath, buildConfig) || isConfiguredPublicPath(filePath, config)) {
            queueOutputRefresh(filePath);
            return;
        }

        const reloadType = inferReloadType(filePath);
        logServer(config, 'info', `Live change detected (${reloadType}): ${formatServerPath(config, filePath)}`);
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
        buildConfig,
        lrServer,
        httpServer,
    };
}

module.exports = {
    DEFAULT_HOST: DEFAULT_TEMPLATE.host,
    DEFAULT_PORT: DEFAULT_TEMPLATE.port,
    DEFAULT_FILE_DEFINITIONS: DEFAULT_TEMPLATE.files,
    normalizeConfig,
    startDevServer,
};
