---
name: wasm-gerber-renderer
description: Use when rendering Gerber/RS-274X PCB files to a browser canvas or PNG with the wasm-gerber-renderer npm package, including CLI, Node.js, and browser usage.
---

# wasm-gerber-renderer

Use `wasm-gerber-renderer` when the user wants to render Gerber/RS-274X PCB layer files to PNG or to an existing browser canvas.

## Install

Browser:

```bash
npm install wasm-gerber-renderer
```

Node.js CLI or headless PNG rendering:

```bash
npm install wasm-gerber-renderer node-gles-webgl2
```

Node.js and CLI rendering are supported via
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) on Linux
x64/arm64, macOS arm64/x64, and Windows x64/arm64. macOS x64 is build-only in
the renderer compatibility workflow because the hosted runner has no EGL display.

For global CLI usage:

```bash
npm install -g wasm-gerber-renderer node-gles-webgl2
```

## CLI

Render one Gerber file:

```bash
gerber-renderer board.gbr --width 1600 --height 1000
```

Render multiple layers together:

```bash
gerber-renderer top.gbr bottom.gbr mask.gbr \
  --output board.png \
  --width 1600 \
  --height 1000 \
  --background '#05070c' \
  --padding 32 \
  --alpha 0.7 \
  --composite-mode blend
```

Render an archive:

```bash
gerber-renderer board-gerbers.tar.gz --width 1600 --height 1000
```

Useful CLI options:

- `--width <px>` and `--height <px>` set PNG size.
- `--output <path>` sets the PNG output path and is required for multiple inputs.
- `--background <color>` accepts hex or `rgb()`/`rgba()`; omit for transparent output.
- `--padding <px>` adds fit-to-view padding.
- `--alpha <0-1>` sets blend-mode Gerber layer opacity; stack mode defaults Gerber layers to full opacity, and drill overlays render at full opacity.
- `--composite-mode <blend|stack>` sets additive blending or ordered stack compositing.
- `--minimum-feature-pixels <px>` keeps thin lines/arcs visible.
- `--max-render-target-bytes <size>` caps per-render target memory, e.g. `512m` or `2g`.
- `--max-band-bytes <size>` caps streamed PNG row-buffer memory.
- `--max-full-frame-bytes <size>` caps full-frame PNG export memory.
- `--framebuffer-memory-safety-factor <n>` adjusts full-frame memory estimates.
- `--render-strategy <auto|full-frame|stream>` chooses the Node PNG export path.
- `--approx-region-arcs` uses faster approximate region arcs.
- `--arc-quality <0|1|2>` controls approximate arc quality.
- `--invert-layer <selector>` renders a Gerber layer as an inverted/negative layer. Repeat it for multiple layers.
- `--outline-layer <selector>` chooses the board outline for inverted layers. Use `auto`, `bounds`, a 1-based layer index, exact layer name, or basename.
- `--flip-x` mirrors the output horizontally.
- `--flip-y` mirrors the output vertically.
- `--no-drill` skips NC drill layers.
- `--no-fit` disables automatic fit-to-view.
- `--skill` prints package usage notes for AI agents.

The CLI renders valid layers and skips invalid inputs such as non-Gerber files in archives. If every layer fails, it exits with an error.

If a single input omits `--output`, generic Gerber extensions such as `.gbr`, `.ger`, `.art`, `.gdo`, and `.pho` are replaced with `.png`; layer-specific or unknown extensions keep the full filename and append `.png`.

## Node.js PNG

Use the `/node` entrypoint. A plain string source is Gerber file content, not a file path. Use `fileLayer()`, `{ path }`, or a `file:` URL for filesystem input.

```js
import { fileLayer, renderGerberToPngFile } from "wasm-gerber-renderer/node";

await renderGerberToPngFile(
  "board.png",
  [
    fileLayer("top.gbr", { name: "Top", color: "#ff3b30" }),
    fileLayer("bottom.gbr", { name: "Bottom", color: "#007aff", alpha: 0.8 }),
  ],
  {
    width: 1600,
    height: 1000,
    background: "#05070c",
    padding: 32,
    compositeMode: "blend",
    minimumFeaturePixels: 1,
    onLayerError: ({ name, error }) => {
      console.warn(`Skipped ${name}: ${error instanceof Error ? error.message : error}`);
    },
  },
);
```

`renderGerberToPngFile()` streams PNG bytes to a temporary file and replaces
the output after success. Use `renderGerberToPngBuffer()` only when the whole
PNG must be kept in memory.

For PNG bytes instead of a file:

```js
import { fileLayer, renderGerberToPngBuffer } from "wasm-gerber-renderer/node";

const png = await renderGerberToPngBuffer([fileLayer("board.gbr")], {
  width: 1200,
  height: 800,
});
```

## Browser Canvas

Use the default browser entrypoint with an `HTMLCanvasElement`.

```js
import { renderGerberToCanvas } from "wasm-gerber-renderer";

const canvas = document.querySelector("canvas");
const gerber = await file.text();

await renderGerberToCanvas(canvas, gerber, {
  background: "#05070c",
  padding: 24,
});
```

