const http = require('node:http');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const livereload = require('livereload');
const { normalizeBuildConfig, runBuild } = require('./build');
const { formatLogLine, formatPath, supportsColor } = require('./log-format');

const DEFAULT_MANIFEST_ROUTE = '/magic-file-code-injector.manifest.json';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 35888;
const DEFAULT_PROJECT_NAME = 'magic-file-code-injector';
const DEFAULT_LOG_PREFIX = '[mfci]';
const DEFAULT_IGNORED_DIRS = ['dev'];

const DEFAULT_FILE_DEFINITIONS = [
    {
        type: 'css',
        dir: 'css',
        urlPrefix: '/css',
        extensions: ['.css'],
        ignoreDirs: ['dev'],
    },
    {
        type: 'js',
        dir: 'js',
        urlPrefix: '/js',
        extensions: ['.js', '.mjs'],
        ignoreDirs: ['dev'],
    },
];

const DEFAULT_WATCH_DIRS = ['css', 'js'];

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

/**
 * Ensure route-like values always start with "/" so URL matching stays deterministic.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @returns {string} Normalized route path starting with "/".
 */
function ensureLeadingSlash(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return '/';
    }
    return value.startsWith('/') ? value : `/${value}`;
}

/**
 * Validate and normalize a port value to avoid invalid runtime socket/server binding.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @returns {number} Valid port value, or default port when invalid.
 */
function normalizePort(value) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
        return parsed;
    }
    return DEFAULT_PORT;
}

/**
 * Collapse file type values to the supported set used by manifest and injection flows.
 * @param {any} typeValue - Candidate file type value from config or runtime input.
 * @returns {"css"|"js"} Supported file type key.
 */
function normalizeType(typeValue) {
    return typeValue === 'js' ? 'js' : 'css';
}

/**
 * Provide extension defaults per file type so config can stay minimal.
 * @param {any} typeValue - Candidate file type value from config or runtime input.
 * @returns {string[]} Default extension list for the provided type.
 */
function defaultExtensionsForType(typeValue) {
    if (typeValue === 'js') {
        return ['.js', '.mjs'];
    }
    return ['.css'];
}

/**
 * Provide serving URL defaults per file type to keep extension paths predictable.
 * @param {any} typeValue - Candidate file type value from config or runtime input.
 * @returns {string} Default public URL prefix for the provided type.
 */
function defaultUrlPrefixForType(typeValue) {
    if (typeValue === 'js') {
        return '/js';
    }
    return '/css';
}

/**
 * Normalize one file definition into a safe runtime descriptor used by HTTP serving and manifest generation.
 * @param {any} definition - Normalized or raw file definition describing exposed source files.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @returns {object} Runtime-safe file definition with resolved paths and ignore rules.
 */
function normalizeFileDefinition(definition, cwd) {
    const source = definition && typeof definition === 'object' ? definition : {};
    const type = normalizeType(source.type);
    const dir =
        typeof source.dir === 'string' && source.dir.trim().length > 0 ? source.dir.trim()
        : type === 'js' ? 'js'
        : 'css';
    const urlPrefix = ensureLeadingSlash(
        typeof source.urlPrefix === 'string' && source.urlPrefix.trim().length > 0 ?
            source.urlPrefix.trim()
        :   defaultUrlPrefixForType(type)
    );
    const extensions =
        Array.isArray(source.extensions) && source.extensions.length > 0 ?
            source.extensions
        :   defaultExtensionsForType(type);
    const ignoreDirs =
        Array.isArray(source.ignoreDirs) && source.ignoreDirs.length > 0 ?
            source.ignoreDirs
        :   DEFAULT_IGNORED_DIRS;
    const fsRoot = path.resolve(cwd, dir);
    // Ignore paths are resolved from the exposed root so callers can pass short folder names (for example "dev").
    const ignoredRoots = ignoreDirs
        .map((directory) => String(directory || '').trim())
        .filter(Boolean)
        .map((directory) => path.resolve(fsRoot, directory));

    return {
        type,
        dir,
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
        ignoredRoots,
    };
}

/**
 * Normalize full server config so downstream code can run without repeated guards.
 * @param {any} inputConfig - Raw configuration object provided by caller or config file.
 * @param {any} options - Runtime options that override or complement loaded config.
 * @returns {object} Fully normalized server configuration.
 */
function normalizeConfig(inputConfig = {}, options = {}) {
    const cwd = options.cwd || process.cwd();
    const source = inputConfig && typeof inputConfig === 'object' ? inputConfig : {};
    const useColor = typeof options.useColor === 'boolean' ? options.useColor : supportsColor();

    const host =
        typeof source.host === 'string' && source.host.trim().length > 0 ?
            source.host.trim()
        :   DEFAULT_HOST;

    const port = normalizePort(source.port ?? DEFAULT_PORT);
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
    const source = inputConfig && typeof inputConfig === 'object' ? inputConfig : {};
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

    return Array.from(extensions).filter(Boolean);
}

/**
 * Map a changed path to a reload category used for logging and LiveReload signaling.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @returns {"css"|"js"|"asset"} Reload category for logs and notifications.
 */
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

/**
 * Protect against path traversal by ensuring a target stays inside the configured root.
 * @param {any} basePath - Base directory used for containment checks.
 * @param {any} targetPath - Target path to validate against a base directory.
 * @returns {boolean} True when target path stays strictly inside base path.
 */
