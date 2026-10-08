import {
  WASM_VARIANT_32,
  isMemoryExhaustionError,
  loadWasmPackage,
} from "../core/wasm-variant.js";

const WASM_INPUT_RESERVE_MARGIN_BYTES = 1024 * 1024;
// The parser reports many times a second on a large layer; the loading modal
// needs a few updates a second.
const PROGRESS_POST_INTERVAL_MS = 100;

let wasmModulePromise = null;
let wasmModuleVariant = null;
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

// A worker serves one build for its whole life; the pool creates a separate
// worker for the memory64 retry.
async function getWasmModule(variant = WASM_VARIANT_32) {
  if (wasmModulePromise && wasmModuleVariant !== variant) {
    throw new Error(
      `Parse worker already loaded the ${wasmModuleVariant} build, not ${variant}`,
    );
  }
  if (!wasmModulePromise) {
    wasmModuleVariant = variant;
    wasmModulePromise = loadWasmPackage(variant).then((loaded) => {
      wasmExports = loaded.wasmExports;
      return loaded.wasmModule;
    });
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

/**
 * Callback for the parser's progress reports. It posts `{ id, progress }`
 * messages while the parse runs: the first and last report of every stage,
 * and in between at most one every PROGRESS_POST_INTERVAL_MS.
 */
function createProgressPoster(id) {
  let lastStage = null;
  let lastPostedAt = -Infinity;
  return (stage, done, total) => {
    const now = performance.now();
    if (
      stage === lastStage &&
      done < total &&
      now - lastPostedAt < PROGRESS_POST_INTERVAL_MS
    ) {
      return;
    }
    lastStage = stage;
    lastPostedAt = now;
    self.postMessage({ id, progress: { stage, done, total } });
  };
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
    kind = "gerber",
    preserveArcRegions = true,
    arcTessellationQuality = 1,
    interactionsEnabled = false,
    wasmVariant = WASM_VARIANT_32,
  } = event.data ?? {};
  let content = event.data?.content;
  let beforeBytes = null;

  try {
    const wasmModule = await getWasmModule(wasmVariant);
    if (typeof wasmModule.parse_gerber_layer !== "function") {
      throw new Error("Parse worker API unavailable: parse_gerber_layer is missing");
    }
    beforeBytes = getWorkerWasmMemoryBytes();
    reserveWasmInputCapacity(wasmModule, content);
    const normalizedQuality = Number(arcTessellationQuality ?? 1);
    const offsetX = Number(offset.x ?? 0);
    const offsetY = Number(offset.y ?? 0);

    const supportsProgress =
      typeof wasmModule.parse_gerber_layer_payload_with_progress === "function";
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
    const returnsPayload =
      kind !== "drill" && (supportsProgress || supportsInteractionPayload);
    const parseLayer = () => {
      if (kind === "drill") {
        if (typeof wasmModule.parse_drill_layer_payload !== "function") {
          throw new Error("Parse worker API unavailable: parse_drill_layer_payload is missing");
        }
        return wasmModule.parse_drill_layer_payload(
          content,
          offsetX,
          offsetY,
          Boolean(interactionsEnabled),
        );
      }
      if (supportsProgress) {
        return wasmModule.parse_gerber_layer_payload_with_progress(
          content,
          offsetX,
          offsetY,
          Boolean(preserveArcRegions),
          normalizedQuality,
          Boolean(interactionsEnabled),
          createProgressPoster(id),
        );
      }
      if (supportsInteractionPayload) {
        return wasmModule.parse_gerber_layer_payload_with_options(
          content,
          offsetX,
          offsetY,
          Boolean(preserveArcRegions),
          normalizedQuality,
        );
      }
      if (typeof wasmModule.parse_gerber_layer_with_options === "function") {
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
      if (!preserveArcRegions) {
        throw new Error(
          "Parse worker requires an updated WASM module for region arc options",
        );
      }
      return wasmModule.parse_gerber_layer(content, offsetX, offsetY);
    };
    const parsedResult = parseLayer();
    const parsedLayer = returnsPayload
      ? parsedResult.renderPayload
      : parsedResult;
    const interactionPayload =
      returnsPayload || kind === "drill"
        ? (parsedResult.interactionPayload ?? null)
        : null;
    if (kind === "drill") delete parsedLayer.interactionPayload;
    const transferables = collectTransferables({
      parsedLayer,
      interactionPayload,
    });
    // ODB++ layers report what they skipped or approximated after the parse.
    const odbDiagnostics =
      typeof wasmModule.take_last_odb_diagnostics === "function"
        ? (wasmModule.take_last_odb_diagnostics() ?? null)
        : null;
    self.postMessage(
      {
        id,
        ok: true,
        parsedLayer,
        interactionPayload,
        odbDiagnostics,
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
      memoryExhausted: isMemoryExhaustionError(error, errorMessage),
      trapped:
        typeof WebAssembly !== "undefined" &&
        error instanceof WebAssembly.RuntimeError,
      // The Err values this crate creates reach JS as strings, thrown after
      // the call has returned normally. Any other thrown value (a trap from a
      // panic or a failed allocation, a stack overflow, an exception thrown
      // through the module) is taken as a call left part-way, without
      // unwinding its stack or running destructors.
      instanceIntact: typeof error === "string",
      workerMemory: {
        beforeBytes,
        afterBytes: getWorkerWasmMemoryBytes(),
      },
    });
  } finally {
    content = null;
  }
});
