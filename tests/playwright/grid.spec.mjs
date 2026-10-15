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
  // Wait for WASM initialization before uploading.
  await expect(page.locator("#region-arc-exact")).toBeChecked({ timeout: 60_000 });
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
  const toggle = page.locator("#grid-toggle-btn");
  if ((await toggle.getAttribute("aria-pressed")) !== String(on)) {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-pressed", String(on));
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
  await expect(page.locator("#grid-toggle-btn")).toHaveAttribute("aria-pressed", "false");
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
  await expect(page.locator("#grid-toggle-btn")).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
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
  // Zooming rewrites the path data of the same two elements.
  await page.locator("#grid-overlay path.grid-major").evaluate((path) => {
    path.dataset.probe = "first";
  });
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
  await expect(page.locator("#grid-overlay > path")).toHaveCount(4);
  await expect(page.locator("#grid-overlay path.grid-major")).toHaveAttribute("data-probe", "first");
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

test("axes and the origin marker follow the world origin", async ({ page }) => {
  await openSample(page);
  await setGrid(page, true);
  // The sample board spans 0..40 x 0..30 mm, so a fitted view shows the origin.
  await expect(page.locator("#grid-overlay path.grid-axis")).toHaveCount(1);
  const originAndAxes = () =>
    page.locator("#grid-overlay").evaluate((overlay) => {
      const axes = overlay.querySelector(".grid-axis").getAttribute("d");
      const origin = overlay.querySelector(".grid-origin").getAttribute("d");
      const vertical = [...axes.matchAll(/M(-?[\d.]+) 0V/g)].map((match) => Number(match[1]));
      const horizontal = [...axes.matchAll(/M0 (-?[\d.]+)H/g)].map((match) => Number(match[1]));
      const centre = origin.match(/^M(-?[\d.]+) (-?[\d.]+)/);
      return { vertical, horizontal, centre: centre && [Number(centre[1]), Number(centre[2])] };
    });
  const fitted = await originAndAxes();
  expect(fitted.vertical).toHaveLength(1);
  expect(fitted.horizontal).toHaveLength(1);
  expect(fitted.centre).toEqual([fitted.vertical[0], fitted.horizontal[0]]);

  // Panning moves the axes and the marker together.
  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 3 + 60, box.y + box.height / 2 - 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await originAndAxes()).vertical[0]).not.toBe(fitted.vertical[0]);
  const panned = await originAndAxes();
  expect(panned.vertical[0] - fitted.vertical[0]).toBeCloseTo(60, 0);
  expect(panned.horizontal[0] - fitted.horizontal[0]).toBeCloseTo(-40, 0);
  expect(panned.centre).toEqual([panned.vertical[0], panned.horizontal[0]]);
});

test("coordinate labels stay inside the view without overlapping while zooming", async ({ page }) => {
  await openSample(page);
  await setGrid(page, true);
  await page.locator("#grid-overlay .grid-x-labels text").first().evaluate((text) => {
    text.parentNode.dataset.probe = "first";
  });

  const labelBoxes = () =>
    page.locator("#grid-overlay").evaluate((overlay) => {
      const view = overlay.getBoundingClientRect();
      const status = document.querySelector(".canvas-status").getBoundingClientRect();
      const hud = document.querySelector(".viewport-hud").getBoundingClientRect();
      const boxes = [...overlay.querySelectorAll(".grid-labels text")].map((text) => {
        const box = text.getBoundingClientRect();
        return { text: text.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      });
      return {
        boxes,
        view: { left: view.left, right: view.right, top: view.top, bottom: view.bottom },
        statusTop: status.top,
        hud: { left: hud.left, right: hud.right, top: hud.top, bottom: hud.bottom },
      };
    });
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  for (const steps of [0, 10, 10, -10, -10, -10]) {
    if (steps) await zoomBy(page, steps);
    const { boxes, view, statusTop, hud } = await labelBoxes();
    expect(boxes.length).toBeGreaterThan(2);
    for (const box of boxes) {
      expect(box.text).toMatch(/^-?\d+(?:\.\d+)?$/);
      expect(box.left).toBeGreaterThanOrEqual(view.left - 0.5);
      expect(box.right).toBeLessThanOrEqual(view.right + 0.5);
      expect(box.bottom).toBeLessThanOrEqual(statusTop + 0.5);
      expect(overlaps(box, hud), `${box.text} under the HUD`).toBe(false);
    }
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        expect(overlaps(boxes[a], boxes[b]), `${boxes[a].text} / ${boxes[b].text}`).toBe(false);
      }
    }
  }
  // The label groups are reused rather than recreated.
  await expect(page.locator("#grid-overlay .grid-x-labels")).toHaveAttribute("data-probe", "first");
});

test("coordinate labels follow the measurement unit", async ({ page }) => {
  await openSample(page);
  await setGrid(page, true);
  const labels = () =>
    page.locator("#grid-overlay .grid-x-labels text").evaluateAll((texts) => texts.map((text) => text.textContent));
  const readout = page.locator("#grid-spacing-readout");

  // The fitted 40 mm board has labels at 0 and at 10 mm, written with the
  // decimals of the spacing ("0", "0.0" or "0.00").
  const mm = await labels();
  expect(mm.some((text) => Number(text) === 0)).toBe(true);
  expect(mm.some((text) => Number(text) === 10)).toBe(true);

  await page.locator("#measurement-unit-toggle").click();
  await expect(readout).toHaveText(spacingLabel("in|mil"));
  const unit = (await readout.textContent()).split(" ")[1];
  const step = Number((await readout.textContent()).split(" ")[0]);
  const imperial = await labels();
  expect(imperial).not.toEqual(mm);
  // Every label is a multiple of five minor steps, in the readout's unit.
  for (const text of imperial) {
    const ratio = Number(text) / (step * 5);
    expect(Math.abs(ratio - Math.round(ratio)), `${text} ${unit}`).toBeLessThan(1e-6);
  }
});
