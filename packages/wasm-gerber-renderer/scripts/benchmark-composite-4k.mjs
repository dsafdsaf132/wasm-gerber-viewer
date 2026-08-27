import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import {
  evaluateCompositeBenchmark,
  getCompositeBenchmarkFailures,
} from "../../../scripts/composite-benchmark-contract.mjs";
import { classifyWebGlRenderer } from "../../../scripts/webgl-renderer-classification.mjs";

const require = createRequire(import.meta.url);
const wasmModuleUrl = new URL("../../../wasm/pkg/wasm_gerber_processor.js", import.meta.url);
const wasmBinaryUrl = new URL("../../../wasm/pkg/wasm_gerber_processor_bg.wasm", import.meta.url);
const wasm = await import(wasmModuleUrl.href);
wasm.initSync({ module: readFileSync(wasmBinaryUrl) });
const { createWebGLRenderingContext } = require("node-gles-webgl2");

const width = 3840;
const height = 2160;
const sourceCount = 24;
const gl = createWebGLRenderingContext({
  width,
  height,
  majorVersion: 3,
  minorVersion: 0,
  webGLCompatibility: true,
});
const processor = new wasm.GerberProcessor();

function describeBackend(context) {
  const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
  const vendor = String(
    context.getParameter(debugInfo?.UNMASKED_VENDOR_WEBGL ?? context.VENDOR) ??
      "unknown",
  );
  const renderer = String(
    context.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? context.RENDERER) ??
      "unknown",
  );
  return {
    backend: "node-gles-webgl2",
    webglVersion: String(context.getParameter(context.VERSION) ?? "unknown"),
    gpuVendor: vendor,
    gpuRenderer: renderer,
    ...classifyWebGlRenderer(vendor, renderer),
  };
}

function flashGerber(slot) {
  const x = String((slot - 12) * 20_000).padStart(6, "0");
  return `%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,40.000*%\nD10*\nX${x}Y000000D03*\nM02*`;
}

function milliseconds(value) {
  return Math.round(value * 100) / 100;
}

try {
  processor.init_with_size(gl, width, height);
  const sourceIds = [];
  for (let slot = 0; slot < sourceCount; slot += 1) {
    sourceIds.push(processor.add_layer(flashGerber(slot)));
  }
  const compositeId = processor.add_composite_preset_with_bounds(
    new Uint32Array(sourceIds),
    "union",
    false,
    -50,
    50,
    -30,
    30,
  );
  const sourceColors = new Float32Array(sourceCount * 4);
  sourceColors.fill(1);
  processor.render(
    new Uint32Array(sourceIds),
    sourceColors,
    0.018,
    0.032,
    0,
    0,
    1,
  );
  gl.finish();

  processor.release_composite_cache(compositeId);
  const selectionStart = performance.now();
  processor.render_composite_selection(compositeId, 0.018, 0.032, 0, 0);
  gl.finish();
  const selectionEntryMs = performance.now() - selectionStart;
  const selectionDiagnostics = processor.get_composite_diagnostics(compositeId);

  const code = 0xffffff;
  const byteIndex = code >>> 3;
  const toggleStart = performance.now();
  processor.set_composite_visible_byte(compositeId, byteIndex, 0x7f);
  processor.render_composite_selection(compositeId, 0.018, 0.032, 0, 0);
  gl.finish();
  const toggleMs = performance.now() - toggleStart;
  const diagnostics = processor.get_composite_diagnostics(compositeId);
  const contract = evaluateCompositeBenchmark({
    selectionMs: selectionEntryMs,
    toggleMs,
    encodePassCount: diagnostics.encodePassCount,
    selectionDiagnostics,
    toggleDiagnostics: diagnostics,
  });
  const failures = getCompositeBenchmarkFailures(contract.targets);
  const functionalFailures = getCompositeBenchmarkFailures(contract.targets, {
    enforceTiming: false,
  });
  const backend = describeBackend(gl);

  process.stdout.write(`${JSON.stringify({
    ...backend,
    benchmarkMode: "software-or-native-smoke",
    timingAcceptanceEligible: false,
    viewport: `${width}x${height}`,
    sourceCount,
    encodePassCount: diagnostics.encodePassCount,
    selectionEntryMs: milliseconds(selectionEntryMs),
    toggleMs: milliseconds(toggleMs),
    outputFormat: diagnostics.outputFormat,
    outlineFormat: diagnostics.outlineFormat,
    cpuBitsetBytes: diagnostics.cpuBitsetBytes,
    gpuLookupBytes: diagnostics.gpuLookupBytes,
    outputMaskBytes: diagnostics.outputMaskBytes,
    sharedMembershipBytes: diagnostics.sharedMembershipBytes,
    sharedOutlineBytes: diagnostics.sharedOutlineBytes,
    r8Fallback:
      diagnostics.outputFormat !== "R8" || diagnostics.outlineFormat !== "R8",
    outputR8Fallback: diagnostics.outputFormat !== "R8",
    outlineR8Fallback: diagnostics.outlineFormat !== "R8",
    ...contract,
    targetThresholdsMs: { selectionEntry: 500, toggle: 100 },
    targetsMet: failures.length === 0,
    functionalTargetsMet: functionalFailures.length === 0,
  }, null, 2)}\n`);
  if (functionalFailures.length > 0) {
    throw new Error(
      `Composite benchmark cache contract failed: ${functionalFailures.join(", ")}.`,
    );
  }
} finally {
  try {
    processor.clear();
  } finally {
    processor.free();
    gl.destroy();
  }
}
