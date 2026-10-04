// Local-only large-input benchmark; never register this in CI/npm test.
// SR_SAMPLE=/path/to/memory64-test-pads-24M.gbr node --expose-gc scripts/benchmark-sr-picking.mjs <checkout> [repeat=31] [pkg]
// Owned typed arrays are transferred from a parse worker to a fresh main WASM.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const checkout = isMainThread ? resolve(process.argv[2]) : workerData.checkout;
const repeat = isMainThread ? Number(process.argv[3] ?? 31) : workerData.repeat;
const variant = isMainThread ? (process.argv[4] ?? 'pkg') : workerData.variant;
const sample = process.env.SR_SAMPLE;
assert.ok(sample, 'Set SR_SAMPLE to the 1000-pad, SRX155Y155 input file');
assert.ok(Number.isInteger(repeat) && repeat > 0 && repeat <= 155, 'repeat must be between 1 and 155');
function buffers(value, result = new Set()) {
  if (ArrayBuffer.isView(value)) result.add(value.buffer);
  else if (Array.isArray(value)) for (const item of value) buffers(item, result);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) buffers(item, result);
  return result;
}
async function load(directory, build) {
  const pkg = resolve(directory, 'wasm', build);
  const api = await import(pathToFileURL(resolve(pkg, 'wasm_gerber_processor.js')));
  const exports = await api.default({ module_or_path: readFileSync(resolve(pkg, 'wasm_gerber_processor_bg.wasm')) });
  return { api, exports };
}
if (!isMainThread) {
  const { api, exports } = await load(workerData.checkout, workerData.variant);
  const source = readFileSync(sample, 'utf8').replace('SRX155Y155', `SRX${workerData.repeat}Y${workerData.repeat}`);
  api.parse_gerber_layer_payload_with_options(source.replace(`SRX${workerData.repeat}Y${workerData.repeat}`, 'SRX2Y2'), 0, 0, true, 1);
  const start = performance.now();
  const payload = api.parse_gerber_layer_payload_with_options(source, 0, 0, true, 1);
  const parseMs = performance.now() - start;
  const featureCount = payload.interactionPayload.featureDescriptors.length;
  assert.equal(featureCount, 1000 * workerData.repeat ** 2);
  assert.equal(payload.renderPayload.sublayers.reduce((sum, layer) => sum + layer.circles.x.length, 0), featureCount);
  const interactionBuffers = buffers(payload.interactionPayload);
  const info = { parseMs, featureCount, workerWasmMiB: exports.memory.buffer.byteLength / 2 ** 20,
    interactionBytes: [...interactionBuffers].reduce((sum, b) => sum + b.byteLength, 0) };
  parentPort.postMessage({ payload, info }, [...buffers(payload)]);
} else {
  const worker = new Worker(new URL(import.meta.url), { workerData: { checkout, repeat, variant } });
  const exit = new Promise((done, reject) => worker.once('exit', code => code ? reject(new Error(`worker exit ${code}`)) : done()));
  const { payload, info } = await new Promise((done, reject) => {
    worker.once('message', done); worker.once('error', reject);
  });
  await exit;
  const { api, exports } = await load(checkout, variant);
  const processor = new api.GerberProcessor();
  try {
    processor.set_interactions_enabled(true);
    // Optional memory64 checkout policy; main has no reserve policy/module.
    const policyPath = resolve(checkout, 'js/core/wasm-variant.js');
    const policy = existsSync(policyPath) ? await import(pathToFileURL(policyPath)) : null;
    const reserveBytes = policy ? policy.getPickingIndexReserveBytes({ addressBits: api.memory_address_bits(),
      payloadBytes: info.interactionBytes, memoryBytes: exports.memory.buffer.byteLength }) : 0;
    const reserveStart = performance.now();
    if (reserveBytes) api.reserve_input_capacity(reserveBytes);
    const reserveMs = performance.now() - reserveStart;
    const start = performance.now();
    processor.add_interaction_payload(0, payload.interactionPayload);
    const importMs = performance.now() - start;
    assert.ok(processor.has_interaction_layer(0));
    const hit = processor.pick_interaction_feature(new Uint32Array([0]), repeat - 1 + 0.78, repeat - 1 + 0.48, 0);
    assert.ok(hit && hit.featureType === 'aperture-flash');
    assert.equal(hit.featureId, info.featureCount - 1);
    console.log(JSON.stringify({ checkout, repeat, variant, ...info, reserveMs, importMs,
      totalMs: info.parseMs + reserveMs + importMs,
      mainWasmMiB: exports.memory.buffer.byteLength / 2 ** 20,
      peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
  } finally {
    processor.free();
  }
}
