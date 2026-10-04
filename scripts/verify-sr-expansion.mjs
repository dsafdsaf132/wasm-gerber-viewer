// Compare release WASM against the parent of the SR optimization.
// Usage: node scripts/verify-sr-expansion.mjs /absolute/baseline/checkout
// SR_FULL=1 additionally measures the original 24M-pad file with wasm64.
// Local-only: do not register this workload in CI or npm test.
// No browser/Playwright required. Each timing sample runs in a fresh process.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const sample = process.env.SR_SAMPLE ?? new URL('../demo/memory64-test-pads-24M.gbr', import.meta.url);
async function load(checkout, variant) {
  const pkg = resolve(checkout, 'wasm', variant);
  const api = await import(pathToFileURL(resolve(pkg, 'wasm_gerber_processor.js')));
  const exports = await api.default({ module_or_path: readFileSync(resolve(pkg, 'wasm_gerber_processor_bg.wasm')) });
  return { api, exports };
}
if (process.argv[2] === '--measure') {
  const [, , , checkout, variant, repeat, picking] = process.argv;
  const { api, exports } = await load(checkout, variant);
  const source = readFileSync(sample, 'utf8').replace('SRX155Y155', `SRX${repeat}Y${repeat}`);
  const parse = picking === 'on' ? api.parse_gerber_layer_payload_with_options : api.parse_gerber_layer_with_options;
  parse(source.replace(`SRX${repeat}Y${repeat}`, 'SRX2Y2'), 0, 0, true, 1);
  globalThis.gc?.();
  const start = performance.now();
  const payload = parse(source, 0, 0, true, 1);
  const elapsedMs = performance.now() - start;
  const render = picking === 'on' ? payload.renderPayload : payload;
  const count = render.sublayers.reduce((sum, layer) => sum + layer.circles.x.length, 0);
  assert.equal(count, 1000 * Number(repeat) ** 2);
  if (picking === 'on') assert.equal(payload.interactionPayload.featureDescriptors.length, count);
  console.log(JSON.stringify({ elapsedMs, count, wasmMiB: exports.memory.buffer.byteLength / 2 ** 20,
    peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
  process.exit(0);
}

const baseline = resolve(process.argv[2]);
const require = createRequire(import.meta.url);
const { createWebGLRenderingContext } = require('node-gles-webgl2');
function fixture(rotation, mirror, step) {
  return [
    '%FSLAX24Y24*%', '%MOMM*%',
    '%AMTHERM*7,0.3,-0.2,1.4,0.7,0.16,17*%',
    '%AMMIX*1,1,0.8,0.2,-0.1*7,0.3,-0.2,1.4,0.7,0.16,17*%',
    '%AMNEG*1,1,1.4,0,0*1,0,0.6,0.1,0*%',
    '%ADD10C,0.15*%', '%ADD11THERM*%', '%ADD12MIX*%', '%ADD13NEG*%',
    '%ADD14R,0.8X0.4*%', `%LR${rotation}*%`, `%LM${mirror}*%`, '%LS1.7*%',
    `%SRX3Y2I${step}J${step}*%`,
    'D11*', 'X0Y0D03*', 'D12*', 'X3000Y2000D03*',
    'D13*', 'X2000Y3000D03*', 'D14*', 'X1000Y2000D03*',
    // Straight and curved interpolation within the same SR block.
    'D10*', 'G01*', 'X-5000Y-3000D02*', 'X8000Y2000D01*',
    'G75*', 'X10000Y0D02*', 'G03X0Y10000I-10000J0D01*',
    '%LPC*%', 'D10*', 'X2000Y2000D03*', 'D11*', 'X0Y0D03*',
    '%LPD*%', 'D12*', 'X1000Y1000D03*', '%SR*%', 'M02*',
  ].join('\n');
}
function pixels(api, source, aa) {
  const size = 128;
  const gl = createWebGLRenderingContext({ width: size, height: size, majorVersion: 3,
    minorVersion: 0, webGLCompatibility: true });
  const processor = new api.GerberProcessor();
  try {
    processor.init_with_size(gl, size, size);
    processor.set_anti_aliasing(aa);
    const id = processor.add_layer(source);
    processor.render(new Uint32Array([id]), new Float32Array([1, 1, 1, 1]), 0.2, 0.2, -0.3, -0.3, 1);
    const output = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, output);
    assert.equal(gl.getError(), gl.NO_ERROR);
    assert.ok(output.some((value, index) => index % 4 === 3 && value > 0), 'empty raster');
    return output;
  } finally {
    processor.free();
    gl.destroy();
  }
}
for (const variant of ['pkg', 'pkg64']) {
  const old = await load(baseline, variant);
  const current = await load(root, variant);
  let cases = 0;
  let rasterCases = 0;
  let pickComparisons = 0;
  for (const rotation of [0, 21, 90, 180, -35]) {
    for (const mirror of ['N', 'X', 'Y', 'XY']) {
      for (const step of [3, 0.15, 0]) {
        const source = fixture(rotation, mirror, step);
        const currentPayload = current.api.parse_gerber_layer_payload_with_options(source, 0, 0, true, 1);
        const oldPayload = old.api.parse_gerber_layer_payload_with_options(source, 0, 0, true, 1);
        assert.deepEqual(currentPayload, oldPayload,
          `${variant} rotation=${rotation} mirror=${mirror} step=${step}`);
        const currentProcessor = new current.api.GerberProcessor();
        const oldProcessor = new old.api.GerberProcessor();
        try {
          currentProcessor.set_interactions_enabled(true);
          oldProcessor.set_interactions_enabled(true);
          currentProcessor.add_interaction_payload(0, currentPayload.interactionPayload);
          oldProcessor.add_interaction_payload(0, oldPayload.interactionPayload);
          const ids = new Uint32Array([0]);
          for (let x = -2; x <= 6; x += 0.5) for (let y = -2; y <= 6; y += 0.5) {
            assert.deepEqual(currentProcessor.pick_interaction_feature(ids, x, y, 0),
              oldProcessor.pick_interaction_feature(ids, x, y, 0),
              `imported pick ${variant} rotation=${rotation} mirror=${mirror} step=${step} x=${x} y=${y}`);
            pickComparisons++;
          }
        } finally {
          currentProcessor.free();
          oldProcessor.free();
        }
        cases++;
        // Render overlapping/coincident cases for every transform, AA off/on.
        if (step !== 3) for (const aa of [false, true]) {
          assert.deepEqual(pixels(current.api, source, aa), pixels(old.api, source, aa),
            `raster ${variant} rotation=${rotation} mirror=${mirror} step=${step} aa=${aa}`);
          rasterCases++;
        }
      }
    }
  }
  console.log(JSON.stringify({ variant, payloadCases: cases, rasterCases, pickComparisons, differingBytes: 0 }));
}
const rounds = Number(process.env.SR_ROUNDS ?? 5);
for (const variant of ['pkg', 'pkg64']) {
  for (const picking of ['off', 'on']) {
    const results = { baseline: [], current: [] };
    for (let round = 0; round < rounds; round++) {
      // Alternate order to avoid consistently favoring the second build.
      for (const label of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url),
          '--measure', label === 'baseline' ? baseline : root, variant, '31', picking],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 });
        assert.equal(child.status, 0, child.stderr);
        results[label].push(JSON.parse(child.stdout.trim()));
      }
    }
    console.log(JSON.stringify({ variant, picking, repeat: 31, results }));
  }
}
if (process.env.SR_FULL === '1') {
  const fullRounds = Number(process.env.SR_FULL_ROUNDS ?? 3);
  for (let round = 0; round < fullRounds; round++) {
    for (const picking of ['off', 'on']) {
      for (const label of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url),
          '--measure', label === 'baseline' ? baseline : root, 'pkg64', '155', picking],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 });
        assert.equal(child.status, 0, child.stderr);
        console.log(JSON.stringify({ full: true, round, label, picking, result: JSON.parse(child.stdout.trim()) }));
      }
    }
  }
}
