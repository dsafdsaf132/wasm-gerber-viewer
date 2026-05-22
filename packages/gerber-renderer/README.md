# wasm-gerber-renderer

WebGL2 Gerber renderer powered by the `wasm-gerber-viewer` Rust/WASM parser and renderer.

The package provides:

- Browser canvas rendering from Gerber source strings, `File`, `Blob`, `ArrayBuffer`, or `Uint8Array` inputs
- Node.js PNG rendering through a headless WebGL2 context
- A `gerber-renderer` CLI for rendering Gerber files or `.tar.gz`/`.tgz` archives to PNG
- Bundled `wasm-bindgen` output generated during packaging

The browser entrypoint uses the caller's WebGL2 canvas. The Node.js entrypoint
uses the same WASM/WebGL renderer, but needs a native WebGL2 context provider.

## Install

Browser users:

```bash
npm install wasm-gerber-renderer
```

CLI users need the renderer package and
[`node-gles-webgl2`](https://www.npmjs.com/package/node-gles-webgl2):

```bash
npm install -g wasm-gerber-renderer node-gles-webgl2
```

The same package is also published to GitHub Packages as
`@dsafdsaf132/wasm-gerber-renderer`:

```bash
npm config set @dsafdsaf132:registry https://npm.pkg.github.com
npm install @dsafdsaf132/wasm-gerber-renderer
```

When installing from GitHub Packages, replace import specifiers such as
`wasm-gerber-renderer` with `@dsafdsaf132/wasm-gerber-renderer`.

Browser usage does not need `node-gles-webgl2`.

## Browser Usage

```js
import { renderGerberToCanvas } from "wasm-gerber-renderer";

const canvas = document.querySelector("canvas");
const gerber = await file.text();

await renderGerberToCanvas(canvas, gerber, {
  background: "#05070c",
  padding: 24,
});
```

For repeated rendering, reuse a renderer instance:

```js
import { createGerberRenderer } from "wasm-gerber-renderer";

const renderer = await createGerberRenderer(canvas);

await renderer.withFrame({ width: 1200, height: 800, padding: 24 }, async () => {
  await renderer.renderLayers([
    { source: topCopper, color: [1, 0, 0] },
    { source: bottomCopper, color: [0, 0.7, 1], alpha: 0.8 },
  ]);
});
```

Batch helpers render as many valid layers as possible by default. If one layer
fails to parse, the remaining layers are still rendered. Use `onLayerError` to
inspect skipped layers, or set `layerErrorMode: "throw"` for strict behavior.

## Type Reference

Color arrays use normalized channel values in the `0` to `1` range.

```ts
type RGBColor = [number, number, number];
type RGBAColor = [number, number, number, number];

type GerberSource =
  | File
  | string
  | Blob
  | ArrayBuffer
  | Uint8Array;

type GerberLayer =
  | GerberSource
  | {
      source: GerberSource;
      name?: string;
      color?: RGBColor;
      alpha?: number;
      offsetX?: number;
      offsetY?: number;
    };
```

In browser APIs, a `string` source is Gerber file content. `File`, `Blob`,
`ArrayBuffer`, and `Uint8Array` sources are decoded as text. Layer config
objects let you attach per-layer options directly to a source.

Node.js accepts the same content sources, plus file paths through `URL`,
`{ path }`, or `{ path, ...options }` layer objects:

```ts
type GerberNodeSource =
  | File
  | string
  | Blob
  | ArrayBuffer
  | Uint8Array
  | URL
  | { path: string };

type GerberNodeLayer =
  | GerberNodeSource
  | {
      source: GerberNodeSource;
      name?: string;
      color?: RGBColor | string;
      alpha?: number;
      offsetX?: number;
      offsetY?: number;
    }
  | {
      path: string;
      name?: string;
      color?: RGBColor | string;
      alpha?: number;
      offsetX?: number;
      offsetY?: number;
    };
```

In Node.js APIs, a plain `string` is still Gerber content. Use
`{ path: "board.gbr" }`, `fileLayer("board.gbr")`, or a `file:` URL when
rendering from the filesystem.

## Browser API

| API | Description |
| --- | --- |
| `renderGerberToCanvas(canvas, layers, frameOptions)` | One-shot batch render into an existing WebGL2-capable canvas. `layers` may be a single `GerberLayer`, an array of layers, or a `FileList`. Failed layers are skipped by default. |
| `renderGerberToPng(canvas, layers, frameOptions, exportOptions)` | One-shot batch render through a browser canvas and returns a PNG `Blob`. `layers` accepts the same values as `renderGerberToCanvas`. Failed layers are skipped by default. |
| `createGerberRenderer(canvas, rendererOptions)` | Creates a reusable renderer for rendering multiple frames or layers without reloading the WASM module every time. |
| `renderer.withFrame(frameOptions, callback)` | Starts a render frame, applies canvas/view options, runs the sync or async callback, and presents the rendered layers after the callback resolves. |
| `renderer.renderLayer(layer, layerOptions)` | Adds one `GerberLayer` to the active frame and resolves to the numeric layer ID. Must be called inside `withFrame()`. This strict single-layer API rejects on failure. |
| `renderer.renderLayers(layers, options)` | Adds multiple layers to the active frame and resolves to `{ renderedCount, failures }`. By default, failed layers are skipped and reported through `onLayerError`; set `layerErrorMode: "throw"` for strict behavior. |
| `renderer.exportPng(exportOptions)` | Exports the last rendered browser frame as a PNG `Blob`. |
| `renderer.dispose()` | Releases the WebGL context when the renderer is no longer needed. |

## Node.js Usage

Install `node-gles-webgl2` before using the Node.js entrypoint.

```js
import { fileLayer, renderGerberToPngFile } from "wasm-gerber-renderer/node";

await renderGerberToPngFile(
  "board.png",
  [
    fileLayer("top.gbr", { name: "Top copper", color: "#ff3b30" }),
    fileLayer("bottom.gbr", { name: "Bottom copper", color: "#007aff" }),
  ],
  {
    width: 1200,
    height: 800,
    background: "#05070c",
    padding: 24,
    onLayerError: ({ name, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Skipped ${name}: ${message}`);
    },
  },
);
```

## Node.js API

| API | Description |
| --- | --- |
| `createNodeGerberRenderer(rendererOptions)` | Creates a reusable headless renderer backed by a native WebGL2/GLES context. |
| `renderGerberToPngBuffer(layers, frameOptions, exportOptions, rendererOptions)` | One-shot batch render that resolves to PNG bytes as a `Uint8Array`. `layers` may be a single `GerberNodeLayer` or an array. Failed layers are skipped by default. |
| `renderGerberToPngFile(outputPath, layers, frameOptions, exportOptions, rendererOptions)` | One-shot batch render that writes PNG bytes to `outputPath`. Parent directories must already exist. Failed layers are skipped by default. |
| `fileLayer(path, options)` | Creates a path-backed Node layer config. `options` accepts `name`, `color`, `alpha`, `offsetX`, and `offsetY`. |
| `packageRoot()` | Returns the installed package directory path. |
| `renderer.withFrame(frameOptions, callback)` | Starts a headless render frame, runs the sync or async callback, and stores the rendered pixels after the callback resolves. |
| `renderer.renderLayer(layer, layerOptions)` | Adds one `GerberNodeLayer` to the active frame and resolves to the numeric layer ID. Must be called inside `withFrame()`. This strict single-layer API rejects on failure. |
| `renderer.renderLayers(layers, options)` | Adds multiple layers to the active frame and resolves to `{ renderedCount, failures }`. By default, failed layers are skipped and reported through `onLayerError`; set `layerErrorMode: "throw"` for strict behavior. |
| `renderer.exportPng(exportOptions)` | Exports the last rendered Node frame as PNG bytes. |
| `renderer.dispose()` | Releases the GLES context when the renderer is no longer needed. |

Batch APIs (`renderGerberToCanvas`, `renderGerberToPng`,
`renderGerberToPngBuffer`, `renderGerberToPngFile`, and `renderLayers`) render
all valid layers they can load. If every layer fails, the operation rejects with
the first layer error.

## API Options

`frameOptions` control the output frame and renderer behavior:

| Option | Default | Description |
| --- | --- | --- |
| `width` | Browser canvas width, Node: `1200` | Output width in pixels. |
| `height` | Browser canvas height, Node: `800` | Output height in pixels. |
| `clear` | `true` | Clears the frame before rendering. Node always renders to a fresh buffer and does not support `false`. |
| `background` | `null` | Background color. Use `null` for transparent output, a browser CSS color string, a Node hex/`rgb()`/`rgba()` string, or `[r, g, b, a]`. |
| `fit` | `true` | Fits all loaded layer bounds into the output frame. |
| `padding` | `0` | Pixel padding applied when `fit` is enabled. |
| `view` | `null` | Manual view override: `{ zoomX, zoomY, offsetX, offsetY }`. When provided, it takes precedence over `fit`. |
| `preserveArcRegions` | `true` | Keeps region arcs for exact arc-region rendering. Set `false` to approximate region arcs. |
| `arcTessellationQuality` | `1` | Arc approximation quality: `0` low, `1` normal, `2` high. |
| `minimumFeaturePixels` | `1` | Minimum rendered line/arc width in screen pixels. |
| `globalAlpha` | `0.7` | Global opacity multiplier applied to rendered layers. |
| `layerErrorMode` | `"skip"` | Batch layer loading behavior for one-shot helpers and `renderLayers()`. `"skip"` renders remaining valid layers; `"throw"` rejects on the first failed layer. |
| `onLayerError` | `undefined` | Callback invoked for each skipped layer in `"skip"` mode: `{ layer, name, error }`. |
| `rendererOptions` | `{}` | Browser one-shot helpers only. Passed through when creating the renderer. |

`layerOptions` control a single layer:

| Option | Default | Description |
| --- | --- | --- |
| `color` | Automatic color cycle | Layer color. Browser accepts `[r, g, b]`; Node accepts `[r, g, b]`, hex strings, or `rgb()`/`rgba()` strings. |
| `alpha` | `1` | Per-layer opacity before `globalAlpha` is applied. |
| `offsetX` | `0` | X offset applied while loading the layer geometry. |
| `offsetY` | `0` | Y offset applied while loading the layer geometry. |
| `name` | Source name or `Layer <id>` | Layer display name when using layer config objects such as `{ source, name }` or `{ path, name }`. |

`exportOptions` control PNG export:

| Option | Default | Description |
| --- | --- | --- |
| `type` | `image/png` | Browser-only export MIME type. Node always writes PNG. |
| `quality` | Browser default | Browser-only encoder quality passed to `canvas.toBlob`. |
| `background` | Last frame background | Export background override. Use `null` to keep transparency. |

`rendererOptions` control renderer creation:

| Option | Applies to | Default | Description |
| --- | --- | --- | --- |
| `wasmModule` | Browser, Node | Bundled module | Preloaded WASM JS module. Most users do not need this. |
| `wasmModuleUrl` | Browser, Node | Bundled module URL | URL used to import the WASM JS module. |
| `wasmBinaryUrl` | Node | Bundled `.wasm` URL | Binary URL used when initializing the WASM module in Node.js. |
| `wasmInitInput` | Browser, Node | `undefined` | Custom value passed to the WASM module initializer. |
| `contextAttributes` | Browser, Node | Package defaults | WebGL context attributes. |
| `releaseContext` | Browser, Node | `true` | Releases the WebGL/GLES context on `dispose()` when supported. |
| `glesModule` | Node | Auto-loaded | Custom GLES module object. Normal CLI usage uses `node-gles-webgl2`. |
| `glesModuleName` | Node | `node-gles-webgl2` fallback list | Module name to load for the GLES runtime. |
| `gl` | Node | Auto-created | Pre-created WebGL2-compatible context. |

## CLI

After global installation, run the CLI directly:

```bash
gerber-renderer board.gbr -o board.png --width 1200 --height 800 --background '#05070c'
```

More complete example:

```bash
gerber-renderer top.gbr bottom.gbr \
  --output board.png \
  --width 1600 \
  --height 1000 \
  --background '#05070c' \
  --padding 32 \
  --alpha 0.7 \
  --minimum-feature-pixels 1
