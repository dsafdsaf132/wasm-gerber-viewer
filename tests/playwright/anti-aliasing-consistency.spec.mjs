import { expect, test } from "@playwright/test";

// Once multisampling stops being available (an allocation or resolve
// failure), masks drawn multisampled earlier must not stay cached next to
// point-sampled ones: the same shapes, options and camera must give the same
// pixels whatever was rendered before. These tests drive the WASM processor
// through a proxied WebGL2 context that injects failures and read the
// renderer's anti-aliasing diagnostics to confirm the transition happened.

const GL = { R8: 0x8229, RGBA8: 0x8058, STENCIL_INDEX8: 0x8d48, OUT_OF_MEMORY: 0x0505, INVALID_ENUM: 0x0500, INVALID_OPERATION: 0x0502 };

const point = (x, y) => `X${Math.round(x * 1e6)}Y${Math.round(y * 1e6)}`;
const header = ["%FSLAX46Y46*%", "%MOMM*%", "G75*", "G01*", "%LPD*%"];
// A: a triangulated region with slanted edges (no arcs, no stencil), whose
// anti-aliased edges carry partial coverage.
const A = [...header, "G36*", `${point(0.3, 0.2)}D02*`, `${point(3.7, 1.1)}D01*`, `${point(1.9, 3.6)}D01*`, `${point(0.3, 0.2)}D01*`, "G37*", "M02*"].join("\n");
// C: another slanted triangle, drawn as a second layer.
const C = [...header, "G36*", `${point(0.4, 3.6)}D02*`, `${point(3.6, 3.4)}D01*`, `${point(2.2, 0.5)}D01*`, `${point(0.4, 3.6)}D01*`, "G37*", "M02*"].join("\n");
// B: a round pad drawn as a G36 region with two arcs (needs the stencil).
const B = [...header, "G36*", `${point(3.0, 2.0)}D02*`, `G03${point(1.0, 2.0)}I${-1e6}J0D01*`, `${point(3.0, 2.0)}I${1e6}J0D01*`, "G37*", "M02*"].join("\n");
// D: a round flash (disc shader with analytic edges).
const D = ["%FSLAX46Y46*%", "%MOMM*%", "%ADD10C,2.6*%", "%LPD*%", "D10*", `${point(2, 2)}D03*`, "M02*"].join("\n");
const LAYERS = { A, B, C, D };

/**
 * Runs steps against a fresh processor on a proxied 96 x 96 context.
 * inject: { storage: {format, error, occurrence?}, blitError: {index, error},
 *           r8TextureFails: n (the n-th R8 texImage2D reports INVALID_ENUM),
 *           loseAfterStorage: format }. Each fires once.
 * Steps: {addLayer: name}, {render: [names], view?: "T"|"U"}, {snapshot: key},
 *        {composite: [names]}, {tile: {...}}, {restoreContext: true}.
 * Renders record pixels (alpha channel), the partial-coverage count and the
 * diagnostics status after the call; a step may {expectError: true}.
 */
