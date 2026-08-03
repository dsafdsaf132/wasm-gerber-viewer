const FRAME_BUDGET_MS = 1000 / 60;

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower] || 0) * fraction;
}

function finiteOrNull(value) {
  return value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function hashFixture(layers) {
  let hash = 0x811c9dc5;
  for (const layer of layers ?? []) {
    const value = `${layer.name ?? ""}\0${layer.kind ?? ""}\0${layer.sourceContent ?? ""}`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createBenchmarkResult({ adapter, frameTimes, cpuSamples, gpu, startedAt, durationMs,
  memoryHighWater = null }) {
  const canvas = adapter.getCanvas?.();
  const layers = adapter.getLayers?.() ?? [];
  return {
    schemaVersion: 1,
    timestamp: new Date(startedAt).toISOString(),
    build: { commit: adapter.getBuildCommit?.() ?? null },
    backend: adapter.getBackend?.() ?? "serial",
    browser: {
      userAgent: globalThis.navigator?.userAgent ?? null,
      platform: globalThis.navigator?.platform ?? null,
      hardwareConcurrency: finiteOrNull(globalThis.navigator?.hardwareConcurrency),
      deviceMemoryGiB: finiteOrNull(globalThis.navigator?.deviceMemory),
    },
    display: {
      dpr: finiteOrNull(globalThis.devicePixelRatio),
      canvasWidth: canvas?.width ?? null,
      canvasHeight: canvas?.height ?? null,
    },
    fixture: { name: adapter.getFixtureName?.() ?? "current", hash: hashFixture(layers), layers: layers.length },
    trace: { durationMs, frames: frameTimes.length },
    frame: {
      p50Ms: percentile(frameTimes, 0.5), p95Ms: percentile(frameTimes, 0.95),
      p99Ms: percentile(frameTimes, 0.99),
      overBudgetRatio: frameTimes.length ? frameTimes.filter((time) => time > FRAME_BUDGET_MS).length / frameTimes.length : null,
    },
    cpu: {
      layerGeometryP95Ms: percentile(cpuSamples.layerGeometry, 0.95),
      pathStencilP95Ms: percentile(cpuSamples.pathStencil, 0.95),
      compositeP95Ms: percentile(cpuSamples.composite, 0.95),
      submitP95Ms: percentile(cpuSamples.submit, 0.95),
    },
    gpu: gpu ?? { supported: false, layerGeometryP95Ms: null, pathStencilP95Ms: null, compositeP95Ms: null, totalP95Ms: null },
    counters: adapter.getProfilingCounters?.() ?? { drawCalls: null, stateChanges: null },
    memoryHighWater: memoryHighWater ?? adapter.getMemoryHighWater?.() ??
      { wasmBytes: null, jsBytes: null, gpuBytes: null },
  };
}

function createGpuTimer(gl) {
  const extension = gl?.getExtension?.("EXT_disjoint_timer_query_webgl2");
  if (!extension) return null;
  const pending = [];
  const samples = [];
  return {
    begin() {
      if (pending.some((item) => item.active)) return null;
      const query = gl.createQuery();
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      const item = { query, active: true };
      pending.push(item);
      return item;
    },
    end(item) {
      if (!item) return;
      gl.endQuery(extension.TIME_ELAPSED_EXT);
      item.active = false;
    },
    poll() {
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const item = pending[index];
        if (!gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE)) continue;
        if (!gl.getParameter(extension.GPU_DISJOINT_EXT)) {
          samples.push(gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6);
        }
        gl.deleteQuery(item.query);
        pending.splice(index, 1);
      }
    },
    result() {
      this.poll();
      return { supported: true, layerGeometryP95Ms: null, pathStencilP95Ms: null,
        compositeP95Ms: null, totalP95Ms: percentile(samples, 0.95) };
    },
  };
}

function animationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export function installBrowserBenchmark(adapter, target = globalThis) {
  if (!target?.window || typeof target.requestAnimationFrame !== "function") return null;
  let latest = null;
  let controller = null;

  async function runCurrent(options = {}) {
    controller?.abort();
    controller = new AbortController();
    const signal = options.signal ?? controller.signal;
    const durationMs = Math.max(250, Number(options.durationMs ?? 10000));
    const original = adapter.captureState();
    const frameTimes = [];
    const cpuSamples = { layerGeometry: [], pathStencil: [], composite: [], submit: [] };
    const gpuTimer = createGpuTimer(adapter.getGl?.());
    const startedAt = Date.now();
    const performanceStartedAt = performance.now();
    let previous = performance.now();
    let previousCounters = adapter.getProfilingCounters?.() ?? {};
    const memoryHighWater = { wasmBytes: null, jsBytes: null, gpuBytes: null };
    try {
      while (performance.now() - performanceStartedAt < durationMs) {
        if (signal.aborted) throw new DOMException("Benchmark cancelled", "AbortError");
        const elapsed = Date.now() - startedAt;
        const phase = elapsed / 1000;
        adapter.applyTraceCamera({ zoom: original.camera.zoom * (1 + 0.12 * Math.sin(phase * 1.7)),
          offsetX: original.camera.offsetX + Math.sin(phase * 2.1) * 20,
          offsetY: original.camera.offsetY + Math.cos(phase * 1.3) * 20 });
        const query = gpuTimer?.begin();
        adapter.renderExact();
        gpuTimer?.end(query);
        await animationFrame();
        const now = performance.now();
        frameTimes.push(now - previous);
        previous = now;
        gpuTimer?.poll();
        const counters = adapter.getProfilingCounters?.() ?? {};
        for (const [key, field] of [["layerGeometry", "layerGeometryMs"], ["pathStencil", "pathStencilMs"],
          ["composite", "compositeMs"], ["submit", "submitMs"]]) {
          const delta = Number(counters[field]) - Number(previousCounters[field]);
          if (Number.isFinite(delta) && delta >= 0) cpuSamples[key].push(delta);
        }
        previousCounters = counters;
        const memory = adapter.getMemoryHighWater?.() ?? {};
        for (const field of Object.keys(memoryHighWater)) {
          const value = finiteOrNull(memory[field]);
          if (value !== null) memoryHighWater[field] = Math.max(memoryHighWater[field] ?? 0, value);
        }
      }
      latest = createBenchmarkResult({ adapter, frameTimes, cpuSamples,
        gpu: gpuTimer?.result(), startedAt, durationMs, memoryHighWater });
      return latest;
    } finally {
      adapter.restoreState(original);
      adapter.renderExact();
    }
  }

  async function runSuite(options = {}) {
    const fixtures = options.fixtures ?? [];
    const results = [];
    for (const fixture of fixtures) {
      await adapter.loadFixture?.(fixture);
      results.push(await runCurrent({ ...options, fixtures: undefined }));
    }
    latest = { schemaVersion: 1, type: "suite", results };
    return latest;
  }

  const api = {
    runCurrent, runSuite, snapshot: () => latest,
    print() {
      const rows = latest?.results ?? (latest ? [latest] : []);
      console.table(rows.map((result) => ({ fixture: result.fixture?.name, backend: result.backend,
        p50: result.frame?.p50Ms, p95: result.frame?.p95Ms, p99: result.frame?.p99Ms,
        over16_7: result.frame?.overBudgetRatio, gpuP95: result.gpu?.totalP95Ms })));
      return latest;
    },
    cancel: () => controller?.abort(),
  };
  target.window.__gerberBenchmark = api;
  return api;
}
