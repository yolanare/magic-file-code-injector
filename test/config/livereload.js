const livereload = require("livereload");
const { resolve } = require("node:path");

const watchDir = resolve(process.cwd(), "dist");

const server = livereload.createServer({
  host: "127.0.0.1",
  port: 35729,
  applyCSSLive: true
});

server.watch(watchDir);

console.log(`[livereload] Watching ${watchDir}`);
console.log("[livereload] WebSocket URL: ws://127.0.0.1:35729/livereload");
