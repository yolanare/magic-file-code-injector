# magic-file-code-injector

Repository with:

- browser extension: `extension/magic-file-code-injector`
- reusable npm package: `@mfci/dev-server` (CLI: `mfci-dev-server`, `mfci-build`)

## Reusable package

The package exposes:

- a local HTTP + LiveReload server (`mfci-dev-server`)
- a build pipeline (`mfci-build`) for Sass/CSS and JS/TS

### Minimal setup for future projects

Copy this `package.json` section:

```json
{
    "scripts": {
        "build": "mfci-build",
        "dev": "mfci-dev-server"
    },
    "devDependencies": {
        "@mfci/dev-server": "^0.3.0"
    }
}
```

Then run:

```bash
npm install
npm run dev
```

Optional standalone build:

```bash
npm run build
```

## Default behavior

`mfci-build` defaults:

- root workspace: `dev-mfci`
- source root: `dev-mfci/dev`
- output root: `dev-mfci/build`
- optional source directories under `dev-mfci/dev`:
  - `html`: standalone HTML
  - `css`: standalone Sass/CSS
  - `js`: standalone JS/TS
  - `modules`: grouped HTML/CSS/JS modules
- output directories under `dev-mfci/build`:
  - `html`: built standalone HTML
  - `css`: built standalone CSS
  - `js`: built standalone JS
  - `modules`: built module outputs grouped by module and type (`build/modules/<module>/html`, `build/modules/<module>/css`, `build/modules/<module>/js`)
  - `merge`: merged HTML outputs when `build.exportHtml.mergeSameName` is enabled

For each module `<module>` under `dev-mfci/dev/modules`, outputs are written under `dev-mfci/build/modules/<module>`:

- `html/...`: built HTML files
- `css/...`: built CSS files + exported HTML wrappers next to each CSS file
- `js/...`: built JS files + exported HTML wrappers next to each JS file
- `build/modules/<module>.html`: merged module HTML (kept at the `build/modules` root)

`mfci-dev-server` defaults:

- serves all JS/CSS files found under `dev-mfci/build`
- runs an initial build on startup using `build` config
- watches existing source folders under `dev-mfci/dev` (`html`, `css`, `js`, `modules`)
- on source changes, rebuilds and sends refresh only for changed outputs
- host/port: `127.0.0.1:35888`

## Config reference

The package ships a default template at [`src/mfci.config.cjs`](src/mfci.config.cjs).

Create your project config (`mfci.config.cjs`) from this template and override only what you need.

### Package config (`mfci.config.cjs`)

#### Root options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | `'127.0.0.1'` | Host used by `mfci-dev-server` HTTP + LiveReload services. |
| `port` | `number` | `35888` | Port used by `mfci-dev-server` HTTP + LiveReload services. |
| `rootDir` | `string` | `'dev-mfci'` | Root folder containing `dev` sources and `build` outputs. |
| `build` | `object` | see below | Build behavior shared by `mfci-build` and startup build in `mfci-dev-server`. |

#### `build` options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `build.clean` | `boolean` | `false` | Removes `rootDir/build` before build starts. |
| `build.copy` | `Array<{ from: string, to: string }>` | `[]` | Additional recursive copy tasks executed after language builds. |
| `build.exportHtml.enabled` | `boolean` | `true` | Exports HTML wrappers next to built CSS/JS outputs (`build/css/*.html`, `build/js/*.html`, and module CSS/JS outputs under `build/modules/<module>/<type>/*.html`). |
| `build.exportHtml.mergeSameName` | `boolean` | `true` | Merges same-name HTML files from `build/html`, `build/css`, `build/js` into `build/merge` in `html > css > js` order. |
| `build.languages.html.enabled` | `boolean` | `true` | Enables standalone/module HTML build. |
| `build.languages.html.extensions` | `string[]` | `['.html']` | Source extensions accepted as HTML. |
| `build.languages.sass.enabled` | `boolean` | `true` | Enables standalone/module Sass/CSS build. |
| `build.languages.sass.extensions` | `string[]` | `['.scss', '.sass', '.css']` | Source extensions accepted as Sass/CSS. |
| `build.languages.sass.settings.style` | `string` | `'expanded'` | Sass output style (`expanded` or `compressed`). |
| `build.languages.sass.settings.sourceMap` | `boolean` | `false` | Enables Sass source maps. |
| `build.languages.sass.settings.loadPaths` | `string[]` | `[]` | Extra Sass import lookup paths. |
| `build.languages.js.enabled` | `boolean` | `true` | Enables standalone/module JS/TS build. |
| `build.languages.js.extensions` | `string[]` | `['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']` | Source extensions accepted as JS/TS-like. |
| `build.languages.js.settings.bundle` | `boolean` | `false` | Enables esbuild bundling mode. |
| `build.languages.js.settings.minify` | `boolean` | `false` | Enables esbuild minification. |
| `build.languages.js.settings.sourcemap` | `boolean` | `false` | Enables esbuild source maps. |
| `build.languages.js` (default mode) | behavior | `bundle=false`, `minify=false`, `sourcemap=false` | Plain `.js`/`.mjs` files are copied as-is (no transformation) to stay as close as possible to source code. |
| `build.languages.js.settings.target` | `string` | `'es2020'` | JavaScript target passed to esbuild. |
| `build.languages.js.settings.format` | `string` | `'esm'` | Output format passed to esbuild. |
| `build.languages.js.settings.platform` | `string` | `'browser'` | Build platform passed to esbuild. |

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

### Extension settings

The extension stores settings in browser storage and applies them per domain.

Global: connection to the local server.
Per-site: active file selection and JS behavior per domain.

| Scope | Option | Type | Default | Where to edit | Description |
| --- | --- | --- | --- | --- | --- |
| Global | `global.host` | `string` | `'127.0.0.1'` | Internal default | Host used by extension to connect to MFCI server. |
| Global | `global.port` | `number` | `35888` | Options page | Port used by extension to connect to MFCI server. |
| Global | `global.injectionEnabled` | `boolean` | `true` | Popup | Enables/disables all CSS/JS injection globally without changing per-site file selections. |
| Per-site | `enabledFileIds` | `string[]` | `[]` | Popup | Selected CSS/JS files enabled for this domain. |
| Per-site | `autoRefreshJs` | `boolean` | `false` | Popup | Enables full page reload when selected JS files change. |

On a target website:

1. Open popup.
2. Enable CSS/JS files for the current domain.
3. Optionally enable auto-refresh for JS.
