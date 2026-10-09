import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_WASM_MODULE_URLS, WASM64_MODULE_URLS, loadWasmJsModule } from "../shared.js";

test("renderer variants use separate packaged and development paths", () => {
  assert.match(DEFAULT_WASM_MODULE_URLS[0].pathname, /\/wasm\/wasm_gerber_processor\.js$/);
  assert.match(WASM64_MODULE_URLS[0].pathname, /\/wasm\/pkg64\/wasm_gerber_processor\.js$/);
  assert.match(WASM64_MODULE_URLS[1].pathname, /\/wasm\/pkg64\/wasm_gerber_processor\.js$/);
});

test("invalid variant rejects, custom module still takes precedence", async () => {
  await assert.rejects(loadWasmJsModule({ wasmVariant: "invalid" }), TypeError);
  const custom = {};
  assert.equal((await loadWasmJsModule({ wasmVariant: "wasm64", wasmModule: custom })).wasmModule, custom);
  const url = "data:text/javascript,export const custom = true";
  assert.equal((await loadWasmJsModule({ wasmVariant: "wasm64", wasmModuleUrl: url })).wasmModule.custom, true);
});

for (const [variant, urls, bits] of [["wasm32", DEFAULT_WASM_MODULE_URLS, 32], ["wasm64", WASM64_MODULE_URLS, 64]]) {
  test(`${variant} initializes the selected real binary`, async (t) => {
    if (!urls.some(url => existsSync(url))) return t.skip("WASM build required");
    const { wasmModule, wasmModuleUrl } = await loadWasmJsModule({ wasmVariant: variant });
    const bytes = await readFile(new URL("wasm_gerber_processor_bg.wasm", wasmModuleUrl));
    if (bits === 64 && !WebAssembly.validate(bytes)) return t.skip("Runtime lacks memory64 support");
    await wasmModule.default({ module_or_path: bytes });
    assert.equal(wasmModule.memory_address_bits(), bits);
    const defaultModule = bits === 32 ? await loadWasmJsModule({}) : null;
    if (defaultModule) assert.equal(defaultModule.wasmModule, wasmModule);
  });
}
