const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const sass = require('sass');
const esbuild = require('esbuild');
const { formatLogLine, formatPath, supportsColor } = require('./log-format');
const DEFAULT_TEMPLATE = require('./mfci.config.cjs');
const { toForwardSlashes, isPathInsideOrSame } = require('./server-utils');

const DEFAULT_BUILD_LOG_PREFIX = '[mfci-build]';

/**
 * Check for non-empty strings before path/flag normalization.
 * @param {any} value - Candidate input value.
 * @returns {boolean} True when value is a non-empty string.
 */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalize optional booleans while preserving explicit false values.
 * @param {any} value - Candidate boolean value.
 * @param {boolean} fallback - Fallback value when input is invalid.
 * @returns {boolean} Normalized boolean.
 */
function normalizeBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

/**
 * Normalize extension lists to lowercase dot-prefixed values.
 * @param {any} value - Candidate extension list.
 * @param {string[]} fallback - Fallback extension list.
 * @returns {Set<string>} Normalized extension set.
 */
function normalizeExtensions(value, fallback) {
    const source = Array.isArray(value) && value.length > 0 ? value : fallback;
    return new Set(
        source
            .map((entry) =>
                String(entry || '')
                    .trim()
                    .toLowerCase()
            )
            .filter(Boolean)
            .map((entry) => (entry.startsWith('.') ? entry : `.${entry}`))
    );
}

/**
 * Normalize extra copy tasks.
 * @param {any} value - Candidate copy tasks list.
 * @param {string} cwd - Working directory.
 * @returns {Array<{from:string,to:string}>} Valid normalized copy tasks.
 */
function normalizeCopyTasks(value, cwd) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((task) => (task && typeof task === 'object' ? task : null))
        .filter(Boolean)
        .map((task) => {
            const from = isNonEmptyString(task.from) ? path.resolve(cwd, task.from.trim()) : '';
            const to = isNonEmptyString(task.to) ? path.resolve(cwd, task.to.trim()) : '';
            if (!from || !to) {
                return null;
            }
            return { from, to };
        })
        .filter(Boolean);
}

/**
 * Normalize build/runtime config to one deterministic structure used by build and dev-server.
 * @param {any} inputConfig - Runtime config object.
 * @param {any} options - Runtime options.
 * @returns {object} Normalized build config.
 */
function normalizeBuildConfig(inputConfig = {}, options = {}) {
    const cwd = options.cwd || process.cwd();
    const useColor = typeof options.useColor === 'boolean' ? options.useColor : supportsColor();
    const logger = typeof options.logger === 'function' ? options.logger : console.log;
    const changedSourcePath = isNonEmptyString(options.changedSourcePath) ? path.resolve(options.changedSourcePath.trim()) : '';

    const source = inputConfig && typeof inputConfig === 'object' ? inputConfig : {};
    const buildSource = source.build && typeof source.build === 'object' ? source.build : {};
    const languageSource = buildSource.languages && typeof buildSource.languages === 'object' ? buildSource.languages : {};

    const defaults = DEFAULT_TEMPLATE;
    const buildDefaults = defaults.build;
    const languageDefaults = defaults.build.languages;

    const rootDir = path.resolve(cwd, isNonEmptyString(source.rootDir) ? source.rootDir.trim() : defaults.rootDir);

    const devRoot = path.resolve(rootDir, 'dev');
    const buildRoot = path.resolve(rootDir, 'build');

    const htmlInput = languageSource.html && typeof languageSource.html === 'object' ? languageSource.html : {};
    const sassInput = languageSource.sass && typeof languageSource.sass === 'object' ? languageSource.sass : {};
    const jsInput = languageSource.js && typeof languageSource.js === 'object' ? languageSource.js : {};

    const sassSettingsInput = sassInput.settings && typeof sassInput.settings === 'object' ? sassInput.settings : {};
    const jsSettingsInput = jsInput.settings && typeof jsInput.settings === 'object' ? jsInput.settings : {};

    return {
        cwd,
        logger,
        useColor,
        logPrefix: DEFAULT_BUILD_LOG_PREFIX,
        changedSourcePath,
        rootDir,
        paths: {
            devRoot,
            buildRoot,
            devHtmlDir: path.resolve(devRoot, 'html'),
            devCssDir: path.resolve(devRoot, 'css'),
            devJsDir: path.resolve(devRoot, 'js'),
            devModulesDir: path.resolve(devRoot, 'modules'),
            buildHtmlDir: path.resolve(buildRoot, 'html'),
            buildCssDir: path.resolve(buildRoot, 'css'),
            buildJsDir: path.resolve(buildRoot, 'js'),
            buildModulesDir: path.resolve(buildRoot, 'modules'),
            buildMergeDir: path.resolve(buildRoot, 'merge'),
        },
        clean: normalizeBoolean(buildSource.clean, buildDefaults.clean),
        copy: normalizeCopyTasks(buildSource.copy ?? buildDefaults.copy, cwd),
        exportHtml: {
            enabled: normalizeBoolean(buildSource.exportHtml && buildSource.exportHtml.enabled, buildDefaults.exportHtml.enabled),
            mergeSameName: normalizeBoolean(buildSource.exportHtml && buildSource.exportHtml.mergeSameName, buildDefaults.exportHtml.mergeSameName),
        },
        languages: {
            html: {
                type: 'html',
                enabled: normalizeBoolean(htmlInput.enabled, languageDefaults.html.enabled),
                extensions: normalizeExtensions(htmlInput.extensions, languageDefaults.html.extensions),
            },
            sass: {
                type: 'sass',
                enabled: normalizeBoolean(sassInput.enabled, languageDefaults.sass.enabled),
                extensions: normalizeExtensions(sassInput.extensions, languageDefaults.sass.extensions),
                settings: {
                    style: sassSettingsInput.style === 'compressed' ? 'compressed' : languageDefaults.sass.settings.style,
                    sourceMap: normalizeBoolean(sassSettingsInput.sourceMap, languageDefaults.sass.settings.sourceMap),
                    loadPaths:
                        Array.isArray(sassSettingsInput.loadPaths) ?
                            sassSettingsInput.loadPaths
                                .map((entry) => String(entry || '').trim())
                                .filter(Boolean)
                                .map((entry) => path.resolve(cwd, entry))
                        :   languageDefaults.sass.settings.loadPaths,
                },
            },
            js: {
                type: 'js',
                enabled: normalizeBoolean(jsInput.enabled, languageDefaults.js.enabled),
                extensions: normalizeExtensions(jsInput.extensions, languageDefaults.js.extensions),
                settings: {
                    bundle: normalizeBoolean(jsSettingsInput.bundle, languageDefaults.js.settings.bundle),
                    minify: normalizeBoolean(jsSettingsInput.minify, languageDefaults.js.settings.minify),
                    sourcemap: normalizeBoolean(jsSettingsInput.sourcemap, languageDefaults.js.settings.sourcemap),
                    target: isNonEmptyString(jsSettingsInput.target) ? jsSettingsInput.target.trim() : languageDefaults.js.settings.target,
                    format: isNonEmptyString(jsSettingsInput.format) ? jsSettingsInput.format.trim() : languageDefaults.js.settings.format,
                    platform: isNonEmptyString(jsSettingsInput.platform) ? jsSettingsInput.platform.trim() : languageDefaults.js.settings.platform,
                },
            },
        },
    };
}

