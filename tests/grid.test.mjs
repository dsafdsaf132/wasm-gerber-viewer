import assert from "node:assert/strict";
import test from "node:test";

import {
  GRID_MAJOR_EVERY,
  GRID_MIN_MINOR_PIXELS,
  GRID_LABEL_BOTTOM_INSET,
  GRID_LABEL_CHAR_PIXELS,
  GRID_LABEL_GAP_PIXELS,
  GRID_LABEL_HEIGHT_PIXELS,
  GRID_LABEL_RIGHT_INSET,
  buildGridPaths,
  chooseGridSpacing,
  formatGridCoordinate,
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

    // The lines through the origin are drawn as axes, not as major lines.
    assert.deepEqual(verticalLines(paths.axes), [origin.x]);
    assert.deepEqual(horizontalLines(paths.axes), [origin.y]);
    const majorX = [...verticalLines(paths.major), origin.x].sort((a, b) => a - b);
    const majorY = [...horizontalLines(paths.major), origin.y].sort((a, b) => a - b);
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

test("the origin marker is centred on the origin and omitted when it is off screen", () => {
  for (const flip of [{}, { flipX: true }, { flipY: true }]) {
    const view = linearView(flip);
    const paths = buildGridPaths({ ...view, unit: "mm" });
    const origin = view.worldToCanvasPoint({ x: 0, y: 0 });
    const moves = [...paths.origin.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)];
    assert.ok(moves.length > 0);
    for (const [, x, y] of moves) {
      assert.deepEqual([Number(x), Number(y)], [origin.x, origin.y]);
    }
  }

  const view = linearView();
  const paths = buildGridPaths({ ...view, bounds: { minX: 2, maxX: 42, minY: 3, maxY: 33 }, unit: "mm" });
  assert.equal(paths.origin, "");
  assert.equal(paths.axes, "");
});

test("coordinates are written in the unit of the spacing label", () => {
  const mm = chooseGridSpacing(80, "mm"); // 0.1 mm
  assert.equal(formatGridCoordinate(0, mm), "0.0");
  assert.equal(formatGridCoordinate(-15, mm), "-1.5");
  assert.equal(formatGridCoordinate(250, mm), "25.0");
  const tenMm = chooseGridSpacing(0.8, "mm"); // 10 mm
  assert.equal(formatGridCoordinate(-5, tenMm), "-50");

  const mil = chooseGridSpacing(800 / 25.4, "inch"); // 10 mil
  assert.equal(formatGridSpacing(mil), "10 mil");
  assert.equal(formatGridCoordinate(5, mil), "50");
  assert.equal(formatGridCoordinate(-250, mil), "-2500");
  const inch = chooseGridSpacing(2 / 25.4, "inch"); // 5 in
  assert.equal(formatGridCoordinate(-10, inch), "-50");
});

test("labels sit on major lines, inside the overlay, without overlapping", () => {
  for (const flip of [{}, { flipX: true }, { flipY: true }, { flipX: true, flipY: true }]) {
    const view = linearView(flip);
    const paths = buildGridPaths({ ...view, unit: "mm" });
    const majorX = [...verticalLines(paths.major), ...verticalLines(paths.axes)];
    const majorY = [...horizontalLines(paths.major), ...horizontalLines(paths.axes)];

    assert.ok(paths.xLabels.length > 1, JSON.stringify(flip));
    assert.ok(paths.yLabels.length > 1, JSON.stringify(flip));
    for (const label of paths.xLabels) {
      assert.ok(majorX.includes(label.x), `x label at ${label.x}`);
      assert.equal(label.y, view.rect.height - GRID_LABEL_BOTTOM_INSET);
      // The canvas maps world x to (x + 10) * 10 or (30 - x) * 10.
      const world = flip.flipX ? 30 - label.x / 10 : label.x / 10 - 10;
      assert.equal(Number(label.text), Math.round(world));
    }
    for (const label of paths.yLabels) {
      assert.equal(label.x, view.rect.width - GRID_LABEL_RIGHT_INSET);
      const lineY = label.y - GRID_LABEL_HEIGHT_PIXELS / 3;
      assert.ok(majorY.some((y) => Math.abs(y - lineY) < 0.11), `y label at ${label.y}`);
      assert.ok(label.y < view.rect.height - GRID_LABEL_BOTTOM_INSET);
    }

    const xs = paths.xLabels.map((label) => label.x).sort((a, b) => a - b);
    const widest = Math.max(...paths.xLabels.map((label) => label.text.length)) * GRID_LABEL_CHAR_PIXELS;
    for (let index = 1; index < xs.length; index++) {
      assert.ok(xs[index] - xs[index - 1] >= widest + GRID_LABEL_GAP_PIXELS);
    }
    // X labels end before the column of Y labels starts.
    const yColumn = view.rect.width - GRID_LABEL_RIGHT_INSET -
      Math.max(...paths.yLabels.map((label) => label.text.length)) * GRID_LABEL_CHAR_PIXELS;
    assert.ok(xs.at(-1) + widest / 2 <= yColumn);
  }
});

