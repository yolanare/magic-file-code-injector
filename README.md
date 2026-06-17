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
  - `modules`: built module outputs grouped by optional group path, module and type (`build/modules/<group>/<module>/html`, `css`, `js`)
  - `merge`: merged HTML outputs when `build.exportHtml.mergeSameName` is enabled

Module folders can be placed directly under `dev-mfci/dev/modules` or organized under any number of group folders. A module folder is identified by at least one source file directly inside it; its nested source folders remain part of that module.

For each module path `<group>/<module>`, outputs are written under `dev-mfci/build/modules/<group>/<module>`:

- `html/...`: built HTML files
- `css/...`: built CSS files + exported HTML wrappers next to each CSS file
- `js/...`: built JS files + exported HTML wrappers next to each JS file
- `build/modules/<group>/<module>.html`: merged module HTML, written next to the module folder

For example, `dev/modules/group/example-name/index.scss` builds to `build/modules/group/example-name/css/index.css`, while its merged export is `build/modules/group/example-name.html`.

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
| `build.cleanStart` | `boolean` | `true` | Removes `rootDir/build` once when `mfci-build` or `mfci-dev-server` starts. |
| `build.cleanEvery` | `boolean` | `false` | Removes `rootDir/build` before every build after startup, then rebuilds all sources instead of using incremental scope. |
| `build.copy` | `Array<{ from: string, to: string }>` | `[]` | Additional recursive copy tasks executed after language builds. |
| `build.ignoreDotFiles` | `boolean` | `true` | Ignores dot-prefixed files and directories such as `.file.html` and `.cache/`. |
| `build.addFilePathBanner` | `boolean` | `true` | Adds a leading source identifier comment to generated HTML, CSS and JS files. |
| `build.exportHtml.enabled` | `boolean` | `true` | Exports HTML wrappers next to built CSS/JS outputs (`build/css/*.html`, `build/js/*.html`, and module CSS/JS outputs under `build/modules/<group>/<module>/<type>/*.html`). |
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

`cleanStart` controls the startup build and `cleanEvery` controls subsequent builds independently. Enabling both cleans at startup and before every rebuild. The `mfci-build --clean` flag enables `cleanStart` for that command only.

With `build.addFilePathBanner` enabled, standalone outputs start with their language path without the extension:

```css
/* css/group/test */
```

```html
<!-- html/same-name -->
```

Module outputs use the module path for every language file, for example `/* group/second-example */` or `<!-- example-name -->`. Exported and merged HTML keeps these comments because it reuses the generated content.

## CLI options

```bash
mfci-dev-server --config mfci.config.cjs
mfci-dev-server --config mfci.config.cjs --port 35900 --host 127.0.0.1

mfci-build --config mfci.config.cjs
mfci-build --config mfci.config.cjs --clean
```

Build browser extension ZIP packages:

```bash
npm run build:extension
```

This writes:

- `extension/dist/chrome/magic-file-code-injector-chrome.zip`
- `extension/dist/firefox/magic-file-code-injector-firefox.zip`

Each ZIP contains `manifest.json` at the archive root. The working unpacked extension keeps the Chrome manifest after packaging.

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
