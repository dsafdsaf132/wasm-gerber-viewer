#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

cargo fmt --manifest-path wasm/Cargo.toml --check
cargo test --manifest-path wasm/Cargo.toml
cargo clippy --manifest-path wasm/Cargo.toml --all-targets -- -D warnings

for shader in wasm/src/renderer/shaders/*.vert.glsl; do
  glslangValidator -S vert "$shader" >/dev/null
done
for shader in wasm/src/renderer/shaders/*.frag.glsl; do
  glslangValidator -S frag "$shader" >/dev/null
done

wasm-pack build wasm --target web --out-dir pkg --release
node --check scripts/benchmark-composite-4k-chrome.mjs
node scripts/check-composite-readme-parity.mjs
node --test tests/webgl-renderer-classification.test.mjs

npm --prefix packages/wasm-gerber-renderer run check

# Browser interaction coverage remains opt-in via npm run test:playwright.
git diff --check
