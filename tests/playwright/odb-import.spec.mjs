import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const sampleTgz = fileURLToPath(new URL("../../demo/odb-sample.tgz", import.meta.url));
const sampleZip = fileURLToPath(new URL("../../demo/odb-sample.zip", import.meta.url));
const symbolGalleryTgz = fileURLToPath(new URL("../../demo/odb-symbol-gallery.tgz", import.meta.url));

const EXPECTED_GERBER_LAYERS = [
  "profile.gko",
  "sst.gto",
  "spt.gtp",
  "smt.gts",
  "top.gtl",
  "bottom.gbl",
  "smb.gbs",
];
const EXPECTED_DRILL_LAYERS = ["drill-pth.drl", "drill-npth.drl", "rout-npth.drl"];

async function uploadAndWait(page, file, layerCount = EXPECTED_GERBER_LAYERS.length + EXPECTED_DRILL_LAYERS.length) {
  await page.locator("#file-input").setInputFiles(file);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#visible-layer-count")).toHaveText(`${layerCount} / ${layerCount}`);
}

async function layerNames(page, selector) {
  return page.locator(selector).evaluateAll((items) =>
    items.map((item) => item.querySelector("strong")?.textContent.trim() ?? item.textContent.trim()),
  );
}

test("Open dialog accepts ODB++ archives", async ({ page }) => {
  await page.goto("/");
  const accept = (await page.locator("#file-input").getAttribute("accept")).split(",");
  expect(accept).toContain(".tgz");
  expect(accept).toContain(".tar");
  expect(accept).toContain(".gz");
});

test("an ODB++ .tgz job loads as named Gerber and drill layers", async ({ page }) => {
  await page.goto("/");
  await uploadAndWait(page, sampleTgz);

  expect(await layerNames(page, ".gerber-layer-item")).toEqual(EXPECTED_GERBER_LAYERS);
  expect(await layerNames(page, ".drill-layer-item")).toEqual(EXPECTED_DRILL_LAYERS);

  const profile = page.locator(".gerber-layer-item", { hasText: "profile.gko" });
  await expect(profile).toContainText("40.100 x 30.100 mm");
  const top = page.locator(".gerber-layer-item", { hasText: "top.gtl" });
  await expect(top).toContainText(/\d{2}\.\d{3} x \d{2}\.\d{3} mm/);
  await expect(page.locator("#bounds-readout")).toHaveText("40.100 x 30.100 mm");

  // The step profile is picked up as the board outline candidate.
  await expect(page.locator("#board-outline-select")).toContainText("profile.gko");

  // The demo job converts completely: no warnings or errors are reported.
  const diagnostics = page.locator("[data-panel='diagnostics']");
  await page.locator("[data-panel-tab='diagnostics']").click();
  await expect(diagnostics).not.toContainText("warning");
  await expect(diagnostics).not.toContainText("danger");
  await expect(diagnostics).not.toContainText("error");
});

test("top and bottom filters use the generated layer names", async ({ page }) => {
  await page.goto("/");
  await uploadAndWait(page, sampleTgz);

  await page.locator("#select-top-btn").click();
  await expect(page.locator("#visible-layer-count")).toContainText(/^\d+ \/ 10$/);
  const visibleAfterTop = await page.locator(".gerber-layer-item input[type=checkbox]:checked").count();
  expect(visibleAfterTop).toBeGreaterThan(0);
  expect(visibleAfterTop).toBeLessThan(EXPECTED_GERBER_LAYERS.length);
  const bottomChecked = await page
    .locator(".gerber-layer-item", { hasText: "bottom.gbl" })
    .locator("input[type=checkbox]")
    .isChecked();
  expect(bottomChecked).toBe(false);
});

test("the same job inside a .zip loads identically, and surfaces keep holes in approximate arc mode", async ({ page }) => {
  await page.goto("/");
  await uploadAndWait(page, sampleZip);
  expect(await layerNames(page, ".gerber-layer-item")).toEqual(EXPECTED_GERBER_LAYERS);
  const exactBounds = await page.locator("#bounds-readout").textContent();

  await page.locator("[data-panel-tab='options']").click();
  const approximate = page.locator("#region-arc-approximate");
  await approximate.check({ force: true });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#bounds-readout")).toHaveText(exactBounds);
});

test("the symbol gallery demo renders every standard symbol family without diagnostics", async ({ page }) => {
  await page.goto("/");
  await uploadAndWait(page, symbolGalleryTgz, 2);

  expect(await layerNames(page, ".gerber-layer-item")).toEqual(["profile.gko", "top.gtl"]);
  await expect(page.locator("#bounds-readout")).toHaveText("41.100 x 71.100 mm");

  const diagnostics = page.locator("[data-panel='diagnostics']");
  await page.locator("[data-panel-tab='diagnostics']").click();
  await expect(diagnostics).not.toContainText("warning");
  await expect(diagnostics).not.toContainText("danger");
  await expect(diagnostics).not.toContainText("error");
});

test("plain Gerber archives still load through the ordinary path", async ({ page }) => {
  await page.goto("/");
  const gerber = "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX000000Y000000D03*\nX100000Y000000D03*\nM02*\n";
  const { gzipSync } = await import("node:zlib");
  const { writeTar } = await import("../../packages/wasm-gerber-renderer/test/helpers/odb-fixture.mjs");
  const tgz = Buffer.from(gzipSync(writeTar({ "board/top.gtl": gerber })));
  await page.locator("#file-input").setInputFiles({ name: "board.tgz", mimeType: "application/gzip", buffer: tgz });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1);
  await expect(page.locator(".gerber-layer-item")).toContainText("top.gtl");
  await expect(page.locator(".gerber-layer-item")).toContainText("11.000 x 1.000 mm");
});
