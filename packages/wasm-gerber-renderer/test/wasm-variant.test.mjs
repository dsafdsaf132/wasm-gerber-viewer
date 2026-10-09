import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { supportsMemory64 } from "../../../js/core/wasm-variant.js";
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

test("module load errors recommend the selected variant's build command", async () => {
  const { createNodeGerberRenderer } = await import("../node.js");
  const wasmModuleUrl = "data:text/javascript,throw new Error('forced module load failure')";
  for (const [wasmVariant, command] of [["wasm32", "build:wasm"], ["wasm64", "build:wasm64"]]) {
    for (const load of [loadWasmJsModule, createNodeGerberRenderer]) {
      await assert.rejects(load({ wasmVariant, wasmModuleUrl }), (error) => {
        assert.ok(error.message.includes(`npm run ${command} before`));
        return true;
      });
    }
  }
});

for (const [variant, urls, bits] of [["wasm32", DEFAULT_WASM_MODULE_URLS, 32], ["wasm64", WASM64_MODULE_URLS, 64]]) {
  test(`${variant} initializes the selected real binary`, async (t) => {
    if (!urls.some(url => existsSync(url))) return t.skip("WASM build required");
    if (bits === 64 && !supportsMemory64()) return t.skip("Runtime lacks memory64 support");
    const { wasmModule, wasmModuleUrl } = await loadWasmJsModule({ wasmVariant: variant });
    const bytes = await readFile(new URL("wasm_gerber_processor_bg.wasm", wasmModuleUrl));
    assert.ok(WebAssembly.validate(bytes), `${variant} binary must be valid on a supported runtime`);
    await wasmModule.default({ module_or_path: bytes });
    assert.equal(wasmModule.memory_address_bits(), bits);
    const defaultModule = bits === 32 ? await loadWasmJsModule({}) : null;
    if (defaultModule) assert.equal(defaultModule.wasmModule, wasmModule);
  });
}
