<div align="center">

# wasm-gerber-viewer

本项目是一个基于 WASM/WebGL2 的 Gerber 文件查看器，适用于 PCB 可视化场景。

![WASM Gerber Viewer preview](demo/preview.png)

<br/>

[**`English`**](README.md) · **`简体中文`** · [**`繁體中文`**](README.zh-Hant.md) · [**`한국어`**](README.kr.md)

</div>

---

在线体验：

- [查看器](https://dsafdsaf132.github.io/wasm-gerber-viewer/) / [镜像站点](https://wasm-gerber-viewer.vercel.app/)
- [Sample 1: SparkFun Thing Plus ESP32 WROOM C Panel](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsparkfun%2FSparkFun_Thing_Plus_ESP32_WROOM_C%2Fmain%2FHardware%2FProduction%2FSparkFun_Thing_Plus_ESP32_WROOM_C-Panel.zip)
- [Sample 2: LimeSDR-PCIe](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmyriadrf%2FLimeSDR-PCIe%2Fmaster%2Fhardware%2F1v3%2FDFM%2FLimeSDR-PCIe_1v3_DB_DFMr2.zip)
- [Sample 3: LimeNET-Micro](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmyriadrf%2FLimeNET-Micro%2Fmaster%2Fhardware%2F2v1%2FLimeNet-Micro_2v1-SDR_DB_DFMr2.zip)
- [Sample 4: Zaius EVT3 Motherboard (ODB++)](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fmedia.githubusercontent.com%2Fmedia%2Fopencomputeproject%2Fzaius-barreleye-g2%2Fmaster%2FHW%2FEE%2FGBR%2FEVT%2FMB%2FZaius-EVT3-LAYOUT-MB-ODB-X02-20161226-Final.zip)
- [功能测试](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fgerber-feature-test.gbr)
- 性能测试 - Stars: [1K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-1K.gbr), [10K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-10K.gbr), [100K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-100K.gbr), [1M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr), [5M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=5&repeatOffsetX=70), [10M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=10&repeatOffsetX=70), [20M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=20&repeatOffsetX=70), [50M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=50&repeatOffsetX=70), [100M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=100&repeatOffsetX=0.007)
- 性能测试 - Single region: [72K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-region-72K.gbr), [648K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-648K.gbr), [1.8M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-1.8M.gbr)
- 性能测试 - Arc region: [1.3M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-arc-region-1.3M.gbr)
- Memory64 测试 - Pads，使用超过 4 GiB 内存: [24M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fmemory64-test-pads-24M.gbr)

## 功能特性

- 面向大型 Gerber 文件（10 MB 以上）优化的高性能渲染
- 基于 WASM 与 WebGL2 的硬件加速渲染
- 支持 RS-274X Gerber 渲染
- 支持 NC drill 叠加渲染
- 支持导入 ODB++ 作业（`.zip`、`.tgz`、`.tar.gz`、`.tar`）
- 支持移动设备触控操作
- 支持按层控制颜色、透明度和可见性
- Composite Layer 支持 Union、Intersection、Difference 和自定义 coverage
  组合
- 支持要素拾取和选中区域高亮
- 支持水平/垂直翻转
- 标尺测量支持 mm/inch 单位切换
- 可按分辨率导出截图，并可包含标尺覆盖层

## 快速开始

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

在浏览器中打开 `http://localhost:8000`，然后上传 Gerber 文件。

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

在浏览器中打开 `http://localhost:8000`，然后上传 Gerber 文件。

</details>

## 本地构建

如果不使用预构建的 Release 产物，可以按以下方式在本地重新构建 WASM 包。

环境要求：

- **Rust stable** - 使用 [rustup](https://rustup.rs/) 安装
- **wasm-pack** - `cargo install wasm-pack`

wasm32 构建输出到 `wasm/pkg`，memory64 构建输出到 `wasm/pkg64`。
memory64 脚本会安装所需的构建工具。

```bash
rustup target add wasm32-unknown-unknown
wasm-pack build wasm --target web --out-dir pkg --release
./scripts/build-wasm64.sh
```

## npm 包

[wasm-gerber-renderer](packages/wasm-gerber-renderer/README.zh-Hans.md)

该包可在 JavaScript、Node.js 和 CLI 中将 Gerber 文件渲染为 PNG。
Node.js 和 CLI 渲染通过
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 支持。

## 项目结构

Rust/WASM 管线及模块详情请参阅
[wasm/README.md](wasm/README.md)。

```text
wasm-gerber-viewer/
├── index.html                         # 应用外壳
├── package.json                       # 项目元数据和脚本
├── css/                               # UI 样式
├── js/
│   ├── main.js                        # 浏览器入口
│   ├── core/                          # GerberViewer 状态和流程编排
│   ├── loading/                       # 文件、压缩包、URL、repeat 和 worker 加载
│   ├── layers/                        # 图层列表 UI、过滤、颜色和 composite bitset
│   │   └── composite-layers.js        # preset、source slot 和 visible-area bitset
│   ├── rendering/                     # viewport 计算、测量和截图导出
│   └── ui/                            # dialog、DOM 查询、通知、诊断和选项
│       └── composite-layer-dialog.js   # Composite 创建、编辑和重命名 dialog
├── vendor/                            # 内置浏览器第三方库
├── packages/
│   └── wasm-gerber-renderer/          # npm 包和 Node CLI
├── wasm/
│   ├── Cargo.toml                     # Rust crate manifest
│   ├── README.md                      # Rust/WASM 管线说明
│   ├── pkg/                           # 生成的 wasm-pack 输出（wasm32）
│   ├── pkg64/                         # 生成的 memory64 构建（scripts/build-wasm64.sh）
│   └── src/
│       ├── lib.rs                     # WASM API 入口
│       ├── tests.rs                   # crate 级测试
│       ├── geometry/                  # 共享 geometry 模型和 region contour
│       ├── parser/                    # Gerber 解析、aperture、命令处理和测试
│       ├── drill/                     # Excellon/NC drill 解析和测试
│       ├── interaction/               # picking、compact payload 和高亮数据
│       ├── renderer/                  # Gerber/composite mask、GPU 资源、shader 和测试
│       │   ├── composite.rs           # membership、lookup、outline、cache 和 picking 状态
│       │   └── shaders/composite_*.frag.glsl
│       └── util/                      # 格式化和工具函数
├── demo/                              # 示例和性能测试 Gerber
├── docs/                              # README assets
├── scripts/                           # 构建和部署脚本
└── .github/workflows/                 # CI、部署和 release workflow
```

## 浏览器要求

需要支持 WebGL2 和 WebAssembly SIMD。

### 64 位（memory64）

- Chrome、Edge 133+
- Firefox 134+

### 32 位（wasm32）

- Chrome、Edge 96–132
- Firefox 114–133
- Safari 16.4+ / iPhone、iPad 浏览器：iOS 16.4+

## 示例来源

示例压缩包从各自的上游项目加载，不包含在本仓库中。

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

## 开源协议

[MIT License](LICENSE)
