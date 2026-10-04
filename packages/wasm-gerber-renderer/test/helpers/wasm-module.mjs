// Loads the web-target WASM package built into `wasm/pkg` for tests that need
// the Rust side (for example the UNIX compress decoder used for ODB++ `.Z`
// files). Returns null when the package has not been built, so such tests can
// skip instead of failing on a source-only checkout.
import { existsSync, readFileSync } from "node:fs";

const PKG_DIR = new URL("../../../../wasm/pkg/", import.meta.url);
const WASM_PATH = new URL("wasm_gerber_processor_bg.wasm", PKG_DIR);
const JS_PATH = new URL("wasm_gerber_processor.js", PKG_DIR);

let modulePromise = null;

export function loadWasmModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      if (!existsSync(WASM_PATH) || !existsSync(JS_PATH)) return null;
      const wasmModule = await import(JS_PATH.href);
      await wasmModule.default({ module_or_path: readFileSync(WASM_PATH) });
      return wasmModule;
    })();
  }
  return modulePromise;
}

/** `decompressUnixZ` callback for the ODB++ job tree, or null without WASM. */
export async function loadUnixZDecoder() {
  const wasmModule = await loadWasmModule();
  if (!wasmModule || typeof wasmModule.decompress_unix_z !== "function") return null;
  return (bytes, maxOutputBytes) => wasmModule.decompress_unix_z(bytes, maxOutputBytes);
}
