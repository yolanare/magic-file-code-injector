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
        "@mfci/dev-server": "^0.1.0"
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

- HTML input: `html/dev`
- HTML output: `html/public/build`
- Sass/CSS input: `css/dev`
- Sass/CSS output: `css/public/build`
- JS/TS input: `js/dev`
- JS output: `js/public/build`
- HTML export output (when enabled): `css/html` and `js/html`
- Merged HTML export output (when enabled and matching names exist): `html-merge`
- `css/dev` and `js/dev` are optional: if present, files are built to `public/build`; if missing, build is skipped for that type.
- files already in `html/public/*`, `css/public/*` and `js/public/*` are not transformed by `mfci-build`; they are served as-is.

`mfci-dev-server` defaults:

- serves `/css/*` from `css/public`
- serves `/js/*` from `js/public`
- serves `/html/*` from `html/public`
- runs an initial build on startup using `build` config
- watches `html`, `css` and `js`: changes trigger rebuild/refresh for sources and public files
- host/port: `127.0.0.1:35888`

## Config reference

The package ships a default template at [`src/mfci.config.cjs`](src/mfci.config.cjs).

Create your project config (`mfci.config.cjs`) from this template and override only what you need.

### Package config (`mfci.config.cjs`)

#### Root options

Global configuration options shared by server and build.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | `'127.0.0.1'` | Host used by `mfci-dev-server` HTTP + LiveReload services. |
| `port` | `number` | `35888` | Port used by `mfci-dev-server` HTTP + LiveReload services. |
| `files` | `Array<object>` | HTML + CSS + JS defaults | Public file groups exposed to extension manifest and served over HTTP. |
| `build` | `object` | See `build` table below | Build behavior used by `mfci-build` and startup build in `mfci-dev-server`. |

#### `files[]` item options

Each entry describes one file group exposed in the extension manifest.
`urlPrefix` is generated automatically from `type` (`html` -> `/html`, `css` -> `/css`, `js` -> `/js`).

| Option | Type | Default (html item) | Default (css item) | Default (js item) | Description |
| --- | --- | --- | --- | --- | --- |
| `type` | `'html' \| 'css' \| 'js'` | `'html'` | `'css'` | `'js'` | File family used by manifest/exposure logic. |
| `rootDir` | `string` | `'html'` | `'css'` | `'js'` | Language root directory watched by dev-server. |
| `publicDir` | `string` | `'html/public'` | `'css/public'` | `'js/public'` | Public directory exposed by server for local files. |
| `extensions` | `string[]` | `['.html']` | `['.css']` | `['.js', '.mjs']` | Extensions exposed in manifest for this family. |

#### `build` options

Unified build section:

- `build.exportHtml` generates `.html` files into language folders (`css/html`, `js/html` by default).
- `build.exportHtml.mergeSameName` can also generate merged `.html` files in one root-level folder (`html-merge` by default) when at least 2 export types share the same HTML name.
- For `html` merge input, files are read directly from `html/public` (no duplicated export to `html/html`).
- `build.html` copies `html/dev` into `html/public/build`.
- `build.sass` compiles `css/dev` into `css/public/build`.
- `build.js` compiles `js/dev` into `js/public/build`.
- `build.copy` runs additional directory copy tasks after compilation.
- HTML exports are generated after build steps complete by scanning `css/public` and `js/public` (structure mirrored into `css/html` and `js/html`), while HTML merge input is read directly from `html/public`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `build.clean` | `boolean` | `false` | Clears build output folders before build starts. |
| `build.exportHtml.html` | `boolean` | `false` | When `true`, includes `html/public` files as direct merge input for `mergeSameName` (without exporting them to `html/html`). |
| `build.exportHtml.css` | `boolean` | `false` | When `true`, exports CSS as `.html` with `<style>...</style>`. |
| `build.exportHtml.js` | `boolean` | `false` | When `true`, exports JS as `.html` with `<script>...</script>`. |
| `build.exportHtml.srcDir` | `string` | `'public'` | Source folder (under each language root) scanned to generate HTML exports. |
| `build.exportHtml.outDir` | `string` | `'html'` | Output folder (under each language root) receiving mirrored HTML exports. |
| `build.exportHtml.mergeSameName` | `boolean` | `true` | When `true`, merges matching exported HTML names from enabled HTML/CSS/JS export types into one file. |
| `build.exportHtml.mergeSameNameDir` | `string` | `'html-merge'` | Root-relative output directory used for merged HTML files. |
| `build.exportHtml.mergeSameNameIgnorePath` | `boolean` | `true` | When `true`, merges by HTML filename only (ignores nested path differences between CSS/JS exports). |
| `build.html.enabled` | `boolean` | `true` | Enables HTML build step. |
| `build.html.srcDir` | `string` | `'html/dev'` | Input directory for HTML sources. |
| `build.html.outDir` | `string` | `'html/public/build'` | Output directory for built HTML files. |
| `build.html.extensions` | `string[]` | `['.html']` | Source extensions accepted by HTML step. |
| `build.sass.enabled` | `boolean` | `true` | Enables Sass/CSS build step. |
| `build.sass.srcDir` | `string` | `'css/dev'` | Input directory for Sass/CSS sources. |
| `build.sass.outDir` | `string` | `'css/public/build'` | Output directory for compiled CSS files. |
| `build.sass.extensions` | `string[]` | `['.scss', '.sass', '.css']` | Source extensions accepted by Sass step. |
| `build.sass.style` | `string` | `'expanded'` | Sass output style passed to compiler. |
| `build.sass.sourceMap` | `boolean` | `false` | Enables Sass source maps. |
| `build.sass.loadPaths` | `string[]` | `[]` | Extra Sass import lookup folders. |
| `build.js.enabled` | `boolean` | `true` | Enables JS/TS build step. |
| `build.js.srcDir` | `string` | `'js/dev'` | Input directory for JS/TS sources. |
| `build.js.outDir` | `string` | `'js/public/build'` | Output directory for compiled JS files. |
| `build.js.extensions` | `string[]` | `['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']` | Source extensions accepted by JS step. |
| `build.js.bundle` | `boolean` | `false` | Enables esbuild bundling mode. |
| `build.js.minify` | `boolean` | `false` | Enables esbuild minification. |
| `build.js.sourcemap` | `boolean` | `false` | Enables esbuild sourcemaps. |
| `build.js.target` | `string` | `'es2020'` | JavaScript target passed to esbuild. |
| `build.js.format` | `string` | `'esm'` | Output format passed to esbuild. |
| `build.js.platform` | `string` | `'browser'` | Build platform passed to esbuild. |
| `build.copy` | `Array<{ from: string, to: string }>` | `[]` | Extra copy tasks executed recursively after build. |

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
