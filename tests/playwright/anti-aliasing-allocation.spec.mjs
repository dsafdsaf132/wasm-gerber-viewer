import { expect, test } from "@playwright/test";

// The shared multisample target starts colour-only; the stencil is added the
// first time a layer with path regions is drawn and then reused. Every
// allocation is checked as soon as it is made. These tests drive the WASM
// processor through a WebGL2 context wrapped in a Proxy that records each
// renderbufferStorageMultisample call (by internal format), each detached
// framebuffer attachment and each resolve blit, and injects failures.

const GL = {
  R8: 0x8229,
  STENCIL_INDEX8: 0x8d48,
  STENCIL_ATTACHMENT: 0x8d20,
  OUT_OF_MEMORY: 0x0505,
  INVALID_VALUE: 0x0501,
  INVALID_ENUM: 0x0500,
  INVALID_OPERATION: 0x0502,
  FRAMEBUFFER_UNSUPPORTED: 0x8cdd,
  FRAMEBUFFER_INCOMPLETE_MULTISAMPLE: 0x8d56,
};

const point = (x, y) => `X${Math.round(x * 1e6)}Y${Math.round(y * 1e6)}`;
const LAYERS = {
  // Discs and a track only: no path regions, no stencil needed.
  flashes: ["%FSLAX46Y46*%", "%MOMM*%", "%ADD10C,1.0*%", "D10*", `${point(0, 0)}D03*`, `${point(1, 1)}D02*`, `${point(2, 1)}D01*`, "M02*"].join("\n"),
  // A round pad drawn as a G36 region with two arcs: a path region.
  pathPad: [
    "%FSLAX46Y46*%",
    "%MOMM*%",
    "G75*",
    "G36*",
    `${point(1, 0)}D02*`,
    `G03${point(-1, 0)}I${-1e6}J0D01*`,
    `${point(1, 0)}I${1e6}J0D01*`,
    "G37*",
    "M02*",
  ].join("\n"),
};
LAYERS.pathPad2 = LAYERS.pathPad.replace("G36*", `G36*\n${point(0, 0)}D02*`);

/** Runs steps against a fresh processor on a proxied 64 x 64 context.
 *  inject: { storage: {format, error}, status: {format, status},
 *            loseAfterStorage: format } (each fires once). */
