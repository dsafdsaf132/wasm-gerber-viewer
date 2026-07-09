<div align="center">

# wasm-gerber-renderer

**`English`** · [**`简体中文`**](README.zh-Hans.md) · [**`繁體中文`**](README.zh-Hant.md) · [**`한국어`**](README.kr.md)

</div>

---

WebGL2 Gerber renderer powered by the `wasm-gerber-viewer` Rust/WASM parser and renderer.

The package provides:

- Browser canvas rendering from Gerber source strings, `File`, `Blob`, `ArrayBuffer`, or `Uint8Array` inputs
- Node.js PNG rendering through a headless WebGL2 context, including direct file/stream output
- A `gerber-renderer` CLI for rendering Gerber files or `.tar.gz`/`.tgz` archives to PNG
- Bundled `wasm-bindgen` output generated during packaging

The browser entrypoint uses the caller's WebGL2 canvas. The Node.js entrypoint
uses the same WASM/WebGL renderer with
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) as its
default native WebGL2 context provider.

## Contents

- [Install](#install)
- [Platform Support](#platform-support)
- [Browser Usage](#browser-usage)
- [Type Reference](#type-reference)
- [Browser API](#browser-api)
- [Node.js Usage](#nodejs-usage)
- [Node.js API](#nodejs-api)
- [API Options](#api-options)
- [CLI](#cli)
- [License](#license)

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

## Platform Support

Browser rendering is platform independent and uses the caller's WebGL2 canvas.

Node.js and CLI rendering are supported via
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) on:

| Platform      | CI                                                                 |
| ------------- | ------------------------------------------------------------------ |
| Linux x64     | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| Linux arm64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| macOS arm64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| macOS x64     | ![build only](https://img.shields.io/badge/CI-build%20only-yellow) |
| Windows x64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| Windows arm64 | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |

macOS x64 validates installation and native module loading only because the
GitHub-hosted Intel runner cannot create the ANGLE EGL display required for
runtime rendering.

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
      kind?: LayerKind;
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
      inverted?: boolean;
      kind?: LayerKind;
    }
  | {
      path: string;
      name?: string;
      color?: RGBColor | string;
      alpha?: number;
      offsetX?: number;
      offsetY?: number;
      inverted?: boolean;
      kind?: LayerKind;
    };
```

In Node.js APIs, a plain `string` is still Gerber content. Use
`{ path: "board.gbr" }`, `fileLayer("board.gbr")`, or a `file:` URL when
rendering from the filesystem.

## Browser API

- `renderGerberToCanvas(canvas, layers, frameOptions)`: one-shot batch render into an existing WebGL2-capable canvas. `layers` may be a single `GerberLayer`, an array, or a `FileList`. Failed layers are skipped by default.
- `renderGerberToPng(canvas, layers, frameOptions, exportOptions)`: one-shot browser render that returns a PNG `Blob`.
- `renderGerberToPngStream(canvas, writable, layers, frameOptions, exportOptions)`: one-shot browser render that writes PNG chunks to a `WritableStream`, closes it on success, and aborts it on failure. Requires browser `CompressionStream` support.
- `createGerberRenderer(canvas, rendererOptions)`: creates a reusable renderer for multiple frames or layers.
- `renderer.withFrame(frameOptions, callback)`: starts a frame, applies canvas/view options, runs the callback, and presents rendered layers after it resolves.
- `renderer.renderLayer(layer, layerOptions)`: adds one layer to the active frame and returns its numeric layer ID. Must be called inside `withFrame()`. This strict API rejects on failure.
- `renderer.renderLayers(layers, options)`: adds multiple layers and returns `{ renderedCount, failures }`. Failed layers are skipped by default; use `layerErrorMode: "throw"` for strict behavior.
- `renderer.exportPng(exportOptions)`: exports the last browser frame as a PNG `Blob`.
- `renderer.exportPngStream(writable, exportOptions)`: exports the last browser frame to a `WritableStream`, closing it on success or aborting it on failure, without assembling a `Blob`.
- `renderer.dispose()`: releases the WebGL context.

## Node.js Usage

Install `node-gles-webgl2` before using the Node.js entrypoint. Node.js and CLI
rendering are supported via
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) on Linux
x64/arm64, macOS arm64/x64, and Windows x64/arm64.

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

- `createNodeGerberRenderer(rendererOptions)`: creates a reusable headless renderer backed by a native WebGL2/GLES context.
- `renderGerberToPngBuffer(layers, frameOptions, exportOptions, rendererOptions)`: one-shot batch render that returns PNG bytes as a `Uint8Array`.
- `renderGerberToPngFile(outputPath, layers, frameOptions, exportOptions, rendererOptions)`: one-shot batch render that streams PNG bytes to a temporary file, then replaces `outputPath` after success. Parent directories must already exist.
- `renderGerberToPngStream(writable, layers, frameOptions, exportOptions, rendererOptions)`: one-shot batch render that writes PNG chunks to a Node writable stream.
- `fileLayer(path, options)`: creates a path-backed Node layer config. `options` accepts `name`, `color`, `alpha`, `offsetX`, `offsetY`, `inverted`, and `kind`.
- `packageRoot()`: returns the installed package directory path.
- `renderer.loadLayer(layer, layerOptions)`: parses a Node layer once and returns a prepared layer that can be reused across frames.
- `renderer.loadLayers(layers, options)`: parses multiple layers and returns `{ layers, loadedCount, failures }`. Failed layers are skipped by default.
- `renderer.withFrame(frameOptions, callback)`: starts a headless render frame and stores rendered pixels after the callback resolves.
- `renderer.renderLayer(layer, layerOptions)`: adds one layer to the active frame and returns its numeric layer ID. Must be called inside `withFrame()`. This strict API rejects on failure.
- `renderer.renderLayers(layers, options)`: adds multiple layers and returns `{ renderedCount, failures }`. Failed layers are skipped by default; use `layerErrorMode: "throw"` for strict behavior.
- `renderer.exportPng(exportOptions)`: exports the last Node frame as PNG bytes in memory.
- `renderer.exportPngStream(writable, exportOptions)`: exports the last Node frame to a writable stream.
- `renderer.exportPngFile(outputPath, exportOptions)`: exports the last Node frame through a temporary file, then replaces `outputPath` after success.
- `renderer.dispose()`: releases the GLES context.

Use prepared layers when rendering the same Gerber inputs more than once:

```js
const renderer = await createNodeGerberRenderer();

try {
  const prepared = await renderer.loadLayers([
    fileLayer("top.gbr", { color: "#ff4040" }),
    fileLayer("bottom.gbr", { color: "#40ff40" }),
  ]);

  await renderer.withFrame({ width: 1920, height: 1080, background: "#000" }, async () => {
    await renderer.renderLayers(prepared.layers);
  });
  const preview = await renderer.exportPng();

  await renderer.withFrame({ width: 3840, height: 2160, background: "#000" }, async () => {
    await renderer.renderLayers(prepared.layers);
  });
  const highRes = await renderer.exportPng();
} finally {
  renderer.dispose();
}
```

Prepared layer geometry is parsed with the `offsetX`, `offsetY`,
`preserveArcRegions`, and `arcTessellationQuality` values used at load time.
Load the layer again to change those options. Per-frame color and alpha can be
overridden in `renderLayer(preparedLayer, layerOptions)`.

Batch APIs (`renderGerberToCanvas`, `renderGerberToPng`,
`renderGerberToPngStream`, `renderGerberToPngBuffer`,
`renderGerberToPngFile`, and `renderLayers`) render all valid layers they can
load. If every layer fails, the operation rejects with the first layer error.

## API Options

`frameOptions` control the output frame and renderer behavior:

- `width`: output width in pixels. Defaults to the browser canvas width or `1200` in Node.
- `height`: output height in pixels. Defaults to the browser canvas height or `800` in Node.
- `clear`: clears the frame before rendering. Defaults to `true`; Node always renders to a fresh buffer.
- `background`: output background. Defaults to `null` for transparent output. Accepts CSS color strings or `[r, g, b, a]`.
- `fit`: fits all loaded layer bounds into the output frame. Defaults to `true`.
- `padding`: pixel padding applied when `fit` is enabled. Defaults to `0`.
- `flipX`: mirrors the output horizontally around the frame center. Defaults to `false`.
- `flipY`: mirrors the output vertically around the frame center. Defaults to `false`.
- `view`: manual `{ zoomX, zoomY, offsetX, offsetY }`; takes precedence over `fit`.
- `preserveArcRegions`: keeps exact region arcs. Defaults to `true`; set `false` to approximate region arcs.
- `arcTessellationQuality`: arc approximation quality, `0` low, `1` normal, `2` high. Defaults to `1`.
- `minimumFeaturePixels`: minimum rendered line/arc width in screen pixels. Defaults to `1`.
- `renderDrills`: renders NC drill files (`.drl`, `.nc`, `.xnc`, `.xln`) as drill overlays. Defaults to `true`.
- `globalAlpha`: opacity for Gerber layers without an explicit layer `alpha` in `blend` mode. Defaults to `0.7`; drill layers render at full opacity unless their own `alpha` is set.
- `compositeMode`: layer compositing mode, `"blend"` or `"stack"`. Defaults to `"blend"`. `blend` uses additive alpha blending; `stack` uses ordered source-over compositing for Gerber layers, so later Gerber layers cover earlier Gerber layers and default to opacity `1`. Drill overlays render after Gerber layers.
- `invertedOutline`: Node-only outline source for inverted layers. Use `"auto"` to detect a board outline layer, `"bounds"` to fill the current Gerber bounds, or a layer index/name selector. Defaults to `"auto"`.
- `maxBandBytes`: Node-only streamed PNG row-buffer budget. Defaults to `512 MiB`.
- `maxFullFrameBytes`: Node-only memory budget for choosing full-frame PNG export. Defaults to `512 MiB`.
- `maxRenderTargetBytes`: Node-only per-render-target memory cap. By default the renderer probes the available GPU/driver budget and falls back to `2 GiB`.
- `framebufferMemorySafetyFactor`: Node-only multiplier for full-frame framebuffer memory estimates. Defaults to `2`.
- `strategy`: Node-only PNG export strategy, `"auto"`, `"full-frame"`, or `"stream"`. Defaults to `"auto"`.
- `layerErrorMode`: `"skip"` renders remaining valid layers; `"throw"` rejects on first failure. Defaults to `"skip"`.
- `onLayerError`: callback for skipped layers in `"skip"` mode: `{ layer, name, error }`.
- `rendererOptions`: browser one-shot helpers only; passed through when creating the renderer.

`layerOptions` control a single layer:

- `color`: layer color. Browser accepts `[r, g, b]`; Node also accepts hex and `rgb()`/`rgba()` strings. Defaults to an automatic color cycle.
- `alpha`: per-layer opacity. When set, it overrides the frame default for that layer; in `stack` mode explicit Gerber `alpha` overrides the full-opacity default. Drill layers default to full opacity unless set.
- `offsetX`: X offset applied while loading geometry. Defaults to `0`.
- `offsetY`: Y offset applied while loading geometry. Defaults to `0`.
- `inverted`: Node-only; renders this Gerber layer as an inverted/negative layer using `frameOptions.invertedOutline`. Defaults to `false`.
- `kind`: force `"gerber"` or `"drill"` when a source filename is unavailable or ambiguous.
- `name`: layer display name for config objects such as `{ source, name }` or `{ path, name }`.

`loadLayer()` and `loadLayers()` also accept parse/load options:

- `preserveArcRegions`: keeps exact region arcs for prepared layers. Defaults to `true`.
- `arcTessellationQuality`: arc approximation quality for prepared layers when region arcs are approximated.
- `retainSourceContentForInversion`: Node-only; keeps the original Gerber text with a prepared layer so it can be used later as an inverted layer or selected outline source.

`exportOptions` control PNG export:

- `type`: browser-only export MIME type. Defaults to `image/png`; Node always writes PNG.
- `quality`: browser-only encoder quality passed to `canvas.toBlob`.
- `background`: export background override. Use `null` to keep transparency. Defaults to the last frame background.
- `maxBandBytes`: approximate row-buffer budget for streamed PNG export. Node also uses it for high-resolution tiled rendering.
- `maxFullFrameBytes`: Node-only memory budget for full-frame PNG export.
- `maxRenderTargetBytes`: Node-only per-render-target memory cap.
- `framebufferMemorySafetyFactor`: Node-only multiplier for framebuffer memory estimates.
- `strategy`: Node-only PNG export strategy, `"auto"`, `"full-frame"`, or `"stream"`.

`rendererOptions` control renderer creation:

- `wasmModule`: preloaded WASM JS module. Most users do not need this.
- `wasmModuleUrl`: URL used to import the WASM JS module.
- `wasmBinaryUrl`: Node-only `.wasm` binary URL.
- `wasmInitInput`: custom value passed to the WASM module initializer.
- `contextAttributes`: WebGL context attributes.
- `releaseContext`: releases the WebGL/GLES context on `dispose()` when supported. Defaults to `true`.
- `glesModule`: Node-only custom GLES module object. Normal CLI usage uses `node-gles-webgl2`.
- `glesModuleName`: Node-only module name to load for the GLES runtime.
- `gl`: Node-only pre-created WebGL2-compatible context.

## CLI

After global installation, run the CLI directly:

```bash
gerber-renderer board.gbr --width 1200 --height 800 --background '#05070c'
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
  --composite-mode blend \
  --minimum-feature-pixels 1 \
  --invert-layer mask.gbr \
  --outline-layer board.gko
```

Archive example:

```bash
gerber-renderer board-gerbers.tar.gz \
  --width 1600 \
  --height 1000 \
  --background '#05070c'
```

CLI options:

- `<input...>`: one or more Gerber/drill files or `.tar.gz`/`.tgz` archives. Gerber inputs render in argument order; drill inputs render as overlays above Gerber layers.
- `-o, --output <path>`: PNG output path. Required for multiple inputs. Parent directories must already exist.
- `--width <px>`: output width. Defaults to `1200`.
- `--height <px>`: output height. Defaults to `800`.
- `--padding <px>`: fit-to-view padding. Defaults to `0`.
- `--background <color>`: hex or `rgb()`/`rgba()` background. Omit for transparent output.
- `--alpha <0-1>`: Gerber layer opacity in `blend` mode. Defaults to `0.7`; `stack` mode uses full Gerber opacity, and drill overlays render at full opacity.
- `--composite-mode <blend|stack>`: layer compositing mode. Defaults to `blend`.
- `--minimum-feature-pixels <px>`: minimum rendered line/arc width. Defaults to `1`.
- `--max-render-target-bytes <size>`: per-render target memory cap. Accepts bytes or suffixes like `512m` and `2g`.
- `--max-band-bytes <size>`: streamed PNG row-buffer cap. Accepts bytes or suffixes like `512m` and `2g`.
- `--max-full-frame-bytes <size>`: full-frame PNG memory cap. Accepts bytes or suffixes like `512m` and `2g`.
- `--framebuffer-memory-safety-factor <n>`: multiplier for full-frame framebuffer memory estimates. Defaults to `2`.
- `--render-strategy <auto|full-frame|stream>`: PNG export strategy. Defaults to `auto`.
- `--approx-region-arcs`: converts region arcs to line segments before rendering.
- `--arc-quality <0|1|2>`: approximate arc quality. Defaults to `1`.
- `--invert-layer <selector>`: renders a Gerber layer as an inverted/negative layer. Repeat for multiple layers. Selectors match 1-based layer index, exact layer name, or basename.
- `--outline-layer <selector>`: board outline used by inverted layers. Use `auto`, `bounds`, a 1-based layer index, exact layer name, or basename. Defaults to `auto`.
- `--flip-x`: mirrors the output horizontally.
- `--flip-y`: mirrors the output vertically.
- `--no-drill`: skips NC drill layers.
- `--no-fit`: disables fit-to-view.
- `--skill`: prints [package usage notes](SKILL.md) for AI agents.
- `-h, --help`: prints CLI usage and exits.

`--arc-quality` is used only with `--approx-region-arcs`. Quality values are
`0` for low, `1` for normal, and `2` for high.

When multiple input files are provided, the CLI skips failed layers, prints a
warning for each skipped file, and renders the remaining layers. If every input
fails, the command exits with an error.

When one input is provided and `--output` is omitted, the CLI writes next to the
input. Generic Gerber extensions such as `.gbr`, `.ger`, `.art`, `.gdo`, and
`.pho` are replaced with `.png`; layer-specific or unknown extensions keep the
full filename and append `.png`.

## License

[MIT License](LICENSE)
