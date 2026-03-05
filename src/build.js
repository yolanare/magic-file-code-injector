const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const sass = require("sass");
const esbuild = require("esbuild");
const { formatLogLine, formatPath, supportsColor } = require("./log-format");
const DEFAULT_TEMPLATE = require("./mfci.config.cjs");

const DEFAULT_BUILD_LOG_PREFIX = "[mfci-build]";

/**
 * Centralize non-empty string checks to keep config normalization concise and consistent.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @returns {boolean} True when value is a non-empty string.
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalize optional booleans while preserving explicit false values.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @param {any} defaultValue - Fallback boolean used when value is not explicitly provided.
 * @returns {boolean} Boolean value with fallback applied.
 */
function normalizeBoolean(value, defaultValue) {
  if (typeof value === "boolean") {
    return value;
  }
  return defaultValue;
}

/**
 * Normalize extension lists to dot-prefixed lowercase values for reliable matching.
 * @param {any} extensions - Configured extensions list before normalization.
 * @param {any} fallbackList - Default extension list used when config does not define one.
 * @returns {Set<string>} Normalized extension set used by matchers.
 */
function normalizeExtensions(extensions, fallbackList) {
  const source = Array.isArray(extensions) && extensions.length > 0 ? extensions : fallbackList;
  const normalized = source
    .map((extension) => String(extension || "").trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
  return new Set(normalized);
}

/**
 * Resolve configurable paths relative to cwd to avoid ambiguous runtime behavior.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @param {any} inputValue - Config value that may override default directory.
 * @param {any} fallbackValue - Default directory used when config is missing.
 * @returns {string} Absolute directory path.
 */
function normalizeDirectory(cwd, inputValue, fallbackValue) {
  const directory = isNonEmptyString(inputValue) ? inputValue.trim() : fallbackValue;
  return path.resolve(cwd, directory);
}

/**
 * Normalize Sass build options into a stable config object used by the build pipeline.
 * @param {any} source - Raw partial config section to normalize.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @returns {object} Normalized Sass build config.
 */
function normalizeSassConfig(source, cwd) {
  const defaults = DEFAULT_TEMPLATE.build.sass;
  const input = source || {};
  const style = input.style === "compressed" ? "compressed" : defaults.style;

  const loadPaths = Array.isArray(input.loadPaths)
    ? input.loadPaths.map((entry) => String(entry || "").trim()).filter(Boolean).map((entry) => path.resolve(cwd, entry))
    : [];

  return {
    enabled: normalizeBoolean(input.enabled, defaults.enabled),
    srcDir: normalizeDirectory(cwd, input.srcDir, defaults.srcDir),
    outDir: normalizeDirectory(cwd, input.outDir, defaults.outDir),
    extensions: normalizeExtensions(input.extensions, defaults.extensions),
    style,
    sourceMap: normalizeBoolean(input.sourceMap, defaults.sourceMap),
    loadPaths,
  };
}

/**
 * Normalize JavaScript build options into a stable config object used by the build pipeline.
 * @param {any} source - Raw partial config section to normalize.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @returns {object} Normalized JS build config.
 */
function normalizeJsConfig(source, cwd) {
  const defaults = DEFAULT_TEMPLATE.build.js;
  const input = source || {};

  return {
    enabled: normalizeBoolean(input.enabled, defaults.enabled),
    srcDir: normalizeDirectory(cwd, input.srcDir, defaults.srcDir),
    outDir: normalizeDirectory(cwd, input.outDir, defaults.outDir),
    extensions: normalizeExtensions(input.extensions, defaults.extensions),
    bundle: normalizeBoolean(input.bundle, defaults.bundle),
    minify: normalizeBoolean(input.minify, defaults.minify),
    sourcemap: normalizeBoolean(input.sourcemap, defaults.sourcemap),
    target: isNonEmptyString(input.target) ? input.target.trim() : defaults.target,
    format: isNonEmptyString(input.format) ? input.format.trim() : defaults.format,
    platform: isNonEmptyString(input.platform) ? input.platform.trim() : defaults.platform,
  };
}

/**
 * Normalize optional HTML export settings used to generate embeddable style/script wrappers.
 * @param {any} source - Raw `build.exportHtml` section from config.
 * @param {any} defaults - Default `build.exportHtml` section from template.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @returns {{css:boolean,js:boolean,outDir:string}} Normalized HTML export settings.
 */
function normalizeExportHtmlConfig(source, defaults, cwd) {
  const input = source || {};
  return {
    css: normalizeBoolean(input.css, defaults.css),
    js: normalizeBoolean(input.js, defaults.js),
    outDir: normalizeDirectory(cwd, input.outDir, defaults.outDir),
  };
}

/**
 * Normalize copy tasks and drop invalid entries early to keep build execution straightforward.
 * @param {any} source - Raw partial config section to normalize.
 * @param {any} cwd - Working directory used to resolve relative paths.
 * @returns {Array<object>} Validated copy task list.
 */
function normalizeCopyTasks(source, cwd) {
  if (!Array.isArray(source) || source.length === 0) {
    return [];
  }

  return source
    .map((task) => (task && typeof task === "object" ? task : {}))
    .map((task) => {
      const from = isNonEmptyString(task.from) ? path.resolve(cwd, task.from.trim()) : "";
      const to = isNonEmptyString(task.to) ? path.resolve(cwd, task.to.trim()) : "";

      if (!from || !to) {
        return null;
      }

      return {
        from,
        to,
      };
    })
    .filter(Boolean);
}

/**
 * Normalize full build config once so build steps can focus on execution only.
 * @param {any} inputConfig - Raw configuration object provided by caller or config file.
 * @param {any} options - Runtime options that override or complement loaded config.
 * @returns {object} Fully normalized build config.
 */
function normalizeBuildConfig(inputConfig = {}, options = {}) {
  const defaults = DEFAULT_TEMPLATE.build;
  const cwd = options.cwd || process.cwd();
  const source = inputConfig || {};
  const logger = typeof options.logger === "function" ? options.logger : console.log;
  const useColor = typeof options.useColor === "boolean" ? options.useColor : supportsColor();
  const changedSourcePath = isNonEmptyString(options.changedSourcePath) ? path.resolve(options.changedSourcePath) : "";

  return {
    cwd,
    logger,
    useColor,
    changedSourcePath,
    // Build log prefix is internal by design so the public config stays focused on build behavior only.
    logPrefix: DEFAULT_BUILD_LOG_PREFIX,
    clean: normalizeBoolean(source.clean, defaults.clean),
    exportHtml: normalizeExportHtmlConfig(source.exportHtml, defaults.exportHtml, cwd),
    sass: normalizeSassConfig(source.sass, cwd),
    js: normalizeJsConfig(source.js, cwd),
    copy: normalizeCopyTasks(source.copy, cwd),
  };
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
 * Format paths in logs using forward slashes for cross-platform readability.
 * @param {any} value - Raw value to sanitize or normalize before runtime usage.
 * @returns {string} Path formatted with forward slashes.
 */
function withPosixSeparators(value) {
  return value.split(path.sep).join("/");
}

/**
 * Render a filesystem path as a short, gray label in logs.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {any} absolutePath - Absolute path to display.
 * @returns {string} Styled relative path label.
 */
function displayPath(config, absolutePath) {
  const relativePath = withPosixSeparators(path.relative(config.cwd, absolutePath) || ".");
  return formatPath(relativePath, { useColor: config.useColor });
}

/**
 * Render source and target paths as a consistent log segment.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {any} sourcePath - Source file or directory path.
 * @param {any} targetPath - Target file or directory path.
 * @returns {string} Styled source-to-target segment.
 */
function displayPathPair(config, sourcePath, targetPath) {
  return `${displayPath(config, sourcePath)} -> ${displayPath(config, targetPath)}`;
}

/**
 * Emit one structured build log through the configured logger.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {"info"|"success"|"warn"|"error"} level - Severity level used for color and hierarchy.
 * @param {any} message - Runtime message payload received from UI/content/background.
 * @returns {void} Writes message to configured logger.
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
 * Compare resolved paths to avoid accidental destructive operations on source directories.
 * @param {any} leftPath - First path in equality comparison.
 * @param {any} rightPath - Second path in equality comparison.
 * @returns {boolean} True when both paths resolve to the same location.
 */
function isSamePath(leftPath, rightPath) {
  return path.resolve(leftPath) === path.resolve(rightPath);
}

/**
 * Variant of path containment check that also accepts the exact same path.
 * @param {any} basePath - Base directory used for containment checks.
 * @param {any} targetPath - Target path to validate against a base directory.
 * @returns {boolean} True when target is inside base path or equal to it.
 */
function isPathInsideOrSame(basePath, targetPath) {
  const relativePath = path.relative(path.resolve(basePath), path.resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * Ensure output parent directories exist before writing built artifacts.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @returns {Promise<void>} Completes when parent directory exists.
 */
async function ensureParentDirectory(filePath) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Replace file extension while preserving relative directory structure.
 * @param {any} filePath - Filesystem path or changed path used by the current operation.
 * @param {any} extension - Source file extension used for output mapping.
 * @returns {string} Path with the requested extension.
 */
function replaceExtension(filePath, extension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

/**
 * Resolve the HTML export target path under the configured root using one subfolder per output type.
 * @param {string} outputFile - Built output file (css/js).
 * @param {string} sourceOutDir - Build output directory that produced the file.
 * @param {string} exportOutDir - Root export HTML directory.
 * @returns {string} Absolute HTML export path.
 */
function resolveHtmlExportPath(outputFile, sourceOutDir, exportOutDir) {
  const relativePath = path.relative(sourceOutDir, outputFile);
  const htmlRelativePath = replaceExtension(relativePath, ".html");
  const typeFolder = path.basename(sourceOutDir);
  return path.resolve(exportOutDir, typeFolder, htmlRelativePath);
}

/**
 * Escape inline script content so embedded `</script>` sequences do not break generated HTML wrappers.
 * @param {string} sourceText - JavaScript source to embed inline.
 * @returns {string} Safe inline script content.
 */
function escapeInlineScriptContent(sourceText) {
  return String(sourceText || "").replace(/<\/script/gi, "<\\/script");
}

/**
 * Keep HTML JS export script mode aligned with dev-server manifest behavior.
 * @param {string} outputFile - Built JS output path.
 * @returns {boolean} True when exported HTML should use `<script type="module">`.
 */
function shouldUseModuleScriptTag(outputFile) {
  const lowerPath = String(outputFile || "").toLowerCase();
  return lowerPath.endsWith(".mjs") || lowerPath.endsWith(".module.js");
}

/**
 * Export one CSS asset as an embeddable HTML snippet (`<style>...</style>`).
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {any} sassConfig - Normalized Sass build config.
 * @param {string} outputFile - Built CSS output path.
 * @param {string} cssText - CSS content to wrap.
 * @returns {Promise<number>} Number of exported HTML files (0 or 1).
 */
async function exportCssAsHtml(config, sassConfig, outputFile, cssText) {
  if (!config.exportHtml.css) {
    return 0;
  }

  const htmlFile = resolveHtmlExportPath(outputFile, sassConfig.outDir, config.exportHtml.outDir);
  const htmlText = `<style>\n${cssText}\n</style>\n`;
  await ensureParentDirectory(htmlFile);
  await fsPromises.writeFile(htmlFile, htmlText, "utf8");
  logBuild(config, "success", `HTML exported: ${displayPathPair(config, outputFile, htmlFile)}`);
  return 1;
}

/**
 * Export one JS asset as an embeddable HTML snippet (`<script>...</script>`).
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @param {any} jsConfig - Normalized JS build config.
 * @param {string} outputFile - Built JS output path.
 * @returns {Promise<number>} Number of exported HTML files (0 or 1).
 */
async function exportJsAsHtml(config, jsConfig, outputFile) {
  if (!config.exportHtml.js) {
    return 0;
  }

  const jsText = await fsPromises.readFile(outputFile, "utf8");
  const htmlFile = resolveHtmlExportPath(outputFile, jsConfig.outDir, config.exportHtml.outDir);
  const needsModuleType = shouldUseModuleScriptTag(outputFile);
  const scriptTag = needsModuleType ? '<script type="module">' : "<script>";
  const htmlText = `${scriptTag}\n${escapeInlineScriptContent(jsText)}\n</script>\n`;

  await ensureParentDirectory(htmlFile);
  await fsPromises.writeFile(htmlFile, htmlText, "utf8");
  logBuild(config, "success", `HTML exported: ${displayPathPair(config, outputFile, htmlFile)}`);
  return 1;
}

/**
 * Collect output files eligible for static HTML export from one output directory.
 * @param {any} outputDir - Output directory to scan recursively.
 * @param {any} sourceDir - Source directory that must be excluded from static exports.
 * @param {Set<string>} supportedExtensions - Extensions allowed for export in this output type.
 * @returns {Promise<string[]>} Absolute output file paths eligible for static export.
 */
async function collectStaticExportCandidates(outputDir, sourceDir, supportedExtensions) {
  if (!fs.existsSync(outputDir)) {
    return [];
  }

  const files = await walkDirectory(outputDir);
  const candidates = files.filter((filePath) => {
    const resolvedPath = path.resolve(filePath);
    const extension = path.extname(resolvedPath).toLowerCase();
    if (!supportedExtensions.has(extension)) {
      return false;
    }

    if (isPathInsideOrSame(sourceDir, resolvedPath)) {
      return false;
    }

    return true;
  });

  candidates.sort();
  return candidates;
}

/**
 * Export HTML wrappers for static files already present in css/js output folders.
 * Files under source folders (`css/dev`, `js/dev`) are intentionally excluded.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @returns {Promise<number>} Number of static HTML files exported.
 */
async function runStaticHtmlExports(config) {
  let exportedCount = 0;

  if (config.exportHtml.css) {
    const cssCandidates = await collectStaticExportCandidates(
      config.sass.outDir,
      config.sass.srcDir,
      new Set([".css"])
    );

    for (const cssFile of cssCandidates) {
      const cssText = await fsPromises.readFile(cssFile, "utf8");
      exportedCount += await exportCssAsHtml(config, config.sass, cssFile, cssText);
    }
  }

  if (config.exportHtml.js) {
    const jsCandidates = await collectStaticExportCandidates(
      config.js.outDir,
      config.js.srcDir,
      new Set([".js", ".mjs"])
    );

    for (const jsFile of jsCandidates) {
      exportedCount += await exportJsAsHtml(config, config.js, jsFile);
    }
  }

  return exportedCount;
}

/**
 * Map TS/JS-like input extensions to final JS output filenames.
 * @param {any} relativePath - Path relative to source root.
 * @param {any} extension - Source file extension used for output mapping.
 * @returns {string} Output-relative JS path.
 */
function renderOutputPathForJs(relativePath, extension) {
  const lowerExtension = extension.toLowerCase();
  if (lowerExtension === ".ts" || lowerExtension === ".tsx" || lowerExtension === ".jsx" || lowerExtension === ".cjs") {
    return replaceExtension(relativePath, ".js");
  }
  return relativePath;
}

/**
 * Clean output folders safely while protecting source trees from accidental deletion.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @returns {Promise<void>} Completes after safe clean pass.
 */
async function cleanOutputDirectories(config) {
  if (!config.clean) {
    return;
  }

  const outputDirs = new Set([config.sass.outDir, config.js.outDir, ...config.copy.map((task) => task.to)]);
  if (config.exportHtml.css || config.exportHtml.js) {
    outputDirs.add(config.exportHtml.outDir);
  }

  for (const outputDir of outputDirs) {
    if (!outputDir || !fs.existsSync(outputDir)) {
      continue;
    }

    if (isSamePath(outputDir, config.sass.srcDir) || isSamePath(outputDir, config.js.srcDir)) {
      logBuild(config, "warn", `Skip clean for source directory: ${displayPath(config, outputDir)}`);
      continue;
    }

    if (isPathInsideOrSame(outputDir, config.sass.srcDir) || isPathInsideOrSame(outputDir, config.js.srcDir)) {
      // Prevent destructive clean when output is a parent folder containing source trees.
      logBuild(config, "warn", `Skip clean for parent directory containing sources: ${displayPath(config, outputDir)}`);
      continue;
    }

    await fsPromises.rm(outputDir, { recursive: true, force: true });
    logBuild(config, "info", `Cleaned ${displayPath(config, outputDir)}`);
  }
}

/**
 * Compile Sass/CSS inputs (when present) into deployable CSS files for injection.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @returns {Promise<number>} Number of Sass/CSS files produced.
 */
async function runSassBuild(config) {
  const sassConfig = config.sass;

  if (!sassConfig.enabled) {
    logBuild(config, "info", "Sass build disabled.");
    return 0;
  }

  if (!fs.existsSync(sassConfig.srcDir)) {
    logBuild(config, "info", `Sass source directory not found (optional, skipped): ${displayPath(config, sassConfig.srcDir)}`);
    return 0;
  }

  const sourceFiles = await walkDirectory(sassConfig.srcDir);
  const candidates = sourceFiles.filter((absolutePath) => {
    const extension = path.extname(absolutePath).toLowerCase();
    return sassConfig.extensions.has(extension);
  });

  let scopedCandidates = candidates;
  if (config.changedSourcePath && isPathInsideOrSame(sassConfig.srcDir, config.changedSourcePath)) {
    const changedExtension = path.extname(config.changedSourcePath).toLowerCase();
    const isSassPartial = path.basename(config.changedSourcePath).startsWith("_");
    if (!isSassPartial && sassConfig.extensions.has(changedExtension)) {
      scopedCandidates = candidates.filter((candidate) => path.resolve(candidate) === config.changedSourcePath);
    }
  }

  if (scopedCandidates.length === 0) {
    logBuild(config, "info", "No Sass/CSS files to build.");
    return 0;
  }

  let builtCount = 0;

  for (const inputFile of scopedCandidates) {
    const relativePath = path.relative(sassConfig.srcDir, inputFile);
    const extension = path.extname(inputFile).toLowerCase();
    const isPlainCss = extension === ".css";
    const relativeOutputPath = isPlainCss ? relativePath : replaceExtension(relativePath, ".css");
    const outputFile = path.resolve(sassConfig.outDir, relativeOutputPath);

    await ensureParentDirectory(outputFile);

    if (isPlainCss) {
      // `.css` files are copied as-is so hand-authored CSS in `css/dev` keeps exact output.
      await fsPromises.copyFile(inputFile, outputFile);
      logBuild(config, "success", `CSS copied: ${displayPathPair(config, inputFile, outputFile)}`);
      builtCount += 1;
      continue;
    }

    const compiled = sass.compile(inputFile, {
      style: sassConfig.style,
      sourceMap: sassConfig.sourceMap,
      loadPaths: sassConfig.loadPaths,
    });

    let cssText = compiled.css;
    if (sassConfig.sourceMap && compiled.sourceMap) {
      // Keep source map linkage explicit for browser devtools.
      const mapFile = `${outputFile}.map`;
      cssText += `\n/*# sourceMappingURL=${path.basename(mapFile)} */\n`;
      await fsPromises.writeFile(mapFile, JSON.stringify(compiled.sourceMap), "utf8");
    }

    await fsPromises.writeFile(outputFile, cssText, "utf8");

    logBuild(config, "success", `Sass built: ${displayPathPair(config, inputFile, outputFile)}`);

    builtCount += 1;
  }

  return builtCount;
}

/**
 * Compile JS/TS inputs (when present) into runtime JS files consumed by the extension.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @returns {Promise<number>} Number of JS/TS files produced.
 */
async function runJsBuild(config) {
  const jsConfig = config.js;

  if (!jsConfig.enabled) {
    logBuild(config, "info", "JS build disabled.");
    return 0;
  }

  if (!fs.existsSync(jsConfig.srcDir)) {
    logBuild(config, "info", `JS source directory not found (optional, skipped): ${displayPath(config, jsConfig.srcDir)}`);
    return 0;
  }

  const sourceFiles = await walkDirectory(jsConfig.srcDir);
  const candidates = sourceFiles.filter((absolutePath) => {
    const extension = path.extname(absolutePath).toLowerCase();
    return jsConfig.extensions.has(extension);
  });

  let scopedCandidates = candidates;
  if (
    config.changedSourcePath &&
    isPathInsideOrSame(jsConfig.srcDir, config.changedSourcePath) &&
    !jsConfig.bundle
  ) {
    const changedExtension = path.extname(config.changedSourcePath).toLowerCase();
    if (jsConfig.extensions.has(changedExtension)) {
      scopedCandidates = candidates.filter((candidate) => path.resolve(candidate) === config.changedSourcePath);
    }
  }

  if (scopedCandidates.length === 0) {
    logBuild(config, "info", "No JS/TS files to build.");
    return 0;
  }

  let builtCount = 0;

  for (const inputFile of scopedCandidates) {
    const relativePath = path.relative(jsConfig.srcDir, inputFile);
    const extension = path.extname(inputFile).toLowerCase();
    const relativeOutputPath = renderOutputPathForJs(relativePath, extension);
    const outputFile = path.resolve(jsConfig.outDir, relativeOutputPath);

    await ensureParentDirectory(outputFile);

    // Build each file independently by default (no bundle) to preserve one-file-per-entry injection.
    await esbuild.build({
      entryPoints: [inputFile],
      outfile: outputFile,
      bundle: jsConfig.bundle,
      minify: jsConfig.minify,
      sourcemap: jsConfig.sourcemap,
      target: jsConfig.target,
      format: jsConfig.format,
      platform: jsConfig.platform,
      logLevel: "silent",
      legalComments: "none",
      charset: "utf8",
    });

    logBuild(config, "success", `JS built: ${displayPathPair(config, inputFile, outputFile)}`);

    builtCount += 1;
  }

  return builtCount;
}

/**
 * Execute optional file copy tasks that complement generated build artifacts.
 * @param {any} config - Normalized runtime configuration for the current subsystem.
 * @returns {Promise<number>} Number of copied files.
 */
async function runCopyTasks(config) {
  if (config.copy.length === 0) {
    return 0;
  }

  let copiedCount = 0;

  for (const task of config.copy) {
    if (!fs.existsSync(task.from)) {
      logBuild(config, "warn", `Copy source not found: ${displayPath(config, task.from)}`);
      continue;
    }

    const files = await walkDirectory(task.from);

    for (const sourceFile of files) {
      const relativePath = path.relative(task.from, sourceFile);
      const destinationFile = path.resolve(task.to, relativePath);

      await ensureParentDirectory(destinationFile);
      await fsPromises.copyFile(sourceFile, destinationFile);

      copiedCount += 1;
    }

    logBuild(
      config,
      "success",
      `Copy task complete: ${displayPathPair(config, task.from, task.to)} (${files.length} file${files.length > 1 ? "s" : ""})`
    );
  }

  return copiedCount;
}

/**
 * Run the full build pipeline and return step-level counts for observability.
 * @param {any} inputConfig - Raw configuration object provided by caller or config file.
 * @param {any} options - Runtime options that override or complement loaded config.
 * @returns {Promise<object>} Build result with normalized config and counters.
 */
async function runBuild(inputConfig = {}, options = {}) {
  const config = normalizeBuildConfig(inputConfig, options);

  await cleanOutputDirectories(config);

  const sassCount = await runSassBuild(config);
  const jsCount = await runJsBuild(config);
  const copyCount = await runCopyTasks(config);
  const staticHtmlCount = await runStaticHtmlExports(config);

  const total = sassCount + jsCount + copyCount + staticHtmlCount;
  logBuild(config, "success", `Build completed: ${total} file${total > 1 ? "s" : ""}.`);

  return {
    config,
    stats: {
      sass: sassCount,
      js: jsCount,
      copy: copyCount,
      staticHtml: staticHtmlCount,
      total,
    },
  };
}

module.exports = {
  DEFAULT_BUILD_LOG_PREFIX,
  DEFAULT_SASS_EXTENSIONS: DEFAULT_TEMPLATE.build.sass.extensions,
  DEFAULT_JS_EXTENSIONS: DEFAULT_TEMPLATE.build.js.extensions,
  normalizeBuildConfig,
  runBuild,
};
