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
├── css/
│   └── style.css                      # UI 样式
├── js/
│   ├── main.js                        # GerberViewer 流程编排和 UI 连接
│   ├── config.js                      # 公共常量和默认值
│   ├── diagnostics.js                 # 诊断面板
│   ├── dom-elements.js                # DOM 元素查询
│   ├── drawer-controller.js           # 抽屉交互
│   ├── file-utils.js                  # 文件名和错误处理工具
│   ├── gerber-parse-worker.js         # Gerber 解析 Web Worker
│   ├── layer-filters.js               # 图层类型过滤器
│   ├── layer-list.js                  # 图层列表渲染
│   ├── measurements.js                # 标尺测量和单位显示
│   ├── notifications.js               # Toast 通知
│   ├── screenshot-exporter.js         # 截图导出
│   ├── source-loader.js               # 本地文件、压缩包和 URL 输入加载
│   ├── viewer-options.js              # 查看器选项保存和恢复
│   └── viewport.js                    # 相机和 viewport 计算
├── vendor/
│   ├── README.md                      # 内置第三方库说明
│   ├── jszip-3.10.1.min.js            # ZIP 压缩包加载
│   ├── lucide-1.16.0.min.js           # UI 图标
│   └── licenses/                      # 第三方库许可证
├── packages/
│   └── wasm-gerber-renderer/
│       ├── package.json               # npm 包配置
│       ├── index.js                   # 浏览器渲染器入口文件
│       ├── node.js                    # Node.js/无界面渲染器入口文件
│       ├── shared.js                  # 浏览器/Node 公共逻辑
│       ├── index.d.ts                 # 浏览器类型定义
│       ├── node.d.ts                  # Node.js 类型定义
│       ├── bin/                       # gerber-renderer CLI
│       ├── scripts/                   # 打包用 WASM stage/clean 脚本
│       └── test/                      # 包测试
├── wasm/
│   ├── Cargo.toml                     # Rust crate manifest
│   ├── Cargo.lock                     # Rust dependency lockfile
│   ├── rust-pipeline.md               # Rust/WASM 管线说明
│   ├── pkg/                           # 生成的 wasm-pack 输出
│   └── src/
│       ├── lib.rs                     # WASM API 入口
│       ├── drill.rs                   # Excellon/NC drill 解析器
│       ├── interaction.rs             # 要素拾取和高亮数据
│       ├── parse_common.rs            # 解析器数字处理公共函数
│       ├── parser.rs                  # Gerber 解析器入口
│       ├── parser/                    # aperture、macro、geometry、state、tests
│       ├── renderer.rs                # WebGL 渲染器
│       ├── renderer/                  # 渲染器模块
│       │   ├── buffer.rs              # GPU 资源结构
│       │   ├── camera.rs              # 变换计算
│       │   ├── shader.rs              # 着色器程序
│       │   └── shaders/               # GLSL 着色器源码
│       ├── shape.rs                   # geometry 数据模型
│       └── util.rs                    # 格式化和工具函数
├── demo/                              # 示例和性能测试 Gerber
├── scripts/
│   └── vercel-build.sh                # CI/Vercel WASM 构建脚本
└── .github/workflows/
    ├── build-and-deploy.yml           # 构建、测试和部署工作流
    ├── renderer-compatibility.yml     # 渲染器包兼容性测试
    └── release.yml                    # 手动 release 工作流
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
