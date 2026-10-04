import { expect, test } from "@playwright/test";

// CircuitCAM writes RS-274X layers with a .gbx extension.
const gbxSource = `%FSLAX44Y44*%
%MOMM*%
%ADD10C,0.50000*%
D10*
X00100000Y00100000D03*
X00200000Y00200000D03*
M02*`;

test("Open dialog accepts .gbx Gerber files", async ({ page }) => {
  await page.goto("/");
  const accept = await page.locator("#file-input").getAttribute("accept");
  expect(accept.split(",")).toContain(".gbx");
});

test(".gbx file loads as a Gerber layer", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "stencil-top.gbx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(gbxSource),
  });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });

  const layer = page.locator(".gerber-layer-item");
  await expect(layer).toHaveCount(1);
  await expect(layer).toContainText("stencil-top.gbx");
  // Circles (r 0.25) at (10,10) and (20,20): X 9.75..20.25, Y 9.75..20.25.
  await expect(layer).toContainText("10.500 x 10.500 mm");
  await expect(page.locator("#visible-layer-count")).toHaveText("1 / 1");
});