function isPathInside(basePath, targetPath) {
    const relativePath = path.relative(basePath, targetPath);
    return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/**
 * Variant of path containment check that also accepts the exact same path.
 * @param {any} basePath - Base directory used for containment checks.
 * @param {any} targetPath - Target path to validate against a base directory.
 * @returns {boolean} True when target is inside base path or equal to it.
 */
function isPathInsideOrSame(basePath, targetPath) {
    const relativePath = path.relative(basePath, targetPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * Check whether a file path belongs to ignored source folders that must not be exposed.
 * @param {any} definition - Normalized or raw file definition describing exposed source files.
 * @param {any} absolutePath - Absolute filesystem path of the current file candidate.
 * @returns {boolean} True when path is under an ignored directory.
 */
function isIgnoredPath(definition, absolutePath) {
    return definition.ignoredRoots.some((ignoredRoot) => isPathInsideOrSame(ignoredRoot, absolutePath));
}

/**
 * Check whether a changed file belongs to dev build sources that should trigger recompilation.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @param {any} buildConfig - Normalized runtime configuration for the current subsystem.
 * @returns {boolean} True when path is inside configured Sass or JS source directories.
 */
function isBuildSourcePath(filePath, buildConfig) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        return false;
    }

    const absolutePath = path.resolve(filePath);
    return (
        isPathInsideOrSame(buildConfig.sass.srcDir, absolutePath) ||
        isPathInsideOrSame(buildConfig.js.srcDir, absolutePath)
    );
}

/**
 * Check whether a changed file belongs to build outputs generated from dev sources.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @param {any} buildConfig - Normalized runtime configuration for the current subsystem.
 * @returns {boolean} True when path is inside configured Sass or JS output directories.
 */
function isBuildOutputPath(filePath, buildConfig) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        return false;
    }

    const absolutePath = path.resolve(filePath);
    return (
        isPathInsideOrSame(buildConfig.sass.outDir, absolutePath) ||
        isPathInsideOrSame(buildConfig.js.outDir, absolutePath)
    );
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
        sass: { ...buildConfig.sass },
        js: { ...buildConfig.js },
        copy: Array.isArray(buildConfig.copy) ? buildConfig.copy.map((task) => ({ ...task })) : [],
    };

    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
        return scoped;
    }

    const absolutePath = path.resolve(sourcePath);
    const isSassSource = isPathInsideOrSame(scoped.sass.srcDir, absolutePath);
    const isJsSource = isPathInsideOrSame(scoped.js.srcDir, absolutePath);

    if (isSassSource && !isJsSource) {
        scoped.js.enabled = false;
    } else if (isJsSource && !isSassSource) {
        scoped.sass.enabled = false;
    }

    return scoped;
}

/**
 * Normalize path separators to web format for manifest URLs across operating systems.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @returns {string} Path with POSIX separators.
 */
function toForwardSlashes(value) {
    return value.split(path.sep).join('/');
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

    if (isIgnoredPath(definition, normalizedPath)) {
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

            // Source folders (like css/dev, js/dev) are intentionally not exposed to the extension.
            if (isIgnoredPath(definition, absolutePath)) {
                writeText(res, 404, 'Not Found');
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
        hasPendingRun: false,
    };
    const pendingRefreshLogs = [];

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
     * Queue build execution to avoid overlapping runs when multiple source events happen quickly.
     * @param {any} reason - Sync reason used for diagnostics and message tracing.
     * @param {any} sourcePath - Filesystem path or changed path used by the current operation.
     * @returns {Promise<void>} Resolves after build queue is drained.
     */
    async function runBuildFromDevServer(reason, sourcePath) {
        if (buildRuntime.isRunning) {
            buildRuntime.hasPendingRun = true;
            return;
        }

        buildRuntime.isRunning = true;

        try {
            do {
                buildRuntime.hasPendingRun = false;
                const sourceLabel = typeof sourcePath === 'string' && sourcePath.length > 0 ? sourcePath : '(startup)';

                const scopedBuildConfig = createScopedBuildConfig(buildConfig, sourcePath);
                const buildResult = await runBuild(scopedBuildConfig, {
                    cwd: config.cwd,
                    logger: () => {},
                    useColor: config.useColor,
                    changedSourcePath: sourcePath,
                });
                const sourceDetails =
                    sourceLabel === '(startup)' ? sourceLabel : formatServerPath(config, sourceLabel);
                if (reason === 'source-change' && sourceLabel !== '(startup)') {
                    logServer(config, 'success', `Build done: ${sourceDetails}`);
                } else {
                    const totalBuilt = buildResult && buildResult.stats ? buildResult.stats.total : 0;
                    logServer(config, 'success', `Build done (${reason}): ${totalBuilt} file(s) from ${sourceDetails}`);
                }
                flushRefreshLogs();
            } while (buildRuntime.hasPendingRun);
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
        if (isBuildOutputPath(filePath, buildConfig)) {
            const reloadType = inferReloadType(filePath);
            if (reloadType === 'css') {
                logRefreshAction('success', `CSS hot refresh signal sent: ${formatServerPath(config, filePath)}`);
            } else if (reloadType === 'js') {
                logRefreshAction(
                    'success',
                    `JS refresh signal sent: ${formatServerPath(config, filePath)} (extension may trigger full reload)`
                );
            } else {
                logRefreshAction('info', `Refresh signal sent (${reloadType}): ${formatServerPath(config, filePath)}`);
            }
            return originalRefresh(filePath);
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
