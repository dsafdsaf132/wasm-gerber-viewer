import { expect, test } from "@playwright/test";

// A small board with every shape the anti-aliasing option touches: round
// pads (discs), a holed pad, a straight track, an arc track and a filled
// region, inside a 40 x 30 mm outline.
function sampleGerber() {
  const coordinate = (v) => Math.round(v * 1e6);
  const point = (x, y) => `X${coordinate(x)}Y${coordinate(y)}`;
  const lines = [
    "G04 anti-aliasing sample*",
    "%FSLAX46Y46*%",
    "%MOMM*%",
    "%ADD10C,0.8*%",
    "%ADD11C,1.6X0.6*%",
    "%ADD12C,0.25*%",
    "%ADD13C,0.1*%",
    "G75*",
    "G01*",
    "%LPD*%",
    "D10*",
  ];
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 8; column++) {
      lines.push(`${point(4 + column * 1.5, 4 + row * 1.5)}D03*`);
    }
  }
  lines.push("D11*", `${point(20, 8)}D03*`, `${point(24, 8)}D03*`);
  lines.push("D12*", `${point(4, 16)}D02*`, `${point(34, 22)}D01*`);
  lines.push(`${point(30, 6)}D02*`, `G03${point(30, 14)}I0J${coordinate(4)}D01*`, "G01*");
  lines.push("G36*", `${point(6, 20)}D02*`, `${point(14, 21)}D01*`, `${point(10, 27)}D01*`, `${point(6, 20)}D01*`, "G37*");
  lines.push("D13*");
  [[0, 0, "D02"], [0, 30, "D01"], [40, 30, "D01"], [40, 0, "D01"], [0, 0, "D01"]].forEach(([x, y, op]) =>
    lines.push(`${point(x, y)}${op}*`),
  );
  lines.push("M02*");
  return `${lines.join("\n")}\n`;
}

/** Canvas pixels that differ from the background: how many, and how many
 *  are partially covered (neither background nor the fully covered colour
 *  of the brightest pixel). */
async function ink(page) {
  return page.locator("#gerber-canvas").evaluate((canvas) => {
    const gl = canvas.getContext("webgl2");
    gl.finish();
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const [r, g, b] = pixels;
    const distances = [];
    for (let index = 0; index < pixels.length; index += 4) {
      const distance =
        Math.abs(pixels[index] - r) + Math.abs(pixels[index + 1] - g) + Math.abs(pixels[index + 2] - b);
      if (distance) distances.push(distance);
    }
    const full = Math.max(0, ...distances);
    const partial = distances.filter((distance) => distance < full * 0.9).length;
    return { count: distances.length, partial };
  });
}

test("anti-aliasing is off by default and adds edge coverage when enabled", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "anti-aliasing.gbr",
    mimeType: "text/plain",
    buffer: Buffer.from(sampleGerber()),
  });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#visible-layer-count")).toHaveText("1 / 1");

  await page.locator("[data-panel-tab='options']").click();
  await expect(page.locator("#anti-aliasing-off")).toBeChecked();
  const inkOff = await ink(page);

  await page.locator("#anti-aliasing-on").check({ force: true });
  await page.waitForTimeout(400);
  const inkOn = await ink(page);

  // Point sampling lights whole pixels; anti-aliasing adds partially covered
  // edge pixels around every pad, track and region, so more pixels differ
  // from the background and many of them are in between.
  expect(inkOn.count).toBeGreaterThan(inkOff.count * 1.1);
  expect(inkOn.partial).toBeGreaterThan(inkOff.partial + 200);

  // Switching back gives the point-sampled picture again.
  await page.locator("#anti-aliasing-off").check({ force: true });
  await page.waitForTimeout(400);
  expect(await ink(page)).toEqual(inkOff);
});
