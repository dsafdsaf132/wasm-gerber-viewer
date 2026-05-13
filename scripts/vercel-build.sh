#!/usr/bin/env bash
set -euo pipefail

export CARGO_HOME="/rust"
export RUSTUP_HOME="/rust"
export PATH="$CARGO_HOME/bin:$PATH"
WASM_PACK_VERSION="0.14.0"

# shellcheck disable=SC1091
. /rust/env

rustup toolchain install stable --profile minimal
rustup default stable
rustup target add wasm32-unknown-unknown --toolchain stable

if ! command -v wasm-pack >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64 | amd64)
      wasm_pack_arch="x86_64"
      ;;
    aarch64 | arm64)
      wasm_pack_arch="aarch64"
      ;;
    *)
      echo "Unsupported architecture for prebuilt wasm-pack: $(uname -m)" >&2
      exit 1
      ;;
  esac

  wasm_pack_target="${wasm_pack_arch}-unknown-linux-musl"
  wasm_pack_archive="wasm-pack-v${WASM_PACK_VERSION}-${wasm_pack_target}.tar.gz"
  wasm_pack_url="https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${wasm_pack_archive}"
  wasm_pack_tmp="$(mktemp -d)"

  curl --proto '=https' --tlsv1.2 -fsSL "$wasm_pack_url" -o "$wasm_pack_tmp/$wasm_pack_archive"
  tar -xzf "$wasm_pack_tmp/$wasm_pack_archive" -C "$wasm_pack_tmp"
  mkdir -p "$CARGO_HOME/bin"
  install -m 0755 \
    "$wasm_pack_tmp/wasm-pack-v${WASM_PACK_VERSION}-${wasm_pack_target}/wasm-pack" \
    "$CARGO_HOME/bin/wasm-pack"
  rm -rf "$wasm_pack_tmp"
fi

cd wasm
wasm-pack build --target web --out-dir pkg --release