test("labels thin out to a 1-2-5 stride when they are wider than a major cell", () => {
  // 1e3 px/mm: 0.01 mm spacing, major lines every 0.05 mm = 50 px apart.
  // Labels like "100.05" are about 42 px wide, so every other major line
  // gets one, always on multiples of 0.1 mm wherever the view is panned.
  for (const shift of [0, 0.013, 0.037]) {
    const minX = 100 + shift;
    const rect = { width: 600, height: 300 };
    const bounds = { minX, maxX: minX + 0.6, minY: 0, maxY: 0.3 };
    const worldToCanvasPoint = ({ x, y }) => ({ x: (x - minX) * 1e3, y: (0.3 - y) * 1e3 });
    const paths = buildGridPaths({ rect, bounds, unit: "mm", worldToCanvasPoint });
    assert.equal(formatGridSpacing(paths.spacing), "0.01 mm");
    assert.ok(paths.xLabels.length >= 2);
    for (const label of paths.xLabels) {
      assert.match(label.text, /^10\d\.\d0$/);
    }
  }
});

test("panning across the origin keeps the same labelled lines", () => {
  // 170 px/mm: 0.05 mm spacing, major lines 42.5 px apart. "0.25" fits a
  // major cell but "-0.25" does not, so the width estimate must not depend
  // on whether the view happens to reach past the origin.
  const rect = { width: 800, height: 400 };
  const strides = new Set();
  for (let minX = -2; minX <= 2; minX += 0.13) {
    const bounds = { minX, maxX: minX + 800 / 170, minY: 0, maxY: 400 / 170 };
    const worldToCanvasPoint = ({ x, y }) => ({ x: (x - minX) * 170, y: (bounds.maxY - y) * 170 });
    const paths = buildGridPaths({ rect, bounds, unit: "mm", worldToCanvasPoint });
    assert.equal(formatGridSpacing(paths.spacing), "0.05 mm");
    const values = paths.xLabels.map((label) => Number(label.text)).sort((a, b) => a - b);
    strides.add(Math.round((values[1] - values[0]) * 100));
  }
  assert.equal(strides.size, 1, [...strides].join(","));
});

test("an overlay too short for the label row has no labels", () => {
  // 400 x 45 px at 10 px/mm: x in [-10, 30], y in [-2, 2.5].
  const rect = { width: 400, height: 45 };
  const bounds = { minX: -10, maxX: 30, minY: -2, maxY: 2.5 };
  const worldToCanvasPoint = ({ x, y }) => ({ x: (x + 10) * 10, y: (2.5 - y) * 10 });
  const paths = buildGridPaths({ rect, bounds, unit: "mm", worldToCanvasPoint });
  assert.ok(paths.major.length > 0);
  assert.deepEqual(paths.xLabels, []);
  assert.deepEqual(paths.yLabels, []);
});

test("an empty overlay or world area draws nothing", () => {
  const view = linearView();
  assert.equal(buildGridPaths({ ...view, rect: { width: 0, height: 300 }, unit: "mm" }), null);
  assert.equal(
    buildGridPaths({ ...view, bounds: { minX: 5, maxX: 5, minY: 0, maxY: 1 }, unit: "mm" }),
    null,
  );
});
