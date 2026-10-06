// Local parser-only comparison; no browser, renderer, or CI timing gate.
// Build both checkouts with identical flags, then:
// node scripts/benchmark-parser-fields.mjs <baseline> <candidate> [pkg|pkg64] [rounds=15]
// PARSER_BENCH_CASES=arc_regions selects individual cases for repeat measurements.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

function sources() {
  const header = '%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\n';
  let flashes = header;
  let lines = header + 'X0Y0D02*\n';
  for (let i = 0; i < 200_000; i++) {
    const x = (i % 1000) * 1000;
    const y = Math.floor(i / 1000) * 1000;
    flashes += `X${x}Y${y}D03*\n`;
    lines += `X${x}Y${y}D01*\n`;
  }
  let regions = header + 'G75*\n';
  for (let i = 0; i < 10_000; i++) {
    const x = (i % 100) * 30_000;
    const y = Math.floor(i / 100) * 30_000;
    regions += `G36*\nX${x + 10_000}Y${y}D02*\nG03*\nX${x - 10_000}Y${y}I-10000J0D01*\nG01*\nX${x + 10_000}Y${y}D01*\nG37*\n`;
  }
  let repeated = header + '%SRX31Y31I1J1*%\n';
  for (let i = 0; i < 250; i++) repeated += `X${i * 20}Y0D03*\n`;
  return { flashes: flashes + 'M02*', lines: lines + 'M02*',
    arc_regions: regions + 'M02*', sr_flashes: repeated + '%SR*%\nM02*' };
}

// Check output equivalence outside the timed region, including typed-array data.
function digest(value, hash = createHash('sha256')) {
  if (ArrayBuffer.isView(value)) {
    hash.update(value.constructor.name);
    hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  } else if (Array.isArray(value)) {
    hash.update(`array:${value.length};`);
    for (const entry of value) digest(entry, hash);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      hash.update(key);
      digest(value[key], hash);
    }
  } else hash.update(JSON.stringify(value) ?? 'undefined');
  return hash;
}

if (isMainThread) {
  const baseline = resolve(process.argv[2]);
  const candidate = resolve(process.argv[3]);
  const variant = process.argv[4] ?? 'pkg';
  const rounds = Number(process.argv[5] ?? 15);
  assert.ok(['pkg', 'pkg64'].includes(variant));
  assert.ok(Number.isInteger(rounds) && rounds >= 5);
  const names = process.env.PARSER_BENCH_CASES?.split(',') ?? ['flashes', 'lines', 'arc_regions', 'sr_flashes'];
  for (const name of names) {
    assert.ok(['flashes', 'lines', 'arc_regions', 'sr_flashes'].includes(name));
    for (const interactions of [false, true]) {
      const result = await new Promise((done, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { baseline, candidate, variant, rounds, name, interactions },
        });
        worker.once('message', done);
        worker.once('error', reject);
        worker.once('exit', code => { if (code) reject(new Error(`worker exit ${code}`)); });
      });
      console.log(JSON.stringify(result));
    }
  }
} else {
  const { baseline, candidate, variant, rounds, name, interactions } = workerData;
  const source = sources()[name];
  const modules = [];
  for (const checkout of [baseline, candidate]) {
    const pkg = resolve(checkout, 'wasm', variant);
    const api = await import(pathToFileURL(resolve(pkg, 'wasm_gerber_processor.js')));
    const exports = await api.default({ module_or_path: readFileSync(resolve(pkg, 'wasm_gerber_processor_bg.wasm')) });
    modules.push({ api, exports });
  }
  const parse = ({ api }) => interactions
    ? api.parse_gerber_layer_payload_with_options(source, 0, 0, true, 1)
    : api.parse_gerber_layer_with_options(source, 0, 0, true, 1);
  assert.equal(digest(parse(modules[0])).digest('hex'), digest(parse(modules[1])).digest('hex'));
  for (let i = 0; i < 5; i++) for (const module of modules) parse(module);
  const times = [[], []];
  for (let round = 0; round < rounds; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      const result = parse(modules[index]);
      times[index].push(performance.now() - start);
      assert.ok(result);
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const baselineMs = median(times[0]);
  const candidateMs = median(times[1]);
  parentPort.postMessage({ variant, name, interactions, rounds, baselineMs, candidateMs,
    changePercent: (candidateMs / baselineMs - 1) * 100,
    baselineWasmMiB: modules[0].exports.memory.buffer.byteLength / 2 ** 20,
    candidateWasmMiB: modules[1].exports.memory.buffer.byteLength / 2 ** 20,
    times, outputEqual: true });
}