async function run(page, { layers, steps, inject = {}, size = 96 }) {
  return page.evaluate(
    async ({ layerTexts, layers, steps, inject, size }) => {
      const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
      await wasm.default();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const raw = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
      const log = { storage: [], blits: 0, r8Textures: 0 };
      let pendingError = null;
      let lost = false;
      const once = { storage: inject.storage, blit: inject.blitError, lose: inject.loseAfterStorage };
      let r8Countdown = inject.r8TextureFails ?? 0;
      const storageCalls = new Map();
      const gl = new Proxy(raw, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "renderbufferStorageMultisample") {
            return (...args) => {
              const format = args[2];
              log.storage.push(format);
              storageCalls.set(format, (storageCalls.get(format) ?? 0) + 1);
              const result = value.apply(target, args);
              if (
                once.storage &&
                once.storage.format === format &&
                storageCalls.get(format) === (once.storage.occurrence ?? 1)
              ) {
                pendingError = once.storage.error;
                once.storage = null;
              }
              if (once.lose === format) {
                lost = true;
                pendingError = 0x9242;
                once.lose = null;
              }
              return result;
            };
          }
          if (property === "texImage2D") {
            return (...args) => {
              const result = value.apply(target, args);
              if (args[2] === 0x8229) {
                log.r8Textures += 1;
                if (r8Countdown > 0 && --r8Countdown === 0) pendingError = 0x0500;
              }
              return result;
            };
          }
          if (property === "blitFramebuffer") {
            return (...args) => {
              log.blits += 1;
              const result = value.apply(target, args);
              if (once.blit && once.blit.index === log.blits) {
                pendingError = once.blit.error;
                once.blit = null;
              }
              return result;
            };
          }
          if (property === "getError") {
            return () => {
              if (pendingError != null) {
                const error = pendingError;
                pendingError = null;
                return error;
              }
              return value.call(target);
            };
          }
          if (property === "isContextLost") return () => lost || value.call(target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const processor = new wasm.GerberProcessor();
      processor.init_with_size(gl, size, size);
      processor.set_anti_aliasing(true);
      const ids = {};
      for (const name of layers) ids[name] = processor.add_layer(layerTexts[name]);
      const views = { T: [0.5, 0.5, -1.0, -1.0], U: [0.5, 0.5, -1.03, -0.98] };
      const results = {};
      const readAlpha = () => {
        gl.finish();
        let pixels = pixelsOut;
        if (!pixels) {
          pixels = new Uint8Array(size * size * 4);
          raw.readPixels(0, 0, size, size, raw.RGBA, raw.UNSIGNED_BYTE, pixels);
        }
        const alpha = [];
        let partial = 0;
        for (let i = 3; i < pixels.length; i += 4) {
          alpha.push(pixels[i]);
          if (pixels[i] > 0 && pixels[i] < 255) partial++;
        }
        return { alpha, partial };
      };
      const colours = (n) => new Float32Array(n * 4).fill(1);
      // The error of the most recent action step, read by the snapshot after
      // it; pixelsOut holds the output of a render_pixels step instead of the
      // canvas.
      let error = null;
      let pixelsOut = null;
      for (const step of steps) {
        if (!step.snapshot) {
          error = null;
          pixelsOut = null;
        }
        try {
          if (step.addLayer) {
            ids[step.addLayer] = processor.add_layer(layerTexts[step.addLayer]);
          } else if (step.render) {
            const list = new Uint32Array(step.render.map((name) => ids[name]));
            processor.render(list, colours(list.length), ...views[step.view ?? "T"], 1);
          } else if (step.composite) {
            const sources = new Uint32Array(step.composite.map((name) => ids[name]));
            ids.composite = processor.add_composite_preset_with_bounds(sources, "union", false, -1, 5, -1, 5);
          } else if (step.renderPixels) {
            const list = new Uint32Array(step.renderPixels.map((name) => ids[name]));
            pixelsOut = processor.render_pixels_with_clear(list, colours(list.length), ...views[step.view ?? "T"], 1, true);
          } else if (step.renderComposite) {
            const list = new Uint32Array([ids.composite]);
            processor.render(list, colours(1), ...views[step.view ?? "T"], 1);
          } else if (step.tile) {
            const { names, exportSize, tileX, tileY } = step.tile;
            const list = new Uint32Array(names.map((name) => ids[name]));
            processor.render_tile(list, colours(list.length), exportSize, exportSize, tileX, tileY, size, size, ...views.T, 1);
          } else if (step.restoreContext) {
            // A restored context starts with a clean error state.
            lost = false;
            pendingError = null;
          } else if (step.antiAliasing !== undefined) {
            processor.set_anti_aliasing(step.antiAliasing);
          }
        } catch (caught) {
          error = String(caught?.message ?? caught);
        }
        if (step.snapshot) {
          const diagnostics = processor.get_anti_aliasing_diagnostics?.() ?? { status: "n/a", stencil: null };
          results[step.snapshot] = {
            ...readAlpha(),
            status: diagnostics.status,
            stencil: diagnostics.stencil,
            mode: diagnostics.mode,
            storage: [...log.storage],
            blits: log.blits,
            error,
          };
        } else if (error && !step.expectError) {
          throw new Error(`step ${JSON.stringify(step)} failed: ${error}`);
        }
      }
      processor.free?.();
      return results;
    },
    { layerTexts: LAYERS, layers, steps, inject, size },
  );
}

const same = (a, b) => a.alpha.length === b.alpha.length && a.alpha.every((v, i) => v === b.alpha[i]);
const differing = (a, b) => a.alpha.reduce((n, v, i) => n + (v !== b.alpha[i] ? 1 : 0), 0);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("maintainer scenario: a stencil failure drops the multisampled cache in the same call", async ({ page }) => {
  const r = await run(page, {
    layers: ["A", "B"],
    inject: { storage: { format: GL.STENCIL_INDEX8, error: GL.OUT_OF_MEMORY } },
    steps: [
      { render: ["A"] },
      { snapshot: "step1" },
      { render: ["A", "B"] },
      { snapshot: "step2" },
      { render: ["A"] },
      { snapshot: "step3" },
      { render: ["A"], view: "U" },
      { render: ["A"] },
      { snapshot: "step4" },
    ],
  });
  // Step 1 was multisampled: the slanted edges have partial coverage.
  expect(r.step1.status).toBe("ready");
  expect(r.step1.partial).toBeGreaterThan(20);
  // Step 2: the stencil allocation failed, so multisampling is off for this
  // size. The transition is the observable state change.
  expect(r.step2.status).toBe("size-limited");
  // Steps 3 and 4 show the same shape, options and camera: identical pixels,
  // both point-sampled, regardless of A's earlier multisampled cache.
  expect(r.step3.partial).toBe(0);
  expect(same(r.step3, r.step4)).toBe(true);
  // Auxiliary: the multisampled and point-sampled renders of A do differ,
  // and nothing was resolved after the failure.
  expect(differing(r.step1, r.step3)).toBeGreaterThan(0);
  expect(r.step2.blits).toBe(r.step1.blits);
});

test("a resolve failure part-way through a frame redraws the frame point-sampled", async ({ page }) => {
  // Blit 1 resolves A in the first call; blit 3 is C's resolve in the second
  // call (A is cached), and fails.
  const r = await run(page, {
    layers: ["A", "C"],
    inject: { blitError: { index: 2, error: GL.INVALID_OPERATION } },
    steps: [
      { render: ["A"] },
      { snapshot: "first" },
      { render: ["A", "C"] },
      { snapshot: "mixed" },
      { render: ["A", "C"], view: "U" },
      { render: ["A", "C"] },
      { snapshot: "again" },
    ],
  });
  expect(r.first.status).toBe("ready");
  expect(r.first.partial).toBeGreaterThan(20);
  expect(r.mixed.status).toBe("unsupported");
  // The frame that hit the failure contains no multisampled mask at all.
  expect(r.mixed.partial).toBe(0);
  expect(same(r.mixed, r.again)).toBe(true);
});

test("an offscreen render_pixels frame is redrawn point-sampled after a resolve failure", async ({ page }) => {
  const r = await run(page, {
    layers: ["A", "C"],
    inject: { blitError: { index: 2, error: GL.INVALID_OPERATION } },
    steps: [
      { renderPixels: ["A"] },
      { snapshot: "first" },
      { renderPixels: ["A", "C"] },
      { snapshot: "mixed" },
      { renderPixels: ["A", "C"], view: "U" },
      { renderPixels: ["A", "C"] },
      { snapshot: "again" },
    ],
  });
  expect(r.first.status).toBe("ready");
  expect(r.first.partial).toBeGreaterThan(20);
  expect(r.mixed.status).toBe("unsupported");
  expect(r.mixed.partial).toBe(0);
  expect(same(r.mixed, r.again)).toBe(true);
});

test("a layer whose mask fell back to RGBA8 makes the whole frame point-sampled", async ({ page }) => {
  // Multisampling is R8 only. When a frame includes an RGBA8 fallback mask
  // (its R8 allocation was refused) every layer of that frame renders
  // point-sampled, exactly as with the option off, no RGBA8 multisample
  // target is allocated, the frame is the same whatever was drawn before,
  // and a frame without that layer multisamples again.
  const r = await run(page, {
    layers: ["A"],
    inject: { r8TextureFails: 2 },
    steps: [
      { render: ["A"] },
      { snapshot: "first" },
      { addLayer: "D" },
      { render: ["A", "D"] },
      { snapshot: "both" },
      { render: ["A", "D"], view: "U" },
      { render: ["A", "D"] },
      { snapshot: "again" },
      { render: ["A"] },
      { snapshot: "aloneAgain" },
    ],
  });
  expect(r.first.mode).toBe("multisampled");
  expect(r.first.partial).toBeGreaterThan(20);
  // A's slanted edges are point-sampled too while D is in the frame.
  expect(r.both.mode).toBe("point-sampled");
  expect(r.both.partial).toBe(0);
  expect(r.both.storage).toEqual([GL.R8]);
  expect(same(r.both, r.again)).toBe(true);
  expect(r.aloneAgain.mode).toBe("multisampled");
  expect(same(r.aloneAgain, r.first)).toBe(true);
});

test("an unsupported stencil format gives up multisampling and renders as the option off", async ({ page }) => {
  const r = await run(page, {
    layers: ["D", "B"],
    inject: { storage: { format: GL.STENCIL_INDEX8, error: GL.INVALID_OPERATION } },
    steps: [
      { render: ["D", "B"] },
      { snapshot: "fallback" },
      { antiAliasing: false },
      { render: ["D", "B"] },
      { snapshot: "off" },
    ],
  });
  expect(r.fallback.status).toBe("unsupported");
  expect(r.fallback.storage).toEqual([GL.R8, GL.STENCIL_INDEX8]);
  expect(r.fallback.partial).toBe(0);
  expect(same(r.fallback, r.off)).toBe(true);
});

test("a composite is rebuilt from point-sampled sources in the same call", async ({ page }) => {
  const r = await run(page, {
    layers: ["A", "B"],
    inject: { storage: { format: GL.STENCIL_INDEX8, error: GL.OUT_OF_MEMORY } },
    steps: [
      { render: ["A"] },
      { snapshot: "first" },
      { composite: ["A", "B"] },
      { renderComposite: true },
      { snapshot: "composite" },
      { renderComposite: true, view: "U" },
      { renderComposite: true },
      { snapshot: "again" },
    ],
  });
  expect(r.first.partial).toBeGreaterThan(20);
  expect(r.composite.status).toBe("size-limited");
  expect(r.composite.partial).toBe(0);
  expect(same(r.composite, r.again)).toBe(true);
});

test("the direct fallback renders exactly as the option off", async ({ page }) => {
  // A disc has analytic edges with anti-aliasing; once multisampling is
  // unavailable the same disc must come out point-sampled, pixel for pixel
  // like the option off, not with fractional edges composited directly.
  const r = await run(page, {
    layers: ["D", "A"],
    inject: { blitError: { index: 1, error: GL.INVALID_OPERATION } },
    steps: [
      { render: ["D", "A"] },
      { snapshot: "fallback" },
      { antiAliasing: false },
      { render: ["D", "A"] },
      { snapshot: "off" },
      { antiAliasing: true },
      { render: ["D", "A"] },
      { snapshot: "onAgain" },
    ],
  });
  expect(r.fallback.status).toBe("unsupported");
  expect(r.fallback.partial).toBe(0);
  expect(same(r.fallback, r.off)).toBe(true);
  // Turning the option back on retries nothing on an unsupported context.
  expect(r.onAgain.status).toBe("unsupported");
  expect(same(r.onAgain, r.off)).toBe(true);
});

test("a lost context is an error, not a fallback, and retries after restore", async ({ page }) => {
  const r = await run(page, {
    layers: ["A"],
    inject: { loseAfterStorage: GL.R8 },
    steps: [
      { render: ["A"], expectError: true },
      { snapshot: "lost" },
      { restoreContext: true },
      { render: ["A"] },
      { snapshot: "restored" },
    ],
  });
  expect(r.lost.error).toContain("context lost");
  expect(r.lost.status).toBe("pending");
  expect(r.restored.status).toBe("ready");
  expect(r.restored.partial).toBeGreaterThan(20);
});

test("tiles: an allocation failure is decided before the first tile", async ({ page }) => {
  // Four 96 px tiles of a 192 px export with A and B; the stencil fails, so
  // every tile is point-sampled and the export succeeds.
  const tiles = [];
  for (const [tileX, tileY] of [[0, 0], [96, 0], [0, 96], [96, 96]]) {
    tiles.push({ tile: { names: ["A", "B"], exportSize: 192, tileX, tileY } }, { snapshot: `tile${tileX}_${tileY}` });
  }
  const r = await run(page, {
    layers: ["A", "B"],
    inject: { storage: { format: GL.STENCIL_INDEX8, error: GL.OUT_OF_MEMORY } },
    steps: tiles,
  });
  for (const key of Object.keys(r)) {
    expect(r[key].error, key).toBeNull();
    expect(r[key].status, key).toBe("size-limited");
    expect(r[key].partial, key).toBe(0);
  }
});

test("tiles: a resolve failure after the first tile fails the tile instead of mixing modes", async ({ page }) => {
  const r = await run(page, {
    layers: ["A", "C"],
    // Tile 1 resolves A and C (blits 1 and 2); the first resolve of tile 2 fails.
    inject: { blitError: { index: 3, error: GL.INVALID_OPERATION } },
    steps: [
      { tile: { names: ["A", "C"], exportSize: 192, tileX: 0, tileY: 0 } },
      { snapshot: "tile1" },
      { tile: { names: ["A", "C"], exportSize: 192, tileX: 96, tileY: 0 }, expectError: true },
      { snapshot: "tile2" },
      { tile: { names: ["A", "C"], exportSize: 192, tileX: 96, tileY: 0 } },
      { snapshot: "tile2again" },
    ],
  });
  expect(r.tile1.error).toBeNull();
  expect(r.tile1.status).toBe("ready");
  expect(r.tile2.error).toContain("tiled render");
  expect(r.tile2.status).toBe("unsupported");
  // A later call at the same tile succeeds point-sampled.
  expect(r.tile2again.error).toBeNull();
  expect(r.tile2again.partial).toBe(0);
});

test("tiles: turning the option off between tiles is not a mode-change error", async ({ page }) => {
  // The option change drops the cached masks, so the next tile call has no
  // multisampled masks to match and renders point-sampled without an error.
  const r = await run(page, {
    layers: ["A", "C"],
    steps: [
      { tile: { names: ["A", "C"], exportSize: 192, tileX: 0, tileY: 0 } },
      { snapshot: "tile1" },
      { antiAliasing: false },
      { tile: { names: ["A", "C"], exportSize: 192, tileX: 96, tileY: 0 } },
      { snapshot: "tile2" },
    ],
  });
  expect(r.tile1.mode).toBe("multisampled");
  expect(r.tile2.error).toBeNull();
  expect(r.tile2.mode).toBe("point-sampled");
  expect(r.tile2.partial).toBe(0);
});

test("tiles: a failure before the first tile of a fresh renderer falls back without an error", async ({ page }) => {
  // No multisampled tile exists yet, so a failure in the first call may fall
  // back silently: every tile of the export is point-sampled.
  const r = await run(page, {
    layers: ["A", "C"],
    inject: { blitError: { index: 1, error: GL.INVALID_OPERATION } },
    steps: [
      { tile: { names: ["A", "C"], exportSize: 192, tileX: 0, tileY: 0 } },
      { snapshot: "tile1" },
      { tile: { names: ["A", "C"], exportSize: 192, tileX: 96, tileY: 0 } },
      { snapshot: "tile2" },
    ],
  });
  expect(r.tile1.error).toBeNull();
  expect(r.tile1.status).toBe("unsupported");
  expect(r.tile1.partial).toBe(0);
  expect(r.tile2.error).toBeNull();
  expect(r.tile2.partial).toBe(0);
});
