# magic-file-code-injector

Repository with:

- browser extension: `extension/magic-file-code-injector`
- reusable npm package: `@mfci/dev-server` (CLI: `mfci-dev-server`)

The package now ships with:

- CLI/server code (`bin`, `src`)
- extension source (`extension/magic-file-code-injector`)

## Reusable package

The package exposes a local HTTP + LiveReload server that serves:

- `/magic-file-code-injector.manifest.json`
- configured CSS/JS files
- websocket endpoint: `/livereload`

### Minimal setup for future projects

Copy this `package.json` section:

```json
{
    "scripts": {
        "inject:server": "mfci-dev-server",
        "inject:build": "node -e \"console.log('No build step required')\""
    },
    "devDependencies": {
        "@mfci/dev-server": "^0.1.0"
    }
}
```

With defaults, no extra config file is required.
The server expects local files in:

- `css/dist` (served as `/css/dist/*`)
- `js` (served as `/js/*`)

Then run:

```bash
npm install
npm run inject:server
```

## Extension

Load unpacked from:

`extension/magic-file-code-injector`

On a target website:

1. Open popup.
2. Enable CSS/JS files for the current domain.
3. Optionally enable auto-refresh for JS.

## CLI options

```bash
mfci-dev-server --config mfci.config.cjs
mfci-dev-server --config mfci.config.cjs --port 35900 --host 127.0.0.1
```
