const WASM_INPUT_RESERVE_MARGIN_BYTES = 1024 * 1024;

let wasmModulePromise = null;
let wasmExports = null;

function getWorkerWasmMemoryBytes() {
  const wasmMemoryBytes = Number(wasmExports?.memory?.buffer?.byteLength);
  return Number.isFinite(wasmMemoryBytes) ? wasmMemoryBytes : null;
}

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

function isWorkerUnavailableErrorMessage(message) {
  const normalizedMessage = String(message ?? "").toLowerCase();
  return (
    normalizedMessage.includes("parse_gerber_layer") ||
    normalizedMessage.includes("parse worker api") ||
    normalizedMessage.includes("parse worker requires an updated wasm module") ||
    normalizedMessage.includes("failed to fetch dynamically imported module") ||
    normalizedMessage.includes("wasm_gerber_processor")
  );
}

async function getWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = import("../wasm/pkg/wasm_gerber_processor.js").then(
      async (wasmModule) => {
        wasmExports = await wasmModule.default();
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
  const {
    id,
    offset = {},
    preserveArcRegions = true,
    arcTessellationQuality = 1,
    interactionsEnabled = false,
  } = event.data ?? {};
  let content = event.data?.content;
  let beforeBytes = null;

  try {
    const wasmModule = await getWasmModule();
    if (typeof wasmModule.parse_gerber_layer !== "function") {
      throw new Error("Parse worker API unavailable: parse_gerber_layer is missing");
    }
    beforeBytes = getWorkerWasmMemoryBytes();
    reserveWasmInputCapacity(wasmModule, content);
    const normalizedQuality = Number(arcTessellationQuality ?? 1);
    const offsetX = Number(offset.x ?? 0);
    const offsetY = Number(offset.y ?? 0);

    const supportsInteractionPayload =
      interactionsEnabled &&
      typeof wasmModule.parse_gerber_layer_payload_with_options === "function";
    if (
      interactionsEnabled &&
      typeof wasmModule.parse_gerber_layer_payload_with_options !== "function"
    ) {
      throw new Error(
        "Parse worker API unavailable: parse_gerber_layer_payload_with_options is missing",
      );
    }
    const supportsArcQuality =
      typeof wasmModule.parse_gerber_layer_with_options === "function" &&
      wasmModule.parse_gerber_layer_with_options.length >= 5;
    const parseLayer = supportsInteractionPayload
      ? () =>
          wasmModule.parse_gerber_layer_payload_with_options(
            content,
            offsetX,
            offsetY,
            Boolean(preserveArcRegions),
            normalizedQuality,
          )
      : typeof wasmModule.parse_gerber_layer_with_options === "function"
        ? () => {
            if (
              !supportsArcQuality &&
              !preserveArcRegions &&
              normalizedQuality !== 1
            ) {
              throw new Error(
                "Parse worker requires an updated WASM module for arc tessellation quality",
              );
            }
            return wasmModule.parse_gerber_layer_with_options(
              content,
              offsetX,
              offsetY,
              Boolean(preserveArcRegions),
              normalizedQuality,
            );
          }
        : () => {
            if (!preserveArcRegions) {
              throw new Error(
                "Parse worker requires an updated WASM module for region arc options",
              );
            }
            return wasmModule.parse_gerber_layer(content, offsetX, offsetY);
          };
    const parsedResult = parseLayer();
    const parsedLayer = supportsInteractionPayload
      ? parsedResult.renderPayload
      : parsedResult;
    const interactionPayload = supportsInteractionPayload
      ? parsedResult.interactionPayload
      : null;
    const transferables = collectTransferables({
      parsedLayer,
      interactionPayload,
    });
    self.postMessage(
      {
        id,
        ok: true,
        parsedLayer,
        interactionPayload,
        workerMemory: {
          beforeBytes,
          afterBytes: getWorkerWasmMemoryBytes(),
        },
      },
      transferables,
    );
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    self.postMessage({
      id,
      ok: false,
      error: errorMessage,
      workerUnavailable: isWorkerUnavailableErrorMessage(errorMessage),
      workerMemory: {
        beforeBytes,
        afterBytes: getWorkerWasmMemoryBytes(),
      },
    });
  } finally {
    content = null;
  }
});
