<div align="center">

# wasm-gerber-renderer

[**`English`**](README.md) · [**`简体中文`**](README.zh-Hans.md) · [**`繁體中文`**](README.zh-Hant.md) · **`한국어`**

</div>

---

`wasm-gerber-viewer`의 Rust/WASM 파서와 렌더러를 사용하는 WebGL2 Gerber 렌더러입니다.

이 패키지는 다음 기능을 제공합니다.

- Gerber 소스 문자열, `File`, `Blob`, `ArrayBuffer`, `Uint8Array` 입력을 브라우저 canvas에 렌더링
- headless WebGL2 context를 통한 Node.js PNG 렌더링과 파일/스트림 직접 출력
- Gerber 파일 또는 `.tar.gz`/`.tgz` 압축 파일을 PNG로 렌더링하는 `gerber-renderer` CLI
- 패키징 과정에서 생성되어 함께 포함되는 `wasm-bindgen` 출력물

브라우저 진입점은 호출자가 제공한 WebGL2 canvas를 사용합니다. Node.js 진입점은 같은 WASM/WebGL 렌더러를 사용하며, 기본 네이티브 WebGL2 context 제공자로 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2)를 사용합니다.

## 목차

- [설치](#설치)
- [플랫폼 지원](#플랫폼-지원)
- [브라우저 사용](#브라우저-사용)
- [타입 참고](#타입-참고)
- [브라우저 API](#브라우저-api)
- [Node.js 사용](#nodejs-사용)
- [Node.js API](#nodejs-api)
- [API 옵션](#api-옵션)
- [CLI](#cli)
- [라이선스](#라이선스)

## 설치

브라우저 사용자:

```bash
npm install wasm-gerber-renderer
```

CLI 사용자는 렌더러 패키지와 [`node-gles-webgl2`](https://www.npmjs.com/package/node-gles-webgl2)가 필요합니다.

```bash
npm install -g wasm-gerber-renderer node-gles-webgl2
```

같은 패키지는 GitHub Packages에도 `@dsafdsaf132/wasm-gerber-renderer` 이름으로 배포됩니다.

```bash
npm config set @dsafdsaf132:registry https://npm.pkg.github.com
npm install @dsafdsaf132/wasm-gerber-renderer
```

GitHub Packages에서 설치할 때는 import 경로의 `wasm-gerber-renderer`를 `@dsafdsaf132/wasm-gerber-renderer`로 바꾸세요.

브라우저 사용에는 `node-gles-webgl2`가 필요하지 않습니다.

## 플랫폼 지원

브라우저 렌더링은 플랫폼에 독립적이며 호출자가 제공한 WebGL2 canvas를 사용합니다.

Node.js와 CLI 렌더링은 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2)를 통해 다음 플랫폼에서 지원됩니다.

| Platform      | CI                                                                 |
| ------------- | ------------------------------------------------------------------ |
| Linux x64     | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| Linux arm64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| macOS arm64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| macOS x64     | ![build only](https://img.shields.io/badge/CI-build%20only-yellow) |
| Windows x64   | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |
| Windows arm64 | ![tested](https://img.shields.io/badge/CI-tested-brightgreen)      |

macOS x64는 GitHub 호스팅 Intel runner에서 runtime 렌더링에 필요한 ANGLE
EGL display를 생성할 수 없어 설치와 native module load만 검증합니다.

## 브라우저 사용

```js
import { renderGerberToCanvas } from "wasm-gerber-renderer";

const canvas = document.querySelector("canvas");
const gerber = await file.text();

await renderGerberToCanvas(canvas, gerber, {
  background: "#05070c",
  padding: 24,
});
```

반복 렌더링에는 렌더러 인스턴스를 재사용하세요.

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

배치 헬퍼는 기본적으로 렌더링 가능한 모든 유효한 layer를 렌더링합니다. 한 layer가 파싱에 실패해도 나머지 layer는 계속 렌더링됩니다. 건너뛴 layer는 `onLayerError`로 확인할 수 있고, `layerErrorMode: "throw"`를 설정하면 첫 실패에서 중단하는 엄격 모드를 사용할 수 있습니다.

## 타입 참고

색상 배열은 `0`부터 `1`까지의 정규화된 채널 값을 사용합니다.

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

브라우저 API에서 `string` source는 Gerber 파일 내용입니다. `File`, `Blob`, `ArrayBuffer`, `Uint8Array` source는 텍스트로 디코딩됩니다. Layer config object를 사용하면 source에 layer별 옵션을 함께 지정할 수 있습니다.

Node.js는 같은 콘텐츠 source에 더해 `URL`, `{ path }`, `{ path, ...options }` layer object를 통한 파일 경로 입력도 받습니다.

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

Node.js API에서도 일반 `string`은 Gerber 내용으로 취급됩니다. 파일 시스템에서 렌더링할 때는 `{ path: "board.gbr" }`, `fileLayer("board.gbr")`, 또는 `file:` URL을 사용하세요.

## 브라우저 API

- `renderGerberToCanvas(canvas, layers, frameOptions)`: WebGL2를 지원하는 기존 canvas에 한 번에 배치 렌더링합니다. `layers`는 단일 `GerberLayer`, 배열, 또는 `FileList`가 될 수 있습니다. 실패한 layer는 기본적으로 건너뜁니다.
- `renderGerberToPng(canvas, layers, frameOptions, exportOptions)`: 브라우저에서 한 번 렌더링한 뒤 PNG `Blob`을 반환합니다.
- `renderGerberToPngStream(canvas, writable, layers, frameOptions, exportOptions)`: PNG chunk를 `WritableStream`에 쓰고 성공 시 닫으며 실패 시 중단합니다. 브라우저의 `CompressionStream` 지원이 필요합니다.
- `createGerberRenderer(canvas, rendererOptions)`: 여러 frame이나 layer를 렌더링할 수 있는 재사용 렌더러를 만듭니다.
- `renderer.withFrame(frameOptions, callback)`: frame을 시작하고 canvas/view 옵션을 적용한 뒤 callback이 끝나면 렌더링된 layer를 표시합니다.
- `renderer.renderLayer(layer, layerOptions)`: 활성 frame에 layer 하나를 추가하고 숫자 layer ID를 반환합니다. 반드시 `withFrame()` 안에서 호출해야 하며, 이 엄격 API는 실패 시 Promise를 reject합니다.
- `renderer.renderLayers(layers, options)`: 여러 layer를 추가하고 `{ renderedCount, failures }`를 반환합니다. 실패한 layer는 기본적으로 건너뛰며, 엄격 모드가 필요하면 `layerErrorMode: "throw"`를 사용하세요.
- `renderer.exportPng(exportOptions)`: 마지막 브라우저 frame을 PNG `Blob`으로 내보냅니다.
- `renderer.exportPngStream(writable, exportOptions)`: 마지막 브라우저 frame을 `Blob`으로 조립하지 않고 `WritableStream`에 내보내며 성공 시 닫고 실패 시 중단합니다.
- `renderer.dispose()`: WebGL context를 해제합니다.

## Node.js 사용

Node.js 진입점을 사용하기 전에 `node-gles-webgl2`를 설치하세요. Node.js와 CLI 렌더링은 Linux x64/arm64, macOS arm64/x64, Windows x64/arm64에서 [`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2)를 통해 지원됩니다.

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

- `createNodeGerberRenderer(rendererOptions)`: 네이티브 WebGL2/GLES context를 사용하는 재사용 headless 렌더러를 만듭니다.
- `renderGerberToPngBuffer(layers, frameOptions, exportOptions, rendererOptions)`: 한 번에 배치 렌더링하고 PNG 바이트를 `Uint8Array`로 반환합니다.
- `renderGerberToPngFile(outputPath, layers, frameOptions, exportOptions, rendererOptions)`: 한 번에 배치 렌더링하고 PNG 바이트를 임시 파일에 스트리밍한 뒤 성공하면 `outputPath`를 교체합니다. 상위 directory는 미리 존재해야 합니다.
- `renderGerberToPngStream(writable, layers, frameOptions, exportOptions, rendererOptions)`: 한 번에 배치 렌더링하고 PNG chunk를 Node writable stream에 씁니다.
- `fileLayer(path, options)`: path 기반 Node layer config를 만듭니다. `options`는 `name`, `color`, `alpha`, `offsetX`, `offsetY`, `inverted`, `kind`를 받습니다.
- `packageRoot()`: 설치된 패키지 directory 경로를 반환합니다.
- `renderer.loadLayer(layer, layerOptions)`: Node layer 하나를 한 번 파싱하고 여러 frame에서 재사용할 수 있는 prepared layer를 반환합니다.
- `renderer.loadLayers(layers, options)`: 여러 layer를 파싱하고 `{ layers, loadedCount, failures }`를 반환합니다. 실패한 layer는 기본적으로 건너뜁니다.
- `renderer.withFrame(frameOptions, callback)`: headless render frame을 시작하고 callback이 끝난 뒤 렌더링된 pixel을 저장합니다.
- `renderer.renderLayer(layer, layerOptions)`: 활성 frame에 layer 하나를 추가하고 숫자 layer ID를 반환합니다. 반드시 `withFrame()` 안에서 호출해야 하며, 이 엄격 API는 실패 시 Promise를 reject합니다.
- `renderer.renderLayers(layers, options)`: 여러 layer를 추가하고 `{ renderedCount, failures }`를 반환합니다. 실패한 layer는 기본적으로 건너뛰며, 엄격 모드가 필요하면 `layerErrorMode: "throw"`를 사용하세요.
- `renderer.exportPng(exportOptions)`: 마지막 Node frame을 메모리상의 PNG 바이트로 내보냅니다.
- `renderer.exportPngStream(writable, exportOptions)`: 마지막 Node frame을 writable stream으로 내보냅니다.
- `renderer.exportPngFile(outputPath, exportOptions)`: 마지막 Node frame을 임시 파일로 내보낸 뒤 성공하면 `outputPath`를 교체합니다.
- `renderer.dispose()`: GLES context를 해제합니다.

같은 Gerber 입력을 여러 번 렌더링할 때는 prepared layer를 사용하세요.

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

Prepared layer geometry는 load 시점의 `offsetX`, `offsetY`, `preserveArcRegions`, `arcTessellationQuality` 값으로 파싱됩니다. 이 옵션을 바꾸려면 layer를 다시 load해야 합니다. Frame별 색상과 alpha는 `renderLayer(preparedLayer, layerOptions)`에서 재정의할 수 있습니다.

Batch API(`renderGerberToCanvas`, `renderGerberToPng`, `renderGerberToPngStream`, `renderGerberToPngBuffer`, `renderGerberToPngFile`, `renderLayers`)는 load 가능한 모든 유효한 layer를 렌더링합니다. 모든 layer가 실패하면 첫 번째 layer error로 Promise를 reject합니다.

## API 옵션

`frameOptions`는 출력 frame과 renderer 동작을 제어합니다.

- `width`: 출력 너비(px). 기본값은 브라우저 canvas width, Node에서는 `1200`입니다.
- `height`: 출력 높이(px). 기본값은 브라우저 canvas height, Node에서는 `800`입니다.
- `clear`: 렌더링 전 frame을 지웁니다. 기본값은 `true`이며, Node는 항상 새 buffer에 렌더링합니다.
- `background`: 출력 배경입니다. 기본값은 투명 출력을 의미하는 `null`입니다. CSS color string 또는 `[r, g, b, a]`를 받습니다.
- `fit`: load된 모든 layer의 경계를 output frame에 맞춥니다. 기본값은 `true`입니다.
- `padding`: `fit`이 켜져 있을 때 적용되는 pixel padding입니다. 기본값은 `0`입니다.
- `flipX`: frame center를 기준으로 output을 좌우 반전합니다. 기본값은 `false`입니다.
- `flipY`: frame center를 기준으로 output을 상하 반전합니다. 기본값은 `false`입니다.
- `view`: 직접 지정하는 `{ zoomX, zoomY, offsetX, offsetY }`입니다. 지정하면 `fit`보다 우선합니다.
- `preserveArcRegions`: region arc를 정확하게 유지합니다. 기본값은 `true`이며, `false`로 설정하면 region arc를 근사합니다.
- `arcTessellationQuality`: arc 근사 품질입니다. `0` low, `1` normal, `2` high이며 기본값은 `1`입니다.
- `minimumFeaturePixels`: line/arc의 최소 렌더링 폭(px)입니다. 기본값은 `1`입니다.
- `renderDrills`: NC drill 파일(`.drl`, `.nc`, `.xnc`, `.xln`)을 drill overlay로 렌더링합니다. 기본값은 `true`입니다.
- `globalAlpha`: `blend` 모드에서 명시적인 layer `alpha`가 없는 Gerber layer에 적용되는 opacity입니다. 기본값은 `0.7`입니다.
- `compositeMode`: layer 합성 모드입니다. `"blend"` 또는 `"stack"`을 받으며 기본값은 `"blend"`입니다. `blend`는 alpha additive blending을 사용하고, `stack`은 Gerber layer를 입력 순서대로 source-over 합성하므로 뒤 Gerber layer가 앞 Gerber layer를 덮으며 기본 opacity는 `1`입니다. Drill overlay는 Gerber layer 이후에 렌더링됩니다.
- `invertedOutline`: Node 전용 inverted layer 기준 outline입니다. `"auto"`는 board outline layer를 자동 감지하고, `"bounds"`는 현재 Gerber bounds를 채우며, layer index/name selector도 사용할 수 있습니다. 기본값은 `"auto"`입니다.
- `maxBandBytes`: Node 전용 streamed PNG row-buffer budget입니다. 기본값은 `512 MiB`입니다.
- `maxFullFrameBytes`: Node 전용 full-frame PNG export 선택 기준 memory budget입니다. 기본값은 `512 MiB`입니다.
- `maxRenderTargetBytes`: Node 전용 per-render-target memory cap입니다. 기본적으로 사용 가능한 GPU/driver budget을 probe하고 실패하면 `2 GiB`를 사용합니다.
- `framebufferMemorySafetyFactor`: Node 전용 full-frame framebuffer memory estimate multiplier입니다. 기본값은 `2`입니다.
- `strategy`: Node 전용 PNG export strategy입니다. `"auto"`, `"full-frame"`, `"stream"` 중 하나이며 기본값은 `"auto"`입니다.
- `layerErrorMode`: `"skip"`은 남은 유효한 layer를 계속 렌더링하고, `"throw"`는 첫 실패에서 Promise를 reject합니다. 기본값은 `"skip"`입니다.
- `onLayerError`: `"skip"` mode에서 건너뛴 layer를 받는 callback입니다. 전달 값은 `{ layer, name, error }`입니다.
- `rendererOptions`: 브라우저 one-shot helper 전용입니다. 렌더러 생성 시 그대로 전달됩니다.

`layerOptions`는 layer 하나를 제어합니다.

- `color`: layer 색상입니다. 브라우저는 `[r, g, b]`를 받고, Node는 hex와 `rgb()`/`rgba()` string도 받습니다. 기본값은 자동 색상 순환입니다.
- `alpha`: layer별 opacity입니다. 설정하면 해당 layer의 frame 기본값을 재정의합니다. `stack` 모드에서는 명시적인 Gerber `alpha`가 불투명 기본값을 재정의합니다. Drill layer는 설정하지 않으면 불투명하게 렌더링됩니다.
- `offsetX`: geometry를 load할 때 적용되는 X offset입니다. 기본값은 `0`입니다.
- `offsetY`: geometry를 load할 때 적용되는 Y offset입니다. 기본값은 `0`입니다.
- `inverted`: Node 전용입니다. 이 Gerber layer를 `frameOptions.invertedOutline` 기준의 inverted/negative layer로 렌더링합니다. 기본값은 `false`입니다.
- `kind`: source filename이 없거나 모호할 때 `"gerber"` 또는 `"drill"`을 강제로 지정합니다.
- `name`: `{ source, name }` 또는 `{ path, name }` 같은 config object에서 쓰는 layer 표시 이름입니다.

`loadLayer()`와 `loadLayers()`는 parse/load option도 받습니다.

- `preserveArcRegions`: prepared layer에서 exact region arc를 유지합니다. 기본값은 `true`입니다.
- `arcTessellationQuality`: region arc를 approximate할 때 prepared layer의 arc quality를 지정합니다.
- `retainSourceContentForInversion`: Node 전용입니다. prepared layer를 나중에 inverted layer나 explicit outline source로 사용할 수 있도록 원본 Gerber text를 유지합니다.

`exportOptions`는 PNG export를 제어합니다.

- `type`: 브라우저 전용 export MIME type입니다. 기본값은 `image/png`이며, Node는 항상 PNG를 씁니다.
- `quality`: 브라우저 전용 encoder quality이며 `canvas.toBlob`에 전달됩니다.
- `background`: export background 재정의입니다. `null`을 사용하면 transparency를 유지합니다. 기본값은 마지막 frame background입니다.
- `maxBandBytes`: streamed PNG export의 approximate row-buffer budget입니다. Node는 high-resolution tiled rendering에도 이 값을 사용합니다.
- `maxFullFrameBytes`: Node 전용 full-frame PNG export memory budget입니다.
- `maxRenderTargetBytes`: Node 전용 per-render-target memory cap입니다.
- `framebufferMemorySafetyFactor`: Node 전용 framebuffer memory estimate multiplier입니다.
- `strategy`: Node 전용 PNG export strategy입니다. `"auto"`, `"full-frame"`, `"stream"` 중 하나입니다.

`rendererOptions`는 renderer 생성을 제어합니다.

- `wasmModule`: 미리 load된 WASM JS module입니다. 대부분의 사용자는 필요하지 않습니다.
- `wasmModuleUrl`: WASM JS module을 import할 때 사용할 URL입니다.
- `wasmBinaryUrl`: Node 전용 `.wasm` binary URL입니다.
- `wasmInitInput`: WASM module initializer에 전달할 사용자 지정 값입니다.
- `contextAttributes`: WebGL context attributes입니다.
- `releaseContext`: `dispose()` 시 WebGL/GLES context를 해제합니다. 기본값은 `true`입니다.
- `glesModule`: Node 전용 사용자 지정 GLES module object입니다. 일반적인 CLI 사용은 `node-gles-webgl2`를 사용합니다.
- `glesModuleName`: GLES runtime을 load할 때 사용할 Node 전용 module name입니다.
- `gl`: Node 전용 pre-created WebGL2-compatible context입니다.

## CLI

전역 설치 후 CLI를 직접 실행합니다.

```bash
gerber-renderer board.gbr --width 1200 --height 800 --background '#05070c'
```

더 자세한 예시:

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

Archive 예시:

```bash
gerber-renderer board-gerbers.tar.gz \
  --width 1600 \
  --height 1000 \
  --background '#05070c'
```

CLI 옵션:

- `<input...>`: 하나 이상의 Gerber/drill 파일 또는 `.tar.gz`/`.tgz` 압축 파일입니다. Gerber 입력은 argument 순서대로 렌더링되고, drill 입력은 Gerber layer 위의 overlay로 렌더링됩니다.
- `-o, --output <path>`: PNG output path입니다. 여러 input을 사용할 때는 필수입니다. 상위 directory는 미리 존재해야 합니다.
- `--width <px>`: 출력 너비입니다. 기본값은 `1200`입니다.
- `--height <px>`: 출력 높이입니다. 기본값은 `800`입니다.
- `--padding <px>`: fit-to-view padding입니다. 기본값은 `0`입니다.
- `--background <color>`: hex 또는 `rgb()`/`rgba()` 배경입니다. 생략하면 투명 출력입니다.
- `--alpha <0-1>`: `blend` 모드의 Gerber layer opacity입니다. 기본값은 `0.7`입니다. `stack` 모드에서는 Gerber layer와 drill overlay를 불투명하게 렌더링합니다.
- `--composite-mode <blend|stack>`: layer 합성 모드입니다. 기본값은 `blend`입니다.
- `--minimum-feature-pixels <px>`: line/arc의 최소 렌더링 폭입니다. 기본값은 `1`입니다.
- `--max-render-target-bytes <size>`: render target별 memory cap입니다. byte 또는 `512m`, `2g` 같은 suffix를 받습니다.
- `--max-band-bytes <size>`: streamed PNG row-buffer cap입니다. byte 또는 `512m`, `2g` 같은 suffix를 받습니다.
- `--max-full-frame-bytes <size>`: full-frame PNG memory cap입니다. byte 또는 `512m`, `2g` 같은 suffix를 받습니다.
- `--framebuffer-memory-safety-factor <n>`: full-frame framebuffer memory estimate multiplier입니다. 기본값은 `2`입니다.
- `--render-strategy <auto|full-frame|stream>`: PNG export strategy입니다. 기본값은 `auto`입니다.
- `--approx-region-arcs`: 렌더링 전에 region arc를 line segment로 변환합니다.
- `--arc-quality <0|1|2>`: arc 근사 품질입니다. 기본값은 `1`입니다.
- `--invert-layer <selector>`: Gerber layer를 inverted/negative layer로 렌더링합니다. 여러 layer를 뒤집으려면 반복해서 지정합니다. Selector는 1-based layer index, exact layer name, basename을 지원합니다.
- `--outline-layer <selector>`: inverted layer에 사용할 board outline입니다. `auto`, `bounds`, 1-based layer index, exact layer name, basename을 사용할 수 있습니다. 기본값은 `auto`입니다.
- `--flip-x`: output을 좌우 반전합니다.
- `--flip-y`: output을 상하 반전합니다.
- `--no-drill`: NC drill layer를 건너뜁니다.
- `--no-fit`: fit-to-view를 끕니다.
- `--skill`: AI agent를 위한 [package usage notes](SKILL.md)를 출력합니다.
- `-h, --help`: CLI 사용법을 출력하고 종료합니다.

`--arc-quality`는 `--approx-region-arcs`와 함께 사용할 때 의미가 있습니다. Quality 값은 `0` low, `1` normal, `2` high입니다.

여러 input file을 제공하면 CLI는 실패한 layer마다 warning을 출력하고, 남은 layer를 계속 렌더링합니다. 모든 input이 실패하면 command는 error로 종료됩니다.

Input이 하나이고 `--output`을 생략하면 CLI는 input 옆에 output을 생성합니다. `.gbr`, `.ger`, `.art`, `.gdo`, `.pho` 같은 일반 Gerber extension은 `.png`로 교체됩니다. Layer-specific 또는 unknown extension은 전체 filename을 유지하고 `.png`를 붙입니다.

## 라이선스

[MIT License](LICENSE)
