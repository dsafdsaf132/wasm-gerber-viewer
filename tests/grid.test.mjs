import assert from "node:assert/strict";
import test from "node:test";

import {
  GRID_MAJOR_EVERY,
  GRID_MIN_MINOR_PIXELS,
  buildGridPaths,
  chooseGridSpacing,
  formatGridSpacing,
} from "../js/rendering/grid.js";

const label = (pixelsPerMm, unit) =>
  formatGridSpacing(chooseGridSpacing(pixelsPerMm, unit));

test("minor spacing steps through 1-2-5 millimetres", () => {
  assert.equal(label(8, "mm"), "1 mm");
  assert.equal(label(7.9, "mm"), "2 mm");
  assert.equal(label(4, "mm"), "2 mm");
  assert.equal(label(3.9, "mm"), "5 mm");
  assert.equal(label(1.6, "mm"), "5 mm");
  assert.equal(label(1.5, "mm"), "10 mm");
  assert.equal(label(80, "mm"), "0.1 mm");
  assert.equal(label(160, "mm"), "0.05 mm");
  assert.equal(label(0.08, "mm"), "100 mm");
});

test("minor cells stay between 8 and 20 pixels across zoom levels", () => {
  for (const unit of ["mm", "inch"]) {
    for (let exponent = -4; exponent <= 5; exponent += 0.01) {
      const pixelsPerMm = 10 ** exponent;
      const spacing = chooseGridSpacing(pixelsPerMm, unit);
      const pixels = spacing.stepMm * pixelsPerMm;
      assert.ok(
        pixels >= GRID_MIN_MINOR_PIXELS * (1 - 1e-9) && pixels <= 20 * (1 + 1e-9),
        `${unit} at ${pixelsPerMm} px/mm gives ${pixels} px`,
      );
      assert.ok([1, 2, 5].includes(spacing.mantissa), `${unit} mantissa ${spacing.mantissa}`);
    }
  }
});

test("inch spacing below one inch is labelled in mils", () => {
  const pixelsPerInch = (pixels) => pixels / 25.4;
  assert.equal(label(pixelsPerInch(8), "inch"), "1 in");
  assert.equal(label(pixelsPerInch(16), "inch"), "500 mil");
  assert.equal(label(pixelsPerInch(80), "inch"), "100 mil");
  assert.equal(label(pixelsPerInch(800), "inch"), "10 mil");
  assert.equal(label(pixelsPerInch(8000), "inch"), "1 mil");
  assert.equal(label(pixelsPerInch(16000), "inch"), "0.5 mil");
  assert.equal(label(pixelsPerInch(2), "inch"), "5 in");
});

test("inch spacing is converted to millimetres for drawing", () => {
  const spacing = chooseGridSpacing(80 / 25.4, "inch");
  assert.equal(spacing.unit, "inch");
  assert.ok(Math.abs(spacing.stepMm - 2.54) < 1e-9);
});

test("an empty or degenerate view has no spacing", () => {
  for (const pixelsPerMm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(chooseGridSpacing(pixelsPerMm, "mm"), null);
  }
});

// A 400 x 300 px view of world x in [-10, 30] mm and y in [-5, 25] mm at
// 10 px/mm, as worldToCanvasPoint maps it: y grows upwards in world space.
function linearView({ flipX = false, flipY = false } = {}) {
  const rect = { width: 400, height: 300 };
  const bounds = { minX: -10, maxX: 30, minY: -5, maxY: 25 };
  const worldToCanvasPoint = ({ x, y }) => ({
    x: flipX ? (30 - x) * 10 : (x + 10) * 10,
    y: flipY ? (y + 5) * 10 : (25 - y) * 10,
  });
  return { rect, bounds, worldToCanvasPoint };
}

const verticalLines = (path) =>
  [...path.matchAll(/M(-?[\d.]+) 0V/g)].map((match) => Number(match[1])).sort((a, b) => a - b);
const horizontalLines = (path) =>
  [...path.matchAll(/M0 (-?[\d.]+)H/g)].map((match) => Number(match[1])).sort((a, b) => a - b);

test("major lines run through the world origin every five minor steps", () => {
  for (const flip of [{}, { flipX: true }, { flipY: true }, { flipX: true, flipY: true }]) {
    const view = linearView(flip);
    const paths = buildGridPaths({ ...view, unit: "mm" });
    assert.equal(formatGridSpacing(paths.spacing), "1 mm");
    const origin = view.worldToCanvasPoint({ x: 0, y: 0 });

    const majorX = verticalLines(paths.major);
    const majorY = horizontalLines(paths.major);
    assert.ok(majorX.includes(origin.x), `${JSON.stringify(flip)} origin x ${origin.x}`);
    assert.ok(majorY.includes(origin.y), `${JSON.stringify(flip)} origin y ${origin.y}`);
    for (const lines of [majorX, majorY]) {
      for (let index = 1; index < lines.length; index++) {
        assert.equal(lines[index] - lines[index - 1], GRID_MAJOR_EVERY * 10);
      }
    }

    // Every millimetre of the view has exactly one line, major or minor.
    const allX = [...majorX, ...verticalLines(paths.minor)].sort((a, b) => a - b);
    assert.equal(allX.length, 41);
    assert.ok(allX.every((x, index) => index === 0 || x - allX[index - 1] === 10));
  }
});

test("a view far from the origin keeps evenly spaced lines", () => {
  // 1e8 mm from the origin at 1e8 px/mm puts line indices near 1e15. World
  // coordinates there carry only a few significant digits per step, so the
  // mapping itself is coarse; the lines must still come out evenly spaced
  // instead of drifting with the size of the origin's screen position.
  const rect = { width: 400, height: 300 };
  const far = 1e8;
  const bounds = { minX: far, maxX: far + 4e-6, minY: far, maxY: far + 3e-6 };
  const worldToCanvasPoint = ({ x, y }) => ({ x: (x - far) * 1e8, y: (far + 3e-6 - y) * 1e8 });
  const paths = buildGridPaths({ rect, bounds, unit: "mm", worldToCanvasPoint });
  const xs = [...verticalLines(paths.minor), ...verticalLines(paths.major)].sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, index) => x - xs[index]);
  assert.ok(xs.length > 10);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 0.2, gaps.join(","));
});

test("a view too far from the origin to step through draws nothing", () => {
  // Line indices beyond 2^53 cannot be stepped through one by one.
  const rect = { width: 400, height: 300 };
  const far = 1e10;
  const bounds = { minX: far, maxX: far + 4e-6, minY: 0, maxY: 3e-6 };
  const worldToCanvasPoint = ({ x, y }) => ({ x: (x - far) * 1e8, y: (3e-6 - y) * 1e8 });
  assert.equal(buildGridPaths({ rect, bounds, unit: "mm", worldToCanvasPoint }), null);
});

test("an empty overlay or world area draws nothing", () => {
  const view = linearView();
  assert.equal(buildGridPaths({ ...view, rect: { width: 0, height: 300 }, unit: "mm" }), null);
  assert.equal(
    buildGridPaths({ ...view, bounds: { minX: 5, maxX: 5, minY: 0, maxY: 1 }, unit: "mm" }),
    null,
  );
});
