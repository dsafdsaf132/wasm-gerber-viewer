import test from "node:test";
import assert from "node:assert/strict";
import {
  SerialRenderBackend,
  createCameraMailbox,
  createRenderBackend,
  detectThreadedCapabilities,
  normalizeExecutionBackend,
} from "../js/rendering/render-backend.js";
import { selectThreadedCapabilityProfile } from "../js/rendering/capability-profile.js";

test("threaded capability detection is safely disabled in headless environments", () => {
  const result = detectThreadedCapabilities(null, {});
  assert.equal(result.threadedSupported, false);
});

test("execution backend values are validated", () => {
  assert.equal(normalizeExecutionBackend(), "auto");
  assert.throws(() => normalizeExecutionBackend("gpu"), TypeError);
});

test("camera mailbox returns a coherent latest camera", () => {
  const mailbox = createCameraMailbox(globalThis);
  mailbox.write({ zoomX: 2, zoomY: 3, offsetX: 4, offsetY: 5, flipX: true });
  assert.deepEqual(mailbox.read(), {
    sequence: 2,
    zoomX: 2,
    zoomY: 3,
    offsetX: 4,
    offsetY: 5,
    flipX: true,
    flipY: false,
  });
});

test("serial backend uses retained state and camera-only rendering", () => {
  const calls = [];
  const processor = {
    set_retained_render_state: (...args) => calls.push(["state", ...args]),
    render_camera: (...args) => calls.push(["camera", ...args]),
  };
  const backend = new SerialRenderBackend(processor);
  const state = { activeLayerIds: new Uint32Array([1]), colorData: new Float32Array([1, 0, 0, 1]),
    blendModes: new Uint8Array([0]), alpha: 1 };
  backend.setRenderState(state);
  backend.renderCamera({ zoomX: 2, zoomY: 2, offsetX: 3, offsetY: 4 });
  assert.equal(calls[0][0], "state");
  assert.deepEqual(calls[1], ["camera", 2, 2, 3, 4, true]);
});

test("only measured enabled capability profiles are selected", () => {
  const capabilities = { threadedSupported: true, browser: "test", hardwareConcurrency: 8, deviceMemory: 8 };
  assert.equal(selectThreadedCapabilityProfile(capabilities), null);
  assert.equal(selectThreadedCapabilityProfile(capabilities, [
    { key: "test:8:8", enabled: true, helperCount: 3 },
  ])?.helperCount, 3);
});

test("failed OffscreenCanvas initialization replaces the transferred canvas and falls back", async () => {
  const replacement = { width: 0, height: 0 };
  const canvas = {
    width: 320,
    height: 200,
    transferControlToOffscreen: () => ({}),
    cloneNode: () => replacement,
    parentNode: { replaceChild: (next, previous) => assert.deepEqual([next, previous], [replacement, canvas]) },
  };
  class OffscreenCanvasProbe {
    getContext() { return {}; }
  }
  class FailingWorker {
    constructor() { throw new Error("worker init failed"); }
  }
  const serialProcessor = {};
  const backend = await createRenderBackend({
    executionBackend: "threaded",
    processor: null,
    canvas,
    workerUrl: "worker.js",
    threadedArtifactUrl: "threaded.js",
    profile: { enabled: true },
    createSerialProcessor: async (nextCanvas) => {
      assert.equal(nextCanvas, replacement);
      return serialProcessor;
    },
    environment: {
      isSecureContext: true,
      crossOriginIsolated: true,
      SharedArrayBuffer,
      Atomics,
      WebAssembly,
      Worker: FailingWorker,
      OffscreenCanvas: OffscreenCanvasProbe,
      navigator: {},
    },
  });
  assert.equal(backend.name, "serial");
  assert.equal(backend.implementation.processor, serialProcessor);
  assert.equal(replacement.width, 320);
  assert.equal(replacement.height, 200);
});
