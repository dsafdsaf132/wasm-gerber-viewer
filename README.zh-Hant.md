<div align="center">

# wasm-gerber-viewer

本專案是一個基於 WASM/WebGL2 的 Gerber 檔案檢視器，適用於 PCB 視覺化場景。

![WASM Gerber Viewer preview](demo/preview.png)

<br/>

[**`English`**](README.md) · [**`简体中文`**](README.zh-Hans.md) · **`繁體中文`** · [**`한국어`**](README.kr.md)

</div>

---

線上體驗：

- [檢視器](https://wasm-gerber-viewer.vercel.app/) / [鏡像站點](https://dsafdsaf132.github.io/wasm-gerber-viewer/)
- [Sample 1: SparkFun Thing Plus ESP32 WROOM C Panel](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsparkfun%2FSparkFun_Thing_Plus_ESP32_WROOM_C%2Fmain%2FHardware%2FProduction%2FSparkFun_Thing_Plus_ESP32_WROOM_C-Panel.zip)
- [Sample 2: LimeSDR-PCIe](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmyriadrf%2FLimeSDR-PCIe%2Fmaster%2Fhardware%2F1v3%2FDFM%2FLimeSDR-PCIe_1v3_DB_DFMr2.zip)
- [Sample 3: LimeNET-Micro](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmyriadrf%2FLimeNET-Micro%2Fmaster%2Fhardware%2F2v1%2FLimeNet-Micro_2v1-SDR_DB_DFMr2.zip)
- [Sample 4: Zaius EVT3 Motherboard (ODB++)](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fmedia.githubusercontent.com%2Fmedia%2Fopencomputeproject%2Fzaius-barreleye-g2%2Fmaster%2FHW%2FEE%2FGBR%2FEVT%2FMB%2FZaius-EVT3-LAYOUT-MB-ODB-X02-20161226-Final.zip)
- [功能測試](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fgerber-feature-test.gbr)
- 效能測試 - Stars: [1K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-1K.gbr), [10K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-10K.gbr), [100K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-100K.gbr), [1M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr), [5M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=5&repeatOffsetX=70), [10M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=10&repeatOffsetX=70), [20M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=20&repeatOffsetX=70), [50M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=50&repeatOffsetX=70), [100M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=100&repeatOffsetX=0.007)
- 效能測試 - Single region: [72K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-region-72K.gbr), [648K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-648K.gbr), [1.8M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-1.8M.gbr)
- 效能測試 - Arc region: [1.3M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-arc-region-1.3M.gbr)
- Memory64 測試 - Pads，使用超過 4 GiB 記憶體: [24M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fmemory64-test-pads-24M.gbr)

## 功能特色

- 針對大型 Gerber 檔案（10 MB 以上）最佳化的高效能渲染
- 基於 WASM 與 WebGL2 的硬體加速渲染
- 支援 RS-274X Gerber 渲染
- 支援 NC drill 疊加渲染
- 支援匯入 ODB++ 作業（`.zip`、`.tgz`、`.tar.gz`、`.tar`）
- 支援行動裝置觸控操作
- 支援依圖層控制顏色、透明度與可見性
- Composite Layer 支援 Union、Intersection、Difference 與自訂 coverage
  組合
- 支援特徵選取與選取區域醒目提示
- 支援水平/垂直翻轉
- 尺規測量支援 mm/inch 單位切換
- 可依解析度匯出截圖，並可包含尺規覆蓋層

## 快速開始

<details>
<summary>Bash</summary>

```bash
viewer_url="$(
  curl -fsSL https://api.github.com/repos/dsafdsaf132/wasm-gerber-viewer/releases/latest |
  sed -n '/"browser_download_url": .*\/wasm-gerber-viewer-.*\.tar\.gz"/ {
    s/.*"browser_download_url": *"\([^"]*\)".*/\1/p
    q
  }'
)"

curl -fsSL "$viewer_url" | tar -xz &&
cd wasm-gerber-viewer-* &&
python3 -m http.server 8000
```

在瀏覽器中開啟 `http://localhost:8000`，然後上傳 Gerber 檔案。

</details>

<details>
<summary>PowerShell</summary>

```powershell
$viewerUrl = (
  Invoke-RestMethod -Uri "https://api.github.com/repos/dsafdsaf132/wasm-gerber-viewer/releases/latest"
).assets |
  Where-Object { $_.name -match '^wasm-gerber-viewer-.*\.tar\.gz$' } |
  Select-Object -First 1 -ExpandProperty browser_download_url

Invoke-WebRequest -Uri $viewerUrl -OutFile viewer.tar.gz
tar -xzf viewer.tar.gz
Remove-Item viewer.tar.gz
Set-Location ((Get-ChildItem -Directory -Filter "wasm-gerber-viewer-*" | Select-Object -First 1).FullName)

python -m http.server 8000
```

在瀏覽器中開啟 `http://localhost:8000`，然後上傳 Gerber 檔案。

</details>

## 本機建置

如果不使用預先建置的 Release 產物，可以按以下方式在本機重新建置 WASM 套件。

環境需求：

- **Rust stable** - 使用 [rustup](https://rustup.rs/) 安裝
- **wasm-pack** - `cargo install wasm-pack`

wasm32 建置輸出到 `wasm/pkg`，memory64 建置輸出到 `wasm/pkg64`。
memory64 指令碼會安裝所需的建置工具。

```bash
rustup target add wasm32-unknown-unknown
wasm-pack build wasm --target web --out-dir pkg --release
./scripts/build-wasm64.sh
```

## npm 套件

[wasm-gerber-renderer](packages/wasm-gerber-renderer/README.zh-Hant.md)

該套件可在 JavaScript、Node.js 與 CLI 中將 Gerber 檔案渲染為 PNG。
Node.js 與 CLI 渲染透過
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 支援。

## 專案結構

Rust/WASM 管線與模組詳情請參閱
[wasm/README.md](wasm/README.md)。

```text
wasm-gerber-viewer/
├── index.html                         # 應用程式外殼
├── package.json                       # 專案中繼資料與腳本
├── css/                               # UI 樣式
├── js/
│   ├── main.js                        # 瀏覽器進入點
│   ├── core/                          # GerberViewer 狀態與流程編排
│   ├── loading/                       # 檔案、壓縮檔、URL、repeat 與 worker 載入
│   ├── layers/                        # 圖層清單 UI、篩選、顏色與 composite bitset
│   │   └── composite-layers.js        # preset、source slot 與 visible-area bitset
│   ├── rendering/                     # viewport 計算、測量與截圖匯出
│   └── ui/                            # dialog、DOM 查詢、通知、診斷與選項
│       └── composite-layer-dialog.js   # Composite 建立、編輯與重新命名 dialog
├── vendor/                            # 內建瀏覽器第三方函式庫
├── packages/
│   └── wasm-gerber-renderer/          # npm 套件與 Node CLI
├── wasm/
│   ├── Cargo.toml                     # Rust crate manifest
│   ├── README.md                      # Rust/WASM 管線說明
│   ├── pkg/                           # 產生的 wasm-pack 輸出（wasm32）
│   ├── pkg64/                         # 產生的 memory64 建置（scripts/build-wasm64.sh）
│   └── src/
│       ├── lib.rs                     # WASM API 入口
│       ├── tests.rs                   # crate 層級測試
│       ├── geometry/                  # 共用 geometry 模型與 region contour
│       ├── parser/                    # Gerber 解析、aperture、命令處理與測試
│       ├── drill/                     # Excellon/NC drill 解析與測試
│       ├── interaction/               # picking、compact payload 與 highlight 資料
│       ├── renderer/                  # Gerber/composite mask、GPU 資源、shader 與測試
│       │   ├── composite.rs           # membership、lookup、outline、cache 與 picking 狀態
│       │   └── shaders/composite_*.frag.glsl
│       └── util/                      # 格式化與工具函式
├── demo/                              # 範例與效能測試 Gerber
├── docs/                              # README assets
├── scripts/                           # 建置與部署腳本
└── .github/workflows/                 # CI、部署與 release workflow
```

## 瀏覽器需求

需要支援 WebGL2 與 WebAssembly SIMD。

### 64 位元（memory64）

- Chrome、Edge 133+
- Firefox 134+

### 32 位元（wasm32）

- Chrome、Edge 96–132
- Firefox 114–133
- Safari 16.4+ / iPhone、iPad 瀏覽器：iOS 16.4+

## 範例來源

範例壓縮檔會從各自的上游專案載入，不包含在本倉庫中。

<details>
<summary>Sample 1: SparkFun Thing Plus ESP32 WROOM C Panel</summary>

- Project: [SparkFun Thing Plus ESP32 WROOM C Panel](https://github.com/sparkfun/SparkFun_Thing_Plus_ESP32_WROOM_C)
- Copyright: SparkFun Electronics
- License: [CC BY-SA 4.0](https://github.com/sparkfun/SparkFun_Thing_Plus_ESP32_WROOM_C/blob/main/LICENSE.md)
- Archive: <https://raw.githubusercontent.com/sparkfun/SparkFun_Thing_Plus_ESP32_WROOM_C/main/Hardware/Production/SparkFun_Thing_Plus_ESP32_WROOM_C-Panel.zip>

</details>

<details>
<summary>Sample 2: LimeSDR-PCIe</summary>

- Project: [LimeSDR-PCIe](https://github.com/myriadrf/LimeSDR-PCIe)
- Copyright: LimeSDR-PCIe (c) 2016 Lime Microsystems Ltd
- License: [CC BY 3.0](https://github.com/myriadrf/LimeSDR-PCIe/blob/master/hardware/COPYING)
- Archive: <https://raw.githubusercontent.com/myriadrf/LimeSDR-PCIe/master/hardware/1v3/DFM/LimeSDR-PCIe_1v3_DB_DFMr2.zip>

</details>

<details>
<summary>Sample 3: LimeNET-Micro</summary>

- Project: [LimeNET-Micro](https://github.com/myriadrf/LimeNET-Micro)
- Copyright: Lime Microsystems Ltd
- License: [CC BY 3.0](https://github.com/myriadrf/LimeNET-Micro#licensing)
- Archive: <https://raw.githubusercontent.com/myriadrf/LimeNET-Micro/master/hardware/2v1/LimeNet-Micro_2v1-SDR_DB_DFMr2.zip>

</details>

<details>
<summary>Sample 4: Zaius EVT3 Motherboard (ODB++)</summary>

- Project: [Zaius & Barreleye G2](https://github.com/opencomputeproject/zaius-barreleye-g2)
- Copyright: Copyright International Business Machines Corporation 2015
- License: [Open Compute Project Hardware License-Permissive (OCPHL-P) v1.0](https://raw.githubusercontent.com/opencomputeproject/zaius-barreleye-g2/master/license.md)
- Archive: <https://media.githubusercontent.com/media/opencomputeproject/zaius-barreleye-g2/master/HW/EE/GBR/EVT/MB/Zaius-EVT3-LAYOUT-MB-ODB-X02-20161226-Final.zip>

</details>

## 授權

[MIT License](LICENSE)
