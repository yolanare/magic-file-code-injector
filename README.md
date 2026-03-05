# magic-file-code-injector

Repository with:

- browser extension: `extension/magic-file-code-injector`
- reusable npm package: `@mfci/dev-server` (CLI: `mfci-dev-server`, `mfci-build`)

The package ships with:

- CLI/server code (`bin`, `src`)
- extension source (`extension/magic-file-code-injector`)

## Reusable package

The package exposes:

- a local HTTP + LiveReload server (`mfci-dev-server`)
- a build pipeline (`mfci-build`) for Sass/CSS and JS/TS

### Minimal setup for future projects

Copy this `package.json` section:

```json
{
    "scripts": {
        "inject:build": "mfci-build",
        "inject:server": "mfci-dev-server"
    },
    "devDependencies": {
        "@mfci/dev-server": "^0.1.0"
    }
}
```

Then run:

```bash
npm install
npm run inject:server
```

Optional standalone build:

```bash
npm run inject:build
```

## Default behavior

`mfci-build` defaults:

- Sass/CSS input: `css/dev`
- Sass/CSS output: `css`
- JS/TS input: `js/dev`
- JS output: `js`
- `css/dev` and `js/dev` are optional: if present, files are built to parent folders; if missing, build is skipped for that type.
- files already in parent folders (`css/*`, `js/*`) are not transformed by `mfci-build`; they are served as-is.

`mfci-dev-server` defaults:

- serves `/css/*` from `css` (`css/dev` ignored)
- serves `/js/*` from `js` (`js/dev` ignored)
- runs an initial build on startup using `build` config
- watches `css/dev` and `js/dev`: changes trigger rebuild, and compiled output refresh is injected automatically
- host/port: `127.0.0.1:35888`
- internal (not user-configurable): manifest route `/magic-file-code-injector.manifest.json`, project name and log prefixes

## Optional config

The package ships a default template at:

- `src/mfci.config.cjs`

Create your project config (`mfci.config.cjs`) from this template:

```js
module.exports = {
    host: '127.0.0.1',
    port: 35888,
    files: [
        { type: 'css', dir: 'css', urlPrefix: '/css', extensions: ['.css'], ignoreDirs: ['dev'] },
        { type: 'js', dir: 'js', urlPrefix: '/js', extensions: ['.js', '.mjs'], ignoreDirs: ['dev'] },
    ],
    watch: ['css', 'js'],
    build: {
        clean: false,
        sass: {
            enabled: true,
            srcDir: 'css/dev',
            outDir: 'css',
            extensions: ['.scss', '.sass', '.css'],
            style: 'expanded',
            sourceMap: false,
            loadPaths: [],
        },
        js: {
            enabled: true,
            srcDir: 'js/dev',
            outDir: 'js',
            extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'],
            bundle: false,
            minify: false,
            sourcemap: false,
            target: 'es2020',
            format: 'esm',
            platform: 'browser',
        },
        copy: [],
    },
};
```

## CLI options

```bash
mfci-dev-server --config mfci.config.cjs
mfci-dev-server --config mfci.config.cjs --port 35900 --host 127.0.0.1

mfci-build --config mfci.config.cjs
mfci-build --config mfci.config.cjs --clean
```

## Extension

Load unpacked from:

`extension/magic-file-code-injector`

On a target website:

1. Open popup.
2. Enable CSS/JS files for the current domain.
3. Optionally enable auto-refresh for JS.
