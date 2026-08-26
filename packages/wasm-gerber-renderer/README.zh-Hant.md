<div align="center">

# wasm-gerber-renderer

[**`English`**](README.md) · [**`简体中文`**](README.zh-Hans.md) · **`繁體中文`** · [**`한국어`**](README.kr.md)

</div>

---

本套件是一個基於 `wasm-gerber-viewer` Rust/WASM 解析器與渲染器的 WebGL2 Gerber 渲染工具。

本套件提供：

- 在瀏覽器 canvas 中渲染 Gerber 內容字串、`File`、`Blob`、`ArrayBuffer` 或 `Uint8Array`
- 透過無介面的 WebGL2 上下文在 Node.js 中渲染 PNG，並支援直接輸出到檔案或串流
- 將 Gerber 檔案或 `.tar.gz`/`.tgz` 壓縮檔渲染為 PNG 的 `gerber-renderer` CLI
- 打包時產生並內建的 `wasm-bindgen` 輸出

瀏覽器進入點使用呼叫方提供的 WebGL2 canvas。Node.js 進入點使用同一個 WASM/WebGL 渲染器，並預設透過 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 建立原生 WebGL2 上下文。

## 目錄

- [安裝](#安裝)
- [平台支援](#平台支援)
- [瀏覽器用法](#瀏覽器用法)
- [型別參考](#型別參考)
- [瀏覽器 API](#瀏覽器-api)
- [Node.js 用法](#nodejs-用法)
- [Node.js API](#nodejs-api)
- [複合圖層](#複合圖層)
- [API 選項](#api-選項)
- [CLI](#cli)
- [授權](#授權)

## 安裝

瀏覽器使用者：

```bash
npm install wasm-gerber-renderer
```

CLI 使用者需要渲染器套件與 [`node-gles-webgl2`](https://www.npmjs.com/package/node-gles-webgl2)。

```bash
npm install -g wasm-gerber-renderer node-gles-webgl2
```

同一個套件也以 `@dsafdsaf132/wasm-gerber-renderer` 名稱發布到 GitHub Packages。

```bash
npm config set @dsafdsaf132:registry https://npm.pkg.github.com
npm install @dsafdsaf132/wasm-gerber-renderer
```

從 GitHub Packages 安裝時，需要把 import 路徑中的 `wasm-gerber-renderer` 改為 `@dsafdsaf132/wasm-gerber-renderer`。

瀏覽器用法不需要 `node-gles-webgl2`。

## 平台支援

瀏覽器渲染與平台無關，使用呼叫方提供的 WebGL2 canvas。

Node.js 與 CLI 渲染透過 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 支援以下平台：

| Platform      | CI                                                                 |
| ------------- | ------------------------------------------------------------------ |
| Linux x64     | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| Linux arm64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| macOS arm64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| macOS x64     | ![build only](https://img.shields.io/badge/CI-build%20only-yellow) |
| Windows x64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| Windows arm64 | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |

macOS x64 僅驗證安裝與原生模組載入，因為 GitHub 託管的 Intel runner 無法建立
runtime 渲染所需的 ANGLE EGL display。

## 瀏覽器用法

```js
import { renderGerberToCanvas } from "wasm-gerber-renderer";

const canvas = document.querySelector("canvas");
const gerber = await file.text();

await renderGerberToCanvas(canvas, gerber, {
  background: "#05070c",
  padding: 24,
});
```

如果需要重複渲染，請重複使用渲染器實例。

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

批次渲染輔助函式預設會盡可能渲染所有有效圖層。如果某個圖層解析失敗，其餘圖層仍會繼續渲染。可以透過 `onLayerError` 查看被跳過的圖層，或設定 `layerErrorMode: "throw"` 在首次失敗時中斷。

## 型別參考

顏色陣列使用 `0` 到 `1` 範圍內的正規化通道值。

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
      visible?: boolean;
      offsetX?: number;
      offsetY?: number;
      kind?: LayerKind;
    };
```

在瀏覽器 API 中，`string` 輸入來源表示 Gerber 檔案內容。`File`、`Blob`、`ArrayBuffer` 與 `Uint8Array` 輸入來源會被解碼為文字。圖層設定物件可以把每層選項直接附加到輸入來源上。

Node.js 接受相同的內容輸入來源，並額外支援透過 `URL`、`{ path }` 或 `{ path, ...options }` 圖層物件指定檔案路徑。

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
      visible?: boolean;
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
      visible?: boolean;
      offsetX?: number;
      offsetY?: number;
      inverted?: boolean;
      kind?: LayerKind;
    };
```

在 Node.js API 中，普通 `string` 仍然表示 Gerber 內容。從檔案系統讀取並渲染時，請使用 `{ path: "board.gbr" }`、`fileLayer("board.gbr")` 或 `file:` URL。

```ts
type CompositePreset = "union" | "intersection" | "difference";
type CompositeLayerOptions = {
  name?: string;
  color?: RGBColor | string;
  alpha?: number;
  visible?: boolean;
  inverted?: boolean;
  outlineLayerId?: number;
  preset?: CompositePreset;
  visibleAreas?: string[];
};
```

## 瀏覽器 API

- `renderGerberToCanvas(canvas, layers, frameOptions)`：一次呼叫即可將圖層批次渲染到既有的 WebGL2 canvas。`layers` 可以是單個 `GerberLayer`、陣列或 `FileList`。失敗的圖層預設會被跳過。
- `renderGerberToPng(canvas, layers, frameOptions, exportOptions)`：在瀏覽器中完成一次性渲染，並回傳 PNG `Blob`。
- `renderGerberToPngStream(canvas, writable, layers, frameOptions, exportOptions)`：把 PNG 資料區塊寫入 `WritableStream`，成功時關閉，失敗時中止。需要瀏覽器支援 `CompressionStream`。
- `createGerberRenderer(canvas, rendererOptions)`：建立可重複使用的渲染器，用於渲染多個渲染幀或多個圖層。
- `renderer.withFrame(frameOptions, callback)`：開始一個渲染幀，套用 canvas 與視圖選項，並在回呼函式結束後顯示渲染後的圖層。
- `renderer.renderLayer(layer, layerOptions)`：向目前渲染幀加入一個圖層，並回傳數值型圖層 ID；使用 `renderDrills: false` 主動略過鑽孔時回傳 `null`。必須在 `withFrame()` 內呼叫；這是嚴格介面，失敗時會以該錯誤 reject。
- `renderer.renderCompositeLayer(sourceLayerIds, options)`：組合目前幀中的 2–24 個 Gerber ID。必須先加入來源圖層，並在 `withFrame()` 內呼叫。
- `renderer.renderLayers(layers, options)`：加入多個圖層，並回傳 `{ renderedCount, failures }`。失敗的圖層預設會被跳過；需要嚴格行為時使用 `layerErrorMode: "throw"`。
- `renderer.exportPng(exportOptions)`：把最後一個瀏覽器渲染幀匯出為 PNG `Blob`。
- `renderer.exportPngStream(writable, exportOptions)`：把最後一個瀏覽器渲染幀匯出到 `WritableStream`，成功時關閉，失敗時中止，不需要先組裝成 `Blob`。
- `renderer.dispose()`：釋放 WebGL 上下文。

瀏覽器匯出只能在 `withFrame()` 成功完成後使用；在畫面開始前、執行期間或失敗後都會被拒絕。`withFrame()` 回呼執行期間會拒絕 `dispose()`。匯出進行期間也會拒絕新的渲染幀、其他匯出與 `dispose()`，避免 canvas 在匯出途中變更。

## Node.js 用法

使用 Node.js 進入點前請安裝 `node-gles-webgl2`。Node.js 與 CLI 渲染透過 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 支援 Linux x64/arm64、macOS arm64/x64 與 Windows x64/arm64。
透過 `fileLayer()`、`{ path }` 或 `file:` URL 傳入的檔案系統來源必須是
不超過 300 MiB 的一般檔案。

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

- `createNodeGerberRenderer(rendererOptions)`：建立由原生 WebGL2/GLES 上下文支撐、可重複使用的無介面渲染器。
- `renderGerberToPngBuffer(layers, frameOptions, exportOptions, rendererOptions)`：一次呼叫即可批次渲染，並以 `Uint8Array` 回傳 PNG 位元組資料。
- `renderGerberToPngFile(outputPath, layers, frameOptions, exportOptions, rendererOptions)`：一次呼叫即可批次渲染，把 PNG 位元組資料寫入暫存檔，成功後替換 `outputPath`。父目錄必須已存在。
- `renderGerberToPngStream(writable, layers, frameOptions, exportOptions, rendererOptions)`：一次呼叫即可批次渲染，把 PNG 資料區塊寫入 Node 可寫串流。
- `fileLayer(path, options)`：建立基於路徑的 Node 圖層設定。`options` 接受 `name`、`color`、`alpha`、`visible`、`offsetX`、`offsetY`、`inverted`、`kind`。
- `packageRoot()`：回傳已安裝套件的目錄路徑。
- `renderer.loadLayer(layer, layerOptions)`：解析一個 Node 圖層，並回傳可跨渲染幀重複使用的預載圖層。僅在使用 `renderDrills: false` 主動略過鑽孔輸入時回傳 `null`。
- `renderer.loadLayers(layers, options)`：解析多個圖層，並回傳 `{ layers, loadedCount, failures }`。失敗的圖層預設會被跳過。
- `renderer.withFrame(frameOptions, callback)`：開始無介面渲染幀，並在回呼函式結束後儲存渲染出的像素資料。
- `renderer.renderLayer(layer, layerOptions)`：向目前渲染幀加入一個圖層，並回傳數值型圖層 ID；使用 `renderDrills: false` 主動略過鑽孔時回傳 `null`。必須在 `withFrame()` 內呼叫；這是嚴格介面，失敗時會以該錯誤 reject。
- `renderer.renderCompositeLayer(sourceLayerIds, options)`：組合目前幀中的 2–24 個 Gerber ID。必須先加入來源圖層，並在 `withFrame()` 內呼叫。
- `renderer.renderLayers(layers, options)`：加入多個圖層，並回傳 `{ renderedCount, failures }`。失敗的圖層預設會被跳過；需要嚴格行為時使用 `layerErrorMode: "throw"`。
- `renderer.exportPng(exportOptions)`：把最後一個 Node 渲染幀匯出為記憶體中的 PNG 位元組資料。
- `renderer.exportPngStream(writable, exportOptions)`：把最後一個 Node 渲染幀匯出到可寫串流。
- `renderer.exportPngFile(outputPath, exportOptions)`：把最後一個 Node 渲染幀匯出到暫存檔，成功後替換 `outputPath`。
- `renderer.dispose()`：釋放 GLES 上下文。

`withFrame()` 回呼執行期間會拒絕 `dispose()`。可重複使用的 Node 匯出進行期間，會拒絕新渲染幀、其他匯出與 `dispose()`，以免其中途替換 GLES 上下文。

如果同一批 Gerber 輸入需要渲染多次，請使用預載圖層。

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

預載圖層的幾何資料會使用載入時的 `offsetX`、`offsetY`、`preserveArcRegions` 與 `arcTessellationQuality` 值進行解析。要修改這些選項，需要重新載入圖層。每個渲染幀的顏色與透明度（alpha）可以在 `renderLayer(preparedLayer, layerOptions)` 中覆寫。
如果把 prepared 物件連同衝突的 parse option 再次傳給 `loadLayer()` 或 `loadLayers()`，呼叫會被拒絕。解析完成後也不能再補加 source content retention；請使用 `retainSourceContentForInversion: true` 重新載入原始 source。

批次 API（`renderGerberToCanvas`、`renderGerberToPng`、`renderGerberToPngStream`、`renderGerberToPngBuffer`、`renderGerberToPngFile` 與 `renderLayers`）會渲染所有可載入的有效圖層。如果所有圖層都失敗，操作會以第一個圖層錯誤 reject。

## 複合圖層

在 `withFrame()` 中先加入普通 Gerber 來源，再建立複合圖層。複合圖層接受
2–24 個互不相同的 Gerber 圖層 ID；鑽孔 ID、複合 ID、重複或失效 ID，
以及上一幀回傳的 ID 都會被拒絕。

複合錯誤採嚴格傳遞。Browser API 的驗證/建構錯誤會 reject
`renderCompositeLayer()`，GPU 配置/渲染錯誤會 reject 外層 `withFrame()`
Promise。Node API 先記錄邏輯定義，因此建構和 GPU 錯誤都會由
`exportPng()`、`exportPngStream()` 或 `exportPngFile()` reject；請捕捉匯出
Promise。

```js
await renderer.withFrame({ width: 1600, height: 1000, compositeMode: "stack" }, async () => {
  const paste = await renderer.renderLayer(
    { source: pasteGerber, name: "top.gtp" },
    { visible: false },
  );
  const notes = await renderer.renderLayer(
    { source: fabGerber, name: "fab.gbr" },
    { visible: false },
  );
  await renderer.renderCompositeLayer([paste, notes], {
    name: "Paste without notes",
    preset: "difference",
    color: "#00a81c",
    alpha: 0.7,
  });
});
```

`visible: false` 只會從最終輸出隱藏來源圖層，其最終 Gerber mask 仍作為
複合依賴渲染。Polarity、aperture block、step-and-repeat、變換、精確
region、反相與最小線寬都會影響 coverage；來源顏色和 alpha 不影響。
`CompositeLayerOptions.visible: false` 則保留目前幀中的複合定義，但從最終
輸出排除該複合。

`preset` 可為 `"union"`、`"intersection"` 或 `"difference"`。Difference
表示第一個來源減去其餘來源的 union。要精確選擇 coverage 組合，請使用
`visibleAreas` 取代 `preset`：

```js
await renderer.renderCompositeLayer([top, mask, notes], {
  visibleAreas: ["110", "101", "000"],
  outlineLayerId: outline,
});
```

最左側 bit 對應第一個來源 ID。重複 pattern 會去重，空陣列會報錯。
`"000"` 僅在 resolved outline 內選擇未被任何來源覆蓋的像素。
`outlineLayerId` 必須是目前幀的普通 Gerber；省略時使用有限的 frame
bounds。複合反相也裁切到該區域。`blend` 使用 additive，`stack` 依呼叫
順序 source-over。一次性的 `renderLayers()` 陣列不支援複合宣告。

CLI 透過 `--composite-config <path>` 讀取 JSON：

```json
{
  "hiddenSources": ["top.gtp", "fab.gbr"],
  "composites": [{
    "name": "Paste without notes",
    "sources": ["top.gtp", "fab.gbr"],
    "preset": "difference",
    "color": "#00a81c",
    "alpha": 0.7,
    "outline": "auto"
  }]
}
```

Selector 可以是 1-based 輸入序號、完整名稱或 basename。JSON number 一律
表示序號；string 比對有歧義時會報錯，不會猜測。`hiddenSources` 會從最終
輸出隱藏符合的輸入；隱藏的 Gerber 仍保留為複合依賴。Outline 優先順序為複合 JSON
`outline`、CLI `--outline-layer`、自動偵測、bounds fallback。某個來源解析
失敗時只跳過依賴它的複合，其他有效圖層和複合繼續渲染。明確使用
`"bounds"` 會跳過自動偵測。

## API 選項

`frameOptions` 控制輸出幀與渲染器行為：

- `width`：輸出寬度，單位為像素。預設使用瀏覽器 canvas 的 width，Node 中預設 `1200`。
- `height`：輸出高度，單位為像素。預設使用瀏覽器 canvas 的 height，Node 中預設 `800`。
- `clear`：渲染前清空幀。預設 `true`；Node 總是渲染到新的緩衝區。
- `background`：輸出背景。預設 `null`，表示透明輸出。Browser export 接受 canvas 支援的所有 CSS 顏色；Node 接受命名 CSS 顏色、hex，以及逗號形式的 `rgb()`/`rgba()`。兩者都接受 `[r, g, b, a]`。
- `fit`：把所有已載入圖層的邊界適配到輸出幀。預設 `true`。
- `padding`：啟用 `fit` 時套用的像素內邊距。預設 `0`。
- `flipX`：圍繞輸出幀中心水平鏡像輸出。預設 `false`。
- `flipY`：圍繞輸出幀中心垂直鏡像輸出。預設 `false`。
- `view`：手動視圖參數 `{ zoomX, zoomY, offsetX, offsetY }`；優先於 `fit`。
- `preserveArcRegions`：保留精確的 region 圓弧。預設 `true`；設為 `false` 時會把 region 圓弧近似為線段。
- `arcTessellationQuality`：圓弧近似品質，`0` 為低、`1` 為標準、`2` 為高。預設 `1`。
- `minimumFeaturePixels`：線段/圓弧的最小渲染寬度，單位為螢幕像素。預設 `1`。
- `renderDrills`：把 NC drill 檔案（`.drl`、`.nc`、`.xnc`、`.xln`）渲染為鑽孔疊加層。預設 `true`。
- `globalAlpha`：`blend` 模式下沒有明確圖層 `alpha` 的 Gerber 圖層透明度。預設 `0.7`。
- `compositeMode`：圖層合成模式，取 `"blend"` 或 `"stack"`。預設 `"blend"`。`blend` 使用 alpha additive blending；`stack` 對 Gerber 圖層按輸入順序使用 source-over 合成，因此後面的 Gerber 圖層覆蓋前面的 Gerber 圖層，預設透明度為 `1`。鑽孔疊加層會在 Gerber 圖層之後渲染。
- `invertedOutline`：僅 Node 使用的反相圖層外框來源。`"auto"` 會自動偵測 board outline 圖層，`"bounds"` 會填充目前 Gerber bounds，也可以使用圖層序號或名稱 selector。預設 `"auto"`。
- `maxBandBytes`：僅 Node 使用的 streamed PNG row-buffer budget。預設 `512 MiB`。
- `maxFullFrameBytes`：僅 Node 使用的 full-frame PNG export 選擇用 memory budget。預設 `512 MiB`。
- `maxRenderTargetBytes`：僅 Node 使用的 per-render-target memory cap。預設會探測可用 GPU/driver budget，失敗時回退到 `2 GiB`。
- `framebufferMemorySafetyFactor`：僅 Node 使用的 full-frame framebuffer memory estimate multiplier。預設 `2`。
- `strategy`：僅 Node 使用的 PNG export strategy，可為 `"auto"`、`"full-frame"` 或 `"stream"`。預設 `"auto"`。
- `layerErrorMode`：`"skip"` 會繼續渲染剩餘有效圖層；`"throw"` 會在第一次失敗時中斷。預設 `"skip"`。
- `onLayerError`：`"skip"` 模式下接收被跳過圖層的同步或非同步回呼，參數為 `{ layer, name, error }`。渲染器會等待該回呼；回呼 reject 會使批次操作 reject。
- `rendererOptions`：僅用於瀏覽器一次性輔助函式；建立渲染器時會原樣傳入。

`layerOptions` 控制單個圖層：

- `color`：圖層顏色。瀏覽器的一般圖層選項接受 `[r, g, b]`；瀏覽器 `CompositeLayerOptions.color` 接受 canvas 支援的所有 CSS 顏色，包括現代 `hsl()` 與空格分隔的 `rgb()`。Node 接受陣列、命名 CSS 顏色、hex，以及逗號形式的 `rgb()`/`rgba()`。圖層或複合顏色字串中的 alpha 分量會被忽略；請使用獨立的 `alpha` 選項。預設使用自動顏色循環。
- `alpha`：每層透明度。設定後會覆蓋該圖層的幀預設值；在 `stack` 模式下，明確 Gerber `alpha` 會覆蓋不透明的預設值。鑽孔圖層預設不透明。
- `visible`：是否包含於最終輸出，預設 `true`。隱藏的普通 Gerber 圖層
  仍可作為複合依賴。
- `offsetX`：載入幾何資料時套用的 X 方向偏移。預設 `0`。
- `offsetY`：載入幾何資料時套用的 Y 方向偏移。預設 `0`。
- `inverted`：僅 Node 使用。把此 Gerber 圖層按 `frameOptions.invertedOutline` 渲染為反相/negative 圖層。預設 `false`。
- `kind`：當輸入來源檔名不存在或含義不明確時，強制指定 `"gerber"` 或 `"drill"`。
- `name`：用於 `{ source, name }` 或 `{ path, name }` 等設定物件的圖層顯示名稱。

`loadLayer()` 與 `loadLayers()` 也接受 parse/load 選項：

- `preserveArcRegions`：為 prepared layer 保留 exact region arc。預設 `true`。
- `arcTessellationQuality`：當 region arc 需要 approximate 時，指定 prepared layer 的 arc quality。
- `retainSourceContentForInversion`：僅 Node 使用；保留原始 Gerber text，使 prepared layer 之後可作為 inverted layer 或 explicit outline source 使用。
- `renderDrills`：僅供 Node 載入使用。設為 `false` 時略過鑽孔輸入；`loadLayer()` 回傳 `null`，`loadLayers()` 則從回傳的 `layers` 中省略該輸入。

`exportOptions` 控制 PNG 匯出：

- `type`：僅瀏覽器使用的匯出 MIME 類型。預設 `image/png`；Node 始終寫 PNG。
- `quality`：僅瀏覽器使用的編碼品質，會傳給 `canvas.toBlob`。
- `background`：匯出時使用的背景，可覆蓋最後一個渲染幀的背景。使用 `null` 保持透明。
- `maxBandBytes`：串流 PNG 匯出的近似列緩衝預算。Node 也會在高解析度分塊渲染中使用它。
- `maxFullFrameBytes`：僅 Node 使用的 full-frame PNG export memory budget。
- `maxRenderTargetBytes`：僅 Node 使用的 per-render-target memory cap。
- `framebufferMemorySafetyFactor`：僅 Node 使用的 framebuffer memory estimate multiplier。
- `strategy`：僅 Node 使用的 PNG export strategy，可為 `"auto"`、`"full-frame"` 或 `"stream"`。

`rendererOptions` 控制渲染器建立：

- `wasmModule`：預先載入的 WASM JS 模組。大多數使用者不需要。
- `wasmModuleUrl`：用於 import WASM JS 模組的 URL。
- `wasmBinaryUrl`：僅 Node.js 使用的 `.wasm` 二進位檔 URL。
- `wasmInitInput`：傳給 WASM 模組初始化函式的自訂值。
- `contextAttributes`：WebGL 上下文屬性。
- `releaseContext`：在 `dispose()` 時釋放 WebGL/GLES 上下文。預設 `true`。
- `glesModule`：僅 Node.js 使用的自訂 GLES 模組物件。常規 CLI 用法使用 `node-gles-webgl2`。
- `glesModuleName`：僅 Node.js 使用，用於載入 GLES 執行階段的模組名稱。
- `gl`：僅 Node.js 使用的預先建立 WebGL2 相容上下文。

## CLI

全域安裝後可以直接執行 CLI。

```bash
gerber-renderer board.gbr --width 1200 --height 800 --background '#05070c'
```

更完整的範例：

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
  --composite-config composites.json \
  --invert-layer mask.gbr \
  --outline-layer board.gko
```

壓縮檔範例：

```bash
gerber-renderer board-gerbers.tar.gz \
  --width 1600 \
  --height 1000 \
  --background '#05070c'
```

CLI 選項：

- `<input...>`：一個或多個 Gerber/drill 檔案，或 `.tar.gz`/`.tgz` 壓縮檔。Gerber 輸入會按參數順序渲染；drill 輸入會作為覆蓋在 Gerber 圖層之上的疊加層渲染。
- `-o, --output <path>`：PNG 輸出路徑。多個輸入時必填。父目錄必須已存在。
- `--width <px>`：輸出寬度。預設 `1200`。
- `--height <px>`：輸出高度。預設 `800`。
- `--padding <px>`：自動適配視圖時使用的像素內邊距。預設 `0`。
- `--background <color>`：hex 或 `rgb()`/`rgba()` 背景。不指定則為透明輸出。
- `--alpha <0-1>`：`blend` 模式下的 Gerber 圖層透明度。預設 `0.7`；`stack` 模式下 Gerber 圖層和鑽孔疊加層都會以不透明方式渲染。
- `--composite-mode <blend|stack>`：圖層合成模式。預設 `blend`。
- `--minimum-feature-pixels <px>`：線段/圓弧的最小渲染寬度。預設 `1`。
- `--max-render-target-bytes <size>`：每個渲染目標的記憶體上限。接受位元組數或 `512m`、`2g` 這類後綴。
- `--max-band-bytes <size>`：streamed PNG row-buffer cap。接受位元組數或 `512m`、`2g` 這類後綴。
- `--max-full-frame-bytes <size>`：full-frame PNG memory cap。接受位元組數或 `512m`、`2g` 這類後綴。
- `--framebuffer-memory-safety-factor <n>`：full-frame framebuffer memory estimate multiplier。預設 `2`。
- `--render-strategy <auto|full-frame|stream>`：PNG export strategy。預設 `auto`。
- `--approx-region-arcs`：渲染前把 region 圓弧轉換為線段。
- `--arc-quality <0|1|2>`：圓弧近似品質。預設 `1`。
- `--invert-layer <selector>`：把 Gerber 圖層渲染為反相/negative 圖層。需要反相多個圖層時可重複指定。Selector 支援 1-based 圖層序號、完整圖層名和 basename。
- `--outline-layer <selector>`：反相圖層使用的 board outline。可使用 `auto`、`bounds`、1-based 圖層序號、完整圖層名或 basename。預設 `auto`。
- `--composite-config <path>`：包含複合定義與隱藏來源 selector 的 JSON 檔案。
- `--flip-x`：水平鏡像輸出。
- `--flip-y`：垂直鏡像輸出。
- `--no-drill`：跳過 NC drill 圖層。
- `--no-fit`：停用自動適配視圖。
- `--skill`：列印面向 AI agent 的[套件使用說明](SKILL.md)。
- `-h, --help`：列印 CLI 用法並結束。

CLI Gerber/drill 輸入與壓縮檔各自限制為 300 MiB，複合 JSON 限制為
16 MiB。一個 TAR 壓縮檔最多可包含 1,000 個標頭與總計 300 MiB 的一般
檔案資料；單一項目上限為 300 MiB，整體解壓縮比例上限為 1,000:1。
每個 TAR metadata 標頭限制為 1 MiB，壓縮檔路徑限制為 4 KiB；格式錯誤
或遭截斷的壓縮檔會在渲染前失敗。

`--arc-quality` 主要在與 `--approx-region-arcs` 一起使用時有意義。取值 `0`、`1`、`2` 分別對應 low、normal、high。

提供多個輸入檔案時，CLI 會為每個失敗的圖層列印警告，並繼續渲染其餘圖層。如果所有輸入都失敗，命令會以錯誤結束。

當只提供一個輸入且省略 `--output` 時，CLI 會在輸入檔案旁邊寫出輸出檔案。`.gbr`、`.ger`、`.art`、`.gdo`、`.pho` 這類通用 Gerber 副檔名會被替換為 `.png`；圖層專用或未知副檔名會保留完整檔名並追加 `.png`。

## 授權

[MIT License](LICENSE)
