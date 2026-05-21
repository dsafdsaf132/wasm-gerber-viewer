# wasm-gerber-renderer

WebGL2 Gerber renderer powered by the `wasm-gerber-viewer` Rust/WASM parser and renderer.

The package provides:

- Browser canvas rendering from Gerber source strings, `File`, `Blob`, `ArrayBuffer`, or `Uint8Array` inputs
- Node.js PNG rendering through a headless WebGL2 context
- A `gerber-renderer` CLI for rendering Gerber files to PNG
- Bundled `wasm-bindgen` output generated during packaging

## Install

```bash
npm install wasm-gerber-renderer
```

For Node.js/headless rendering, also install a WebGL2-capable GLES package:

```bash
npm install wasm-gerber-renderer node-gles-webgl2
```

`node-gles-webgl2` is an optional native runtime for Node.js rendering, not a browser dependency. You can also pass a compatible custom GLES module through `rendererOptions.glesModule`.

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
  await renderer.renderLayer(topCopper, { color: [1, 0, 0] });
  await renderer.renderLayer(bottomCopper, { color: [0, 0.7, 1], alpha: 0.8 });
});
```

## Node.js Usage

```js
import { renderGerberToPngFile } from "wasm-gerber-renderer/node";

await renderGerberToPngFile(
  "board.png",
  ["top.gbr", "bottom.gbr"],
  {
    width: 1200,
    height: 800,
    background: "#05070c",
    padding: 24,
  },
);
```

## CLI

```bash
npx gerber-renderer board.gbr -o board.png --width 1200 --height 800 --background '#05070c'
```

Useful options:

```text
--padding <px>                   Fit padding in pixels
--alpha <0-1>                    Global alpha
--minimum-feature-pixels <px>    Minimum line/arc display width
--approx-region-arcs             Approximate region arcs before rendering
--arc-quality <0|1|2>            Approx arc quality
--no-fit                         Use identity view instead of fit view
```

## Custom WASM or GLES Modules

The default package includes the WASM renderer under `wasm/`.

Advanced callers can override the WASM module or binary:

```js
import wasmModule from "./custom/wasm_gerber_processor.js";
import { createNodeGerberRenderer } from "wasm-gerber-renderer/node";

const renderer = await createNodeGerberRenderer({
  wasmModule,
  wasmModuleUrl: new URL("./custom/wasm_gerber_processor.js", import.meta.url),
});
```

For Node.js, a custom GLES module can be supplied:

```js
await createNodeGerberRenderer({
  glesModule: customGlesModule,
});
```

## Publish Checklist

From `packages/gerber-renderer`:

```bash
npm run check
npm run verify:publish
npm publish
```

`prepack` builds the Rust/WASM package and stages the generated files into this package before packing. `postpack` removes the staged WASM directory from the working tree.

## License

MIT
