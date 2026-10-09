import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { applyProcessorOptions, createBaseFrameOptions } from "../shared.js";
import { ViewerOptionsStore } from "../../../js/ui/viewer-options.js";
import { GerberViewer } from "../../../js/core/viewer.js";
import { ScreenshotExporter } from "../../../js/rendering/screenshot-exporter.js";

test("viewer disables unsupported counts and refreshes saved settings", () => {
  const viewer = Object.create(GerberViewer.prototype);
  viewer.viewerOptionsStore = new ViewerOptionsStore({ getItem: () => null, setItem() {} });
  viewer.antiAliasing = true;
  viewer.msaaSamples = 16;
  let stencilSamples = [8, 4, 2, 1];
  viewer.gl = {
    RENDERBUFFER: 1, R8: 2, STENCIL_INDEX8: 3, SAMPLES: 4,
    getInternalformatParameter: (_target, format) =>
      new Int32Array(format === 2 ? [16, 8, 4, 2] : stencilSamples),
  };
  viewer.refreshMsaaSupport();
  assert.deepEqual(viewer.supportedMsaaSamples, [4, 8]);
  assert.equal(viewer.msaaSamples, 8);
  assert.equal(viewer.viewerOptionsStore.get("msaaSamples"), 8);
  for (const [value, unsupported] of [["off", false], ["on", false], ["8", false], ["16", true]]) {
    assert.equal(viewer.isAntiAliasingInputUnsupported({ value }), unsupported);
  }
  stencilSamples = [2, 1];
  viewer.refreshMsaaSupport();
  assert.equal(viewer.antiAliasing, false);
  assert.deepEqual(viewer.supportedMsaaSamples, []);
});

test("stream replacement pins internal x2 without broadening public sample options", () => {
  const source = readFileSync(new URL("../node.js", import.meta.url), "utf8");
  const start = source.indexOf("function planForReplacementProcessor(");
  const end = source.indexOf("function disposeStreamRenderState(", start);
  const { replace, apply } = new Function("applyProcessorOptions",
    `${source.slice(start, end)}; return { replace: planForReplacementProcessor, apply: applyPlanProcessorOptions };`,
  )(applyProcessorOptions);
  const plan = replace({ antiAliasing: true, msaaSamples: 16 }, "multisampled:2");
  const calls = [];
  apply({ set_anti_aliasing() {}, set_msaa_samples: (samples) => calls.push(samples) }, plan);
  assert.deepEqual(calls, [16, 2]);
  assert.throws(() => createBaseFrameOptions({ msaaSamples: 2 }), /msaaSamples/);
});

test("MSAA options preserve boolean compatibility and validate sample counts", () => {
  assert.equal(createBaseFrameOptions().msaaSamples, 4);
  assert.equal(createBaseFrameOptions({ antiAliasing: true }).msaaSamples, 4);
  for (const msaaSamples of [4, 8, 16]) {
    const options = createBaseFrameOptions({ antiAliasing: true, msaaSamples });
    const calls = [];
    applyProcessorOptions({
      set_anti_aliasing: (value) => calls.push(value),
      set_msaa_samples: (value) => calls.push(value),
    }, options);
    assert.deepEqual(calls, [true, msaaSamples]);
  }
  for (const msaaSamples of [null, 0, 2, 12, 32, "8", NaN]) {
    assert.throws(() => createBaseFrameOptions({ msaaSamples }), /msaaSamples/);
  }
  applyProcessorOptions({ set_anti_aliasing() {} }, { antiAliasing: true });
  assert.throws(() => applyProcessorOptions({ set_anti_aliasing() {} }, {
    antiAliasing: true, msaaSamples: 8,
  }), /updated WASM/);
});

test("viewer stores MSAA counts and migrates old boolean settings to x4", () => {
  let stored = JSON.stringify({ antiAliasing: true });
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  const store = new ViewerOptionsStore(storage);
  assert.equal(store.get("msaaSamples"), 4);
  assert.equal(store.get("antiAliasing"), true);
  store.set("msaaSamples", 16);
  assert.equal(new ViewerOptionsStore(storage).get("msaaSamples"), 16);
  stored = JSON.stringify({ msaaSamples: 12 });
  assert.equal(new ViewerOptionsStore(storage).get("msaaSamples"), 4);
});

test("viewer applies count changes while enabled and rolls failed changes back", () => {
  const viewer = Object.create(GerberViewer.prototype);
  viewer.antiAliasing = true;
  viewer.msaaSamples = 4;
  viewer.isRendererBusy = () => false;
  viewer.syncOptionControls = () => {};
  viewer.updateUiState = () => {};
  viewer.configureWasmProcessorOptions = () => {};
  viewer.showError = () => {};
  viewer.viewerOptionsStore = new ViewerOptionsStore({ getItem: () => null, setItem() {} });
  let renders = 0;
  const calls = [];
  viewer.requestRender = () => { renders++; };
  viewer.wasmProcessor = { set_anti_aliasing() {}, set_msaa_samples: (value) => calls.push(value) };
  viewer.setAntiAliasing(true, 8);
  viewer.setAntiAliasing(true, 8);
  assert.deepEqual(calls, [8]);
  assert.equal(renders, 1);
  viewer.setAntiAliasing(false);
  assert.equal(viewer.msaaSamples, 8);
  viewer.wasmProcessor.set_msaa_samples = () => { throw new Error("failure"); };
  viewer.setAntiAliasing(true, 16);
  assert.equal(viewer.antiAliasing, false);
  assert.equal(viewer.msaaSamples, 8);
  assert.equal(viewer.viewerOptionsStore.get("msaaSamples"), 8);
});

test("screenshot tile budgeting grows with the requested sample count", () => {
  const exporter = Object.create(ScreenshotExporter.prototype);
  exporter.canvas = { getBoundingClientRect: () => ({ width: 10000, height: 10000 }) };
  exporter.getMaxDimension = () => 16384;
  exporter.getPngRowStride = (width) => width * 4 + 1;
  exporter.getMemoryLimitMessage = () => "budget exceeded";
  const heights = [];
  for (const msaaSamples of [4, 8, 16]) {
    exporter.getRenderOptions = () => ({ antiAliasing: true, msaaSamples });
    heights.push(exporter.getStreamTileDimensions(16384, 16384, 1).height);
  }
  assert.ok(heights[0] > heights[1]);
  assert.ok(heights[1] > heights[2]);
});
