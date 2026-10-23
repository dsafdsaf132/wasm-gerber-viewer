<div align="center">

# wasm-gerber-viewer

WASM/WebGL2-based Gerber file viewer for PCB visualization.

![WASM Gerber Viewer preview](demo/preview.png)

<br/>

**`English`** · [**`简体中文`**](README.zh-Hans.md) · [**`繁體中文`**](README.zh-Hant.md) · [**`한국어`**](README.kr.md)

</div>

---

## Websites

- [Viewer](https://wasm-gerber-viewer.vercel.app/) / [Mirror](https://dsafdsaf132.github.io/wasm-gerber-viewer/)
- [Sample 1: SparkFun Thing Plus ESP32 WROOM C Panel](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsparkfun%2FSparkFun_Thing_Plus_ESP32_WROOM_C%2Fmain%2FHardware%2FProduction%2FSparkFun_Thing_Plus_ESP32_WROOM_C-Panel.zip)
- [Sample 2: LimeSDR-PCIe](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmyriadrf%2FLimeSDR-PCIe%2Fmaster%2Fhardware%2F1v3%2FDFM%2FLimeSDR-PCIe_1v3_DB_DFMr2.zip)
- [Sample 3: LimeNET-Micro](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmyriadrf%2FLimeNET-Micro%2Fmaster%2Fhardware%2F2v1%2FLimeNet-Micro_2v1-SDR_DB_DFMr2.zip)
- [Sample 4: Zaius EVT3 Motherboard (ODB++)](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fmedia.githubusercontent.com%2Fmedia%2Fopencomputeproject%2Fzaius-barreleye-g2%2Fmaster%2FHW%2FEE%2FGBR%2FEVT%2FMB%2FZaius-EVT3-LAYOUT-MB-ODB-X02-20161226-Final.zip)
- [Feature test](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fgerber-feature-test.gbr)
- Performance test - Stars: [1K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-1K.gbr), [10K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-stars-10K.gbr), [100K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-100K.gbr), [1M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr), [5M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=5&repeatOffsetX=70), [10M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=10&repeatOffsetX=70), [20M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=20&repeatOffsetX=70), [50M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-stars-1M.gbr&repeat=50&repeatOffsetX=0.007)
- Performance test - Single region: [72K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fperformance-test-region-72K.gbr), [648K](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-648K.gbr), [1.8M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-region-1.8M.gbr)
- Performance test - Arc region: [1.3M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fw2f6wchhvqyk5cap.public.blob.vercel-storage.com%2Fdemo%2Fperformance-test-arc-region-1.3M.gbr)
- Memory64 test - Pads, uses more than 4 GiB of memory: [24M](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fwasm-gerber-viewer.vercel.app%2Fdemo%2Fmemory64-test-pads-24M.gbr)

## Features

- High-performance rendering for large Gerber files (>10 MB)
- WebGL2 hardware-accelerated rendering via WASM
- RS-274X Gerber rendering support
- NC drill overlay rendering support
- ODB++ job import (`.zip`, `.tgz`, `.tar.gz`, `.tar`)
- Touch support for mobile devices
- Multi-layer rendering with per-layer color and visibility control
- Composite Layers with Union, Intersection, Difference, and custom coverage
  combinations
- Feature picking with selected-area highlighting
- Horizontal/vertical flip controls
- Ruler measurements with mm/inch unit switching
- Screenshot export with resolution options, including ruler overlays

## Quick Start

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

Open `http://localhost:8000` and upload Gerber files.

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

Open `http://localhost:8000` and upload Gerber files.

</details>

## Building

Use this when you need to rebuild the WASM package locally instead of using the
prebuilt release artifact.

Requirements:

- **Rust stable** - install with [rustup](https://rustup.rs/)
- **wasm-pack** - `cargo install wasm-pack`

```bash
rustup target add wasm32-unknown-unknown
wasm-pack build wasm --target web --out-dir pkg --release
./scripts/build-wasm64.sh
```

## npm Package

[wasm-gerber-renderer](packages/wasm-gerber-renderer/README.md)

JavaScript, Node.js, and CLI package for rendering Gerber files to PNG.
Node.js and CLI rendering are supported via
[`node-gles-webgl2`](https://github.com/dsafdsaf132/node-gles-webgl2).

## Project Structure

For the Rust/WASM pipeline and module details, see
[wasm/README.md](wasm/README.md).

```text
wasm-gerber-viewer/
├── index.html                         # Application shell
├── package.json                       # Project metadata and scripts
├── css/                               # UI styles
├── js/
│   ├── main.js                        # Browser entry point
│   ├── core/                          # GerberViewer state and orchestration
│   ├── loading/                       # File, archive, URL, repeat, and worker loading
│   ├── layers/                        # Layer list UI, filters, colors, and composite bitsets
│   ├── rendering/                     # Viewport math, measurements, and screenshot export
│   └── ui/                            # Dialogs, DOM lookup, notifications, diagnostics, options
├── vendor/                            # Vendored browser libraries
├── packages/
│   └── wasm-gerber-renderer/          # npm package and Node CLI
├── wasm/
│   ├── Cargo.toml                     # Rust crate manifest
│   ├── README.md                      # Rust/WASM pipeline notes
│   ├── pkg/                           # Generated wasm-pack output (wasm32)
│   ├── pkg64/                         # Generated memory64 build (scripts/build-wasm64.sh)
│   └── src/
│       ├── lib.rs                     # WASM API entry point
│       ├── tests.rs                   # Crate-level tests
│       ├── geometry/                  # Shared geometry model and region contours
│       ├── parser/                    # Gerber parser, apertures, commands, and tests
│       ├── drill/                     # Excellon/NC drill parser and tests
│       ├── interaction/               # Picking, compact payloads, and highlight data
│       ├── renderer/                  # Gerber/composite masks, GPU resources, shaders, tests
│       └── util/                      # Formatting and utility helpers
├── demo/                              # Sample and performance Gerbers
├── docs/                              # README assets
├── scripts/                           # Build and deployment scripts
└── .github/workflows/                 # CI, deploy, and release workflows
```

## Browser Requirements

WebGL2 and WebAssembly SIMD are required.

### 64-bit (memory64)

- Chrome / Edge 133+
- Firefox 134+

### 32-bit (wasm32)

- Chrome / Edge 96–132
- Firefox 114–133
- Safari 16.4+ / iPhone/iPad browsers: iOS 16.4+

## Source

Sample archives are loaded from their upstream sources and are not bundled in
this repository.

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

## License

[MIT License](LICENSE)
