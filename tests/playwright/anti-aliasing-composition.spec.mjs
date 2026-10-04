import { expect, test } from "@playwright/test";

// Layer masks drawn with anti-aliasing carry partial coverage at edges, so
// polarity composition must not depend on how many times the same shape is
// drawn. These tests drive the WASM processor directly on a 241 x 241
// canvas (odd, so one pixel centre falls exactly on (5, 5)) and compare
// pixels.

const header = ["%FSLAX46Y46*%", "%MOMM*%", "%ADD10C,3.3*%", "%ADD11C,6.1*%", "G75*", "G01*", "%LPD*%"];
const point = (x, y) => `X${Math.round(x * 1e6)}Y${Math.round(y * 1e6)}`;
const darkSquare = ["G36*", `${point(0, 0)}D02*`, `${point(10, 0)}D01*`, `${point(10, 10)}D01*`, `${point(0, 10)}D01*`, `${point(0, 0)}D01*`, "G37*"];
const gerber = (...body) => [...header, ...body, "M02*"].join("\n");

const CASES = {
  // A clear pad over a dark square, flashed once.
  clearOnce: gerber(...darkSquare, "%LPC*%", "D10*", `${point(5, 5)}D03*`),
  // The same pad flashed twice in one clear sublayer.
  clearTwiceSameSublayer: gerber(...darkSquare, "%LPC*%", "D10*", `${point(5, 5)}D03*`, `${point(5, 5)}D03*`),
  // The same pad in two clear sublayers (a dark polarity switch between).
  clearTwiceSeparateSublayers: gerber(
    ...darkSquare,
    "%LPC*%",
    "D10*",
    `${point(5, 5)}D03*`,
    "%LPD*%",
    "%LPC*%",
    `${point(5, 5)}D03*`,
  ),
  // Dark square, clear 6.1 mm pad, dark 3.3 mm pad on top: the centre must
  // be dark again, the ring between the two pads clear.
  darkClearDark: gerber(...darkSquare, "%LPC*%", "D11*", `${point(5, 5)}D03*`, "%LPD*%", "D10*", `${point(5, 5)}D03*`),
  // The same pad flashed dark and then clear at the same place: nothing may
  // remain, not even at the anti-aliased edge.
  darkThenClearSame: gerber("D10*", `${point(5, 5)}D03*`, "%LPC*%", `${point(5, 5)}D03*`),
};

// Full-circle arcs of radius 2 mm around (5, 5): a 4 mm stroke is exactly as
// thick as the diameter, and 4.02 mm is thicker by a fraction of a pixel (as
// Minimum Line Width can make it). Neither has an inner edge, so both must
// be fully covered at the centre pixel, where a fade from a non-existent
// inner edge would show.
const arc = (width) =>
  [
    "%FSLAX46Y46*%",
    "%MOMM*%",
    `%ADD12C,${width}*%`,
    "G75*",
    "%LPD*%",
    "D12*",
    `${point(7, 5)}D02*`,
    `G03${point(7, 5)}I${-2 * 1e6}J0D01*`,
    "M02*",
  ].join("\n");
CASES.arcThicknessEqualsDiameter = arc("4.0");
CASES.arcThickerThanDiameter = arc("4.02");

async function renderCases(page, antiAliasing) {
  return page.evaluate(
    async ({ cases, antiAliasing }) => {
      const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
      await wasm.default();
      const size = 241;
      const out = {};
      for (const [name, text] of Object.entries(cases)) {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
        const processor = new wasm.GerberProcessor();
        processor.init_with_size(gl, size, size);
        processor.set_anti_aliasing(antiAliasing);
        const id = processor.add_layer(text);
        // 12 mm across the canvas, centred on (5, 5).
        const scale = 2 / 12;
        processor.render(new Uint32Array([id]), new Float32Array([1, 1, 1, 1]), scale, scale, -5 * scale, -5 * scale, 1);
        gl.finish();
        const pixels = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const at = (mmX, mmY) => {
          const x = Math.floor(((mmX - 5) / 12 + 0.5) * size);
          const y = Math.floor(((mmY - 5) / 12 + 0.5) * size);
          return pixels[(y * size + x) * 4 + 3];
        };
        let partial = 0;
        let lit = 0;
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] > 0) lit++;
          if (pixels[i] > 0 && pixels[i] < 255) partial++;
        }
        out[name] = {
          pixels: Array.from(pixels),
          partial,
          lit,
          centre: at(5, 5),
          ring: at(5 + 2.3, 5),
          corner: at(0.6, 0.6),
          stroke: at(5 + 1.0, 5),
        };
        processor.free?.();
      }
      return out;
    },
    { cases: CASES, antiAliasing },
  );
}

const differingPixels = (a, b) => {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
};

test("an anti-aliased clear shape erases the same coverage however often it is drawn", async ({ page }) => {
  await page.goto("/");
  const result = await renderCases(page, true);
  // The clear pad's edge is anti-aliased, so the comparison is meaningful.
  expect(result.clearOnce.partial).toBeGreaterThan(20);
  expect(differingPixels(result.clearOnce.pixels, result.clearTwiceSameSublayer.pixels)).toBe(0);
  expect(differingPixels(result.clearOnce.pixels, result.clearTwiceSeparateSublayers.pixels)).toBe(0);
});

test("a shape flashed dark and then clear at the same place leaves nothing", async ({ page }) => {
  await page.goto("/");
  for (const antiAliasing of [false, true]) {
    const { darkThenClearSame } = await renderCases(page, antiAliasing);
    expect(darkThenClearSame.lit, `AA ${antiAliasing}`).toBe(0);
  }
});

test("polarity order is kept: dark, clear, dark", async ({ page }) => {
  await page.goto("/");
  for (const antiAliasing of [false, true]) {
    const { darkClearDark } = await renderCases(page, antiAliasing);
    expect(darkClearDark.corner, `square, AA ${antiAliasing}`).toBe(255);
    expect(darkClearDark.ring, `cleared ring, AA ${antiAliasing}`).toBe(0);
    expect(darkClearDark.centre, `dark again at the centre, AA ${antiAliasing}`).toBe(255);
  }
});

test("an arc stroke as thick as its diameter is filled to the centre", async ({ page }) => {
  await page.goto("/");
  for (const antiAliasing of [false, true]) {
    const result = await renderCases(page, antiAliasing);
    for (const name of ["arcThicknessEqualsDiameter", "arcThickerThanDiameter"]) {
      expect(result[name].stroke, `${name} stroke, AA ${antiAliasing}`).toBe(255);
      expect(result[name].centre, `${name} centre, AA ${antiAliasing}`).toBe(255);
    }
  }
});
