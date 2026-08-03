#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
threaded_toolchain="nightly-2026-07-20"
out_dir="$repo_root/wasm/pkg-threaded"

if ! rustup toolchain list | grep -q "^${threaded_toolchain}"; then
  rustup toolchain install "$threaded_toolchain" --profile minimal
fi
if ! rustup component list --toolchain "$threaded_toolchain" --installed | grep -q "^rust-src"; then
  rustup component add rust-src --toolchain "$threaded_toolchain"
fi
if ! rustup target list --toolchain "$threaded_toolchain" --installed | grep -q "^wasm32-unknown-unknown"; then
  rustup target add wasm32-unknown-unknown --toolchain "$threaded_toolchain"
fi

export RUSTUP_TOOLCHAIN="$threaded_toolchain"
export RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--import-memory -C link-arg=--max-memory=2147483648"

cd "$repo_root/wasm"
wasm-pack build \
  --target web \
  --out-dir pkg-threaded \
  --release \
  -- \
  --features threaded \
  -Z build-std=std,panic_abort

test -f "$out_dir/wasm_gerber_processor.js"
test -f "$out_dir/wasm_gerber_processor_bg.wasm"
if ! find "$out_dir" -type f -name '*workerHelpers*.js' -print -quit | grep -q .; then
  echo "Threaded WASM helper asset is missing" >&2
  exit 1
fi
