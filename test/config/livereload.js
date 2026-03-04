const http = require("node:http");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const livereload = require("livereload");

const HOST = process.env.LR_HOST || process.env.MFCI_HOST || "127.0.0.1";
const PORT = Number(process.env.LR_PORT || process.env.MFCI_PORT || 35888);
const PROJECT_ROOT = process.cwd();
const MANIFEST_ROUTE = "/magic-file-code-injector.manifest.json";

const FILE_DEFINITIONS = [
  {
    type: "css",
    urlPrefix: "/css/dist",
    fsRoot: path.resolve(PROJECT_ROOT, "css/dist"),
    extensions: new Set([".css"]),
  },
  {
    type: "js",
    urlPrefix: "/js",
    fsRoot: path.resolve(PROJECT_ROOT, "js"),
    extensions: new Set([".js", ".mjs"]),
  },
];

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function isPathInside(basePath, targetPath) {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function toForwardSlashes(value) {
  return value.split(path.sep).join("/");
}

function toUrlPath(fsPath, definition) {
  const relativePath = toForwardSlashes(path.relative(definition.fsRoot, fsPath));
  return `${definition.urlPrefix}/${relativePath}`;
}

function inferScriptType(urlPath) {
  if (urlPath.endsWith(".mjs") || urlPath.endsWith(".module.js")) {
    return "module";
  }

  return "script";
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_TYPES[extension] || "application/octet-stream";
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

  if (definition.type === "js") {
    descriptor.scriptType = inferScriptType(urlPath);
  }

  return descriptor;
}

async function buildManifest() {
  const files = [];

  for (const definition of FILE_DEFINITIONS) {
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
    project: "magic-file-code-injector",
    generatedAt: new Date().toISOString(),
    files,
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function writeText(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === MANIFEST_ROUTE) {
      const manifest = await buildManifest();
      writeJson(res, 200, manifest);
      return;
    }

    const definition = FILE_DEFINITIONS.find((item) => pathname === item.urlPrefix || pathname.startsWith(`${item.urlPrefix}/`));
    if (!definition) {
      writeText(res, 404, "Not Found");
      return;
    }

    const relativePath = pathname.slice(definition.urlPrefix.length).replace(/^\/+/, "");
    if (!relativePath) {
      writeText(res, 400, "Directory listing is disabled.");
      return;
    }

    const absolutePath = path.resolve(definition.fsRoot, relativePath);
    if (!isPathInside(definition.fsRoot, absolutePath)) {
      writeText(res, 400, "Invalid path.");
      return;
    }

    const stats = await fsPromises.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isFile()) {
      writeText(res, 404, "Not Found");
      return;
    }

    const data = await fsPromises.readFile(absolutePath);
    res.writeHead(200, {
      "Content-Type": getMimeType(absolutePath),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  } catch (error) {
    writeText(res, 500, `Server error: ${error.message}`);
  }
});

const requestedWatchDirs = (process.env.LR_WATCH_DIRS || "")
  .split(",")
  .map((directory) => directory.trim())
  .filter(Boolean)
  .map((directory) => path.resolve(PROJECT_ROOT, directory));

const defaultWatchDirs = [
  path.resolve(PROJECT_ROOT, "css/dist"),
  path.resolve(PROJECT_ROOT, "js"),
  path.resolve(PROJECT_ROOT, "dist"),
];

const watchDirs = (requestedWatchDirs.length > 0 ? requestedWatchDirs : defaultWatchDirs).filter((directoryPath) => fs.existsSync(directoryPath));

if (watchDirs.length === 0) {
  console.error("[mfci-server] No watch directory found. Checked: css/dist, js, dist");
  process.exit(1);
}

const lrServer = livereload.createServer({
  host: HOST,
  port: PORT,
  applyCSSLive: true,
  server: httpServer,
});

for (const watchDir of watchDirs) {
  lrServer.watch(watchDir);
  console.log(`[mfci-server] Watching ${watchDir}`);
}

console.log(`[mfci-server] HTTP + WS running on http://${HOST}:${PORT}`);
console.log(`[mfci-server] Manifest endpoint: http://${HOST}:${PORT}${MANIFEST_ROUTE}`);
console.log(`[mfci-server] WebSocket endpoint: ws://${HOST}:${PORT}/livereload`);

function shutdown() {
  try {
    lrServer.close();
  } catch (_error) {
    // Ignore shutdown errors.
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
