# wasm-gerber-viewer

WASM/WebGL2-based Gerber file viewer for PCB visualization.

Website:

- [Viewer](https://wasm-gerber-viewer.vercel.app/)
- [Sample 1: KLP-5e ESP32 Sensor Board](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fraw.githubusercontent.com%2Ffutureshocked%2FKLP-5e-ESP32-sensor-board%2Fmain%2FKiCad%2520project%2Fdfm%2Fgerber.zip)
- [Sample 2: Xassette-Asterisk](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fprocessor-cdn.kitspace.org%2Fv6%2FSdtElectronics%2FXassette-Asterisk%2F6ccd88501c99e2339571de744d003d571be47fad%2F_%2FXassette-Asterisk-6ccd885-gerbers.zip)
- [Sample 3: OtterCastAmp](https://wasm-gerber-viewer.vercel.app/?url=https%3A%2F%2Fprocessor-cdn.kitspace.org%2Fv6%2FOttercast%2FOtterCastAmp%2F0b5f7f9a8e4e43a5d39048b9a1fa03e5cf7fc9f7%2F_%2FOtterCastAmp-0b5f7f9-gerbers.zip)

## Features

- High-performance rendering for large Gerber files (>10 MB)
- WebGL2 hardware-accelerated rendering via WASM
- Touch support for mobile devices
- Multi-layer rendering with per-layer color and visibility control
- Drag-and-drop upload and per-file size validation (300MB limit)

## Limitations

This project focuses on high-performance rendering, but rendering accuracy is currently limited.

As this is a work in progress, some Gerber syntax may not be fully supported.

## Requirements

- **Rust** - [Install Rust](https://rustup.rs/)
- **wasm-pack** - Install via: `cargo install wasm-pack`
- **Python 3** - For running the local HTTP server

## Quick Start

```bash
git clone https://github.com/dsafdsaf132/wasm-gerber-viewer.git
cd wasm-gerber-viewer

# Build WASM module
wasm-pack build wasm --target web --out-dir pkg --release

# Start development server
python3 -m http.server 8000
```

Open `http://localhost:8000` and upload Gerber files.

## Project Structure

```text
wasm-gerber-viewer/
├── index.html                             # Main page
├── js/                                    # JavaScript files
│   └── main.js                            # Main application (GerberViewer)
├── css/                                   # Stylesheets
│   └── style.css                          # Application styles
└── wasm/                                  # Rust/WASM module
    ├── Cargo.toml                         # Rust dependencies
    └── src/                               # Rust source
        ├── lib.rs                         # WASM entry point (GerberProcessor)
        ├── shape.rs                       # Geometry data structures
        ├── parser.rs                      # Parser entry point and main logic
        ├── parser/                        # Gerber file parsing submodules
        │   ├── geometry.rs                # Geometric operations and primitives
        │   ├── state.rs                   # Parser state and configuration
        │   ├── aperture.rs                # Aperture definitions and parsing
        │   └── aperture_macro.rs          # Aperture macro definitions and parsing
        ├── renderer.rs                    # Renderer core logic
        └── renderer/                      # WebGL2 rendering submodules
            ├── shader.rs                  # Shader compilation and WebGL constants
            ├── camera.rs                  # Camera and viewport transformations
            └── buffer.rs                  # GPU buffer and framebuffer structures
```

## Browser Requirements

Modern browsers with WebGL2 support:

- Chrome 80+, Firefox 75+, Safari 15+, Edge 80+

## Work in Progress

The following Gerber commands are not implemented yet:

- **%LR** - Layer Rotation transformations

## Source

Sample archives are loaded from their upstream sources and are not bundled in
this repository.

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

## License

[MIT License](LICENSE)