async function run(page, { layers, steps, inject = {} }) {
  return page.evaluate(
    async ({ layerTexts, layers, steps, inject }) => {
      const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
      await wasm.default();
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const raw = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
      const log = { storage: [], detached: [], blits: 0 };
      const formatOf = new Map();
      const attached = new Map();
      let pendingError = null;
      let lost = false;
      const once = { storage: inject.storage, status: inject.status, lose: inject.loseAfterStorage };
      const gl = new Proxy(raw, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "renderbufferStorageMultisample") {
            return (rbTarget, samples, format, width, height) => {
              log.storage.push(format);
              formatOf.set(target.getParameter(target.RENDERBUFFER_BINDING), format);
              const result = value.call(target, rbTarget, samples, format, width, height);
              if (once.storage && once.storage.format === format) {
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
          if (property === "framebufferRenderbuffer") {
            return (fbTarget, attachment, rbTarget, renderbuffer) => {
              if (renderbuffer == null) log.detached.push(attachment);
              attached.set(attachment, renderbuffer);
              return value.call(target, fbTarget, attachment, rbTarget, renderbuffer);
            };
          }
          if (property === "checkFramebufferStatus") {
            return (fbTarget) => {
              const status = value.call(target, fbTarget);
              if (once.status) {
                for (const renderbuffer of attached.values()) {
                  if (renderbuffer && formatOf.get(renderbuffer) === once.status.format) {
                    const forced = once.status.status;
                    once.status = null;
                    return forced;
                  }
                }
              }
              return status;
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
          if (property === "blitFramebuffer") {
            return (...args) => {
              log.blits += 1;
              return value.apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const processor = new wasm.GerberProcessor();
      processor.init_with_size(gl, 64, 64);
      processor.set_anti_aliasing(true);
      const ids = Object.fromEntries(layers.map((name) => [name, processor.add_layer(layerTexts[name])]));
      const snapshots = {};
      let frame = 0;
      const errors = [];
      for (const step of steps) {
        if (step.render) {
          // Nudge the view so every render redraws the layer masks.
          const zoom = 0.2 * (1 + ++frame * 1e-4);
          const list = new Uint32Array(step.render.map((name) => ids[name]));
          try {
            processor.render(list, new Float32Array(list.length * 4).fill(1), zoom, zoom, 0, 0, 1);
          } catch (error) {
            if (!step.expectError) throw error;
            errors.push(String(error?.message ?? error));
          }
        } else if (step.resize) {
          processor.resize_to(...step.resize);
        } else if (step.toggle) {
          processor.set_anti_aliasing(false);
          processor.set_anti_aliasing(true);
        } else if (step.restoreContext) {
          // A restored context starts with a clean error state.
          lost = false;
          pendingError = null;
        } else if (step.snapshot) {
          snapshots[step.snapshot] = { storage: [...log.storage], detached: [...log.detached], blits: log.blits, errors: [...errors] };
        }
      }
      processor.free?.();
      return { ...snapshots, final: { storage: [...log.storage], detached: [...log.detached], blits: log.blits, errors } };
    },
    { layerTexts: LAYERS, layers, steps, inject },
  );
}

const { R8, STENCIL_INDEX8: S8 } = GL;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("a layer without path regions allocates no stencil", async ({ page }) => {
  const r = await run(page, { layers: ["flashes"], steps: [{ render: ["flashes"] }, { render: ["flashes"] }] });
  expect(r.final.storage).toEqual([R8]);
  expect(r.final.blits).toBe(2);
});

test("the stencil is allocated once, for the first path layer, and reused", async ({ page }) => {
  const r = await run(page, {
    layers: ["flashes", "pathPad", "pathPad2"],
    steps: [
      { render: ["flashes"] },
      { snapshot: "colourOnly" },
      { render: ["flashes", "pathPad", "pathPad2"] },
      { render: ["pathPad", "pathPad2"] },
      { snapshot: "withPaths" },
      { resize: [48, 48] },
      { render: ["flashes", "pathPad"] },
    ],
  });
  expect(r.colourOnly.storage).toEqual([R8]);
  expect(r.withPaths.storage).toEqual([R8, S8]);
  // A resize replaces the target; the stencil comes back with the first path layer.
  expect(r.final.storage).toEqual([R8, S8, R8, S8]);
  expect(r.final.blits).toBeGreaterThan(r.withPaths.blits);
});

test("a colour allocation out of memory stops before any stencil", async ({ page }) => {
  const r = await run(page, {
    layers: ["pathPad"],
    inject: { storage: { format: R8, error: GL.OUT_OF_MEMORY } },
    steps: [{ render: ["pathPad"] }, { render: ["pathPad"] }],
  });
  expect(r.final.storage).toEqual([R8]);
  expect(r.final.blits).toBe(0);
});

test("a stencil allocation out of memory does not try the larger fallback format", async ({ page }) => {
  const r = await run(page, {
    layers: ["pathPad"],
    inject: { storage: { format: S8, error: GL.OUT_OF_MEMORY } },
    steps: [{ render: ["pathPad"] }, { render: ["pathPad"] }],
  });
  expect(r.final.storage).toEqual([R8, S8]);
  expect(r.final.blits).toBe(0);
});

for (const [label, inject] of [
  ["an unsupported framebuffer", { status: { format: S8, status: GL.FRAMEBUFFER_UNSUPPORTED } }],
  ["an incomplete multisample framebuffer", { status: { format: S8, status: GL.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE } }],
  ["a sample count the format rejects", { storage: { format: S8, error: GL.INVALID_OPERATION } }],
]) {
  test(`${label} with STENCIL_INDEX8 gives up multisampling instead of taking a larger format`, async ({ page }) => {
    // The export budget counts 8 bytes per pixel for the target; a
    // DEPTH24_STENCIL8 stencil would be 16, so there is no fallback format.
    const r = await run(page, { layers: ["pathPad"], steps: [{ render: ["pathPad"] }, { render: ["pathPad"] }] , inject });
    expect(r.final.storage).toEqual([R8, S8]);
    expect(r.final.blits).toBe(0);
  });
}

test("INVALID_ENUM is unexpected: no fallback, no retry until the option is toggled", async ({ page }) => {
  const stencil = await run(page, {
    layers: ["pathPad"],
    inject: { storage: { format: S8, error: GL.INVALID_ENUM } },
    steps: [{ render: ["pathPad"] }, { render: ["pathPad"] }],
  });
  expect(stencil.final.storage).toEqual([R8, S8]);
  expect(stencil.final.blits).toBe(0);

  const colour = await run(page, {
    layers: ["flashes"],
    inject: { storage: { format: R8, error: GL.INVALID_ENUM } },
    steps: [{ render: ["flashes"] }, { render: ["flashes"] }, { snapshot: "failed" }, { toggle: true }, { render: ["flashes"] }],
  });
  expect(colour.failed.storage).toEqual([R8]);
  expect(colour.failed.blits).toBe(0);
  expect(colour.final.storage).toEqual([R8, R8]);
  expect(colour.final.blits).toBe(1);
});

test("an unsupported colour format stays off after a toggle", async ({ page }) => {
  const r = await run(page, {
    layers: ["flashes"],
    inject: { status: { format: R8, status: GL.FRAMEBUFFER_UNSUPPORTED } },
    steps: [{ render: ["flashes"] }, { toggle: true }, { render: ["flashes"] }],
  });
  expect(r.final.storage).toEqual([R8]);
  expect(r.final.blits).toBe(0);
});

test("INVALID_VALUE is a size failure: retried at another size", async ({ page }) => {
  const r = await run(page, {
    layers: ["flashes"],
    inject: { storage: { format: R8, error: GL.INVALID_VALUE } },
    steps: [{ render: ["flashes"] }, { render: ["flashes"] }, { snapshot: "failed" }, { resize: [48, 48] }, { render: ["flashes"] }],
  });
  expect(r.failed.storage).toEqual([R8]);
  expect(r.failed.blits).toBe(0);
  expect(r.final.storage).toEqual([R8, R8]);
  expect(r.final.blits).toBe(1);
});

test("a lost context stops allocation at once, fails the frame, and retries after restore", async ({ page }) => {
  const r = await run(page, {
    layers: ["pathPad"],
    inject: { loseAfterStorage: R8 },
    steps: [{ render: ["pathPad"], expectError: true }, { snapshot: "lost" }, { restoreContext: true }, { render: ["pathPad"] }],
  });
  expect(r.lost.storage).toEqual([R8]);
  expect(r.lost.blits).toBe(0);
  // The frame is abandoned rather than drawn point-sampled behind a lost context.
  expect(r.lost.errors).toHaveLength(1);
  expect(r.lost.errors[0]).toContain("context lost");
  expect(r.final.storage).toEqual([R8, R8, S8]);
  expect(r.final.blits).toBe(1);
  expect(r.final.errors).toHaveLength(1);
});
