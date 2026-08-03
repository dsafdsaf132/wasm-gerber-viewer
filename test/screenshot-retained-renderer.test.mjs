import test from "node:test";
import assert from "node:assert/strict";
import { ScreenshotExporter } from "../js/rendering/screenshot-exporter.js";

test("screenshot exporter borrows and restores the interactive renderer", () => {
  const calls = [];
  const canvas = { width: 640, height: 480 };
  const processor = { resize: () => calls.push("resize") };
  const gl = {};
  const exporter = new ScreenshotExporter({
    canvas,
    getGl: () => gl,
    getWasmProcessor: () => processor,
    getLayers: () => [{}, {}],
    getScreenshotRenderLayerPayload: () => ({
      activeLayerIds: new Uint32Array([1]),
      colorData: new Float32Array([1, 0, 0, 1]),
      blendModes: new Uint8Array([0]),
      alpha: 1,
    }),
    onRendererBorrow: () => calls.push("borrow"),
    onRendererRestore: () => calls.push("restore"),
  });
  const renderer = exporter.createRenderer({}, false);
  assert.equal(renderer.borrowed, true);
  canvas.width = 32;
  canvas.height = 32;
  exporter.disposeRenderer(renderer);
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 480);
  assert.deepEqual(calls, ["borrow", "resize", "restore"]);
});

test("screenshot readback flips rows and unpremultiplies transparent pixels", () => {
  const exporter = new ScreenshotExporter({});
  const written = [];
  const context = {
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: (image) => written.push(image),
  };
  const renderer = {
    lastPixels: new Uint8Array([
      64, 0, 0, 128,
      0, 64, 0, 128,
    ]),
  };
  exporter.copyRenderedPixels(renderer, context, 1, 2, null);
  assert.deepEqual([...written[0].data], [0, 128, 0, 128, 128, 0, 0, 128]);
  assert.equal(renderer.lastPixels, null);
});
