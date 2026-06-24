<div align="center">

# wasm-gerber-renderer

[**`English`**](README.md) · **`简体中文`** · [**`繁體中文`**](README.zh-Hant.md) · [**`한국어`**](README.kr.md)

</div>

---

本包是一个基于 `wasm-gerber-viewer` Rust/WASM 解析器和渲染器的 WebGL2 Gerber 渲染工具。

本包提供：

- 在浏览器 canvas 中渲染 Gerber 内容字符串、`File`、`Blob`、`ArrayBuffer` 或 `Uint8Array`
- 通过无界面的 WebGL2 上下文在 Node.js 中渲染 PNG，并支持直接输出到文件或流
- 将 Gerber 文件或 `.tar.gz`/`.tgz` 压缩包渲染为 PNG 的 `gerber-renderer` CLI
- 打包时生成并内置的 `wasm-bindgen` 输出

浏览器入口使用调用方提供的 WebGL2 canvas。Node.js 入口使用同一个 WASM/WebGL 渲染器，并默认通过 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 创建原生 WebGL2 上下文。

## 目录

- [安装](#安装)
- [平台支持](#平台支持)
- [浏览器用法](#浏览器用法)
- [类型参考](#类型参考)
- [浏览器 API](#浏览器-api)
- [Node.js 用法](#nodejs-用法)
- [Node.js API](#nodejs-api)
- [API 选项](#api-选项)
- [CLI](#cli)
- [开源协议](#开源协议)

## 安装

浏览器用户：

```bash
npm install wasm-gerber-renderer
```

CLI 用户需要渲染器包和 [`node-gles-webgl2`](https://www.npmjs.com/package/node-gles-webgl2)。

```bash
npm install -g wasm-gerber-renderer node-gles-webgl2
```

同一个包也以 `@dsafdsaf132/wasm-gerber-renderer` 名称发布到 GitHub Packages。

```bash
npm config set @dsafdsaf132:registry https://npm.pkg.github.com
npm install @dsafdsaf132/wasm-gerber-renderer
```

从 GitHub Packages 安装时，需要把 import 路径中的 `wasm-gerber-renderer` 改为 `@dsafdsaf132/wasm-gerber-renderer`。

浏览器用法不需要 `node-gles-webgl2`。

## 平台支持

浏览器渲染与平台无关，使用调用方提供的 WebGL2 canvas。

Node.js 和 CLI 渲染通过 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 支持以下平台：

| Platform      | CI                                                                 |
| ------------- | ------------------------------------------------------------------ |
| Linux x64     | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| Linux arm64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| macOS arm64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| macOS x64     | ![build only](https://img.shields.io/badge/CI-build%20only-yellow) |
| Windows x64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| Windows arm64 | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |

macOS x64 包含在 `node-gles-webgl2` 支持矩阵中，但当前 renderer compatibility workflow 只对该平台执行 build-only 验证。

## 浏览器用法

```js
import { renderGerberToCanvas } from "wasm-gerber-renderer";

const canvas = document.querySelector("canvas");
const gerber = await file.text();

await renderGerberToCanvas(canvas, gerber, {
  background: "#05070c",
  padding: 24,
});
```

如果需要重复渲染，请复用渲染器实例。

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

批量渲染辅助函数默认会尽可能渲染所有有效图层。如果某个图层解析失败，其余图层仍会继续渲染。可以通过 `onLayerError` 查看被跳过的图层，或设置 `layerErrorMode: "throw"` 在首次失败时中断。

## 类型参考

颜色数组使用 `0` 到 `1` 范围内的归一化通道值。

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

在浏览器 API 中，`string` 输入源表示 Gerber 文件内容。`File`、`Blob`、`ArrayBuffer` 和 `Uint8Array` 输入源会被解码为文本。图层配置对象可以把每层选项直接附加到输入源上。

Node.js 接受相同的内容输入源，并额外支持通过 `URL`、`{ path }` 或 `{ path, ...options }` 图层对象指定文件路径。

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
    }
  | {
      path: string;
      name?: string;
      color?: RGBColor | string;
      alpha?: number;
      offsetX?: number;
      offsetY?: number;
      inverted?: boolean;
    };
```

在 Node.js API 中，普通 `string` 仍然表示 Gerber 内容。从文件系统读取并渲染时，请使用 `{ path: "board.gbr" }`、`fileLayer("board.gbr")` 或 `file:` URL。

## 浏览器 API

- `renderGerberToCanvas(canvas, layers, frameOptions)`：一次调用即可将图层批量渲染到现有的 WebGL2 canvas。`layers` 可以是单个 `GerberLayer`、数组或 `FileList`。失败的图层默认会被跳过。
- `renderGerberToPng(canvas, layers, frameOptions, exportOptions)`：在浏览器中完成一次性渲染，并返回 PNG `Blob`。
- `renderGerberToPngStream(canvas, writable, layers, frameOptions, exportOptions)`：把 PNG 数据块写入 `WritableStream` 并关闭它。需要浏览器支持 `CompressionStream`。
- `createGerberRenderer(canvas, rendererOptions)`：创建可复用渲染器，用于渲染多个帧或多个图层。
- `renderer.withFrame(frameOptions, callback)`：开始一个渲染帧，应用 canvas 和视图选项，并在回调函数结束后显示渲染后的图层。
- `renderer.renderLayer(layer, layerOptions)`：向当前帧添加一个图层，并返回数值型图层 ID。必须在 `withFrame()` 内调用；这是严格接口，失败时会以该错误 reject。
- `renderer.renderLayers(layers, options)`：添加多个图层，并返回 `{ renderedCount, failures }`。失败的图层默认会被跳过；需要严格行为时使用 `layerErrorMode: "throw"`。
- `renderer.exportPng(exportOptions)`：把最后一个浏览器帧导出为 PNG `Blob`。
- `renderer.exportPngStream(writable, exportOptions)`：把最后一个浏览器帧导出到 `WritableStream`，无需先组装成 `Blob`。
- `renderer.dispose()`：释放 WebGL 上下文。

## Node.js 用法

使用 Node.js 入口前请安装 `node-gles-webgl2`。Node.js 和 CLI 渲染通过 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 支持 Linux x64/arm64、macOS arm64/x64 和 Windows x64/arm64。

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

- `createNodeGerberRenderer(rendererOptions)`：创建由原生 WebGL2/GLES 上下文支撑的可复用无界面渲染器。
- `renderGerberToPngBuffer(layers, frameOptions, exportOptions, rendererOptions)`：一次调用即可批量渲染，并以 `Uint8Array` 返回 PNG 字节数据。
- `renderGerberToPngFile(outputPath, layers, frameOptions, exportOptions, rendererOptions)`：一次调用即可批量渲染，把 PNG 字节数据写入临时文件，成功后替换 `outputPath`。父目录必须已存在。
- `renderGerberToPngStream(writable, layers, frameOptions, exportOptions, rendererOptions)`：一次调用即可批量渲染，把 PNG 数据块写入 Node 可写流。
- `fileLayer(path, options)`：创建基于路径的 Node 图层配置。`options` 接受 `name`、`color`、`alpha`、`offsetX`、`offsetY`。
- `packageRoot()`：返回已安装包的目录路径。
- `renderer.loadLayer(layer, layerOptions)`：解析一个 Node 图层，并返回可跨帧复用的预加载图层。
- `renderer.loadLayers(layers, options)`：解析多个图层，并返回 `{ layers, loadedCount, failures }`。失败的图层默认会被跳过。
- `renderer.withFrame(frameOptions, callback)`：开始无界面渲染帧，并在回调函数结束后保存渲染出的像素数据。
- `renderer.renderLayer(layer, layerOptions)`：向当前帧添加一个图层，并返回数值型图层 ID。必须在 `withFrame()` 内调用；这是严格接口，失败时会以该错误 reject。
- `renderer.renderLayers(layers, options)`：添加多个图层，并返回 `{ renderedCount, failures }`。失败的图层默认会被跳过；需要严格行为时使用 `layerErrorMode: "throw"`。
- `renderer.exportPng(exportOptions)`：把最后一个 Node 帧导出为内存中的 PNG 字节数据。
- `renderer.exportPngStream(writable, exportOptions)`：把最后一个 Node 帧导出到可写流。
- `renderer.exportPngFile(outputPath, exportOptions)`：把最后一个 Node 帧导出到临时文件，成功后替换 `outputPath`。
- `renderer.dispose()`：释放 GLES 上下文。

如果同一批 Gerber 输入需要渲染多次，请使用预加载图层。

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

预加载图层的几何数据会使用加载时的 `offsetX`、`offsetY`、`preserveArcRegions` 和 `arcTessellationQuality` 值进行解析。要修改这些选项，需要重新加载图层。每一帧的颜色和透明度（alpha）可以在 `renderLayer(preparedLayer, layerOptions)` 中覆盖。

批量 API（`renderGerberToCanvas`、`renderGerberToPng`、`renderGerberToPngStream`、`renderGerberToPngBuffer`、`renderGerberToPngFile` 和 `renderLayers`）会渲染所有可加载的有效图层。如果所有图层都失败，操作会以第一个图层错误 reject。

## API 选项

`frameOptions` 控制输出帧和渲染器行为：

- `width`：输出宽度，单位为像素。默认使用浏览器 canvas 的 width，Node 中默认 `1200`。
- `height`：输出高度，单位为像素。默认使用浏览器 canvas 的 height，Node 中默认 `800`。
- `clear`：渲染前清空帧。默认 `true`；Node 总是渲染到新的缓冲区。
- `background`：输出背景。默认 `null`，表示透明输出。接受 CSS 颜色字符串或 `[r, g, b, a]`。
- `fit`：把所有已加载图层的边界适配到输出帧。默认 `true`。
- `padding`：启用 `fit` 时应用的像素内边距。默认 `0`。
- `flipX`：围绕帧中心水平镜像输出。默认 `false`。
- `flipY`：围绕帧中心垂直镜像输出。默认 `false`。
- `view`：手动视图参数 `{ zoomX, zoomY, offsetX, offsetY }`；优先级高于 `fit`。
- `preserveArcRegions`：保留精确的 region 圆弧。默认 `true`；设为 `false` 时会把 region 圆弧近似为线段。
- `arcTessellationQuality`：圆弧近似质量，`0` 为低、`1` 为标准、`2` 为高。默认 `1`。
- `minimumFeaturePixels`：线段/圆弧的最小渲染宽度，单位为屏幕像素。默认 `1`。
- `renderDrills`：把 NC drill 文件（`.drl`、`.nc`、`.xnc`、`.xln`）渲染为钻孔叠加层。默认 `true`。
- `globalAlpha`：`blend` 模式下没有显式图层 `alpha` 的 Gerber 图层透明度。默认 `0.7`。
- `compositeMode`：图层合成模式，取 `"blend"` 或 `"stack"`。默认 `"blend"`。`blend` 使用 alpha additive blending；`stack` 对 Gerber 图层按输入顺序使用 source-over 合成，因此后面的 Gerber 图层覆盖前面的 Gerber 图层，默认透明度为 `1`。钻孔叠加层会在 Gerber 图层之后渲染。
- `invertedOutline`：仅 Node 使用的反相图层外框来源。`"auto"` 会自动检测 board outline 图层，`"bounds"` 会填充当前 Gerber bounds，也可以使用图层序号或名称 selector。默认 `"auto"`。
- `layerErrorMode`：`"skip"` 会继续渲染剩余有效图层；`"throw"` 会在第一次失败时中断。默认 `"skip"`。
- `onLayerError`：`"skip"` 模式下接收被跳过图层的回调函数，参数为 `{ layer, name, error }`。
- `rendererOptions`：仅用于浏览器一次性辅助函数；创建渲染器时会原样传入。

`layerOptions` 控制单个图层：

- `color`：图层颜色。浏览器接受 `[r, g, b]`；Node 也接受 hex 和 `rgb()`/`rgba()` 字符串。默认使用自动颜色循环。
- `alpha`：每层透明度。设置后会覆盖该图层的帧默认值；在 `stack` 模式下，显式 Gerber `alpha` 会覆盖不透明的默认值。钻孔图层默认不透明。
- `offsetX`：加载几何数据时应用的 X 方向偏移。默认 `0`。
- `offsetY`：加载几何数据时应用的 Y 方向偏移。默认 `0`。
- `inverted`：仅 Node 使用。把此 Gerber 图层按 `frameOptions.invertedOutline` 渲染为反相/negative 图层。默认 `false`。
- `kind`：当输入源文件名不存在或含义不明确时，强制指定 `"gerber"` 或 `"drill"`。
- `name`：用于 `{ source, name }` 或 `{ path, name }` 等配置对象的图层显示名称。

`exportOptions` 控制 PNG 导出：

- `type`：仅浏览器使用的导出 MIME 类型。默认 `image/png`；Node 始终写 PNG。
- `quality`：仅浏览器使用的编码质量，会传给 `canvas.toBlob`。
- `background`：导出时使用的背景，可覆盖最后一帧的背景。使用 `null` 保持透明。
- `maxBandBytes`：流式 PNG 导出的近似行缓冲预算。Node 也会在高分辨率分块渲染中使用它。

`rendererOptions` 控制渲染器创建：

- `wasmModule`：预加载的 WASM JS 模块。大多数用户不需要。
- `wasmModuleUrl`：用于 import WASM JS 模块的 URL。
- `wasmBinaryUrl`：仅 Node.js 使用的 `.wasm` 二进制文件 URL。
- `wasmInitInput`：传给 WASM 模块初始化函数的自定义值。
- `contextAttributes`：WebGL 上下文属性。
- `releaseContext`：在 `dispose()` 时释放 WebGL/GLES 上下文。默认 `true`。
- `glesModule`：仅 Node.js 使用的自定义 GLES 模块对象。常规 CLI 用法使用 `node-gles-webgl2`。
- `glesModuleName`：仅 Node.js 使用，用于加载 GLES 运行时的模块名。
- `gl`：仅 Node.js 使用的预创建 WebGL2 兼容上下文。

## CLI

全局安装后可以直接运行 CLI。

```bash
gerber-renderer board.gbr --width 1200 --height 800 --background '#05070c'
```

更完整的示例：

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

压缩包示例：

```bash
gerber-renderer board-gerbers.tar.gz \
  --width 1600 \
  --height 1000 \
  --background '#05070c'
```

CLI 选项：

- `<input...>`：一个或多个 Gerber/drill 文件，或 `.tar.gz`/`.tgz` 压缩包。Gerber 输入会按参数顺序渲染；drill 输入会作为覆盖在 Gerber 图层之上的叠加层渲染。
- `-o, --output <path>`：PNG 输出路径。多个输入时必填。父目录必须已存在。
- `--width <px>`：输出宽度。默认 `1200`。
- `--height <px>`：输出高度。默认 `800`。
- `--padding <px>`：自适应视图时使用的像素内边距。默认 `0`。
- `--background <color>`：hex 或 `rgb()`/`rgba()` 背景。不指定则为透明输出。
- `--alpha <0-1>`：`blend` 模式下的 Gerber 图层透明度。默认 `0.7`；`stack` 模式下 Gerber 图层和钻孔叠加层都会以不透明方式渲染。
- `--composite-mode <blend|stack>`：图层合成模式。默认 `blend`。
- `--minimum-feature-pixels <px>`：线段/圆弧的最小渲染宽度。默认 `1`。
- `--max-render-target-bytes <size>`：每个渲染目标的内存上限。接受字节数或 `512m`、`2g` 这样的后缀。
- `--approx-region-arcs`：渲染前把 region 圆弧转换为线段。
- `--arc-quality <0|1|2>`：圆弧近似质量。默认 `1`。
- `--invert-layer <selector>`：把 Gerber 图层渲染为反相/negative 图层。需要反相多个图层时可重复指定。Selector 支持 1-based 图层序号、完整图层名和 basename。
- `--outline-layer <selector>`：反相图层使用的 board outline。可使用 `auto`、`bounds`、1-based 图层序号、完整图层名或 basename。默认 `auto`。
- `--flip-x`：水平镜像输出。
- `--flip-y`：垂直镜像输出。
- `--no-drill`：跳过 NC drill 图层。
- `--no-fit`：禁用自适应视图。
- `--skill`：打印面向 AI agent 的[包使用说明](SKILL.md)。
- `-h, --help`：打印 CLI 用法并退出。

`--arc-quality` 主要在与 `--approx-region-arcs` 一起使用时有意义。取值 `0`、`1`、`2` 分别对应 low、normal、high。

提供多个输入文件时，CLI 会为每个失败的图层打印警告，并继续渲染其余图层。如果所有输入都失败，命令会以错误退出。

当只提供一个输入且省略 `--output` 时，CLI 会在输入文件旁边写出输出文件。`.gbr`、`.ger`、`.art`、`.gdo`、`.pho` 这类通用 Gerber 扩展名会被替换为 `.png`；图层专用或未知扩展名会保留完整文件名并追加 `.png`。

## 开源协议

[MIT License](LICENSE)