/**
 * Render one path with project-relative and dim formatting.
 * @param {any} config - Normalized build config.
 * @param {string} absolutePath - Absolute filesystem path.
 * @returns {string} Formatted path label.
 */
function displayPath(config, absolutePath) {
    const relative = toForwardSlashes(path.relative(config.cwd, absolutePath) || '.');
    return formatPath(relative, { useColor: config.useColor });
}

/**
 * Emit one build log line through configured logger.
 * @param {any} config - Normalized build config.
 * @param {"info"|"success"|"warn"|"error"} level - Log level.
 * @param {string} message - Log message.
 * @returns {void} Writes one line.
 */
function logBuild(config, level, message) {
    config.logger(
        formatLogLine({
            prefix: config.logPrefix,
            level,
            message,
            useColor: config.useColor,
        })
    );
}

/**
 * Recursively list files from one directory.
 * @param {string} directoryPath - Directory path.
 * @returns {Promise<string[]>} Discovered file paths.
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
 * Ensure output parent directory exists.
 * @param {string} filePath - Target file path.
 * @returns {Promise<void>} Completes when parent exists.
 */
async function ensureParentDirectory(filePath) {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Replace one extension while preserving relative folders.
 * @param {string} filePath - Input file path.
 * @param {string} extension - New extension.
 * @returns {string} Path with replaced extension.
 */
function replaceExtension(filePath, extension) {
    const parsed = path.parse(filePath);
    return path.join(parsed.dir, `${parsed.name}${extension}`);
}

/**
 * Normalize CSS output by removing top-level charset declarations.
 * @param {string} cssText - CSS content.
 * @returns {string} Normalized CSS content.
 */
function stripLeadingCssCharset(cssText) {
    return String(cssText || '').replace(/^\uFEFF?\s*@charset\s+["'][^"']+["'];\s*/i, '');
}

/**
 * Read one UTF-8 file and trim surrounding whitespace.
 * @param {string} filePath - Source file path.
 * @returns {Promise<string>} Trimmed file content.
 */
async function readTextFileTrimmed(filePath) {
    return String((await fsPromises.readFile(filePath, 'utf8')) || '').trim();
}

/**
 * Write one UTF-8 file only when content changed.
 * @param {string} outputFile - Destination path.
 * @param {string} content - UTF-8 content.
 * @returns {Promise<boolean>} True when file content changed.
 */
async function writeTextFileIfChanged(outputFile, content) {
    const nextText = String(content || '');
    const previousText = await fsPromises.readFile(outputFile, 'utf8').catch(() => null);
    if (previousText === nextText) {
        return false;
    }

    await ensureParentDirectory(outputFile);
    await fsPromises.writeFile(outputFile, nextText, 'utf8');
    return true;
}

/**
 * Remove one file if it exists.
 * @param {string} filePath - File path.
 * @returns {Promise<boolean>} True when a file was removed.
 */
async function removeFileIfExists(filePath) {
    const stats = await fsPromises.stat(filePath).catch(() => null);
    if (!stats || !stats.isFile()) {
        return false;
    }

    await fsPromises.rm(filePath, { force: true });
    return true;
}

/**
 * Map JS-like source extensions to final output extension.
 * @param {string} relativePath - Source-relative file path.
 * @param {string} sourceExtension - Source extension.
 * @returns {string} Output-relative JS path.
 */
function renderJsOutputPath(relativePath, sourceExtension) {
    const extension = String(sourceExtension || '').toLowerCase();
    if (extension === '.ts' || extension === '.tsx' || extension === '.jsx' || extension === '.cjs') {
        return replaceExtension(relativePath, '.js');
    }
    return relativePath;
}

/**
 * Render one output-relative path from source type + source path metadata.
 * @param {"html"|"css"|"js"} sourceType - Source type.
 * @param {string} relativePath - Source path relative to source root.
 * @param {string} sourceExtension - Source extension.
 * @returns {string} Output-relative path.
 */
function renderOutputPathBySourceType(sourceType, relativePath, sourceExtension) {
    if (sourceType === 'css') {
        return sourceExtension === '.css' ? relativePath : replaceExtension(relativePath, '.css');
    }

    if (sourceType === 'js') {
        return renderJsOutputPath(relativePath, sourceExtension);
    }

    return relativePath;
}

/**
 * Derive one build execution scope from the changed source path.
 * @param {any} config - Normalized build config.
 * @returns {{standaloneHtml:boolean,standaloneCss:boolean,standaloneJs:boolean,modules:boolean}} Build scope.
 */
function resolveBuildScope(config) {
    const changedSourcePath = config.changedSourcePath;
    if (!changedSourcePath) {
        return {
            standaloneHtml: true,
            standaloneCss: true,
            standaloneJs: true,
            modules: true,
        };
    }

    if (isPathInsideOrSame(config.paths.devHtmlDir, changedSourcePath)) {
        return { standaloneHtml: true, standaloneCss: false, standaloneJs: false, modules: false };
    }

    if (isPathInsideOrSame(config.paths.devCssDir, changedSourcePath)) {
        return { standaloneHtml: false, standaloneCss: true, standaloneJs: false, modules: false };
    }

    if (isPathInsideOrSame(config.paths.devJsDir, changedSourcePath)) {
        return { standaloneHtml: false, standaloneCss: false, standaloneJs: true, modules: false };
    }

    if (isPathInsideOrSame(config.paths.devModulesDir, changedSourcePath)) {
        return { standaloneHtml: false, standaloneCss: false, standaloneJs: false, modules: true };
    }

    return {
        standaloneHtml: true,
        standaloneCss: true,
        standaloneJs: true,
        modules: true,
    };
}

/**
 * Keep build logs readable by rendering a source->output pair in one consistent format.
 * @param {any} config - Normalized build config.
 * @param {string} sourcePath - Source path.
 * @param {string} outputPath - Output path.
 * @returns {string} Formatted pair label.
 */
function displayPathPair(config, sourcePath, outputPath) {
    return `${displayPath(config, sourcePath)} -> ${displayPath(config, outputPath)}`;
}

/**
 * Collect files matching one extension set in deterministic order.
 * @param {string} sourceDir - Source directory.
 * @param {Set<string>} extensions - Allowed extensions.
 * @returns {Promise<string[]>} Matching files.
 */
async function collectCandidates(sourceDir, extensions) {
    const files = await walkDirectory(sourceDir);
    return files.filter((filePath) => extensions.has(path.extname(filePath).toLowerCase())).sort();
}

/**
 * Resolve changed source state for one source directory and extension set.
 * @param {string} changedPath - Absolute changed source path.
 * @param {string} sourceDir - Source root directory.
 * @param {Set<string>} extensions - Allowed source extensions.
 * @returns {null|{path:string,extension:string,exists:boolean,isKnownExtension:boolean}} Changed source state.
 */
function resolveChangedCandidateState(changedPath, sourceDir, extensions) {
    if (!changedPath || !isPathInsideOrSame(sourceDir, changedPath)) {
        return null;
    }

    const extension = path.extname(changedPath).toLowerCase();
    return {
        path: changedPath,
        extension,
        exists: fs.existsSync(changedPath),
        isKnownExtension: extensions.has(extension),
    };
}

/**
 * Select build candidates from one changed source state.
 * @param {string[]} candidates - Candidates discovered from source directory.
 * @param {null|{path:string,exists:boolean,isKnownExtension:boolean}} changedState - Changed source state.
 * @param {(state:{path:string,exists:boolean,isKnownExtension:boolean})=>boolean} shouldRebuildAll - Rebuild-all selector.
 * @returns {string[]} Selected candidates.
 */
function selectCandidatesForChangedState(candidates, changedState, shouldRebuildAll = () => false) {
    if (!changedState || !changedState.isKnownExtension) {
        return candidates;
    }

    if (!changedState.exists) {
        return [];
    }

    if (shouldRebuildAll(changedState)) {
        return candidates;
    }

    return candidates.filter((candidate) => path.resolve(candidate) === changedState.path);
}

/**
 * Build one HTML file by direct copy.
 * @param {any} config - Normalized build config.
 * @param {string} inputFile - Source HTML file.
 * @param {string} outputFile - Output HTML file.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed output files.
 */
async function buildHtmlFile(config, inputFile, outputFile, changedOutputs) {
    const htmlText = await fsPromises.readFile(inputFile, 'utf8');
    const changed = await writeTextFileIfChanged(outputFile, htmlText);
    if (!changed) {
        return 0;
    }

    changedOutputs.add(outputFile);
    logBuild(config, 'success', `HTML built: ${displayPathPair(config, inputFile, outputFile)}`);
    return 1;
}

/**
 * Build one CSS/Sass file to CSS output.
 * @param {any} config - Normalized build config.
 * @param {string} inputFile - Source CSS/Sass file.
 * @param {string} outputFile - Output CSS file.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed output files.
 */
async function buildCssFile(config, inputFile, outputFile, changedOutputs) {
    const extension = path.extname(inputFile).toLowerCase();
    const isPlainCss = extension === '.css';

    if (isPlainCss) {
        const cssText = stripLeadingCssCharset(await fsPromises.readFile(inputFile, 'utf8'));
        const changed = await writeTextFileIfChanged(outputFile, cssText);
        if (!changed) {
            return 0;
        }

        changedOutputs.add(outputFile);
        logBuild(config, 'success', `CSS copied: ${displayPathPair(config, inputFile, outputFile)}`);
        return 1;
    }

    const compiled = sass.compile(inputFile, {
        style: config.languages.sass.settings.style,
        sourceMap: config.languages.sass.settings.sourceMap,
        loadPaths: config.languages.sass.settings.loadPaths,
        charset: false,
    });

    let changedCount = 0;
    let cssText = stripLeadingCssCharset(compiled.css);

    if (config.languages.sass.settings.sourceMap && compiled.sourceMap) {
        const mapFile = `${outputFile}.map`;
        cssText += `\n/*# sourceMappingURL=${path.basename(mapFile)} */\n`;
        const mapChanged = await writeTextFileIfChanged(mapFile, JSON.stringify(compiled.sourceMap));
        if (mapChanged) {
            changedCount += 1;
        }
    }

    const cssChanged = await writeTextFileIfChanged(outputFile, cssText);
    if (!cssChanged) {
        return changedCount;
    }

    changedOutputs.add(outputFile);
    logBuild(config, 'success', `Sass built: ${displayPathPair(config, inputFile, outputFile)}`);
    return changedCount + 1;
}

/**
 * Build one JS/TS-like source file to JavaScript output.
 * @param {any} config - Normalized build config.
 * @param {string} inputFile - Source JS/TS file.
 * @param {string} outputFile - Output JS file.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed output files.
 */
async function buildJsFile(config, inputFile, outputFile, changedOutputs) {
    await ensureParentDirectory(outputFile);

    const result = await esbuild.build({
        entryPoints: [inputFile],
        outfile: outputFile,
        bundle: config.languages.js.settings.bundle,
        minify: config.languages.js.settings.minify,
        sourcemap: config.languages.js.settings.sourcemap,
        target: config.languages.js.settings.target,
        format: config.languages.js.settings.format,
        platform: config.languages.js.settings.platform,
        logLevel: 'silent',
        legalComments: 'none',
        charset: 'utf8',
        write: false,
    });

    let changedCount = 0;

    for (const output of result.outputFiles || []) {
        const outputText = output.text;
        const changed = await writeTextFileIfChanged(output.path, outputText);
        if (!changed) {
            continue;
        }

        changedCount += 1;
        const extension = path.extname(output.path).toLowerCase();
        if (extension === '.js' || extension === '.mjs') {
            changedOutputs.add(output.path);
        }
    }

    if (changedCount > 0) {
        logBuild(config, 'success', `JS built: ${displayPathPair(config, inputFile, outputFile)}`);
    }

    return changedCount;
}

/**
 * Remove generated outputs for one deleted standalone source file.
 * @param {any} config - Normalized build config.
 * @param {"html"|"css"|"js"} sourceType - Standalone source type.
 * @param {string} deletedSourcePath - Deleted source path.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of removed files.
 */
async function removeStandaloneOutputForDeletedSource(config, sourceType, deletedSourcePath, changedOutputs) {
    let sourceDir = '';
    let outputDir = '';

    if (sourceType === 'html') {
        sourceDir = config.paths.devHtmlDir;
        outputDir = config.paths.buildHtmlDir;
    } else if (sourceType === 'css') {
        sourceDir = config.paths.devCssDir;
        outputDir = config.paths.buildCssDir;
    } else {
        sourceDir = config.paths.devJsDir;
        outputDir = config.paths.buildJsDir;
    }

    const relativePath = path.relative(sourceDir, deletedSourcePath);
    const extension = path.extname(deletedSourcePath).toLowerCase();
    const outputRelative = renderOutputPathBySourceType(sourceType, relativePath, extension);

    const outputFile = path.resolve(outputDir, outputRelative);

    let removedCount = 0;
    const outputRemoved = await removeFileIfExists(outputFile);
    if (outputRemoved) {
        changedOutputs.add(outputFile);
        removedCount += 1;
    }

    if (sourceType === 'css') {
        const mapRemoved = await removeFileIfExists(`${outputFile}.map`);
        if (mapRemoved) {
            removedCount += 1;
        }
    }

    if (config.exportHtml.enabled && (sourceType === 'css' || sourceType === 'js')) {
        const wrapperFile = replaceExtension(outputFile, '.html');
        const wrapperRemoved = await removeFileIfExists(wrapperFile);
        if (wrapperRemoved) {
            removedCount += 1;
        }
    }

    if (removedCount > 0) {
        logBuild(config, 'warn', `Output removed (${sourceType} source deleted): ${displayPath(config, outputFile)}`);
    }

    return removedCount;
}

/**
 * Build standalone `dev/html` sources into `build/html`.
 * @param {any} config - Normalized build config.
 * @param {any} scope - Resolved build scope.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<{count:number}>} Build result.
 */
async function runStandaloneHtmlBuild(config, scope, changedOutputs) {
    if (!scope.standaloneHtml || !config.languages.html.enabled) {
        return { count: 0 };
    }

    const sourceDir = config.paths.devHtmlDir;
    const outputDir = config.paths.buildHtmlDir;
    const changedState = resolveChangedCandidateState(config.changedSourcePath, sourceDir, config.languages.html.extensions);

    if (!fs.existsSync(sourceDir)) {
        logBuild(config, 'info', `HTML source directory not found (optional, skipped): ${displayPath(config, sourceDir)}`);
        return { count: 0 };
    }

    const candidates = await collectCandidates(sourceDir, config.languages.html.extensions);
    const selectedCandidates = selectCandidatesForChangedState(candidates, changedState);

    let count = 0;

    for (const inputFile of selectedCandidates) {
        const relativePath = path.relative(sourceDir, inputFile);
        const outputFile = path.resolve(outputDir, relativePath);
        count += await buildHtmlFile(config, inputFile, outputFile, changedOutputs);
    }

    if (changedState && changedState.isKnownExtension && !changedState.exists) {
        count += await removeStandaloneOutputForDeletedSource(config, 'html', changedState.path, changedOutputs);
    }

    return { count };
}

/**
 * Build standalone `dev/css` sources into `build/css`.
 * @param {any} config - Normalized build config.
 * @param {any} scope - Resolved build scope.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @param {Set<string>} cssAssets - Mutable set of processed standalone CSS outputs.
 * @returns {Promise<{count:number}>} Build result.
 */
async function runStandaloneCssBuild(config, scope, changedOutputs, cssAssets) {
    if (!scope.standaloneCss || !config.languages.sass.enabled) {
        return { count: 0 };
    }

    const sourceDir = config.paths.devCssDir;
    const outputDir = config.paths.buildCssDir;
    const changedState = resolveChangedCandidateState(config.changedSourcePath, sourceDir, config.languages.sass.extensions);

    if (!fs.existsSync(sourceDir)) {
        logBuild(config, 'info', `CSS source directory not found (optional, skipped): ${displayPath(config, sourceDir)}`);
        return { count: 0 };
    }

    const candidates = (await collectCandidates(sourceDir, config.languages.sass.extensions)).filter((candidate) => {
        const extension = path.extname(candidate).toLowerCase();
        if ((extension === '.scss' || extension === '.sass') && path.basename(candidate).startsWith('_')) {
            return false;
        }
        return true;
    });

    const selectedCandidates = selectCandidatesForChangedState(candidates, changedState, (state) => path.basename(state.path).startsWith('_'));

    let count = 0;

    for (const inputFile of selectedCandidates) {
        const relativePath = path.relative(sourceDir, inputFile);
        const extension = path.extname(inputFile).toLowerCase();
        const outputRelativePath = renderOutputPathBySourceType('css', relativePath, extension);
        const outputFile = path.resolve(outputDir, outputRelativePath);

        cssAssets.add(outputFile);
        count += await buildCssFile(config, inputFile, outputFile, changedOutputs);
    }

    if (changedState && changedState.isKnownExtension && !changedState.exists) {
        count += await removeStandaloneOutputForDeletedSource(config, 'css', changedState.path, changedOutputs);
    }

    return { count };
}

/**
 * Build standalone `dev/js` sources into `build/js`.
 * @param {any} config - Normalized build config.
 * @param {any} scope - Resolved build scope.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @param {Set<string>} jsAssets - Mutable set of processed standalone JS outputs.
 * @returns {Promise<{count:number}>} Build result.
 */
async function runStandaloneJsBuild(config, scope, changedOutputs, jsAssets) {
    if (!scope.standaloneJs || !config.languages.js.enabled) {
        return { count: 0 };
    }

    const sourceDir = config.paths.devJsDir;
    const outputDir = config.paths.buildJsDir;
    const changedState = resolveChangedCandidateState(config.changedSourcePath, sourceDir, config.languages.js.extensions);

    if (!fs.existsSync(sourceDir)) {
        logBuild(config, 'info', `JS source directory not found (optional, skipped): ${displayPath(config, sourceDir)}`);
        return { count: 0 };
    }

    const candidates = await collectCandidates(sourceDir, config.languages.js.extensions);
    const selectedCandidates = selectCandidatesForChangedState(candidates, changedState);

    let count = 0;

    for (const inputFile of selectedCandidates) {
        const relativePath = path.relative(sourceDir, inputFile);
        const extension = path.extname(inputFile).toLowerCase();
        const outputRelativePath = renderOutputPathBySourceType('js', relativePath, extension);
        const outputFile = path.resolve(outputDir, outputRelativePath);

        jsAssets.add(outputFile);
        count += await buildJsFile(config, inputFile, outputFile, changedOutputs);
    }

    if (changedState && changedState.isKnownExtension && !changedState.exists) {
        count += await removeStandaloneOutputForDeletedSource(config, 'js', changedState.path, changedOutputs);
    }

    return { count };
}

/**
 * Resolve module source file type based on active language extension sets.
 * @param {any} config - Normalized build config.
 * @param {string} absolutePath - Module source path.
 * @returns {"html"|"css"|"js"|""} Resolved module source type.
 */
function inferModuleSourceType(config, absolutePath) {
    const extension = path.extname(absolutePath).toLowerCase();

    if (config.languages.html.enabled && config.languages.html.extensions.has(extension)) {
        return 'html';
    }

    if (config.languages.sass.enabled && config.languages.sass.extensions.has(extension)) {
        return 'css';
    }

    if (config.languages.js.enabled && config.languages.js.extensions.has(extension)) {
        return 'js';
    }

    return '';
}

/**
 * Build module files from `dev/modules` into `build/modules`, preserving full relative structure.
 * @param {any} config - Normalized build config.
 * @param {any} scope - Resolved build scope.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<{count:number}>} Build result.
 */
async function runModulesBuild(config, scope, changedOutputs) {
    if (!scope.modules) {
        return { count: 0 };
    }

    const sourceDir = config.paths.devModulesDir;
    const outputDir = config.paths.buildModulesDir;

    if (!fs.existsSync(sourceDir)) {
        logBuild(config, 'info', `Modules directory not found (optional, skipped): ${displayPath(config, sourceDir)}`);
        return { count: 0 };
    }

    const allowedExtensions = new Set([
        ...Array.from(config.languages.html.extensions),
        ...Array.from(config.languages.sass.extensions),
        ...Array.from(config.languages.js.extensions),
    ]);

    const candidates = await collectCandidates(sourceDir, allowedExtensions);
    const changedState = resolveChangedCandidateState(config.changedSourcePath, sourceDir, allowedExtensions);
    const selectedCandidates = selectCandidatesForChangedState(candidates, changedState, (state) => {
        const isSassPartial = (state.extension === '.scss' || state.extension === '.sass') && path.basename(state.path).startsWith('_');
        return inferModuleSourceType(config, state.path) === 'css' && isSassPartial;
    });

    let count = 0;

    for (const inputFile of selectedCandidates) {
        const fileType = inferModuleSourceType(config, inputFile);
        if (!fileType) {
            continue;
        }

        const relativePath = path.relative(sourceDir, inputFile);

        if (fileType === 'html') {
            const outputFile = path.resolve(outputDir, relativePath);
            count += await buildHtmlFile(config, inputFile, outputFile, changedOutputs);
            continue;
        }

        if (fileType === 'css') {
            const extension = path.extname(inputFile).toLowerCase();
            if ((extension === '.scss' || extension === '.sass') && path.basename(inputFile).startsWith('_')) {
                continue;
            }

            const outputRelativePath = renderOutputPathBySourceType('css', relativePath, extension);
            const outputFile = path.resolve(outputDir, outputRelativePath);
            count += await buildCssFile(config, inputFile, outputFile, changedOutputs);
            continue;
        }

        const sourceExtension = path.extname(inputFile).toLowerCase();
        const outputRelativePath = renderOutputPathBySourceType('js', relativePath, sourceExtension);
        const outputFile = path.resolve(outputDir, outputRelativePath);
        count += await buildJsFile(config, inputFile, outputFile, changedOutputs);
    }

    if (changedState && changedState.isKnownExtension && !changedState.exists) {
        const deletedType = inferModuleSourceType(config, changedState.path);
        if (deletedType) {
            const relativePath = path.relative(sourceDir, changedState.path);
            const outputRelativePath = renderOutputPathBySourceType(deletedType, relativePath, changedState.extension);
            const outputFile = path.resolve(outputDir, outputRelativePath);
            const removedOutput = await removeFileIfExists(outputFile);
            if (removedOutput) {
                changedOutputs.add(outputFile);
                count += 1;
                logBuild(config, 'warn', `Module output removed (source deleted): ${displayPath(config, outputFile)}`);
            }

            if (deletedType === 'css') {
                const removedMap = await removeFileIfExists(`${outputFile}.map`);
                if (removedMap) {
                    count += 1;
                }
            }
        }
    }

    return { count };
}

/**
 * Export one CSS output as an inline HTML wrapper.
 * @param {string} outputFile - CSS output path.
 * @returns {Promise<boolean>} True when wrapper content changed.
 */
async function exportCssAsHtml(outputFile) {
    const htmlFile = replaceExtension(outputFile, '.html');
    const cssText = await readTextFileTrimmed(outputFile);
    const htmlText = `<style>\n${cssText}\n</style>\n`;
    return writeTextFileIfChanged(htmlFile, htmlText);
}

/**
 * Export one JS output as an inline HTML wrapper.
 * @param {string} outputFile - JS output path.
 * @returns {Promise<boolean>} True when wrapper content changed.
 */
async function exportJsAsHtml(outputFile) {
    const htmlFile = replaceExtension(outputFile, '.html');
    const jsText = await readTextFileTrimmed(outputFile);
    const isModule = outputFile.toLowerCase().endsWith('.mjs') || outputFile.toLowerCase().endsWith('.module.js');
    const typeAttribute = isModule ? ' type="module"' : '';
    const htmlText = `<script${typeAttribute}>\n${escapeInlineScriptContent(jsText)}\n</script>\n`;
    return writeTextFileIfChanged(htmlFile, htmlText);
}

/**
 * Export HTML wrappers for one language output set.
 * @param {any} config - Normalized build config.
 * @param {Set<string>} assets - Build output assets.
 * @param {(outputFile:string)=>Promise<boolean>} exporter - Per-file HTML exporter.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed wrapper files.
 */
async function runAssetHtmlExport(config, assets, exporter, changedOutputs) {
    let count = 0;

    for (const outputFile of Array.from(assets).sort()) {
        if (!fs.existsSync(outputFile)) {
            continue;
        }

        const changed = await exporter(outputFile);
        if (!changed) {
            continue;
        }

        const wrapperFile = replaceExtension(outputFile, '.html');
        changedOutputs.add(wrapperFile);
        count += 1;
        logBuild(config, 'success', `HTML exported: ${displayPathPair(config, outputFile, wrapperFile)}`);
    }

    return count;
}

/**
 * Export HTML wrappers for standalone CSS/JS outputs.
 * @param {any} config - Normalized build config.
 * @param {Set<string>} cssAssets - Standalone CSS outputs processed by this build.
 * @param {Set<string>} jsAssets - Standalone JS outputs processed by this build.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed wrapper files.
 */
async function runExportHtml(config, cssAssets, jsAssets, changedOutputs) {
    if (!config.exportHtml.enabled) {
        return 0;
    }

    const cssCount = await runAssetHtmlExport(config, cssAssets, exportCssAsHtml, changedOutputs);
    const jsCount = await runAssetHtmlExport(config, jsAssets, exportJsAsHtml, changedOutputs);
    return cssCount + jsCount;
}

/**
 * Group HTML files by basename and keep the first file for deterministic merge.
 * @param {string} rootDir - Source root directory.
 * @returns {Promise<Map<string, string>>} Basename -> absolute file path map.
 */
async function collectFirstHtmlByBasename(rootDir) {
    const map = new Map();

    if (!fs.existsSync(rootDir)) {
        return map;
    }

    const files = (await walkDirectory(rootDir)).filter((filePath) => path.extname(filePath).toLowerCase() === '.html').sort();

    for (const filePath of files) {
        const key = path.basename(filePath);
        if (!map.has(key)) {
            map.set(key, filePath);
        }
    }

    return map;
}

/**
 * Escape inline script content to avoid closing the script tag accidentally.
 * @param {string} sourceText - JavaScript source text.
 * @returns {string} Escaped JavaScript text safe for inline script tags.
 */
function escapeInlineScriptContent(sourceText) {
    return String(sourceText || '').replace(/<\/script/gi, '<\\/script');
}

/**
 * Resolve merged HTML part content from one exported HTML fragment file.
 * @param {string} htmlFilePath - HTML source path selected for merge.
 * @returns {Promise<string>} Part content ready for final concatenation.
 */
async function resolveMergedPartContent(htmlFilePath) {
    return readTextFileTrimmed(htmlFilePath);
}

/**
 * Resolve one inline module part content from an already built module file.
 * @param {"html"|"css"|"js"} type - Module part type.
 * @param {string} absoluteFilePath - Absolute built file path in `build/modules/<module>/...`.
 * @returns {Promise<string>} Inline-ready content.
 */
async function resolveInlineModulePartContent(type, absoluteFilePath) {
    const sourceText = await readTextFileTrimmed(absoluteFilePath);
    if (!sourceText) {
        return '';
    }

    if (type === 'html') {
        return sourceText;
    }

    if (type === 'css') {
        return `<style>\n${sourceText}\n</style>`;
    }

    const isModule = absoluteFilePath.toLowerCase().endsWith('.mjs') || absoluteFilePath.toLowerCase().endsWith('.module.js');
    const typeAttribute = isModule ? ' type="module"' : '';
    return `<script${typeAttribute}>\n${escapeInlineScriptContent(sourceText)}\n</script>`;
}

/**
 * Merge one module directory into one standalone HTML output next to module folders.
 * @param {any} config - Normalized build config.
 * @param {string} moduleDirPath - Absolute module directory path in `build/modules`.
 * @param {string} moduleName - Module folder name.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed files.
 */
async function mergeOneModuleDirectory(config, moduleDirPath, moduleName, changedOutputs) {
    const moduleFiles = (await walkDirectory(moduleDirPath)).sort();
    const groupedFiles = { html: [], css: [], js: [] };

    for (const filePath of moduleFiles) {
        const extension = path.extname(filePath).toLowerCase();

        if (extension === '.html') {
            groupedFiles.html.push(filePath);
            continue;
        }

        if (extension === '.css') {
            groupedFiles.css.push(filePath);
            continue;
        }

        if (extension === '.js' || extension === '.mjs') {
            groupedFiles.js.push(filePath);
        }
    }

    const mergeableFileCount = groupedFiles.html.length + groupedFiles.css.length + groupedFiles.js.length;
    const mergedParts = [];
    for (const [type, files] of [
        ['html', groupedFiles.html],
        ['css', groupedFiles.css],
        ['js', groupedFiles.js],
    ]) {
        for (const filePath of files) {
            const part = await resolveInlineModulePartContent(type, filePath);
            if (part) {
                mergedParts.push(part);
            }
        }
    }

    const moduleMergeOutputFile = path.resolve(config.paths.buildModulesDir, `${moduleName}.html`);
    if (mergeableFileCount === 0) {
        const removed = await removeFileIfExists(moduleMergeOutputFile);
        if (!removed) {
            return 0;
        }

        changedOutputs.add(moduleMergeOutputFile);
        logBuild(config, 'warn', `Module merge removed (no mergeable files): ${displayPath(config, moduleMergeOutputFile)}`);
        return 1;
    }

    const mergedHtmlText = mergedParts.length > 0 ? `${mergedParts.join('\n\n')}\n` : '\n';
    const changed = await writeTextFileIfChanged(moduleMergeOutputFile, mergedHtmlText);
    if (!changed) {
        return 0;
    }

    changedOutputs.add(moduleMergeOutputFile);
    logBuild(config, 'success', `Module merged: ${displayPath(config, moduleDirPath)} -> ${displayPath(config, moduleMergeOutputFile)}`);
    return 1;
}

/**
 * Merge all built modules into standalone HTML files in `build/modules/<module>.html`.
 * @param {any} config - Normalized build config.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed files.
 */
async function runModuleDirectoryMerges(config, changedOutputs) {
    if (!config.exportHtml.enabled || !config.exportHtml.mergeSameName) {
        return 0;
    }

    if (!fs.existsSync(config.paths.buildModulesDir)) {
        return 0;
    }

    const moduleEntries = (await fsPromises.readdir(config.paths.buildModulesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

    const moduleNames = new Set(moduleEntries);
    let changedCount = 0;

    for (const moduleName of moduleEntries) {
        const moduleDirPath = path.resolve(config.paths.buildModulesDir, moduleName);
        changedCount += await mergeOneModuleDirectory(config, moduleDirPath, moduleName, changedOutputs);
    }

    const topLevelFiles = await fsPromises.readdir(config.paths.buildModulesDir, { withFileTypes: true });
    for (const entry of topLevelFiles) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.html') {
            continue;
        }

        const moduleNameFromFile = path.basename(entry.name, '.html');
        if (moduleNames.has(moduleNameFromFile)) {
            continue;
        }

        const staleFilePath = path.resolve(config.paths.buildModulesDir, entry.name);
        const removed = await removeFileIfExists(staleFilePath);
        if (!removed) {
            continue;
        }

        changedOutputs.add(staleFilePath);
        changedCount += 1;
        logBuild(config, 'warn', `Module merge removed (stale): ${displayPath(config, staleFilePath)}`);
    }

    return changedCount;
}

/**
 * Merge same-name HTML files from build/html, build/css and build/js into build/merge.
 * @param {any} config - Normalized build config.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed merged files.
 */
async function runMergeSameName(config, changedOutputs) {
    if (!config.exportHtml.enabled || !config.exportHtml.mergeSameName) {
        return 0;
    }

    const htmlGroups = await collectFirstHtmlByBasename(config.paths.buildHtmlDir);
    const cssGroups = await collectFirstHtmlByBasename(config.paths.buildCssDir);
    const jsGroups = await collectFirstHtmlByBasename(config.paths.buildJsDir);

    const allNames = new Set([...htmlGroups.keys(), ...cssGroups.keys(), ...jsGroups.keys()]);
    await fsPromises.mkdir(config.paths.buildMergeDir, { recursive: true });
    const expectedOutputs = new Set();

    let count = 0;

    for (const name of Array.from(allNames).sort()) {
        const orderedParts = [
            { type: 'html', filePath: htmlGroups.get(name) },
            { type: 'css', filePath: cssGroups.get(name) },
            { type: 'js', filePath: jsGroups.get(name) },
        ].filter((part) => Boolean(part.filePath));

        if (orderedParts.length < 2) {
            continue;
        }

        const mergedText = `${(await Promise.all(orderedParts.map((part) => resolveMergedPartContent(part.filePath))))
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
            .join('\n\n')}\n`;

        const outputFile = path.resolve(config.paths.buildMergeDir, name);
        expectedOutputs.add(outputFile);
        const changed = await writeTextFileIfChanged(outputFile, mergedText);
        if (!changed) {
            continue;
        }

        changedOutputs.add(outputFile);
        count += 1;

        const sourceLabel = orderedParts.map((part) => displayPath(config, part.filePath)).join(' + ');
        logBuild(config, 'success', `HTML merged: ${sourceLabel} -> ${displayPath(config, outputFile)}`);
    }

    const existingMergeFiles = await walkDirectory(config.paths.buildMergeDir);
    for (const filePath of existingMergeFiles) {
        if (path.extname(filePath).toLowerCase() !== '.html' || expectedOutputs.has(filePath)) {
            continue;
        }

        const removed = await removeFileIfExists(filePath);
        if (!removed) {
            continue;
        }

        changedOutputs.add(filePath);
        count += 1;
        logBuild(config, 'warn', `HTML merge removed (stale): ${displayPath(config, filePath)}`);
    }

    return count;
}

/**
 * Execute one copy task recursively with change-aware writes.
 * @param {any} config - Normalized build config.
 * @param {{from:string,to:string}} task - Copy task.
 * @param {Set<string>} changedOutputs - Mutable set of changed output files.
 * @returns {Promise<number>} Number of changed copied files.
 */
async function runCopyTask(config, task, changedOutputs) {
    if (!fs.existsSync(task.from)) {
        logBuild(config, 'warn', `Copy source not found: ${displayPath(config, task.from)}`);
        return 0;
    }

    const files = await walkDirectory(task.from);
    let count = 0;

    for (const sourceFile of files) {
        const relativePath = path.relative(task.from, sourceFile);
        const destinationFile = path.resolve(task.to, relativePath);
        const buffer = await fsPromises.readFile(sourceFile);
        const previous = await fsPromises.readFile(destinationFile).catch(() => null);
        const changed = !previous || !Buffer.isBuffer(previous) || !buffer.equals(previous);

        if (!changed) {
            continue;
        }

        await ensureParentDirectory(destinationFile);
        await fsPromises.writeFile(destinationFile, buffer);
        changedOutputs.add(destinationFile);
        count += 1;
    }

    if (count > 0) {
        logBuild(config, 'success', `Copy task complete: ${displayPathPair(config, task.from, task.to)} (${count} file${count > 1 ? 's' : ''})`);
    }

    return count;
}

/**
 * Clean build output root.
 * @param {any} config - Normalized build config.
 * @returns {Promise<void>} Completes after clean pass.
 */
async function runClean(config) {
    if (!config.clean) {
        return;
    }

    await fsPromises.rm(config.paths.buildRoot, { recursive: true, force: true });
    logBuild(config, 'info', `Cleaned ${displayPath(config, config.paths.buildRoot)}`);
}

/**
 * Build a targeted HTML export for one changed standalone output file.
 * @param {any} normalizedConfig - Normalized build config.
 * @param {string} outputFilePath - Changed output file path.
 * @returns {Promise<number>} Number of changed HTML wrapper files.
 */
async function exportOutputFileAsHtml(normalizedConfig, outputFilePath) {
    const config = normalizeBuildConfig(normalizedConfig, {
        cwd: normalizedConfig && normalizedConfig.cwd ? normalizedConfig.cwd : process.cwd(),
        logger: normalizedConfig && normalizedConfig.logger ? normalizedConfig.logger : console.log,
        useColor: normalizedConfig && typeof normalizedConfig.useColor === 'boolean' ? normalizedConfig.useColor : supportsColor(),
    });

    if (!config.exportHtml.enabled || !isNonEmptyString(outputFilePath)) {
        return 0;
    }

    const absolutePath = path.resolve(outputFilePath);
    if (!fs.existsSync(absolutePath)) {
        return 0;
    }

    const changedOutputs = new Set();

    if (isPathInsideOrSame(config.paths.buildCssDir, absolutePath) && path.extname(absolutePath).toLowerCase() === '.css') {
        const changed = await exportCssAsHtml(absolutePath);
        if (changed) {
            changedOutputs.add(replaceExtension(absolutePath, '.html'));
        }
    }

    if (isPathInsideOrSame(config.paths.buildJsDir, absolutePath) && ['.js', '.mjs'].includes(path.extname(absolutePath).toLowerCase())) {
        const changed = await exportJsAsHtml(absolutePath);
        if (changed) {
            changedOutputs.add(replaceExtension(absolutePath, '.html'));
        }
    }

    if (config.exportHtml.mergeSameName) {
        await runMergeSameName(config, changedOutputs);
    }

    return changedOutputs.size;
}

/**
 * Run the full build pipeline.
 * @param {any} inputConfig - Runtime config object.
 * @param {any} options - Runtime options.
 * @returns {Promise<{config:object,stats:object,changedOutputs:string[]}>} Build result.
 */
async function runBuild(inputConfig = {}, options = {}) {
    const config = normalizeBuildConfig(inputConfig, options);
    const scope = resolveBuildScope(config);
    const changedOutputs = new Set();
    const standaloneCssAssets = new Set();
    const standaloneJsAssets = new Set();

    await runClean(config);

    const standaloneHtml = await runStandaloneHtmlBuild(config, scope, changedOutputs);
    const standaloneCss = await runStandaloneCssBuild(config, scope, changedOutputs, standaloneCssAssets);
    const standaloneJs = await runStandaloneJsBuild(config, scope, changedOutputs, standaloneJsAssets);
    const modules = await runModulesBuild(config, scope, changedOutputs);

    let copied = 0;
    for (const task of config.copy) {
        copied += await runCopyTask(config, task, changedOutputs);
    }

    const exportedHtml = await runExportHtml(config, standaloneCssAssets, standaloneJsAssets, changedOutputs);
    const mergedHtml = await runMergeSameName(config, changedOutputs);
    const mergedModules = await runModuleDirectoryMerges(config, changedOutputs);

    const total = standaloneHtml.count + standaloneCss.count + standaloneJs.count + modules.count + copied + exportedHtml + mergedHtml + mergedModules;

    logBuild(config, 'success', `Build completed: ${total} file${total > 1 ? 's' : ''}.`);

    return {
        config,
        stats: {
            standaloneHtml: standaloneHtml.count,
            standaloneCss: standaloneCss.count,
            standaloneJs: standaloneJs.count,
            modules: modules.count,
            copy: copied,
            exportHtml: exportedHtml,
            mergeHtml: mergedHtml,
            mergeModules: mergedModules,
            total,
        },
        changedOutputs: Array.from(changedOutputs).sort(),
    };
}

module.exports = {
    DEFAULT_BUILD_LOG_PREFIX,
    normalizeBuildConfig,
    exportOutputFileAsHtml,
    runBuild,
};