```

Archive example:

```bash
gerber-renderer board-gerbers.tar.gz \
  --output board.png \
  --width 1600 \
  --height 1000 \
  --background '#05070c'
```

CLI options:

| Option | Default | Description |
| --- | --- | --- |
| `<input...>` | Required | One or more Gerber files or `.tar.gz`/`.tgz` archives. Multiple files are rendered as separate layers in argument order. Regular archive entries are expanded in archive order; non-Gerber entries are skipped by the renderer. |
| `-o, --output <path>` | Required | PNG output path. Parent directories must already exist. |
| `--width <px>` | `1200` | Output canvas width in pixels. Must be a positive integer. |
| `--height <px>` | `800` | Output canvas height in pixels. Must be a positive integer. |
| `--padding <px>` | `0` | Extra screen-space padding used by fit-to-view. |
| `--background <color>` | Transparent | Hex or `rgb()`/`rgba()` background color, such as `#05070c` or `rgba(0,0,0,0)`. |
| `--alpha <0-1>` | `0.7` | Global layer opacity applied while rendering. |
| `--minimum-feature-pixels <px>` | `1` | Minimum rendered line/arc width in screen pixels, useful for keeping very thin features visible. |
| `--approx-region-arcs` | Disabled | Converts region arcs to line segments before rendering instead of using the exact arc-region renderer. |
| `--arc-quality <0\|1\|2>` | `1` | Arc tessellation quality: `0` low, `1` normal, `2` high. Mainly relevant with `--approx-region-arcs`. |
| `--no-fit` | Disabled | Disables fit-to-view and renders with the renderer's identity view. |
| `-h, --help` | - | Prints CLI usage and exits. |

`--arc-quality` is used only with `--approx-region-arcs`. Quality values are
`0` for low, `1` for normal, and `2` for high.

When multiple input files are provided, the CLI skips failed layers, prints a
warning for each skipped file, and renders the remaining layers. If every input
fails, the command exits with an error.

## License

[MIT License](LICENSE)
