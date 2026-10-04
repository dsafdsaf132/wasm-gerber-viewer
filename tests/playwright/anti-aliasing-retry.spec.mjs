import { expect, test } from "@playwright/test";

// The multisample target is allocated on demand. A size-specific allocation
// failure (OUT_OF_MEMORY) is remembered so the renderer does not retry it on
// every frame, but the user switching the option off and on again is a
// request to try once more with whatever memory is available now. Drive the
// processor directly through a proxied WebGL2 context that fails the first
// multisample allocation, then count the retries and the resolve blits.
test("anti-aliasing retries a failed multisample allocation after the option is toggled", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    await wasm.default();
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const rawGl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
    const counters = { multisampleAllocations: 0, blits: 0 };
    let failNextAllocation = false;
    let forcedError = null;
    const gl = new Proxy(rawGl, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "renderbufferStorageMultisample") {
          return (...args) => {
            counters.multisampleAllocations += 1;
            if (failNextAllocation) {
              failNextAllocation = false;
              forcedError = target.OUT_OF_MEMORY;
            }
            return value.apply(target, args);
          };
        }
        if (property === "getError") {
          return () => {
            if (forcedError != null) {
              const error = forcedError;
              forcedError = null;
              return error;
            }
            return value.call(target);
          };
        }
        if (property === "blitFramebuffer") {
          return (...args) => {
            counters.blits += 1;
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const processor = new wasm.GerberProcessor();
    processor.init_with_size(gl, 64, 64);
    processor.set_anti_aliasing(true);
    const layerId = processor.add_layer("%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.000*%\nD10*\nX000000Y000000D03*\nM02*");
    const ids = new Uint32Array([layerId]);
    const colors = new Float32Array([0, 1, 0, 1]);
    const render = () => processor.render(ids, colors, 0.2, 0.2, 0, 0, 1);
    const snapshot = () => ({ ...counters });

    failNextAllocation = true;
    render();
    const afterFailure = snapshot();
    render();
    const afterSecondFrame = snapshot();

    processor.set_anti_aliasing(false);
    processor.set_anti_aliasing(true);
    render();
    const afterToggle = snapshot();
    processor.free?.();
    return { afterFailure, afterSecondFrame, afterToggle, maxSamples: rawGl.getParameter(rawGl.MAX_SAMPLES) };
  });

  test.skip(result.maxSamples < 2, "this context cannot multisample");
  // The first frame tried to allocate and was refused: nothing was resolved.
  expect(result.afterFailure.multisampleAllocations).toBeGreaterThan(0);
  expect(result.afterFailure.blits).toBe(0);
  // Same size, option unchanged: no retry on the next frame.
  expect(result.afterSecondFrame).toEqual(result.afterFailure);
  // Off then On at the same size: allocate again and, with memory available
  // this time, render through the multisample target.
  expect(result.afterToggle.multisampleAllocations).toBeGreaterThan(result.afterSecondFrame.multisampleAllocations);
  expect(result.afterToggle.blits).toBeGreaterThan(0);
});
