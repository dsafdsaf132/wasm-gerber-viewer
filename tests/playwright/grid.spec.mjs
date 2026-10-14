import { expect, test } from "@playwright/test";

// A 40 x 30 mm board outline with a few pads, enough to give the view a size.
function sampleGerber() {
  const coordinate = (v) => Math.round(v * 1e6);
  const point = (x, y) => `X${coordinate(x)}Y${coordinate(y)}`;
  const lines = ["G04 grid sample*", "%FSLAX46Y46*%", "%MOMM*%", "%ADD10C,0.8*%", "%ADD11C,0.1*%", "G01*", "%LPD*%"];
  lines.push("D10*", `${point(5, 5)}D03*`, `${point(35, 25)}D03*`);
  lines.push("D11*");
  [[0, 0, "D02"], [0, 30, "D01"], [40, 30, "D01"], [40, 0, "D01"], [0, 0, "D01"]].forEach(([x, y, op]) =>
    lines.push(`${point(x, y)}${op}*`),
  );
  lines.push("M02*");
  return `${lines.join("\n")}\n`;
}

async function openSample(page) {
  await page.goto("/");
  // The option radios are checked once the WASM module has loaded; uploading
  // before that is lost (see anti-aliasing.spec.mjs).
  await expect(page.locator("#grid-off")).toBeChecked({ timeout: 60_000 });
  await page.locator("#file-input").setInputFiles({
    name: "grid.gbr",
    mimeType: "text/plain",
    buffer: Buffer.from(sampleGerber()),
  });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#visible-layer-count")).toHaveText("1 / 1");
  await page.locator("[data-panel-tab='options']").click();
}

// A 1-2-5 step: 1, 2, 5, 10, 20, 50, ... or 0.5, 0.02, 0.001, ...
const STEP = String.raw`(?:[125]0*|0\.0*[125])`;
const spacingLabel = (units) => new RegExp(`^${STEP} (?:${units})$`);

async function setGrid(page, on) {
  await page.locator(on ? "#grid-on" : "#grid-off").check({ force: true });
}

/** Distances in CSS pixels between neighbouring vertical grid lines. */
async function minorCellPixels(page) {
  return page.locator("#grid-overlay").evaluate((overlay) => {
    const xs = [...overlay.querySelectorAll("path")]
      .flatMap((path) => [...path.getAttribute("d").matchAll(/M(-?[\d.]+) 0V/g)])
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, index) => x - xs[index]);
    return { min: Math.min(...gaps), max: Math.max(...gaps), lines: xs.length };
  });
}

const gridPathData = (page) =>
  page.locator("#grid-overlay").evaluate((overlay) =>
    [...overlay.querySelectorAll("path")].map((path) => path.getAttribute("d")).join("|"),
  );

/** Wheel-zooms about a point left of centre and waits for the grid to redraw. */
async function zoomBy(page, steps) {
  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  const before = await gridPathData(page);
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
  for (let index = 0; index < Math.abs(steps); index++) {
    await page.mouse.wheel(0, steps > 0 ? -240 : 240);
  }
  await expect.poll(() => gridPathData(page)).not.toBe(before);
}

test("grid is off by default and leaves the overlay empty", async ({ page }) => {
  await openSample(page);
  await expect(page.locator("#grid-off")).toBeChecked();
  await expect(page.locator("#grid-overlay > *")).toHaveCount(0);
  await expect(page.locator("#grid-spacing-pill")).toBeHidden();
});

test("turning the grid on draws it, persists, and turning it off empties it", async ({ page }) => {
  await openSample(page);
  await setGrid(page, true);
  await expect(page.locator("#grid-overlay path.grid-minor")).toHaveCount(1);
  await expect(page.locator("#grid-overlay path.grid-major")).toHaveCount(1);
  await expect(page.locator("#grid-spacing-pill")).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("wasm-gerber-viewer.options.v2")).grid,
  );
  expect(stored).toBe(true);

  // After a reload the option is restored, and the grid comes back with the
  // first layer: it stays hidden while the "No Layers Loaded" screen shows.
  await page.reload();
  await expect(page.locator("#grid-on")).toBeChecked({ timeout: 60_000 });
  await expect(page.locator("#grid-overlay > *")).toHaveCount(0);
  await expect(page.locator("#grid-spacing-pill")).toBeHidden();
  await page.locator("#file-input").setInputFiles({
    name: "grid.gbr",
    mimeType: "text/plain",
    buffer: Buffer.from(sampleGerber()),
  });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#grid-overlay path.grid-major")).toHaveCount(1);

  await page.locator("[data-panel-tab='options']").click();
  await setGrid(page, false);
  await expect(page.locator("#grid-overlay > *")).toHaveCount(0);
  await expect(page.locator("#grid-spacing-pill")).toBeHidden();
});

test("minor cells stay between 8 and 20 pixels while zooming far in and out", async ({ page }) => {
  await openSample(page);
  await setGrid(page, true);
  const labels = new Set();
  for (const steps of [0, 12, 12, -12, -12, -12]) {
    if (steps) await zoomBy(page, steps);
    const cells = await minorCellPixels(page);
    expect(cells.lines).toBeGreaterThan(1);
    expect(cells.min).toBeGreaterThanOrEqual(7.8);
    expect(cells.max).toBeLessThanOrEqual(20.2);
    labels.add(await page.locator("#grid-spacing-readout").textContent());
  }
  // Zooming changes the spacing rather than the cell size.
  expect(labels.size).toBeGreaterThan(2);
});

test("the spacing label follows the measurement unit", async ({ page }) => {
  await openSample(page);
  await setGrid(page, true);
  const readout = page.locator("#grid-spacing-readout");
  await expect(readout).toHaveText(spacingLabel("mm"));

  await page.locator("#measurement-unit-toggle").click();
  await expect(readout).toHaveText(spacingLabel("in|mil"));

  await page.locator("#measurement-unit-toggle").click();
  await expect(readout).toHaveText(spacingLabel("mm"));
});

test("inch spacing switches from inches to mils when zooming in", async ({ page }) => {
  await openSample(page);
  await setGrid(page, true);
  await page.locator("#measurement-unit-toggle").click();
  const readout = page.locator("#grid-spacing-readout");

  // Zoom out until the spacing is a whole number of inches, then back in
  // until it drops below one inch and is written in mils.
  for (let attempt = 0; attempt < 10 && !/ in$/.test(await readout.textContent()); attempt++) {
    await zoomBy(page, -6);
  }
  await expect(readout).toHaveText(spacingLabel("in"));
  for (let attempt = 0; attempt < 10 && !/ mil$/.test(await readout.textContent()); attempt++) {
    await zoomBy(page, 3);
  }
  await expect(readout).toHaveText(spacingLabel("mil"));
});

test("grid lines switch colour with the canvas theme", async ({ page }) => {
  await openSample(page);
  await setGrid(page, true);
  const stroke = () =>
    page.locator("#grid-overlay path.grid-major").evaluate((path) => getComputedStyle(path).stroke);
  const dark = await stroke();
  await page.locator("#canvas-theme-toggle").click();
  await expect.poll(stroke).not.toBe(dark);
  await page.locator("#canvas-theme-toggle").click();
  await expect.poll(stroke).toBe(dark);
});
