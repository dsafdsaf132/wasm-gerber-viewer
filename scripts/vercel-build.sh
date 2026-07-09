#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${CARGO_HOME:-}" && -f /rust/env ]]; then
  export CARGO_HOME="/rust"
fi
if [[ -z "${RUSTUP_HOME:-}" && -f /rust/env ]]; then
  export RUSTUP_HOME="/rust"
fi
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export PATH="$CARGO_HOME/bin:$PATH"
WASM_PACK_VERSION="0.14.0"
RUST_TOOLCHAIN_VERSION="1.97.0"

for rust_env in "$CARGO_HOME/env" "$RUSTUP_HOME/env" /rust/env; do
  if [[ -f "$rust_env" ]]; then
    # shellcheck disable=SC1090
    . "$rust_env"
    break
  fi
done

wasm_package_hash() {
  (
    cd "$REPO_ROOT"
    {
      printf '%s\0' scripts/vercel-build.sh rust-toolchain.toml wasm/Cargo.lock wasm/Cargo.toml
      find wasm/src -type f -print0 | sort -z
    } | xargs -0 sha256sum
  ) | sha256sum | cut -d ' ' -f1
}

wasm_hash="$(wasm_package_hash)"
wasm_pkg_dir="$REPO_ROOT/wasm/pkg"

if [[
  -f "$wasm_pkg_dir/.source-hash" &&
  -f "$wasm_pkg_dir/wasm_gerber_processor.js" &&
  -f "$wasm_pkg_dir/wasm_gerber_processor_bg.wasm" &&
  "$(cat "$wasm_pkg_dir/.source-hash")" == "$wasm_hash"
]]; then
  echo "Reusing cached wasm/pkg for source hash $wasm_hash"
  exit 0
fi

installed_rustc_version="$(RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN_VERSION" rustc --version 2>/dev/null || true)"
if [[ "$installed_rustc_version" != "rustc $RUST_TOOLCHAIN_VERSION "* ]]; then
  rustup toolchain install "$RUST_TOOLCHAIN_VERSION" --profile minimal
fi
export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN_VERSION"
rust_sysroot="$(rustc --print sysroot)"
if [[ ! -d "$rust_sysroot/lib/rustlib/wasm32-unknown-unknown" ]]; then
  rustup target add wasm32-unknown-unknown --toolchain "$RUST_TOOLCHAIN_VERSION"
fi

installed_wasm_pack_version="$(wasm-pack --version 2>/dev/null || true)"
if [[ "$installed_wasm_pack_version" != "wasm-pack $WASM_PACK_VERSION" ]]; then
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

if [[ "$(wasm-pack --version)" != "wasm-pack $WASM_PACK_VERSION" ]]; then
  echo "Failed to activate wasm-pack $WASM_PACK_VERSION" >&2
  exit 1
fi

cd "$REPO_ROOT/wasm"
wasm-pack build --target web --out-dir pkg --release
printf '%s\n' "$wasm_hash" > pkg/.source-hash
