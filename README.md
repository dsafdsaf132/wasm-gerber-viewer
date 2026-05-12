# WASM Gerber Viewer

WASM/WebGL2-based Gerber file viewer for PCB visualization.

[website](https://wasm-gerber-viewer.vercel.app/)

## Features

- High-performance rendering when huge Gerber files (>10MB) are uploaded
- WebGL2 hardware-accelerated rendering via WASM
- Touch support for mobile devices
- Multi-layer rendering with per-layer color and visibility control
- Drag-and-drop upload and per-file size validation (300MB limit)

## Limitations

This project focuses on high-performance rendering, but it does not render accurately.

As it is a Work In Progress, some Gerber syntax may not be fully supported.

## Requirements

- **Rust** - [Install Rust](https://rustup.rs/)
- **wasm-pack** - Install via: `cargo install wasm-pack`
- **Python 3** - For running the local HTTP server

## Quick Start

```bash
git clone https://github.com/dsafdsaf132/wasm_gerber_viewer.git
cd wasm_gerber_viewer

# Build WASM module
wasm-pack build wasm --target web --out-dir pkg --release

# Start development server
python3 -m http.server 8000
```

Open `http://localhost:8000` and upload Gerber files.

## Project Structure

```text
wasm_gerber_viewer/
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

## Architecture Summary

### Frontend (JavaScript + HTML/CSS)

- `GerberViewer` in `js/main.js` owns UI state (layers, selection, alpha, camera) and forwards rendering commands to WASM.
- Canvas interactions include:
  - mouse wheel zoom (cursor-centered)
  - drag pan
  - touch pan + pinch zoom
- The drawer UI manages layer visibility, color, ordering and removal.
- Upload pipeline validates file size first, then parses files concurrently.

### Backend Rendering (Rust + WebGL2 via wasm-bindgen)

- `GerberProcessor` in `wasm/src/lib.rs` exposes the public WASM API:
  - `init`, `add_layer`, `remove_layer`, `clear`, `render`, `get_boundary`, `resize`
- `Renderer` in `wasm/src/renderer.rs` stores sparse layer slots and per-layer FBOs.
- Each rendered layer can contain multiple polarity sublayers.
- Render pipeline:
  1. geometry render into per-layer FBO (white/alpha coverage)
  2. composite FBO textures into canvas with layer color and global alpha

## Code Review Notes (Repository-wide)

### README/documentation

- Build, run and constraints are documented, but renderer internals were under-documented.
- This README update adds architecture and review notes to reduce onboarding time.

### Frontend review highlights

- Good separation between UI event handling and WASM API calls.
- Good: upload handling uses `Promise.all` and renders once at the end.
- Risk: wheel/pinch zoom has no minimum/maximum clamp, so extreme deltas may produce unstable camera zoom values.
- Risk: `warningMessage.innerHTML` is built from file names; if untrusted filenames are possible, this should be escaped or switched to `textContent` rendering.

### Backend rendering review highlights

- Good: explicit cleanup for framebuffers, textures, VAOs and buffers in `remove_layer` and `clear_all`.
- Good: per-layer FBO architecture keeps compositing simple and scalable.
- Risk: several attribute lookups rely on `.unwrap()` when binding shader attributes; if shader-source drift occurs, runtime panic can occur instead of recoverable `Result` error.
- Rendering currently uses additive blending (`ONE, ONE`) during final compositing, which intentionally creates a lighter blend. If physical stack-up accuracy is required later, a different compositing model will be needed.

### Recommended next improvements

1. Add zoom clamps in JS camera controls.
2. Replace `innerHTML`-based warning rendering with safe node/text rendering.
3. Replace key `unwrap()` calls in renderer attribute lookup paths with explicit `Result` propagation.
4. Add smoke tests (or wasm-bindgen tests) for layer add/remove/clear lifecycle and boundary behavior.

## Browser Requirements

Modern browsers with WebGL2 support:

- Chrome 80+, Firefox 75+, Safari 15+, Edge 80+

## Work in Progress

The following Gerber commands are not yet implemented:

- **%AB** - Aperture Block definitions
- **%LR** - Layer Rotation transformations

## License

[MIT License](LICENSE)
