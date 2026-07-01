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
- [Sample 1: KLP-5e ESP32 Sensor Board](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Ffutureshocked%2FKLP-5e-ESP32-sensor-board%2Fmain%2FKiCad%2520project%2Fdfm%2Fgerber.zip)
- [Sample 2: Xassette-Asterisk](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fprocessor-cdn.kitspace.org%2Fv6%2FSdtElectronics%2FXassette-Asterisk%2F6ccd88501c99e2339571de744d003d571be47fad%2F_%2FXassette-Asterisk-6ccd885-gerbers.zip)
- [Sample 3: OtterCastAmp](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fprocessor-cdn.kitspace.org%2Fv6%2FOttercast%2FOtterCastAmp%2F0b5f7f9a8e4e43a5d39048b9a1fa03e5cf7fc9f7%2F_%2FOtterCastAmp-0b5f7f9-gerbers.zip)
- [功能测试](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fgerber-feature-test.gbr)
- 性能测试 - Stars: [1K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-1K.gbr), [10K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-10K.gbr), [100K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-100K.gbr), [1M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr), [5M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=5&repeatOffsetX=70), [10M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=10&repeatOffsetX=70), [20M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=20&repeatOffsetX=70), [50M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=50&repeatOffsetX=70), [100M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=100&repeatOffsetX=0.007)
- 性能测试 - Single region: [72K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-region-72K.gbr), [648K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-648K.gbr), [1.8M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-1.8M.gbr)
- 性能测试 - Arc region: [1.3M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-arc-region-1.3M.gbr)

## 功能特性

- 面向大型 Gerber 文件（10 MB 以上）优化的高性能渲染
- 基于 WASM 与 WebGL2 的硬件加速渲染
- 支持 RS-274X Gerber 渲染
- 支持 NC drill 叠加渲染
- 支持移动设备触控操作
- 支持按层控制颜色、透明度和可见性
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

```bash
rustup target add wasm32-unknown-unknown
wasm-pack build wasm --target web --out-dir pkg --release
```

## npm 包

[wasm-gerber-renderer](packages/wasm-gerber-renderer/README.zh-Hans.md)

该包可在 JavaScript、Node.js 和 CLI 中将 Gerber 文件渲染为 PNG。
Node.js 和 CLI 渲染通过
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2) 支持。

## 项目结构

```text
wasm-gerber-viewer/
├── index.html                         # 应用外壳
├── package.json                       # 项目元数据和脚本
├── css/                               # UI 样式
├── js/
│   ├── main.js                        # 浏览器入口
│   ├── core/                          # GerberViewer 状态和流程编排
│   ├── loading/                       # 文件、压缩包、URL、repeat 和 worker 加载
│   ├── layers/                        # 图层列表 UI、过滤、颜色和右键操作
│   ├── rendering/                     # viewport 计算、测量和截图导出
│   └── ui/                            # DOM 查询、抽屉、通知、诊断和选项
├── vendor/                            # 内置浏览器第三方库
├── packages/
│   └── wasm-gerber-renderer/          # npm 包和 Node CLI
├── wasm/
│   ├── Cargo.toml                     # Rust crate manifest
│   ├── README.md                      # Rust/WASM 管线说明
│   ├── pkg/                           # 生成的 wasm-pack 输出
│   └── src/
│       ├── lib.rs                     # WASM API 入口
│       ├── tests.rs                   # crate 级测试
│       ├── geometry/                  # 共享 geometry 模型和 region contour
│       ├── parser/                    # Gerber 解析、aperture、命令处理和测试
│       ├── drill/                     # Excellon/NC drill 解析和测试
│       ├── interaction/               # picking、compact payload 和高亮数据
│       ├── renderer/                  # WebGL 渲染器、GPU 资源、shader 和测试
│       └── util/                      # 格式化和工具函数
├── demo/                              # 示例和性能测试 Gerber
├── docs/                              # README assets
├── scripts/                           # 构建和部署脚本
└── .github/workflows/                 # CI、部署和 release workflow
```

## 浏览器要求

需要支持 WebGL2 的现代浏览器。

- Chrome 80+, Firefox 75+, Safari 15+, Edge 80+

## 示例来源

示例压缩包从各自的上游项目加载，不包含在本仓库中。

<details>
<summary>Sample 1: KLP-5e ESP32 Sensor Board</summary>

- Project: [KLP-5e ESP32 Sensor Board](https://github.com/futureshocked/KLP-5e-ESP32-sensor-board)
- Copyright: Copyright (c) 2025, Peter Dalmaris
- License: CERN-OHL-S v2.0
- Archive: <https://raw.githubusercontent.com/futureshocked/KLP-5e-ESP32-sensor-board/main/KiCad%20project/dfm/gerber.zip>

</details>

<details>
<summary>Sample 2: Xassette-Asterisk</summary>

- Project: [Xassette-Asterisk](https://github.com/SdtElectronics/Xassette-Asterisk)
- Copyright: SdtElectronics
- License: CERN-OHL-W v2.0
- Archive: <https://processor-cdn.kitspace.org/v6/SdtElectronics/Xassette-Asterisk/6ccd88501c99e2339571de744d003d571be47fad/_/Xassette-Asterisk-6ccd885-gerbers.zip>

</details>

<details>
<summary>Sample 3: OtterCastAmp</summary>

- Project: [OtterCastAmp](https://github.com/Ottercast/OtterCastAmp)
- Copyright: Copyright (c) 2021 Ottercast, Niklas Fauth
- License: MIT License
- Archive: <https://processor-cdn.kitspace.org/v6/Ottercast/OtterCastAmp/0b5f7f9a8e4e43a5d39048b9a1fa03e5cf7fc9f7/_/OtterCastAmp-0b5f7f9-gerbers.zip>

</details>

## 开源协议

[MIT License](LICENSE)
