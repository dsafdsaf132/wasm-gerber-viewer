const WASM_INPUT_RESERVE_MARGIN_BYTES = 1024 * 1024;

let wasmModulePromise = null;

function getUtf8ByteLength(value) {
  let bytes = 0;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

async function getWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = import("../wasm/pkg/wasm_gerber_processor.js").then(
      async (wasmModule) => {
        await wasmModule.default();
        wasmModule.init_panic_hook?.();
        return wasmModule;
      },
    );
  }

  return wasmModulePromise;
}

function reserveWasmInputCapacity(wasmModule, content) {
  if (typeof wasmModule.reserve_input_capacity !== "function") {
    return;
  }

  const byteLength = getUtf8ByteLength(content);
  wasmModule.reserve_input_capacity(byteLength + WASM_INPUT_RESERVE_MARGIN_BYTES);
}

function collectTransferables(value, transferables = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return transferables;
  }
  seen.add(value);

  if (ArrayBuffer.isView(value)) {
    if (value.buffer.byteLength > 0 && !transferables.includes(value.buffer)) {
      transferables.push(value.buffer);
    }
    return transferables;
  }

  if (value instanceof ArrayBuffer) {
    if (value.byteLength > 0 && !transferables.includes(value)) {
      transferables.push(value);
    }
    return transferables;
  }

  for (const child of Object.values(value)) {
    collectTransferables(child, transferables, seen);
  }

  return transferables;
}

self.addEventListener("message", async (event) => {
  const { id, offset = {} } = event.data ?? {};
  let content = event.data?.content;

  try {
    const wasmModule = await getWasmModule();
    reserveWasmInputCapacity(wasmModule, content);
    const parsedLayer = wasmModule.parse_gerber_layer(
      content,
      Number(offset.x ?? 0),
      Number(offset.y ?? 0),
    );
    self.postMessage(
      {
        id,
        ok: true,
        parsedLayer,
      },
      collectTransferables(parsedLayer),
    );
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: getErrorMessage(error),
    });
  } finally {
    content = null;
  }
});
