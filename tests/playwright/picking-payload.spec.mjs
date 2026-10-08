import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// gc() lets the test see which payloads are still reachable.
test.use({ launchOptions: { args: ["--js-flags=--expose-gc"] } });

const padLayer = (name, x) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(`%FSLAX24Y24*%
%MOMM*%
%ADD10C,1.000*%
D10*
X${x}Y000000D03*
M02*`),
});

const drillFile = {
  name: "smoke-test.drl",
  mimeType: "text/plain",
  buffer: readFileSync(fileURLToPath(new URL("../../demo/smoke-test.drl", import.meta.url))),
};

// Before each picking import, collects garbage and counts the payloads still
// alive anywhere: picking payloads imported earlier in the same index build,
// and render payloads already added to a renderer. Both have their copy in
// WASM by then.
//
// A WeakRef keeps its target alive until the end of the job that created or
// dereferenced it, so this relies on the viewer waiting for a frame between
// two imports and between the last render payload and the first import, as
// it does now. A payload handed to console.* would also stay reachable
// through the inspector Playwright attaches.
async function countLivePayloadsPerImport(page) {
  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const build = GerberViewer.prototype.buildInteractionLayersForRecords;
    const processor = wasm.GerberProcessor.prototype;
    const addRender = processor.add_render_payload;
    const addDrillRender = processor.add_drill_render_payload;
    const addInteraction = processor.add_interaction_payload;
    const alive = (references) =>
      references.filter((reference) => reference.deref() !== undefined).length;
    window.__live = [];
    let imported = [];
    let rendered = [];
    GerberViewer.prototype.buildInteractionLayersForRecords = function (...args) {
      imported = [];
      window.__live.push([]);
      return build.apply(this, args);
    };
    processor.add_render_payload = function (payload) {
      const result = addRender.call(this, payload);
      rendered.push(new WeakRef(payload));
      return result;
    };
    processor.add_drill_render_payload = function (payload) {
      const result = addDrillRender.call(this, payload);
      rendered.push(new WeakRef(payload));
      return result;
    };
    processor.add_interaction_payload = function (layerId, payload) {
      globalThis.gc();
      window.__live.at(-1).push({ picking: alive(imported), render: alive(rendered) });
      const result = addInteraction.call(this, layerId, payload);
      imported.push(new WeakRef(payload));
      return result;
    };
  });
}

const nothingAlive = { picking: 0, render: 0 };

async function openViewer(page) {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-wasm-main", /^wasm/);
  await countLivePayloadsPerImport(page);
}

test("each layer's payloads are released once the main instance has them", async ({ page }) => {
  await openViewer(page);
  await page.locator("#file-input").setInputFiles([
    padLayer("a.gtl", "000000"),
    padLayer("b.gbl", "020000"),
    padLayer("c.gto", "040000"),
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(3);

  // Re-parsing for a parser option builds the renderer and the index again.
  await page.locator("#region-arc-approximate").evaluate((input) => {
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });

  expect(await page.evaluate(() => window.__live)).toEqual([
    [nothingAlive, nothingAlive, nothingAlive],
    [nothingAlive, nothingAlive, nothingAlive],
  ]);
});

test("mixed Gerber and drill uploads release both worker payloads", async ({ page }) => {
  await openViewer(page);
  await page.locator("#file-input").setInputFiles([padLayer("a.gtl", "000000"), drillFile]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1);

  expect(await page.evaluate(() => window.__live)).toEqual([[nothingAlive, nothingAlive]]);
});
