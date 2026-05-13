# wasm-gerber-viewer

WASM/WebGL2-based Gerber file viewer for PCB visualization.

[Website](https://wasm-gerber-viewer.vercel.app/)

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

- **%AB** - Aperture Block definitions
- **%LR** - Layer Rotation transformations

## Source

The Demo button loads Gerber files from the
[KLP-5e ESP32 Sensor Board](https://github.com/futureshocked/KLP-5e-ESP32-sensor-board)
project.

- Copyright: Copyright (c) 2025, Peter Dalmaris
- License: CERN-OHL-S v2.0
- Source archive:
  <https://raw.githubusercontent.com/futureshocked/KLP-5e-ESP32-sensor-board/main/KiCad%20project/dfm/gerber.zip>
- The demo archive is loaded from the upstream repository and is not bundled in this repository.

## License

[MIT License](LICENSE)
