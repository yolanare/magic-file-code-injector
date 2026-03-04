# magic-file-code-injector

Local workflow to inject **CSS + JavaScript** from your machine into any site, with per-domain selection memory.

## Project structure

- `test/`: local dev server + watch pipeline that exposes files and manifest
- `extension/magic-file-code-injector/`: browser extension (Chrome/Firefox MV3)

## Quick start

### 1) Start local file server

```bash
cd test
npm install
npm run dev
```

This starts:

- Sass watcher: `test/css/dev -> test/dist`
- Local HTTP + WebSocket server: `http://127.0.0.1:35888`

Server endpoints:

- Manifest: `http://127.0.0.1:35888/magic-file-code-injector.manifest.json`
- WebSocket: `ws://127.0.0.1:35888/livereload`

### 2) Load extension

Load unpacked extension from:

`extension/magic-file-code-injector`

### 3) Use on a site

- Open any `http` or `https` page
- Click the extension icon
- Select files to activate for the current domain
- Optional: enable `Auto-refresh page when JS updates`

Selections are saved per host (default: all files disabled).

## Manifest contract

The extension expects:

`/magic-file-code-injector.manifest.json`

Example:

```json
{
  "version": 1,
  "generatedAt": "2026-03-04T10:00:00.000Z",
  "files": [
    {
      "id": "css:/dist/test.css",
      "type": "css",
      "path": "/dist/test.css",
      "label": "test.css"
    },
    {
      "id": "js:/js/test.js",
      "type": "js",
      "scriptType": "script",
      "path": "/js/test.js",
      "label": "test.js"
    }
  ]
}
```

## Notes

- JavaScript injection is **best effort**. On strict CSP pages, execution can be blocked.
- If JS auto-refresh is disabled, JS file changes are stored as pending updates per domain.
