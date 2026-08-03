import test from "node:test";
import assert from "node:assert/strict";
import {
  createBenchmarkResult,
  installBrowserBenchmark,
} from "../js/performance/browser-benchmark.js";

test("benchmark installation is a safe no-op outside a browser", () => {
  assert.equal(installBrowserBenchmark({}, {}), null);
});

test("benchmark schema keeps unavailable GPU fields nullable", () => {
  const result = createBenchmarkResult({
    adapter: {
      getCanvas: () => ({ width: 100, height: 50 }),
      getLayers: () => [{ name: "board.gbr", sourceContent: "G04*", kind: "gerber" }],
      getBackend: () => "serial",
    },
    frameTimes: [10, 20, 30],
    cpuSamples: { layerGeometry: [], pathStencil: [], composite: [], submit: [] },
    gpu: null,
    startedAt: 0,
    durationMs: 1000,
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.backend, "serial");
  assert.equal(result.gpu.totalP95Ms, null);
  assert.equal(result.frame.p50Ms, 20);
  assert.equal(result.fixture.layers, 1);
});