Render multiple layers:

```js
await renderGerberToCanvas(
  canvas,
  [
    { source: topGerber, color: [1, 0, 0] },
    { source: bottomGerber, color: [0, 0.7, 1], alpha: 0.8 },
  ],
  {
    width: 1200,
    height: 800,
    padding: 24,
    globalAlpha: 0.7,
  },
);
```

Export a PNG `Blob` in the browser:

```js
import { renderGerberToPng } from "wasm-gerber-renderer";

const blob = await renderGerberToPng(canvas, file, {
  width: 1600,
  height: 1000,
  background: null,
  padding: 32,
});
```

For browser file streaming, pass a `WritableStream` to `renderer.exportPngStream()`
or `renderGerberToPngStream()`. This requires `CompressionStream` support,
closes the stream after `IEND` on success, aborts it on failure, and avoids
building a PNG `Blob`.

## Reusable Renderer

Use a renderer instance when rendering multiple frames.

```js
import { createGerberRenderer } from "wasm-gerber-renderer";

const renderer = await createGerberRenderer(canvas);

try {
  await renderer.withFrame({ width: 1200, height: 800, padding: 24 }, async () => {
    await renderer.renderLayers([
      { source: topGerber, color: [1, 0, 0] },
      { source: bottomGerber, color: [0, 0.7, 1] },
    ]);
  });

  const png = await renderer.exportPng();
} finally {
  renderer.dispose();
}
```

In Node, parse repeated inputs once with prepared layers:

```js
import { createNodeGerberRenderer, fileLayer } from "wasm-gerber-renderer/node";

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

Prepared layer parse options and offsets are fixed at load time. Load the layer again to change `offsetX`, `offsetY`, `preserveArcRegions`, or `arcTessellationQuality`.

## Input Rules

Browser sources:

- `File`
- `string` containing Gerber text
- `Blob`
- `ArrayBuffer`
- `Uint8Array`

Node sources:

- all browser sources
- `URL`
- `{ path: "board.gbr" }`
- `fileLayer("board.gbr", options)`

Layer options:

- `name`
- `color`
- `alpha` overrides the frame default for that layer; in `stack` mode explicit Gerber alpha overrides the full-opacity default, and drill layers default to full opacity unless set
- `offsetX`
- `offsetY`
- `kind` forces `"gerber"` or `"drill"` when a filename is unavailable or ambiguous
- Node-only `inverted` renders a Gerber layer as an inverted/negative layer

Colors are normalized RGB arrays in browser APIs, e.g. `[1, 0, 0]`. Node APIs also accept CSS-like color strings such as `"#ff3b30"` and `"rgba(255,0,0,0.8)"`.

Node prepared layers can be loaded with `preserveArcRegions`,
`arcTessellationQuality`, and `retainSourceContentForInversion`.
Use `retainSourceContentForInversion: true` when a prepared layer must later be
rendered as inverted or used as the explicit inverted outline source.

## Error Handling

Batch APIs skip failed layers by default and continue rendering valid layers:

- `renderGerberToCanvas`
- `renderGerberToPng`
- `renderGerberToPngBuffer`
- `renderGerberToPngFile`
- `renderGerberToPngStream`
- `renderer.renderLayers`
- `renderer.loadLayers`

Use `onLayerError` to report skipped layers. Use `layerErrorMode: "throw"` when a single bad layer should reject the whole render.

`renderer.renderLayer()` and `renderer.loadLayer()` are strict and reject on failure. Use `renderLayers()` or `loadLayers()` for best-effort batch handling.

## Common Options

- `width`, `height`: output size.
- `background`: `null` for transparent output or a color string/RGBA array.
- `fit`: defaults to `true`.
- `padding`: fit-to-view padding in pixels.
- `flipX`, `flipY`: mirror the output around the frame center.
- `view`: manual `{ zoomX, zoomY, offsetX, offsetY }`.
- `globalAlpha`: opacity for Gerber layers without explicit layer `alpha` in `blend` mode; `stack` defaults Gerber layers to full opacity.
- `compositeMode`: `"blend"` for additive alpha blending or `"stack"` for ordered source-over Gerber compositing; drill overlays render after Gerber layers.
- `minimumFeaturePixels`: minimum visible line/arc width.
- `renderDrills`: render NC drill files as drill overlays; set `false` to skip them.
- `preserveArcRegions`: defaults to `true`; set `false` for approximate region arcs.
- `arcTessellationQuality`: `0` low, `1` normal, `2` high.

## Notes

- Node.js rendering requires a WebGL2-capable native module; use `node-gles-webgl2`.
- Node.js and CLI rendering are supported via [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) on Linux x64/arm64, macOS arm64/x64, and Windows x64/arm64. macOS x64 receives build-only validation because the hosted runner has no EGL display.
- Parent directories for output PNG files must already exist.
- Very large Gerber files can fail with memory limits; report the error and avoid retry loops.
- Drill, job, image, text, and metadata files are not Gerber image layers and may be skipped.
