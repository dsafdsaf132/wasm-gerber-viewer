import { expect, test } from "@playwright/test";

const leftSource = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,4.000*%
D10*
X-015000Y000000D03*
M02*`;

const rightSource = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,4.000*%
D10*
X015000Y000000D03*
M02*`;

const outlineSource = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.200*%
D10*
X-050000Y-050000D02*
X050000Y-050000D01*
X050000Y050000D01*
X-050000Y050000D01*
X-050000Y-050000D01*
M02*`;

const disconnectedSource = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,2.000*%
D10*
X-025000Y000000D03*
X025000Y000000D03*
M02*`;

const centerSource = `%FSLAX24Y24*%
%MOMM*%
%ADD10C,1.000*%
D10*
X000000Y000000D03*
M02*`;

const drillSource = `M48
METRIC,LZ
T01C0.800
%
T01
X010000Y010000
X020000Y020000
X030000Y010000
M30`;

async function loadTwoSources(page) {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "left.gtl", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
    { name: "right.gbl", mimeType: "text/plain", buffer: Buffer.from(rightSource) },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(2);
  await expect(page.locator(".layer-create-composite button")).toBeEnabled();
}

async function loadThreeSources(page) {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "left.gtl", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
    { name: "right.gbl", mimeType: "text/plain", buffer: Buffer.from(rightSource) },
    { name: "board-outline.gko", mimeType: "text/plain", buffer: Buffer.from(outlineSource) },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(3);
}

async function createCompositeFromSources(page, name, sourceNames) {
  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog.locator("[data-composite-name]").fill(name);
  for (const sourceName of sourceNames) {
    await dialog
      .locator(".composite-source-choice", { hasText: sourceName })
      .locator("input")
      .check();
  }
  await dialog.locator("[data-composite-submit]").click();
  const row = page.locator(".composite-layer-item").filter({
    has: page.getByText(name, { exact: true }),
  });
  await expect(row).toHaveCount(1);
  return row;
}

async function createComposite(page, name = "Coverage") {
  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-composite-name]").fill(name);
  const sourceChoices = dialog.locator(".composite-source-choice input");
  for (let index = 0; index < await sourceChoices.count(); index += 1) {
    await sourceChoices.nth(index).check();
  }
  await expect(dialog.locator("[data-composite-count]")).toHaveText("2 / 24");
  await dialog.locator('[data-composite-preset="difference"]').click();
  await dialog.locator("[data-composite-submit]").click();
  const row = page.locator(".composite-layer-item").filter({
    has: page.getByText(name, { exact: true }),
  });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".layer-label strong")).toHaveText(name);
  await expect(
    page.locator("#layer-list > .layer-group-heading", { hasText: "Composite Layers" }),
  ).toHaveCount(1);
  const sectionOrder = await page.locator("#layer-list").evaluate((list) =>
    Array.from(list.children).map((child) =>
      child.classList.contains("layer-group-heading")
        ? child.textContent.trim()
        : child.classList.contains("composite-layer-item")
          ? "composite-row"
          : child.classList.contains("gerber-layer-item")
            ? "gerber-row"
            : null));
  expect(sectionOrder.indexOf("Composite Layers")).toBeLessThan(
    sectionOrder.indexOf("composite-row"),
  );
  expect(sectionOrder.indexOf("composite-row")).toBeLessThan(
    sectionOrder.indexOf("Gerber Layers"),
  );
  const layerId = await row.getAttribute("data-layer-id");
  return page.locator(`.composite-layer-item[data-layer-id="${layerId}"]`);
}

async function readCanvasPixel(page, xRatio = 0.5, yRatio = 0.5) {
  return page.locator("#gerber-canvas").evaluate((canvas, { xRatio, yRatio }) => {
    const gl = canvas.getContext("webgl2");
    gl.finish();
    const pixel = new Uint8Array(4);
    gl.readPixels(
      Math.min(canvas.width - 1, Math.max(0, Math.floor(canvas.width * xRatio))),
      Math.min(canvas.height - 1, Math.max(0, Math.floor(canvas.height * (1 - yRatio)))),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    );
    return [...pixel];
  }, { xRatio, yRatio });
}

async function saveLayerPickrColor(page, row, rgba, { useGlobalAlpha = false } = {}) {
  await row.locator(".layer-color-picker").click();
  const pickr = page.locator(".pcr-app.layer-color-pickr:visible");
  await expect(pickr).toBeVisible();
  const useGlobal = pickr.locator(".pcr-layer-alpha-override input");
  if (await useGlobal.count()) {
    if (useGlobalAlpha) {
      await useGlobal.check();
    } else {
      await useGlobal.uncheck();
    }
  }
  await pickr.locator(".pcr-result").fill(rgba);
  await pickr.locator(".pcr-result").press("Enter");
  await pickr.locator(".pcr-save").click();
  await expect(pickr).toBeHidden();
}

async function installGatedFatalProcessorMethod(page, method, detail) {
  await page.evaluate(async ({ method, detail }) => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalMethod = processorPrototype[method];
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseInjectedCompositeFatal = releaseRecovery;
    window.__injectedCompositeFatalRecoveryStarted = false;
    viewerPrototype.restoreLayerFromSnapshot = async function delayedRestore(...args) {
      window.__injectedCompositeFatalRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let shouldFail = true;
    processorPrototype[method] = function failMethodOnce(...args) {
      if (shouldFail) {
        shouldFail = false;
        throw new WebAssembly.RuntimeError(
          `unreachable: forced fatal recovery test in ${detail}`,
        );
      }
      return originalMethod.apply(this, args);
    };
  }, { method, detail });
}

async function waitForInjectedFatalRecovery(page) {
  await expect
    .poll(() => page.evaluate(() => window.__injectedCompositeFatalRecoveryStarted))
    .toBe(true);
  await expect(page.locator("#workspace-status")).toHaveText("Rebuilding renderer");
}

async function releaseInjectedFatalRecovery(page) {
  await page.evaluate(() => window.__releaseInjectedCompositeFatal());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => {
    if (
      !error.message.includes("forced fatal recovery test") &&
      !error.message.includes("forced screenshot renderer setup failure")
    ) {
      errors.push(error.message);
    }
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("forced fatal recovery test") &&
      !message.text().includes("forced screenshot renderer setup failure")
    ) {
      errors.push(message.text());
    }
  });
  page.on("close", () => {
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test("creates, renames, applies presets, and edits a composite", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page);

  await row.click({ button: "right" });
  const menu = page.locator(".layer-context-menu");
  await expect(menu).toBeVisible();
  await menu.locator('[data-layer-menu-action="composite-intersection"]').click();

  await row.click({ button: "right" });
  await menu.locator('[data-layer-menu-action="rename-layer"]').click();
  const renameDialog = page.locator(".composite-layer-dialog");
  await renameDialog.locator("[data-composite-name]").fill("Renamed coverage");
  await renameDialog.locator("[data-composite-submit]").click();
  await expect(row.locator(".layer-label strong")).toHaveText("Renamed coverage");

  await row.locator(".layer-menu-btn").click();
  await menu.locator('[data-layer-menu-action="edit-composite"]').click();
  await expect(page.locator(".composite-layer-dialog [data-composite-count]")).toHaveText("2 / 24");
  await page.locator('.composite-layer-dialog [data-composite-preset="union"]').click();
  await page.locator(".composite-layer-dialog [data-composite-submit]").click();
  await expect(page.locator(".composite-layer-dialog")).toBeHidden();
});

test("ordinary Gerber and drill workflows remain compatible without composites", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(async () =>
    (await fetch("/js/core/viewer.js", { cache: "reload" })).headers.get("cache-control"),
  )).toBe("no-store");
  await expect(page.locator("#workspace-status")).toHaveText("Ready");

  await page.locator("#file-input").setInputFiles([
    { name: "left.gtl", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
    { name: "right.gbl", mimeType: "text/plain", buffer: Buffer.from(rightSource) },
    { name: "board-outline.gko", mimeType: "text/plain", buffer: Buffer.from(outlineSource) },
    { name: "legacy.drl", mimeType: "text/plain", buffer: Buffer.from(drillSource) },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(3);
  await expect(page.locator(".drill-layer-item")).toHaveCount(1);
  await expect(page.locator(".composite-layer-item")).toHaveCount(0);
  await expect(page.locator("#workspace-status")).toHaveText("4 visible / 4 loaded");

  // A same-task layer-list refresh must destroy the open Pickr and cancel its
  // pending focus frame without leaving a detached picker or stale callback.
  await page.evaluate(() => {
    const row = document.querySelector(".gerber-layer-item");
    row.querySelector(".layer-color-picker").click();
    row.querySelector(".layer-checkbox").click();
  });
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator(".pcr-app.layer-color-pickr")).toHaveCount(4);
  await page
    .locator(".gerber-layer-item:not(.composite-layer-item)")
    .first()
    .locator(".layer-checkbox")
    .check();
  await expect(page.locator("#workspace-status")).toHaveText("4 visible / 4 loaded");

  const drill = page.locator(".drill-layer-item");
  await drill.locator(".layer-menu-btn").click();
  const menu = page.locator(".layer-context-menu");
  await expect(menu.locator('[data-layer-menu-action="rename-layer"]')).toBeEnabled();
  await expect(menu.locator('[data-layer-menu-action="invert-layer"]')).toBeDisabled();
  for (const action of [
    "edit-composite",
    "composite-union",
    "composite-intersection",
    "composite-difference",
    "select-visible-area",
  ]) {
    await expect(menu.locator(`[data-layer-menu-action="${action}"]`)).toBeHidden();
  }
  await menu.locator('[data-layer-menu-action="rename-layer"]').click();
  const renameDialog = page.locator(".composite-layer-dialog");
  await renameDialog.locator("[data-composite-name]").fill("Legacy plated drill");
  await renameDialog.locator("[data-composite-submit]").click();
  await expect(page.locator(".drill-layer-item .layer-label strong")).toHaveText(
    "Legacy plated drill",
  );

  const canvas = page.locator("#gerber-canvas");
  const beforeInvert = await canvas.screenshot();
  await page.locator("#board-outline-select").selectOption({
    label: "board-outline.gko",
  });
  const left = page.locator(".gerber-layer-item").filter({
    has: page.getByText("left.gtl", { exact: true }),
  });
  await left.locator(".layer-menu-btn").click();
  for (const action of [
    "edit-composite",
    "composite-union",
    "composite-intersection",
    "composite-difference",
    "select-visible-area",
  ]) {
    await expect(menu.locator(`[data-layer-menu-action="${action}"]`)).toBeHidden();
  }
  await menu.locator('[data-layer-menu-action="invert-layer"]').click();
  await expect(left).toHaveClass(/layer-item-inverted/);
  await expect.poll(async () => (await canvas.screenshot()).equals(beforeInvert)).toBe(false);

  await left.locator(".layer-checkbox").uncheck();
  await expect(page.locator("#workspace-status")).toHaveText("3 visible / 4 loaded");
  await left.locator(".layer-checkbox").check();
  await expect(page.locator("#workspace-status")).toHaveText("4 visible / 4 loaded");

  await page.locator('[data-panel-tab="options"]').click();
  await page.locator('label:has(#rendering-mode-realtime)').click();
  await expect(page.locator("#rendering-mode-realtime")).toBeChecked();
  await page.locator('label:has(#composite-mode-stack)').click();
  await expect(page.locator("#composite-mode-stack")).toBeChecked();
  await page.locator('label:has(#interaction-mode-off)').click();
  await expect(page.locator("#interaction-mode-off")).toBeChecked();
  await page.locator('label:has(#interaction-mode-on)').click();
  await expect(page.locator("#interaction-mode-on")).toBeChecked();
  await page.locator('label:has(#rendering-mode-lazy)').click();
  await page.locator('label:has(#composite-mode-blend)').click();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-btn").click();
  await page.locator("#screenshot-scale-select").selectOption("1");
  await page.locator("#screenshot-export-btn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^gerber-viewer-.*\.png$/);
  await expect(page.locator("#screenshot-dialog")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 740 });
  await expect(page.locator("#drawer-toggle")).toBeVisible();
  await page.locator("#drawer-toggle").click();
  await expect(page.locator("#drawer-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#drawer-toggle").click();
  await expect(page.locator("#drawer-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".composite-layer-item")).toHaveCount(0);

  await page.locator("#toolbar-clear-all-btn").click();
  await expect(page.locator(".layer-item[data-layer-id]")).toHaveCount(0);
  await expect(page.locator("#workspace-status")).toHaveText("Ready");
});

test("composite dialogs disambiguate duplicate source names and expose accessible state", async ({ page }) => {
  await loadTwoSources(page);

  const renameSource = async (currentName, nextName) => {
    const row = page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
      has: page.locator(".layer-label strong", { hasText: currentName }),
    });
    await row.locator(".layer-menu-btn").click();
    await page.locator('.layer-context-menu [data-layer-menu-action="rename-layer"]').click();
    const dialog = page.locator(".composite-layer-dialog");
    await expect(dialog).toHaveAccessibleName("Rename Layer");
    await dialog.locator("[data-composite-name]").fill(nextName);
    await dialog.locator("[data-composite-submit]").click();
  };

  await renameSource("left.gtl", "Shared copper");
  await renameSource("right.gbl", "Shared copper");

  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await expect(dialog).toHaveAccessibleName("Create Composite Layer");
  await expect(dialog.locator("[data-composite-search]")).toHaveAccessibleName(
    "Filter Gerber sources",
  );
  await expect(dialog.getByRole("status")).toHaveText("0 / 24");
  await expect(dialog.locator('[data-composite-preset="union"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.locator('[data-composite-preset="intersection"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const choices = dialog.locator(".composite-source-choice");
  await expect(choices).toHaveCount(2);
  const labels = await choices.allTextContents();
  expect(new Set(labels).size).toBe(2);
  expect(labels.some((label) => label.includes("left.gtl"))).toBe(true);
  expect(labels.some((label) => label.includes("right.gbl"))).toBe(true);

  await dialog.locator("[data-composite-search]").fill("left.gtl");
  await expect(choices).toHaveCount(1);
  await expect(choices).toContainText("left.gtl");
  await dialog.locator("[data-composite-search]").fill("");

  await choices.filter({ hasText: "left.gtl" }).locator("input").check();
  await choices.filter({ hasText: "right.gbl" }).locator("input").check();
  await expect(dialog.getByRole("status")).toHaveText("2 / 24");
  const selected = dialog.locator("[data-composite-selected] li");
  await expect(selected).toHaveCount(2);
  await dialog.getByRole("button", { name: /Move Shared copper.*left\.gtl.* down/ }).click();
  await expect(selected.nth(0)).toContainText("right.gbl");
  await expect(selected.nth(1)).toContainText("left.gtl");

  await dialog.locator('[data-composite-preset="difference"]').click();
  await expect(dialog.locator('[data-composite-preset="difference"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.locator('[data-composite-preset="union"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await dialog.locator("[data-composite-name]").fill("Duplicate sources");
  await dialog.locator("[data-composite-submit]").click();

  const composite = page.locator(".composite-layer-item").filter({
    has: page.getByText("Duplicate sources", { exact: true }),
  });
  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="edit-composite"]').click();
  await expect(dialog).toHaveAccessibleName("Edit Composite Layer");
  await expect(dialog.locator("[data-composite-selected] li").nth(0)).toContainText("right.gbl");
  await expect(dialog.locator("[data-composite-selected] li").nth(1)).toContainText("left.gtl");
  await dialog.locator("[data-composite-dismiss]").click();

  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="rename-layer"]').click();
  await expect(dialog).toHaveAccessibleName("Rename Layer");
  await dialog.locator("[data-composite-dismiss]").click();
});

test("Custom creates or edits a composite and immediately opens visible-area selection", async ({ page }) => {
  await loadTwoSources(page);
  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  const custom = dialog.locator("[data-composite-custom]");
  await expect(custom).toBeDisabled();
  await dialog.locator("[data-composite-name]").fill("Custom coverage");
  const choices = dialog.locator(".composite-source-choice input");
  await choices.nth(0).check();
  await expect(custom).toBeDisabled();
  await choices.nth(1).check();
  await expect(custom).toBeEnabled();
  await custom.click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();
  await expect(page.locator(".composite-selection-presets")).toBeVisible();
  await expect(page.locator("#layer-list > .composite-area-heading")).toContainText(
    "Coverage Areas",
  );
  await expect(page.locator("#layer-list .gerber-layer-item")).toHaveCount(0);
  await expect.poll(() => page.locator("#layer-list .composite-area-item").count())
    .toBeGreaterThan(0);
  const areaCheckboxes = page.locator("#layer-list [data-composite-area-code]");
  expect(await areaCheckboxes.evaluateAll((inputs) =>
    inputs.every((input) => !input.checked))).toBe(true);
  await areaCheckboxes.first().check();
  await expect(areaCheckboxes.first()).toBeChecked();
  await areaCheckboxes.first().uncheck();
  await expect(areaCheckboxes.first()).not.toBeChecked();

  const toolbarLabels = await page
    .locator(".composite-selection-presets button")
    .allTextContents();
  expect(toolbarLabels).toEqual([
    "Union",
    "Intersection",
    "Difference",
    "None",
    "Done",
  ]);
  const [noneBox, dividerBox, doneBox] = await Promise.all([
    page.locator(".composite-selection-presets").getByRole(
      "button",
      { name: "None", exact: true },
    ).boundingBox(),
    page.locator(".composite-selection-divider").boundingBox(),
    page.locator(".composite-selection-presets").getByRole(
      "button",
      { name: "Done", exact: true },
    ).boundingBox(),
  ]);
  expect(dividerBox.x).toBeGreaterThan(noneBox.x + noneBox.width);
  expect(doneBox.x).toBeGreaterThan(dividerBox.x + dividerBox.width);
  expect(doneBox.x).toBeGreaterThan(noneBox.x);
  expect(doneBox.y).toBe(noneBox.y);
  await expect(page.locator(".canvas-status")).toHaveJSProperty(
    "childElementCount",
    3,
  );
  expect(await page.locator(".canvas-status > span").evaluateAll((spans) =>
    spans.map((span) => span.id))).toEqual([
    "cursor-readout",
    "composite-selection-info",
    "bounds-readout",
  ]);
  await expect(page.locator("#composite-selection-info")).toHaveCSS(
    "text-overflow",
    "ellipsis",
  );
  await page.keyboard.press("Escape");

  const row = page.locator(".composite-layer-item").filter({
    has: page.getByText("Custom coverage", { exact: true }),
  });
  await row.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="edit-composite"]').click();
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-composite-custom]").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();
  await page.locator(".composite-selection-bar button", { hasText: "Done" }).click();
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
});

test("visible-area preset toolbar applies Union, Intersection, Difference, and None drafts", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Preset toolbar coverage");
  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const original = prototype.set_composite_visible_bits;
    window.__selectionPresetUploads = [];
    prototype.set_composite_visible_bits = function captureSelectionPreset(id, bitset) {
      window.__selectionPresetUploads.push(Array.from(bitset));
      return original.call(this, id, bitset);
    };
  });
  await row.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="select-visible-area"]').click();

  const toolbar = page.locator(".composite-selection-presets");
  await expect(toolbar).toHaveAccessibleName("Visible area presets");
  for (const [label, expectedByte] of [
    ["Union", 0xfe],
    ["Intersection", 0x08],
    ["Difference", 0x02],
    ["None", 0x00],
  ]) {
    const button = toolbar.getByRole("button", { name: label, exact: true });
    if (label === "Union") {
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(toolbar).toBeVisible();
    } else {
      await button.click();
    }
    await expect.poll(() => page.evaluate(() =>
      window.__selectionPresetUploads.at(-1)?.[0])).toBe(expectedByte);
  }

  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() =>
    window.__selectionPresetUploads.at(-1)?.[0])).toBe(0x02);
  await expect(toolbar).toBeHidden();
});

test("24-source drafts copy once and clean edits retain bitset ownership", async ({ page }) => {
  await page.goto("/");
  const metrics = await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const { CompositeLayerDialog } = await import(
      "/js/ui/composite-layer-dialog.js"
    );
    const { createCompositePresetBitset } = await import(
      "/js/layers/composite-layers.js"
    );
    const sources = Array.from({ length: 24 }, (_unused, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      sourceName: `source-${index}.gbr`,
      sourceContent: `G04 retained-source-probe-${index}*`.repeat(256),
    }));
    const authoritative = createCompositePresetBitset(24, "union");
    const layer = {
      id: "composite-probe",
      layerId: 17,
      kind: "composite",
      name: "Ownership probe",
      sourceIds: sources.map((source) => source.id),
      slotSourceIds: sources.map((source) => source.id),
      visibleBitset: authoritative,
      visible: true,
    };
    const dialog = new CompositeLayerDialog({
      getGerberLayers: () => sources,
    });
    const originalSlice = Uint8Array.prototype.slice;
    const originalSome = Uint8Array.prototype.some;
    let largeSlices = 0;
    let largeSomeCalls = 0;
    Uint8Array.prototype.slice = function trackedSlice(...args) {
      if (this.byteLength === 2 * 1024 * 1024) largeSlices += 1;
      return originalSlice.apply(this, args);
    };
    Uint8Array.prototype.some = function trackedSome(...args) {
      if (this.byteLength === 2 * 1024 * 1024) largeSomeCalls += 1;
      return originalSome.apply(this, args);
    };

    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const assertDialogReleased = (label) => {
      assert(dialog.options === null, `${label} retained dialog options`);
      assert(dialog.selectedSourceIds === null, `${label} retained source IDs`);
      assert(dialog.draftLayer === null, `${label} retained the edit draft`);
      assert(dialog.presetCommand === null, `${label} retained the preset command`);
      assert(dialog.availableList.childElementCount === 0, `${label} retained source rows`);
      assert(dialog.selectedList.childElementCount === 0, `${label} retained order rows`);
    };
    try {
      let before = largeSlices;
      const cancelPromise = dialog.openEdit(layer);
      assert(largeSlices - before === 1, "edit cancel must create one large draft");
      dialog.form.querySelector("[data-composite-dismiss]").click();
      assert(await cancelPromise === null, "cancel must resolve without a draft");
      assert(layer.visibleBitset === authoritative, "cancel replaced authoritative bitset");
      assertDialogReleased("edit cancel");

      before = largeSlices;
      const cleanPromise = dialog.openEdit(layer);
      assert(largeSlices - before === 1, "clean edit must create one large draft");
      dialog.form.querySelector("[data-composite-name]").value =
        "Renamed ownership probe";
      dialog.form
        .querySelector('[aria-label="Move Source 0 down"]')
        .click();
      dialog.form.querySelector("[data-composite-submit]").click();
      const cleanResult = await cleanPromise;
      assertDialogReleased("clean edit Apply");
      assert(
        cleanResult.name === "Renamed ownership probe",
        "clean name edit was not retained",
      );
      assert(cleanResult.bitsetDirty === false, "reorder marked the bitset dirty");
      assert(
        cleanResult.visibleBitset !== authoritative,
        "edit draft must own its buffer",
      );
      assert(largeSlices - before === 1, "Apply copied a clean large draft");

      let uploads = 0;
      let uploadedBuffer = null;
      const cleanLayer = { ...layer, visibleBitset: authoritative };
      const cleanContext = {
        layers: [cleanLayer],
        isRendererBusy: () => false,
        compositeLayerDialog: { openEdit: async () => cleanResult },
        wasmProcessor: {
          set_composite_visible_bits(_layerId, bits) {
            uploads += 1;
            uploadedBuffer = bits;
          },
        },
        removeCompositeRendererLayer: () => true,
        ensureCompositeRendererLayer: () => cleanLayer.layerId,
        refreshCompositeLayerBounds() {},
        renderLayerList() {},
        requestRender() {},
        updateUiState() {},
        scheduleCompositeFatalRecovery: () => false,
        setCompositeLayerError() {},
        showError() {},
      };
      await GerberViewer.prototype.editCompositeLayer.call(
        cleanContext,
        cleanLayer,
      );
      assert(cleanLayer.visibleBitset === authoritative, "reorder replaced bitset identity");
      assert(cleanLayer.name === "Renamed ownership probe", "clean rename was not applied");
      assert(uploads === 0, "reorder uploaded an unchanged bitset");
      assert(largeSomeCalls === 0, "reorder scanned the large bitset");
      assert(largeSlices - before === 1, "Viewer copied the clean Apply result");

      before = largeSlices;
      const dirtyPromise = dialog.openEdit(layer);
      assert(largeSlices - before === 1, "preset edit must create one large draft");
      dialog.form
        .querySelector('[data-composite-preset="intersection"]')
        .click();
      dialog.form.querySelector("[data-composite-submit]").click();
      const dirtyResult = await dirtyPromise;
      assertDialogReleased("preset edit Apply");
      assert(dirtyResult.bitsetDirty === true, "preset did not mark the bitset dirty");
      assert(largeSlices - before === 1, "preset Apply copied the large draft");

      const dirtyLayer = { ...layer, visibleBitset: authoritative };
      const dirtyContext = {
        ...cleanContext,
        layers: [dirtyLayer],
        compositeLayerDialog: { openEdit: async () => dirtyResult },
      };
      await GerberViewer.prototype.editCompositeLayer.call(
        dirtyContext,
        dirtyLayer,
      );
      assert(dirtyLayer.visibleBitset === dirtyResult.visibleBitset, "dirty draft was copied");
      assert(uploads === 1, "dirty draft was not uploaded exactly once");
      assert(uploadedBuffer === dirtyResult.visibleBitset, "upload did not use transferred draft");
      assert(largeSomeCalls === 0, "dirty Apply scanned the large bitset");
      assert(largeSlices - before === 1, "Viewer copied the dirty Apply result");

      before = largeSlices;
      const removePromise = dialog.openEdit(layer);
      assert(largeSlices - before === 1, "remove edit must create one large draft");
      dialog.form.querySelector(".composite-source-choice input:checked").click();
      dialog.form.querySelector("[data-composite-submit]").click();
      const removeResult = await removePromise;
      assertDialogReleased("source removal Apply");
      assert(removeResult.bitsetDirty === true, "source removal did not mark dirty");
      assert(removeResult.sourceIds.length === 23, "source removal was not retained");
      assert(largeSlices - before === 1, "source removal copied its owned input draft");

      const smallLayer = {
        ...layer,
        sourceIds: [sources[0].id, sources[1].id],
        slotSourceIds: [sources[0].id, sources[1].id],
        visibleBitset: createCompositePresetBitset(2, "union"),
      };
      const addPromise = dialog.openEdit(smallLayer);
      dialog.form
        .querySelector(`.composite-source-choice input:not(:checked)`)
        .click();
      dialog.form.querySelector("[data-composite-submit]").click();
      const addResult = await addPromise;
      assertDialogReleased("source addition Apply");
      assert(addResult.bitsetDirty === true, "source addition did not mark dirty");
      assert(addResult.sourceIds.length === 3, "source addition was not retained");

      before = largeSlices;
      const selectionLayer = { ...layer, visibleBitset: authoritative };
      let selectionFullUploads = 0;
      let selectionByteUploads = 0;
      const selectionContext = {
        compositeSelection: null,
        isRendererBusy: () => false,
        ensureCompositeRendererLayer: () => selectionLayer.layerId,
        wasmProcessor: {
          set_composite_visible_bits() {
            selectionFullUploads += 1;
          },
          set_composite_visible_byte() {
            selectionByteUploads += 1;
          },
          end_composite_selection() {},
        },
        isRulerActive: false,
        createCompositeSelectionBar() {},
        cancelLazyViewportRender() {},
        clearSelectedFeature() {},
        refreshCompositeLayerBounds() {},
        renderLayerList() {},
        updateUiState() {},
        requestRender() {},
        focusLayerActionButton() {},
      };
      assert(
        GerberViewer.prototype.startCompositeSelection.call(
          selectionContext,
          selectionLayer,
        ),
        "selection did not start",
      );
      assert(largeSlices - before === 1, "selection created more than one draft copy");
      assert(
        selectionContext.compositeSelection.original === authoritative,
        "selection copied its immutable original",
      );
      assert(
        selectionContext.compositeSelection.draft !== authoritative,
        "selection draft did not own its buffer",
      );
      assert(
        selectionContext.compositeSelection.changedByteIndices.size === 0,
        "new selection started dirty",
      );
      GerberViewer.prototype.finishCompositeSelection.call(
        selectionContext,
        false,
      );
      assert(selectionFullUploads === 0, "no-op cancel uploaded the 2 MiB bitset");
      assert(selectionByteUploads === 0, "no-op cancel uploaded a visibility byte");

      return {
        largeSlices,
        largeSomeCalls,
        uploads,
        selectionFullUploads,
        selectionByteUploads,
      };
    } finally {
      Uint8Array.prototype.slice = originalSlice;
      Uint8Array.prototype.some = originalSome;
      dialog.finish(null);
      dialog.dialog.remove();
    }
  });

  expect(metrics).toEqual({
    largeSlices: 5,
    largeSomeCalls: 0,
    uploads: 1,
    selectionFullUploads: 0,
    selectionByteUploads: 0,
  });
});

test("deterministic composite operation sequences match an independent logical oracle", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const {
      createCompositeLayerPresetBitset,
      createCompositePresetBitset,
      getCompositeAreaVisible,
      reconcileCompositeSources,
      setCompositeAreaVisible,
    } = await import("/js/layers/composite-layers.js");

    let randomState = 0x6d2b79f5;
    const random = () => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState;
    };
    const pool = Array.from({ length: 32 }, (_unused, index) => `source-${index}`);
    const patternForCode = (code, count) =>
      Array.from({ length: count }, (_unused, slot) =>
        code & 2 ** slot ? "1" : "0").join("");
    const bitsetPatterns = (bitset, count) => {
      const patterns = new Set();
      for (let code = 0; code < 2 ** count; code += 1) {
        if (getCompositeAreaVisible(bitset, code)) {
          patterns.add(patternForCode(code, count));
        }
      }
      return patterns;
    };
    const projectAndExpand = (oldPatterns, oldSlots, nextSlots) => {
      const common = oldSlots
        .map((sourceId, oldIndex) => ({ sourceId, oldIndex }))
        .filter(({ sourceId }) => nextSlots.includes(sourceId))
        .map(({ sourceId, oldIndex }) => ({
          oldIndex,
          nextIndex: nextSlots.indexOf(sourceId),
        }));
      const expected = new Set();
      for (let code = 0; code < 2 ** nextSlots.length; code += 1) {
        const nextPattern = patternForCode(code, nextSlots.length);
        if ([...oldPatterns].some((oldPattern) =>
          common.every(({ oldIndex, nextIndex }) =>
            oldPattern[oldIndex] === nextPattern[nextIndex]))) {
          expected.add(nextPattern);
        }
      }
      return expected;
    };
    const assertPatterns = (actual, expected, label) => {
      const actualValues = [...actual].sort();
      const expectedValues = [...expected].sort();
      if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
        throw new Error(`${label}: ${actualValues} !== ${expectedValues}`);
      }
    };

    let layer = {
      kind: "composite",
      sourceIds: pool.slice(0, 3),
      slotSourceIds: pool.slice(0, 3),
      visibleBitset: createCompositePresetBitset(3, "union"),
    };
    let oracle = bitsetPatterns(layer.visibleBitset, layer.slotSourceIds.length);
    let nextPoolIndex = 3;
    const takeUnusedSource = (sourceIds) => {
      for (let attempt = 0; attempt < pool.length; attempt += 1) {
        const sourceId = pool[nextPoolIndex % pool.length];
        nextPoolIndex += 1;
        if (!sourceIds.includes(sourceId)) return sourceId;
      }
      throw new Error("deterministic source pool exhausted");
    };
    let checksum = 2166136261;

    for (let step = 0; step < 160; step += 1) {
      const operation = step % 5;
      if (operation === 0) {
        const offset = random() % layer.sourceIds.length;
        const nextOrder = [
          ...layer.sourceIds.slice(offset),
          ...layer.sourceIds.slice(0, offset),
        ];
        layer = { kind: "composite", ...reconcileCompositeSources(layer, nextOrder) };
      } else if (operation === 1) {
        const preset = ["union", "intersection", "difference"][random() % 3];
        layer.visibleBitset = createCompositeLayerPresetBitset(layer, preset);
        oracle = bitsetPatterns(layer.visibleBitset, layer.slotSourceIds.length);
      } else if (operation === 2) {
        const code = random() % (2 ** layer.slotSourceIds.length);
        const pattern = patternForCode(code, layer.slotSourceIds.length);
        const visible = !oracle.has(pattern);
        setCompositeAreaVisible(layer.visibleBitset, code, visible);
        if (visible) oracle.add(pattern);
        else oracle.delete(pattern);
      } else {
        const canAdd = layer.sourceIds.length < 8;
        const shouldAdd = canAdd && (operation === 3 || layer.sourceIds.length <= 2);
        const nextOrder = [...layer.sourceIds];
        if (shouldAdd) {
          const insertAt = random() % (nextOrder.length + 1);
          nextOrder.splice(insertAt, 0, takeUnusedSource(nextOrder));
        } else {
          const removeAt = random() % nextOrder.length;
          nextOrder.splice(removeAt, 1);
          if (operation === 4) {
            nextOrder.splice(removeAt, 0, takeUnusedSource(nextOrder));
          }
        }
        const oldSlots = [...layer.slotSourceIds];
        const oldOracle = oracle;
        const reconciled = reconcileCompositeSources(layer, nextOrder);
        oracle = projectAndExpand(oldOracle, oldSlots, reconciled.slotSourceIds);
        layer = { kind: "composite", ...reconciled };
      }

      const actual = bitsetPatterns(layer.visibleBitset, layer.slotSourceIds.length);
      assertPatterns(actual, oracle, `step ${step}`);
      if (new Set(layer.sourceIds).size !== layer.sourceIds.length) {
        throw new Error(`step ${step}: duplicate ordered source`);
      }
      if (
        layer.sourceIds.some((sourceId) => !layer.slotSourceIds.includes(sourceId)) ||
        layer.sourceIds.length !== layer.slotSourceIds.length
      ) {
        throw new Error(`step ${step}: source/slot identity divergence`);
      }
      for (const byte of layer.visibleBitset) {
        checksum = Math.imul(checksum ^ byte, 16777619) >>> 0;
      }
      for (const sourceId of layer.sourceIds) {
        checksum = Math.imul(checksum ^ sourceId.length, 16777619) >>> 0;
      }
    }

    return {
      checksum,
      sourceCount: layer.sourceIds.length,
      visibleCount: oracle.size,
    };
  });

  expect(result).toEqual({
    checksum: 3431478979,
    sourceCount: 7,
    visibleCount: 4,
  });
});

test("Viewer operation sequence preserves model, renderer, camera, and recovery invariants", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "islands.gtl", mimeType: "text/plain", buffer: Buffer.from(disconnectedSource) },
    { name: "center.gbl", mimeType: "text/plain", buffer: Buffer.from(centerSource) },
    { name: "left-extra.gto", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
    { name: "right-extra.gbo", mimeType: "text/plain", buffer: Buffer.from(rightSource) },
    { name: "board-outline.gko", mimeType: "text/plain", buffer: Buffer.from(outlineSource) },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(5);

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRenderLayerList = viewerPrototype.renderLayerList;
    const originalUpdateUiState = viewerPrototype.updateUiState;
    const originalFitView = viewerPrototype.fitView;
    window.__viewerSequenceCounters = { add: 0, setBits: 0, setByte: 0 };
    window.__viewerSequenceSnapshot = null;
    const capture = (viewer) => {
      const composite = viewer.layers.find((layer) => layer.kind === "composite");
      if (!composite) return;
      const names = new Map(viewer.layers.map((layer) => [layer.id, layer.name]));
      window.__viewerSequenceSnapshot = {
        name: composite.name,
        sourceNames: composite.sourceIds.map((id) => names.get(id)),
        slotNames: composite.slotSourceIds.map((id) => names.get(id)),
        visibleBitset: [...composite.visibleBitset],
        visible: composite.visible,
        inverted: composite.inverted,
      };
    };
    viewerPrototype.renderLayerList = function captureCompositeModel(...args) {
      const result = originalRenderLayerList.apply(this, args);
      capture(this);
      return result;
    };
    viewerPrototype.updateUiState = function captureCompositeStateChange(...args) {
      const result = originalUpdateUiState.apply(this, args);
      capture(this);
      return result;
    };
    viewerPrototype.fitView = function captureFittedCamera(...args) {
      const result = originalFitView.apply(this, args);
      window.__viewerSequenceFittedCamera = {
        zoom: this.camera.zoom,
        offsetX: this.camera.offsetX,
        offsetY: this.camera.offsetY,
        flipX: this.camera.flipX,
        flipY: this.camera.flipY,
      };
      return result;
    };
    for (const method of [
      "add_composite_layer_with_bounds",
      "add_composite_layer_with_outline_content",
    ]) {
      const original = processorPrototype[method];
      processorPrototype[method] = function countCompositeConstruction(...args) {
        window.__viewerSequenceCounters.add += 1;
        return original.apply(this, args);
      };
    }
    const originalSetBits = processorPrototype.set_composite_visible_bits;
    processorPrototype.set_composite_visible_bits = function countFullBitset(...args) {
      window.__viewerSequenceCounters.setBits += 1;
      return originalSetBits.apply(this, args);
    };
    const originalSetByte = processorPrototype.set_composite_visible_byte;
    processorPrototype.set_composite_visible_byte = function countBitsetByte(...args) {
      window.__viewerSequenceCounters.setByte += 1;
      return originalSetByte.apply(this, args);
    };
    window.__resetViewerSequenceCounters = () => {
      window.__viewerSequenceCounters = { add: 0, setBits: 0, setByte: 0 };
    };
  });

  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog.locator("[data-composite-name]").fill("Metamorphic coverage");
  for (const sourceName of ["islands.gtl", "center.gbl", "left-extra.gto"]) {
    await dialog
      .locator(".composite-source-choice", { hasText: sourceName })
      .locator("input")
      .check();
  }
  await dialog.locator('[data-composite-preset="difference"]').click();
  await dialog.locator("[data-composite-submit]").click();
  let composite = page.locator(".composite-layer-item");
  const snapshot = () => page.evaluate(() => window.__viewerSequenceSnapshot);
  await expect.poll(snapshot).toMatchObject({
    sourceNames: ["islands.gtl", "center.gbl", "left-extra.gto"],
    slotNames: ["islands.gtl", "center.gbl", "left-extra.gto"],
    visibleBitset: [2],
  });

  await page
    .locator(".gerber-layer-item:not(.composite-layer-item) .layer-checkbox")
    .evaluateAll((checkboxes) => {
      for (const checkbox of checkboxes) {
        if (checkbox.checked) checkbox.click();
      }
    });
  await page.waitForTimeout(75);
  const canvas = page.locator("#gerber-canvas");
  const initialPixels = await canvas.screenshot();
  await page.evaluate(() => window.__resetViewerSequenceCounters());

  const islands = page
    .locator(".gerber-layer-item:not(.composite-layer-item)")
    .filter({ has: page.getByText("islands.gtl", { exact: true }) });
  await islands.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="rename-layer"]').click();
  await dialog.locator("[data-composite-name]").fill("Renamed islands");
  await dialog.locator("[data-composite-submit]").click();
  await page.waitForTimeout(75);
  expect(await page.evaluate(() => window.__viewerSequenceCounters)).toEqual({
    add: 0,
    setBits: 0,
    setByte: 0,
  });
  expect((await canvas.screenshot()).equals(initialPixels)).toBe(true);

  composite = page.locator(".composite-layer-item");
  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="edit-composite"]').click();
  await dialog.getByRole("button", { name: "Move left-extra.gto up" }).click();
  await dialog.getByRole("button", { name: "Move left-extra.gto up" }).click();
  await dialog.locator("[data-composite-submit]").click();
  await expect.poll(snapshot).toMatchObject({
    sourceNames: ["left-extra.gto", "Renamed islands", "center.gbl"],
    slotNames: ["Renamed islands", "center.gbl", "left-extra.gto"],
    visibleBitset: [2],
  });
  expect(await page.evaluate(() => window.__viewerSequenceCounters)).toEqual({
    add: 0,
    setBits: 0,
    setByte: 0,
  });
  expect((await canvas.screenshot()).equals(initialPixels)).toBe(true);

  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="edit-composite"]').click();
  await dialog
    .locator(".composite-source-choice", { hasText: "right-extra.gbo" })
    .locator("input")
    .check();
  await dialog.locator("[data-composite-submit]").click();
  await expect.poll(snapshot).toMatchObject({
    slotNames: ["Renamed islands", "center.gbl", "left-extra.gto", "right-extra.gbo"],
    visibleBitset: [2, 2],
  });
  expect((await canvas.screenshot()).equals(initialPixels)).toBe(true);

  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="edit-composite"]').click();
  await dialog
    .locator(".composite-source-choice", { hasText: "center.gbl" })
    .locator("input")
    .uncheck();
  await dialog.locator("[data-composite-submit]").click();
  await expect.poll(snapshot).toMatchObject({
    sourceNames: ["left-extra.gto", "Renamed islands", "right-extra.gbo"],
    slotNames: ["Renamed islands", "left-extra.gto", "right-extra.gbo"],
    visibleBitset: [34],
  });
  expect((await canvas.screenshot()).equals(initialPixels)).toBe(true);
  expect(await page.evaluate(() => window.__viewerSequenceCounters.add)).toBe(2);

  await page.evaluate(() => window.__resetViewerSequenceCounters());
  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="composite-difference"]').click();
  await expect.poll(snapshot).toMatchObject({ visibleBitset: [4] });
  expect(await page.evaluate(() => window.__viewerSequenceCounters)).toEqual({
    add: 0,
    setBits: 1,
    setByte: 0,
  });
  await page.waitForTimeout(75);
  const differencePixels = await canvas.screenshot();

  await page.locator("#fit-view-btn").click();
  await page.waitForTimeout(200);
  const fittedCamera = await page.evaluate(() => window.__viewerSequenceFittedCamera);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.wheel(0, -160);
  await page.waitForTimeout(50);
  await page.locator("#fit-view-btn").click();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__viewerSequenceFittedCamera)).toEqual(
    fittedCamera,
  );
  await expect.poll(snapshot).toMatchObject({ visibleBitset: [4] });

  const outlineOption = page.locator("#board-outline-select option", {
    hasText: "board-outline.gko",
  });
  await page.locator("#board-outline-select").selectOption(
    await outlineOption.getAttribute("value"),
  );
  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect.poll(snapshot).toMatchObject({ inverted: true, visibleBitset: [4] });
  await page.waitForTimeout(75);
  expect((await canvas.screenshot()).equals(differencePixels)).toBe(false);
  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect.poll(snapshot).toMatchObject({ inverted: false, visibleBitset: [4] });

  await composite.locator(".layer-checkbox").uncheck();
  await expect.poll(snapshot).toMatchObject({ visible: false, visibleBitset: [4] });
  await composite.locator(".layer-checkbox").check();
  await expect.poll(snapshot).toMatchObject({ visible: true, visibleBitset: [4] });
  await page.waitForTimeout(75);
  const beforeRecovery = await canvas.screenshot();
  const beforeRecoveryModel = await snapshot();

  const dprMappings = await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    return [1, 1.25, 1.5, 2].map((dpr) => {
      const width = Math.round(320 * dpr);
      const height = Math.round(180 * dpr);
      const context = {
        canvas: {
          width,
          height,
          getBoundingClientRect: () => ({
            left: 11,
            top: 17,
            right: 331,
            bottom: 197,
            width: 320,
            height: 180,
          }),
        },
      };
      return {
        dpr,
        actual: GerberViewer.prototype.getCompositeCanvasPixel.call(
          context,
          11 + 320 * 0.137,
          17 + 180 * 0.829,
        ),
        expected: {
          x: Math.floor(width * 0.137),
          y: height - 1 - Math.floor(height * 0.829),
        },
      };
    });
  });
  for (const mapping of dprMappings) {
    expect(mapping.actual, `DPR ${mapping.dpr}`).toEqual(mapping.expected);
  }

  await page.evaluate(() => {
    const canvasElement = document.querySelector("#gerber-canvas");
    window.__viewerSequenceContextLoss = canvasElement
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__viewerSequenceContextLoss.loseContext();
  });
  await expect(page.locator("#workspace-status")).toContainText(/lost|Restoring/);
  await page.evaluate(() => window.__viewerSequenceContextLoss.restoreContext());
  await expect(page.locator("#workspace-status")).not.toContainText(/lost|Restoring/, {
    timeout: 30_000,
  });
  await expect.poll(snapshot).toEqual(beforeRecoveryModel);
  await page.waitForTimeout(75);
  expect((await canvas.screenshot()).equals(beforeRecovery)).toBe(true);
  await expect(page.locator(".layer-item-error")).toHaveCount(0);
});

test("outline identity changes invalidate both composite and inverted caches without benign rename churn", async ({ page }) => {
  await loadThreeSources(page);
  await createCompositeFromSources(
    page,
    "Outline identity coverage",
    ["left.gtl", "right.gbl"],
  );
  let left = page
    .locator(".gerber-layer-item:not(.composite-layer-item)")
    .filter({ has: page.getByText("left.gtl", { exact: true }) });
  await left.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect(left).toHaveClass(/layer-item-inverted/);
  await page.waitForTimeout(75);

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    window.__outlineIdentityCounters = {
      compositeBounds: 0,
      compositeOutline: 0,
      invertedBounds: 0,
      invertedOutline: 0,
    };
    for (const [method, key] of [
      ["add_composite_layer_with_bounds", "compositeBounds"],
      ["add_composite_layer_with_outline_content", "compositeOutline"],
      ["add_inverted_layer_with_bounds", "invertedBounds"],
      ["add_inverted_layer_with_outline", "invertedOutline"],
    ]) {
      const original = prototype[method];
      prototype[method] = function countOutlineIdentityChange(...args) {
        window.__outlineIdentityCounters[key] += 1;
        return original.apply(this, args);
      };
    }
    window.__resetOutlineIdentityCounters = () => {
      for (const key of Object.keys(window.__outlineIdentityCounters)) {
        window.__outlineIdentityCounters[key] = 0;
      }
    };
  });

  const rename = async (currentName, nextName) => {
    const row = page
      .locator(".gerber-layer-item:not(.composite-layer-item)")
      .filter({ has: page.getByText(currentName, { exact: true }) });
    await row.locator(".layer-menu-btn").click();
    await page.locator('.layer-context-menu [data-layer-menu-action="rename-layer"]').click();
    const dialog = page.locator(".composite-layer-dialog");
    await dialog.locator("[data-composite-name]").fill(nextName);
    await dialog.locator("[data-composite-submit]").click();
    await page.waitForTimeout(75);
  };

  await rename("board-outline.gko", "fabrication-notes.gbr");
  await expect(page.locator("#board-outline-status")).toContainText("Auto fallback: Bounds");
  let counters = await page.evaluate(() => window.__outlineIdentityCounters);
  expect(counters.compositeBounds).toBeGreaterThan(0);
  expect(counters.invertedBounds).toBeGreaterThan(0);
  expect(counters.compositeOutline).toBe(0);
  expect(counters.invertedOutline).toBe(0);

  await page.evaluate(() => window.__resetOutlineIdentityCounters());
  await rename("left.gtl", "Renamed left copper");
  counters = await page.evaluate(() => window.__outlineIdentityCounters);
  expect(counters).toEqual({
    compositeBounds: 0,
    compositeOutline: 0,
    invertedBounds: 0,
    invertedOutline: 0,
  });

  await rename("fabrication-notes.gbr", "restored-board.gko");
  await expect(page.locator("#board-outline-status")).toContainText(
    "Auto outline: restored-board.gko",
  );
  counters = await page.evaluate(() => window.__outlineIdentityCounters);
  expect(counters.compositeOutline).toBeGreaterThan(0);
  expect(counters.invertedOutline).toBeGreaterThan(0);
  await expect(page.locator(".layer-item-error")).toHaveCount(0);
});

test("layer menu and visible-area selection restore keyboard focus", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Keyboard coverage");
  const menu = page.locator(".layer-context-menu");
  const menuButton = row.locator(".layer-menu-btn");

  await expect(menuButton).toBeFocused();
  await expect(menuButton).toHaveAccessibleName("Keyboard coverage actions");
  await expect(menuButton).toHaveAttribute("aria-haspopup", "menu");
  await expect(menuButton).toHaveAttribute("aria-controls", "layer-context-menu");
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await menuButton.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAccessibleName("Keyboard coverage actions");
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await expect(menu.locator('[data-layer-menu-action="show-all"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(menuButton).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeFocused();

  const enterSelection = async () => {
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    const selectVisibleArea = menu.locator(
      '[data-layer-menu-action="select-visible-area"]',
    );
    await selectVisibleArea.focus();
    await page.keyboard.press("Enter");
    const done = page.locator(".composite-selection-bar button", { hasText: "Done" });
    await expect(page.locator(".composite-selection-bar")).toHaveAttribute(
      "aria-label",
      "Composite visible area selection",
    );
    await expect(done).toBeFocused();
  };

  await enterSelection();
  await page.keyboard.press("Escape");
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(row.locator(".layer-menu-btn")).toBeFocused();

  await enterSelection();
  await page.keyboard.press("Enter");
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(row.locator(".layer-menu-btn")).toBeFocused();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const prototype = GerberViewer.prototype;
    const original = prototype.ensureCompositeRendererLayer;
    let fail = true;
    prototype.ensureCompositeRendererLayer = function failSelectionStartOnce(layer, ...args) {
      if (fail && layer?.name === "Keyboard coverage") {
        fail = false;
        return null;
      }
      return original.call(this, layer, ...args);
    };
  });
  await page.keyboard.press("Enter");
  await menu.locator('[data-layer-menu-action="select-visible-area"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(row.locator(".layer-menu-btn")).toBeFocused();
});

test("mobile drawer has a keyboard-operable expand and collapse control", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await loadTwoSources(page);

  const drawer = page.locator("#drawer");
  const drawerToggle = page.locator("#drawer-toggle");
  const createCompositeButton = page.locator(".layer-create-composite button");
  await expect(drawer).toHaveClass(/collapsed/);
  await expect(drawerToggle).toBeVisible();
  await expect(drawerToggle).toHaveAttribute("aria-label", "Show panel");
  await expect(drawerToggle).toHaveAttribute("aria-expanded", "false");
  await expect(createCompositeButton).toBeHidden();

  await drawerToggle.focus();
  await page.keyboard.press("Enter");
  await expect(drawer).not.toHaveClass(/collapsed/);
  await expect(drawerToggle).toHaveAttribute("aria-label", "Hide panel");
  await expect(drawerToggle).toHaveAttribute("aria-expanded", "true");
  await expect(createCompositeButton).toBeVisible();

  await page.keyboard.press("Space");
  await expect(drawer).toHaveClass(/collapsed/);
  await expect(drawerToggle).toHaveAttribute("aria-label", "Show panel");
  await expect(drawerToggle).toHaveAttribute("aria-expanded", "false");
  await expect(createCompositeButton).toBeHidden();
});

test("mobile composite selection Done stays above open and collapsed drawers", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await loadTwoSources(page);

  const drawer = page.locator("#drawer");
  const drawerToggle = page.locator("#drawer-toggle");
  await drawerToggle.click();
  await expect(drawer).not.toHaveClass(/collapsed/);
  const row = await createComposite(page, "Mobile coverage");

  const startSelection = async () => {
    await expect(async () => {
      await row.locator(".layer-menu-btn").click();
      const menu = page.locator(".layer-context-menu");
      await expect(menu).toBeVisible();
      await menu
        .locator('[data-layer-menu-action="select-visible-area"]')
        .focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".composite-selection-bar")).toBeVisible();
    }).toPass();
  };
  const expectDoneIsTopmost = async () => {
    const done = page.locator(".composite-selection-bar button", { hasText: "Done" });
    await expect.poll(() => done.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return hit === button || button.contains(hit);
    })).toBe(true);
    return done;
  };

  await startSelection();
  let done = await expectDoneIsTopmost();
  await done.click();
  await expect(page.locator(".composite-selection-bar")).toBeHidden();

  await startSelection();
  await drawerToggle.click();
  await expect(drawer).toHaveClass(/collapsed/);
  done = await expectDoneIsTopmost();
  await done.click();
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
});

test("loading makes the viewer inert and restores stable layer-control focus", async ({ page }) => {
  await loadTwoSources(page);
  const checkbox = page
    .locator(".gerber-layer-item:not(.composite-layer-item)")
    .first()
    .locator(".layer-checkbox");
  const initiallyChecked = await checkbox.isChecked();
  await checkbox.focus();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const prototype = GerberViewer.prototype;
    const original = prototype.collectLayerSources;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    window.__releaseLoadingA11yGate = release;
    window.__loadingA11yGateStarted = false;
    prototype.collectLayerSources = async function gatedLayerCollection(...args) {
      window.__loadingA11yGateStarted = true;
      await gate;
      return original.apply(this, args);
    };
  });

  await page.locator("#file-input").setInputFiles({
    name: "third.gto",
    mimeType: "text/plain",
    buffer: Buffer.from(centerSource),
  });
  await expect.poll(() => page.evaluate(() => window.__loadingA11yGateStarted)).toBe(true);

  const loadingModal = page.locator("#loading-modal");
  await expect(loadingModal).toBeVisible();
  await expect(loadingModal).toBeFocused();
  await expect(loadingModal).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".top-toolbar")).toHaveAttribute("inert", "");
  await expect(page.locator(".workspace")).toHaveAttribute("inert", "");
  await expect(checkbox).toBeDisabled();
  await page.keyboard.press("Space");
  expect(await checkbox.isChecked()).toBe(initiallyChecked);

  await page.evaluate(() => window.__releaseLoadingA11yGate());
  await expect(loadingModal).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(3);
  await expect(page.locator(".top-toolbar")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".workspace")).not.toHaveAttribute("inert", "");
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeFocused();
  expect(await checkbox.isChecked()).toBe(initiallyChecked);
});

test("mobile localized source dialogs stay contained and honor reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 480 });
  await loadTwoSources(page);
  await page.locator("#drawer-toggle").click();

  const longName = "共有銅層 매우 긴 번역 이름 ".repeat(7).trim();
  const sourceRows = page.locator(".gerber-layer-item:not(.composite-layer-item)");
  for (let index = 0; index < 2; index += 1) {
    await sourceRows.nth(index).locator(".layer-menu-btn").click();
    await page.locator('.layer-context-menu [data-layer-menu-action="rename-layer"]').click();
    const renameDialog = page.locator(".composite-layer-dialog");
    await renameDialog.locator("[data-composite-name]").fill(longName);
    await renameDialog.locator("[data-composite-submit]").click();
  }

  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName("Create Composite Layer");
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(320);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(480);
  await expect(dialog).toHaveCSS("overflow-y", "auto");

  const labels = dialog.locator(".composite-source-choice > span");
  await expect(labels).toHaveCount(2);
  for (const label of await labels.all()) {
    await expect(label).toHaveAttribute("title", new RegExp(longName.slice(0, 20)));
    await expect(label).toHaveCSS("text-overflow", "ellipsis");
    await expect(label).toHaveCSS("white-space", "nowrap");
  }

  for (const choice of await dialog.locator(".composite-source-choice input").all()) {
    await choice.focus();
    await page.keyboard.press("Space");
  }
  await expect(dialog.getByRole("status")).toHaveText("2 / 24");
  for (let index = 0; index < 18; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }

  await expect(page.locator(".side-panel")).toHaveCSS("transition-duration", "0s");
  await expect(page.locator(".loading-header svg")).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(".layer-create-composite button")).toBeFocused();
});

test("selection mode locks layer controls and supports cancel and commit", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page);
  await row.locator(".layer-checkbox").uncheck();

  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();
  await expect(page.locator("#workspace-status")).toHaveText("Selecting composite areas");
  await expect(page.locator("#screenshot-btn")).toBeDisabled();
  await expect(page.locator(".layer-create-composite button")).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(page.locator(".layer-panel-controls")).toBeHidden();
  await expect(page.locator(".outline-source-control")).toBeHidden();
  await expect.poll(() =>
    page.locator("[data-composite-area-code]").count()).toBeGreaterThan(0);
  await expect(page.locator("[data-composite-area-code]").first()).toBeEnabled();

  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const selectionBarBox = await page.locator(".composite-selection-bar").boundingBox();
  const selectionPresetBox = await page.locator(".composite-selection-presets").boundingBox();
  expect(selectionBarBox).not.toBeNull();
  expect(selectionPresetBox).not.toBeNull();
  expect(selectionBarBox.y).toBeGreaterThanOrEqual(box.y);
  expect(selectionBarBox.y).toBeLessThanOrEqual(box.y + 20);
  expect(selectionBarBox.x + selectionBarBox.width).toBeLessThanOrEqual(
    box.x + box.width,
  );
  expect(selectionPresetBox.x + selectionPresetBox.width).toBeLessThanOrEqual(
    box.x + box.width,
  );
  await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.5 } });
  await expect(page.locator(".composite-selection-bar strong")).toHaveCount(0);
  await expect(page.locator("#composite-selection-info")).not.toHaveText("No area selected");
  await page.keyboard.press("Escape");
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(row.locator(".layer-checkbox")).not.toBeChecked();

  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.5 } });
  await page.keyboard.press("Enter");
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(row.locator(".layer-checkbox")).not.toBeChecked();
});

test("selection mode renders wheel zoom immediately and accepts the next click", async ({ page }) => {
  await loadTwoSources(page);
  await page.locator("#rendering-mode-lazy").check();
  const row = await createComposite(page);
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();

  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box.width * 0.35, y: box.height * 0.5 };
  await page.mouse.move(box.x + point.x, box.y + point.y);
  await page.mouse.wheel(0, -120);

  // Selection owns a live membership framebuffer, so lazy-mode CSS preview
  // must never be used while picking is active.
  expect(await canvas.evaluate((element) => element.style.transform)).toBe("");
  await page.waitForTimeout(25);
  const beforeToggle = await canvas.screenshot();
  await canvas.click({ position: point });
  await page.waitForTimeout(50);
  const afterToggle = await canvas.screenshot();
  expect(afterToggle.equals(beforeToggle)).toBe(false);
  await page.keyboard.press("Escape");
});

test("selection preview failure unlocks the viewer and retries from a fresh definition", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Preview retry coverage");
  await row.locator(".layer-checkbox").uncheck();
  const canvas = page.locator("#gerber-canvas");
  const readHealthyPixels = () => page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    const gl = canvas.getContext("webgl2");
    const result = [];
    for (const ratio of [0.35, 0.5, 0.65]) {
      const pixel = new Uint8Array(4);
      gl.readPixels(
        Math.floor(canvas.width * ratio),
        Math.floor(canvas.height * 0.5),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      result.push(...pixel);
    }
    return result;
  });
  await page.waitForTimeout(50);
  const healthyPixels = await readHealthyPixels();
  const diagnosticsBefore = Number(
    await page.locator("#diagnostics-count").textContent(),
  );

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const original = prototype.render_composite_selection;
    let shouldFail = true;
    prototype.render_composite_selection = function failPreviewOnce(...args) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("forced composite selection preview failure");
      }
      return original.apply(this, args);
    };
    window.__restoreCompositeSelectionPreview = () => {
      prototype.render_composite_selection = original;
    };
  });

  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(row).toHaveClass(/layer-item-error/);
  await expect(row).toHaveAttribute("aria-invalid", "true");
  await expect(row.locator(".layer-label span")).toContainText("Error ·");
  await expect(row.locator(".layer-menu-btn")).toHaveAccessibleName(
    "Preview retry coverage actions, rendering error",
  );
  await expect(row.locator(".layer-checkbox")).toHaveAccessibleName(
    "Preview retry coverage visibility, rendering error",
  );
  await expect(row.locator(".layer-checkbox")).not.toBeChecked();
  await expect(page.locator("#screenshot-btn")).toBeEnabled();
  await expect(page.locator(".layer-create-composite button")).toBeEnabled();
  await expect
    .poll(async () => Number(await page.locator("#diagnostics-count").textContent()))
    .toBeGreaterThan(diagnosticsBefore);
  await page.waitForTimeout(50);
  expect(await readHealthyPixels()).toEqual(healthyPixels);

  await page.evaluate(() => window.__restoreCompositeSelectionPreview());
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveClass(/layer-item-error/);
  await expect(row.locator(".layer-checkbox")).not.toBeChecked();
});

test("fatal composite preview traps rebuild the authoritative renderer", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Fatal preview coverage");
  await row.locator(".layer-checkbox").uncheck();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalPreview = processorPrototype.render_composite_selection;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseFatalCompositePreview = releaseRecovery;
    window.__fatalCompositePreviewRecoveryStarted = false;
    viewerPrototype.restoreLayerFromSnapshot = async function delayedRestore(...args) {
      window.__fatalCompositePreviewRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let shouldFail = true;
    processorPrototype.render_composite_selection = function failPreviewOnce(...args) {
      if (shouldFail) {
        shouldFail = false;
        throw new WebAssembly.RuntimeError(
          "unreachable: forced fatal recovery test in composite preview",
        );
      }
      return originalPreview.apply(this, args);
    };
  });

  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__fatalCompositePreviewRecoveryStarted))
    .toBe(true);
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(page.locator("#workspace-status")).toHaveText("Rebuilding renderer");
  await expect(page.locator("#screenshot-btn")).toBeDisabled();
  await expect(row.locator(".layer-checkbox")).toBeDisabled();

  await page.evaluate(() => window.__releaseFatalCompositePreview());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
  await expect(row.locator(".layer-checkbox")).not.toBeChecked();
  await expect(page.locator("#screenshot-btn")).toBeEnabled();
});

test("fatal composite byte-toggle traps cancel the draft and rebuild", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Fatal toggle coverage");
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalToggle = processorPrototype.set_composite_visible_byte;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseFatalCompositeToggle = releaseRecovery;
    window.__fatalCompositeToggleRecoveryStarted = false;
    viewerPrototype.restoreLayerFromSnapshot = async function delayedRestore(...args) {
      window.__fatalCompositeToggleRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let shouldFail = true;
    processorPrototype.set_composite_visible_byte = function failToggleOnce(...args) {
      if (shouldFail) {
        shouldFail = false;
        throw new WebAssembly.RuntimeError(
          "unreachable: forced fatal recovery test in composite toggle",
        );
      }
      return originalToggle.apply(this, args);
    };
  });

  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.5 } });
  await expect
    .poll(() => page.evaluate(() => window.__fatalCompositeToggleRecoveryStarted))
    .toBe(true);
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(page.locator("#workspace-status")).toHaveText("Rebuilding renderer");
  await expect(page.locator("#file-input")).toBeDisabled();

  await page.evaluate(() => window.__releaseFatalCompositeToggle());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
  await expect(page.locator("#file-input")).toBeEnabled();
});

test("all WebAssembly runtime traps rebuild and cancel composite selection", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Non-unreachable trap coverage");
  await row.click({ button: "right" });
  await page
    .locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]')
    .click();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalToggle = processorPrototype.set_composite_visible_byte;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseNonUnreachableTrap = releaseRecovery;
    window.__nonUnreachableTrapRecoveryStarted = false;
    viewerPrototype.restoreLayerFromSnapshot = async function delayedRestore(...args) {
      window.__nonUnreachableTrapRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let shouldFail = true;
    processorPrototype.set_composite_visible_byte = function failWithRuntimeTrap(...args) {
      if (shouldFail) {
        shouldFail = false;
        throw new WebAssembly.RuntimeError(
          "memory access out of bounds: forced fatal recovery test",
        );
      }
      return originalToggle.apply(this, args);
    };
  });

  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.5 } });
  await expect
    .poll(() => page.evaluate(() => window.__nonUnreachableTrapRecoveryStarted))
    .toBe(true);
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await expect(page.locator("#workspace-status")).toHaveText("Rebuilding renderer");

  await page.evaluate(() => window.__releaseNonUnreachableTrap());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
});

test("fatal inverted dependencies stop the active renderer stack before recovery", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Inverted dependency trap coverage");

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalInverted = processorPrototype.add_inverted_layer_with_bounds;
    const originalComposite = processorPrototype.add_composite_layer_with_bounds;
    const originalRender = processorPrototype.render;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseInvertedDependencyTrap = releaseRecovery;
    window.__invertedDependencyTrap = {
      recoveryStarted: false,
      trapped: false,
      postTrapCompositeCalls: 0,
      postTrapRenderCalls: 0,
    };
    viewerPrototype.restoreLayerFromSnapshot = async function delayedRestore(...args) {
      window.__invertedDependencyTrap.recoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let shouldFail = true;
    processorPrototype.add_inverted_layer_with_bounds = function failInvertedOnce(...args) {
      if (shouldFail) {
        shouldFail = false;
        window.__invertedDependencyTrap.trapped = true;
        throw new WebAssembly.RuntimeError(
          "unreachable: forced fatal recovery test in inverted dependency",
        );
      }
      return originalInverted.apply(this, args);
    };
    processorPrototype.add_composite_layer_with_bounds = function countComposite(...args) {
      if (window.__invertedDependencyTrap.trapped) {
        window.__invertedDependencyTrap.postTrapCompositeCalls += 1;
      }
      return originalComposite.apply(this, args);
    };
    processorPrototype.render = function countRender(...args) {
      if (window.__invertedDependencyTrap.trapped) {
        window.__invertedDependencyTrap.postTrapRenderCalls += 1;
      }
      return originalRender.apply(this, args);
    };
  });

  const source = page
    .locator(".gerber-layer-item:not(.composite-layer-item)")
    .filter({ hasText: "left.gtl" });
  await source.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__invertedDependencyTrap.recoveryStarted))
    .toBe(true);
  expect(await page.evaluate(() => window.__invertedDependencyTrap)).toEqual({
    recoveryStarted: true,
    trapped: true,
    postTrapCompositeCalls: 0,
    postTrapRenderCalls: 0,
  });

  await page.evaluate(() => window.__releaseInvertedDependencyTrap());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
  await expect(source).not.toHaveClass(/layer-item-inverted/);
});

test("fatal Auto-outline composite construction never falls through to Bounds", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "left.gtl", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
    { name: "right.gbl", mimeType: "text/plain", buffer: Buffer.from(rightSource) },
    {
      name: "board-outline.gko",
      mimeType: "text/plain",
      buffer: Buffer.from(outlineSource),
    },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".gerber-layer-item")).toHaveCount(3);
  await expect(page.locator("#board-outline-select")).toHaveValue("auto");

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalOutlineConstructor =
      processorPrototype.add_composite_layer_with_outline_content;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseFatalOutlineComposite = releaseRecovery;
    window.__fatalOutlineCompositeRecoveryStarted = false;
    viewerPrototype.restoreLayerFromSnapshot = async function delayedRestore(...args) {
      window.__fatalOutlineCompositeRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let shouldFail = true;
    processorPrototype.add_composite_layer_with_outline_content =
      function failOutlineConstructorOnce(...args) {
        if (shouldFail) {
          shouldFail = false;
          throw new WebAssembly.RuntimeError(
            "unreachable: forced fatal recovery test in Auto outline constructor",
          );
        }
        return originalOutlineConstructor.apply(this, args);
      };
  });

  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog.locator("[data-composite-name]").fill("Fatal outline coverage");
  await dialog
    .locator(".composite-source-choice", { hasText: "left.gtl" })
    .locator("input")
    .check();
  await dialog
    .locator(".composite-source-choice", { hasText: "right.gbl" })
    .locator("input")
    .check();
  await dialog.locator("[data-composite-submit]").click();

  await expect
    .poll(() => page.evaluate(() => window.__fatalOutlineCompositeRecoveryStarted))
    .toBe(true);
  await expect(page.locator("#workspace-status")).toHaveText("Rebuilding renderer");
  await expect(page.locator("#screenshot-btn")).toBeDisabled();
  await expect(page.locator(".layer-create-composite button")).toBeDisabled();

  await page.evaluate(() => window.__releaseFatalOutlineComposite());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(3);
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
  await expect(page.locator(".composite-layer-item .layer-label strong")).toHaveText(
    "Fatal outline coverage",
  );
});

test("fatal composite inversion and hidden-cache release both rebuild safely", async ({ page }) => {
  await loadTwoSources(page);
  let row = await createComposite(page, "Fatal mutation coverage");

  await installGatedFatalProcessorMethod(
    page,
    "set_composite_inverted",
    "composite inversion",
  );
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await waitForInjectedFatalRecovery(page);
  await expect(page.locator("#screenshot-btn")).toBeDisabled();
  await releaseInjectedFatalRecovery(page);
  row = page.locator(".composite-layer-item").filter({ hasText: "Fatal mutation coverage" });
  await expect(row).not.toHaveClass(/layer-item-inverted/);

  await installGatedFatalProcessorMethod(
    page,
    "release_composite_cache",
    "hidden composite cache release",
  );
  await row.locator(".layer-checkbox").uncheck();
  await waitForInjectedFatalRecovery(page);
  await expect(page.locator("#file-input")).toBeDisabled();
  await releaseInjectedFatalRecovery(page);
  row = page.locator(".composite-layer-item").filter({ hasText: "Fatal mutation coverage" });
  await expect(row.locator(".layer-checkbox")).not.toBeChecked();
  await expect(row).not.toHaveClass(/layer-item-inverted/);
});

test("fatal final rendering cancels a pending touch reorder and preserves order", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Fatal render coverage");
  const layerNames = page.locator("#layer-list > .gerber-layer-item .layer-label strong");
  const orderBefore = await layerNames.allTextContents();
  await installGatedFatalProcessorMethod(page, "render", "final rendering");

  await page.evaluate(() => {
    const target = document.querySelector(
      ".composite-layer-item [data-layer-touch-reorder]",
    );
    const rect = target.getBoundingClientRect();
    const touch = new Touch({
      identifier: 77,
      target,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    target.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
    }));
  });
  await page
    .locator(".gerber-layer-item:not(.composite-layer-item) .layer-checkbox")
    .first()
    .uncheck();
  await waitForInjectedFatalRecovery(page);
  await page.waitForTimeout(550);
  await expect(page.locator(".layer-context-menu")).toBeHidden();
  await expect(page.locator(".dragging, .touch-dragging")).toHaveCount(0);

  await releaseInjectedFatalRecovery(page);
  await expect(layerNames).toHaveText(orderBefore);
  await expect(
    page.locator(".gerber-layer-item:not(.composite-layer-item) .layer-checkbox").first(),
  ).not.toBeChecked();
});

test("fatal layer removal and Clear All restore the authoritative layer set", async ({ page }) => {
  await loadTwoSources(page);
  let row = await createComposite(page, "Fatal deletion coverage");

  await installGatedFatalProcessorMethod(page, "remove_layer", "layer removal");
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="delete-layer"]').click();
  await waitForInjectedFatalRecovery(page);
  await releaseInjectedFatalRecovery(page);
  await expect(page.locator(".gerber-layer-item")).toHaveCount(3);
  row = page.locator(".composite-layer-item").filter({ hasText: "Fatal deletion coverage" });
  await expect(row).toHaveCount(1);

  await installGatedFatalProcessorMethod(page, "clear", "Clear All");
  await page.locator("#clear-all-btn").click();
  await waitForInjectedFatalRecovery(page);
  await releaseInjectedFatalRecovery(page);
  await expect(page.locator(".gerber-layer-item")).toHaveCount(3);

  await page.locator("#clear-all-btn").click();
  await expect(page.locator(".gerber-layer-item")).toHaveCount(0);
});

test("changing the resolved outline releases hidden composite definitions", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "left.gtl", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
    { name: "right.gbl", mimeType: "text/plain", buffer: Buffer.from(rightSource) },
    { name: "outline-a.gko", mimeType: "text/plain", buffer: Buffer.from(outlineSource) },
    { name: "outline-b.gko", mimeType: "text/plain", buffer: Buffer.from(outlineSource) },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await page.locator("#board-outline-select").selectOption({ label: "outline-a.gko" });

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalAdd = prototype.add_composite_layer_with_outline_content;
    const originalRemove = prototype.remove_layer;
    window.__outlineCompositeIds = [];
    window.__outlineRemovedIds = [];
    prototype.add_composite_layer_with_outline_content = function trackAdd(...args) {
      const id = originalAdd.apply(this, args);
      window.__outlineCompositeIds.push(Number(id));
      return id;
    };
    prototype.remove_layer = function trackRemove(id, ...args) {
      window.__outlineRemovedIds.push(Number(id));
      return originalRemove.call(this, id, ...args);
    };
  });

  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog.locator("[data-composite-name]").fill("Outline lifecycle coverage");
  for (const name of ["left.gtl", "right.gbl"]) {
    await dialog
      .locator(".composite-source-choice", { hasText: name })
      .locator("input")
      .check();
  }
  await dialog.locator("[data-composite-submit]").click();
  const row = page.locator(".composite-layer-item").filter({
    hasText: "Outline lifecycle coverage",
  });
  await row.locator(".layer-checkbox").uncheck();
  const compositeId = await page.evaluate(() => window.__outlineCompositeIds.at(-1));

  await page.locator("#board-outline-select").selectOption({ label: "outline-b.gko" });
  await expect
    .poll(() => page.evaluate(
      (id) => window.__outlineRemovedIds.includes(id),
      compositeId,
    ))
    .toBe(true);

  page.once("dialog", (confirmation) => confirmation.accept());
  const outlineB = page.locator(".gerber-layer-item").filter({ hasText: "outline-b.gko" });
  await outlineB.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="delete-layer"]').click();
  await expect(page.locator(".composite-layer-item")).toHaveCount(0);
});

test("post-create boundary failure removes the unreachable composite before retry", async ({ page }) => {
  await loadTwoSources(page);
  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalAdd = prototype.add_composite_layer_with_bounds;
    const originalBoundary = prototype.get_layer_boundary;
    const originalRemove = prototype.remove_layer;
    window.__boundaryCleanupEvents = [];
    window.__boundaryCleanupCompositeIds = [];
    let failFirstBoundary = true;
    prototype.add_composite_layer_with_bounds = function trackComposite(...args) {
      const id = Number(originalAdd.apply(this, args));
      window.__boundaryCleanupCompositeIds.push(id);
      window.__boundaryCleanupEvents.push(`add:${id}`);
      return id;
    };
    prototype.get_layer_boundary = function failCompositeBoundaryOnce(id, ...args) {
      const numericId = Number(id);
      if (
        failFirstBoundary &&
        window.__boundaryCleanupCompositeIds[0] === numericId
      ) {
        failFirstBoundary = false;
        window.__boundaryCleanupEvents.push(`boundary-fail:${numericId}`);
        throw new Error("forced post-create composite boundary failure");
      }
      return originalBoundary.call(this, id, ...args);
    };
    prototype.remove_layer = function trackBoundaryCleanup(id, ...args) {
      window.__boundaryCleanupEvents.push(`remove:${Number(id)}`);
      return originalRemove.call(this, id, ...args);
    };
  });

  const row = await createComposite(page, "Boundary cleanup");
  await expect
    .poll(() => page.evaluate(() => window.__boundaryCleanupCompositeIds.length))
    .toBeGreaterThanOrEqual(2);
  await expect(row).not.toHaveClass(/layer-item-error/);
  const result = await page.evaluate(() => ({
    ids: window.__boundaryCleanupCompositeIds,
    events: window.__boundaryCleanupEvents,
  }));
  const firstId = result.ids[0];
  const secondId = result.ids[1];
  expect(result.events.indexOf(`boundary-fail:${firstId}`)).toBeLessThan(
    result.events.indexOf(`remove:${firstId}`),
  );
  expect(result.events.indexOf(`remove:${firstId}`)).toBeLessThan(
    result.events.lastIndexOf(`add:${secondId}`),
  );
});

test("hidden cache release and Bounds-key changes discard stale composite definitions", async ({ page }) => {
  await loadThreeSources(page);
  await page.locator("#board-outline-select").selectOption("bounds");
  const row = await createCompositeFromSources(page, "Bounds lifecycle", [
    "left.gtl",
    "right.gbl",
  ]);
  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalRelease = prototype.release_composite_cache;
    const originalRemove = prototype.remove_layer;
    const originalAdd = prototype.add_composite_layer_with_bounds;
    window.__boundsLifecycle = { released: [], removed: [], added: [] };
    let failRelease = true;
    prototype.release_composite_cache = function failReleaseOnce(id, ...args) {
      window.__boundsLifecycle.released.push(Number(id));
      if (failRelease) {
        failRelease = false;
        throw new Error("forced ordinary hidden cache release failure");
      }
      return originalRelease.call(this, id, ...args);
    };
    prototype.remove_layer = function trackRemove(id, ...args) {
      window.__boundsLifecycle.removed.push(Number(id));
      return originalRemove.call(this, id, ...args);
    };
    prototype.add_composite_layer_with_bounds = function trackAdd(...args) {
      const id = Number(originalAdd.apply(this, args));
      window.__boundsLifecycle.added.push(id);
      return id;
    };
  });

  await row.locator(".layer-checkbox").uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__boundsLifecycle.removed.length))
    .toBe(1);
  const failedReleaseId = await page.evaluate(
    () => window.__boundsLifecycle.released[0],
  );
  expect(await page.evaluate(() => window.__boundsLifecycle.removed[0])).toBe(
    failedReleaseId,
  );

  await row.locator(".layer-checkbox").check();
  await expect
    .poll(() => page.evaluate(() => window.__boundsLifecycle.added.length))
    .toBe(1);
  const marginDefinitionId = await page.evaluate(
    () => window.__boundsLifecycle.added.at(-1),
  );
  await row.locator(".layer-checkbox").uncheck();
  await page.evaluate(() => {
    const input = document.querySelector("#board-outline-bounds-margin");
    input.value = "11";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect
    .poll(() => page.evaluate((id) => window.__boundsLifecycle.removed.includes(id), marginDefinitionId))
    .toBe(true);

  await row.locator(".layer-checkbox").check();
  await expect
    .poll(() => page.evaluate(() => window.__boundsLifecycle.added.length))
    .toBe(2);
  const visibilityDefinitionId = await page.evaluate(
    () => window.__boundsLifecycle.added.at(-1),
  );
  await row.locator(".layer-checkbox").uncheck();
  const nonSource = page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
    has: page.locator(".layer-label strong", { hasText: "board-outline.gko" }),
  });
  await nonSource.locator(".layer-checkbox").uncheck();
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__boundsLifecycle.removed.includes(id),
        visibilityDefinitionId,
      ),
    )
    .toBe(true);

  await row.locator(".layer-checkbox").check();
  await expect(row).not.toHaveClass(/layer-item-error/);
});

test("fatal inverted-cache removal rebuilds inversion and outline changes authoritatively", async ({ page }) => {
  await loadThreeSources(page);
  await createCompositeFromSources(page, "Inverted recovery", ["left.gtl", "right.gbl"]);
  const sourceRow = page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
    has: page.locator(".layer-label strong", { hasText: "left.gtl" }),
  });

  await sourceRow.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect(sourceRow).toHaveClass(/layer-item-inverted/);
  await page.waitForTimeout(100);
  await installGatedFatalProcessorMethod(page, "remove_layer", "inverted cache toggle");
  await sourceRow.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await waitForInjectedFatalRecovery(page);
  await releaseInjectedFatalRecovery(page);
  await expect(sourceRow).not.toHaveClass(/layer-item-inverted/);
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);

  await sourceRow.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect(sourceRow).toHaveClass(/layer-item-inverted/);
  await page.waitForTimeout(100);
  await installGatedFatalProcessorMethod(page, "remove_layer", "inverted outline change");
  await page.locator("#board-outline-select").selectOption("bounds");
  await waitForInjectedFatalRecovery(page);
  await releaseInjectedFatalRecovery(page);
  await expect(page.locator("#board-outline-select")).toHaveValue("bounds");
  await expect(sourceRow).toHaveClass(/layer-item-inverted/);
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
});

test("hidden Auto-to-Bounds fallback definitions invalidate on margin and Gerber add", async ({ page }) => {
  await loadThreeSources(page);
  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalOutline = prototype.add_composite_layer_with_outline_content;
    const originalBounds = prototype.add_composite_layer_with_bounds;
    const originalRemove = prototype.remove_layer;
    let failOutline = true;
    window.__autoFallbackLifecycle = { added: [], removed: [] };
    prototype.add_composite_layer_with_outline_content = function failAutoOutlineOnce(...args) {
      if (failOutline) {
        failOutline = false;
        throw new Error("forced ordinary Auto outline failure");
      }
      return originalOutline.apply(this, args);
    };
    prototype.add_composite_layer_with_bounds = function trackFallback(...args) {
      const id = Number(originalBounds.apply(this, args));
      window.__autoFallbackLifecycle.added.push(id);
      return id;
    };
    prototype.remove_layer = function trackFallbackRemoval(id, ...args) {
      window.__autoFallbackLifecycle.removed.push(Number(id));
      return originalRemove.call(this, id, ...args);
    };
  });
  const row = await createCompositeFromSources(page, "Auto fallback lifecycle", [
    "left.gtl",
    "right.gbl",
  ]);
  await expect
    .poll(() => page.evaluate(() => window.__autoFallbackLifecycle.added.length))
    .toBe(1);
  await row.locator(".layer-checkbox").uncheck();
  const marginId = await page.evaluate(() => window.__autoFallbackLifecycle.added.at(-1));
  await page.evaluate(() => {
    const input = document.querySelector("#board-outline-bounds-margin");
    input.value = "12";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect
    .poll(() =>
      page.evaluate((id) => window.__autoFallbackLifecycle.removed.includes(id), marginId),
    )
    .toBe(true);

  await row.locator(".layer-checkbox").check();
  await expect
    .poll(() => page.evaluate(() => window.__autoFallbackLifecycle.added.length))
    .toBe(2);
  await row.locator(".layer-checkbox").uncheck();
  const addId = await page.evaluate(() => window.__autoFallbackLifecycle.added.at(-1));
  await page.locator("#file-input").setInputFiles({
    name: "extra.gts",
    mimeType: "text/plain",
    buffer: Buffer.from(leftSource.replace("X-015000", "X000000")),
  });
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(() =>
      page.evaluate((id) => window.__autoFallbackLifecycle.removed.includes(id), addId),
    )
    .toBe(true);
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(4);
});

test("Gerber load stops interaction mutation when Bounds invalidation schedules recovery", async ({ page }) => {
  await loadThreeSources(page);
  await page.locator("#board-outline-select").selectOption("bounds");
  const row = await createCompositeFromSources(page, "Load recovery", ["left.gtl", "right.gbl"]);
  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalRelease = prototype.release_composite_cache;
    window.__loadRecoveryCompositeId = null;
    prototype.release_composite_cache = function rememberHiddenComposite(id, ...args) {
      window.__loadRecoveryCompositeId = Number(id);
      return originalRelease.call(this, id, ...args);
    };
  });
  await row.locator(".layer-checkbox").uncheck();
  await expect
    .poll(() => page.evaluate(() => window.__loadRecoveryCompositeId))
    .not.toBeNull();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalRemove = processorPrototype.remove_layer;
    const originalInteraction = processorPrototype.add_interaction_payload;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseLoadRecovery = releaseRecovery;
    window.__loadRecoveryStarted = false;
    window.__loadRecoveryInteractionCalls = 0;
    viewerPrototype.restoreLayerFromSnapshot = async function gateLoadRecovery(...args) {
      window.__loadRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let failed = false;
    processorPrototype.remove_layer = function failTargetComposite(id, ...args) {
      if (!failed && Number(id) === window.__loadRecoveryCompositeId) {
        failed = true;
        throw new Error("forced Bounds invalidation removal failure");
      }
      return originalRemove.call(this, id, ...args);
    };
    processorPrototype.add_interaction_payload = function countInteraction(...args) {
      window.__loadRecoveryInteractionCalls += 1;
      return originalInteraction.apply(this, args);
    };
  });

  await page.locator("#file-input").setInputFiles({
    name: "loaded-during-recovery.gts",
    mimeType: "text/plain",
    buffer: Buffer.from(rightSource.replace("X015000", "X000000")),
  });
  await expect.poll(() => page.evaluate(() => window.__loadRecoveryStarted)).toBe(true);
  expect(await page.evaluate(() => window.__loadRecoveryInteractionCalls)).toBe(0);
  await page.evaluate(() => window.__releaseLoadRecovery());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(4);
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
});

test("interaction building rechecks renderer ownership immediately before mutation", async ({ page }) => {
  await loadTwoSources(page);
  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalEnsureHeadroom = viewerPrototype.ensureInteractionMemoryHeadroom;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalAddInteraction = processorPrototype.add_interaction_payload;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseInteractionOwnershipRecovery = releaseRecovery;
    window.__interactionOwnershipRecoveryStarted = false;
    window.__staleInteractionMutationCalls = 0;
    viewerPrototype.restoreLayerFromSnapshot = async function gateOwnershipRecovery(...args) {
      window.__interactionOwnershipRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let scheduleRecovery = true;
    viewerPrototype.ensureInteractionMemoryHeadroom = function invalidateBeforeMutation(...args) {
      const result = originalEnsureHeadroom.apply(this, args);
      if (scheduleRecovery) {
        scheduleRecovery = false;
        this.scheduleAuthoritativeRendererRecovery(
          null,
          new Error("forced interaction ownership race"),
          "interaction ownership race",
        );
      }
      return result;
    };
    processorPrototype.add_interaction_payload = function countStaleMutation(...args) {
      window.__staleInteractionMutationCalls += 1;
      return originalAddInteraction.apply(this, args);
    };
  });

  await page.locator("#file-input").setInputFiles({
    name: "interaction-race.gts",
    mimeType: "text/plain",
    buffer: Buffer.from(leftSource.replace("X-015000", "X000000")),
  });
  await expect
    .poll(() => page.evaluate(() => window.__interactionOwnershipRecoveryStarted))
    .toBe(true);
  expect(await page.evaluate(() => window.__staleInteractionMutationCalls)).toBe(0);
  await page.evaluate(() => window.__releaseInteractionOwnershipRecovery());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(3);
});

test("composite edit never recreates on a processor whose definition removal failed", async ({ page }) => {
  await loadThreeSources(page);
  const row = await createCompositeFromSources(page, "Edit removal recovery", [
    "left.gtl",
    "right.gbl",
  ]);
  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalRemove = processorPrototype.remove_layer;
    const originalBounds = processorPrototype.add_composite_layer_with_bounds;
    const originalOutline = processorPrototype.add_composite_layer_with_outline_content;
    let releaseRecovery;
    const gate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseEditRemovalRecovery = releaseRecovery;
    window.__editRemovalRecoveryStarted = false;
    window.__editRemovalCompositeAdds = 0;
    viewerPrototype.restoreLayerFromSnapshot = async function gateEditRecovery(...args) {
      window.__editRemovalRecoveryStarted = true;
      await gate;
      return originalRestore.apply(this, args);
    };
    let failRemove = true;
    processorPrototype.remove_layer = function failEditRemovalOnce(id, ...args) {
      if (failRemove) {
        failRemove = false;
        throw new Error("forced composite edit removal failure");
      }
      return originalRemove.call(this, id, ...args);
    };
    processorPrototype.add_composite_layer_with_bounds = function countBounds(...args) {
      window.__editRemovalCompositeAdds += 1;
      return originalBounds.apply(this, args);
    };
    processorPrototype.add_composite_layer_with_outline_content = function countOutline(...args) {
      window.__editRemovalCompositeAdds += 1;
      return originalOutline.apply(this, args);
    };
  });

  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="edit-composite"]').click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog
    .locator(".composite-source-choice", { hasText: "board-outline.gko" })
    .locator("input")
    .check();
  await dialog
    .locator(".composite-source-choice", { hasText: "left.gtl" })
    .locator("input")
    .uncheck();
  await dialog.locator("[data-composite-submit]").click();
  await expect.poll(() => page.evaluate(() => window.__editRemovalRecoveryStarted)).toBe(true);
  expect(await page.evaluate(() => window.__editRemovalCompositeAdds)).toBe(0);
  await page.evaluate(() => window.__releaseEditRemovalRecovery());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect
    .poll(() => page.evaluate(() => window.__editRemovalCompositeAdds))
    .toBe(1);
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="edit-composite"]').click();
  await expect(dialog.locator("[data-composite-selected]")).toContainText("right.gbl");
  await expect(dialog.locator("[data-composite-selected]")).toContainText("board-outline.gko");
  await expect(dialog.locator("[data-composite-selected]")).not.toContainText("left.gtl");
  await dialog.locator("[data-composite-dismiss]").click();
});

test("selection rollback never recreates after its definition removal fails", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Selection removal recovery");
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();
  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalRemove = processorPrototype.remove_layer;
    const originalSetByte = processorPrototype.set_composite_visible_byte;
    const originalAdd = processorPrototype.add_composite_layer_with_bounds;
    let releaseRecovery;
    const gate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseSelectionRemovalRecovery = releaseRecovery;
    window.__selectionRemovalRecoveryStarted = false;
    window.__selectionRemovalCompositeAdds = 0;
    viewerPrototype.restoreLayerFromSnapshot = async function gateSelectionRecovery(...args) {
      window.__selectionRemovalRecoveryStarted = true;
      await gate;
      return originalRestore.apply(this, args);
    };
    window.__failSelectionRollbackByte = false;
    processorPrototype.set_composite_visible_byte = function failRollbackOnce(...args) {
      if (window.__failSelectionRollbackByte) {
        window.__failSelectionRollbackByte = false;
        throw new Error("forced selection rollback failure");
      }
      return originalSetByte.apply(this, args);
    };
    let failRemove = true;
    processorPrototype.remove_layer = function failSelectionRemovalOnce(id, ...args) {
      if (failRemove) {
        failRemove = false;
        throw new Error("forced selection definition removal failure");
      }
      return originalRemove.call(this, id, ...args);
    };
    processorPrototype.add_composite_layer_with_bounds = function countSelectionAdd(...args) {
      window.__selectionRemovalCompositeAdds += 1;
      return originalAdd.apply(this, args);
    };
  });

  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  await canvas.click({
    position: { x: box.width / 2, y: box.height / 2 },
  });
  await page.evaluate(() => {
    window.__failSelectionRollbackByte = true;
  });
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.__selectionRemovalRecoveryStarted))
    .toBe(true);
  expect(await page.evaluate(() => window.__selectionRemovalCompositeAdds)).toBe(0);
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await page.evaluate(() => window.__releaseSelectionRemovalRecovery());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer", {
    timeout: 30_000,
  });
  await expect
    .poll(() => page.evaluate(() => window.__selectionRemovalCompositeAdds))
    .toBe(1);
  await expect(row).not.toHaveClass(/layer-item-error/);
});

test("exports a PNG and recovers from WebGL context loss", async ({ page }) => {
  await loadTwoSources(page);
  const visibleComposite = await createComposite(page);
  const hiddenComposite = await createComposite(page, "Hidden recovery coverage");
  await hiddenComposite.locator(".layer-checkbox").uncheck();

  await page.locator("#screenshot-btn").click();
  await expect(page.locator("#screenshot-dialog")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );

  await visibleComposite.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.5 } });
  await page.keyboard.press("Enter");
  await visibleComposite.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await page.waitForTimeout(50);
  const beforeContextLoss = await canvas.screenshot();

  await page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    window.__viewerContextLossExtension = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__viewerContextLossExtension.loseContext();
  });
  await expect(page.locator("#workspace-status")).toContainText(/WebGL context lost|Restoring WebGL/);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.__viewerContextLossExtension.restoreContext();
  });
  await expect(page.locator("#workspace-status")).not.toContainText(/lost|Restoring/, { timeout: 30_000 });
  await expect(page.locator(".composite-layer-item")).toHaveCount(2);
  await expect(visibleComposite).toHaveClass(/layer-item-inverted/);
  await expect(hiddenComposite.locator(".layer-checkbox")).not.toBeChecked();
  await page.waitForTimeout(50);
  expect((await canvas.screenshot()).equals(beforeContextLoss)).toBe(true);
  await hiddenComposite.locator(".layer-checkbox").check();
  await page.waitForTimeout(50);
  expect((await canvas.screenshot()).equals(beforeContextLoss)).toBe(false);
});

test("renderer recovery cancels dialogs before layer records become stale", async ({ page }) => {
  await loadTwoSources(page);
  let row = await createComposite(page, "Dialog recovery coverage");
  await row.locator(".layer-menu-btn").click();
  await page
    .locator('.layer-context-menu [data-layer-menu-action="edit-composite"]')
    .click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog.locator("[data-composite-name]").fill("Stale edit must not apply");

  await page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    window.__editDialogContextLoss = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__editDialogContextLoss.loseContext();
  });
  await expect(dialog).toBeHidden();
  await page.evaluate(() => window.__editDialogContextLoss.restoreContext());
  await expect(page.locator("#workspace-status")).not.toContainText(/lost|Restoring/, {
    timeout: 30_000,
  });
  row = page.locator(".composite-layer-item");
  await expect(row.locator(".layer-label strong")).toHaveText(
    "Dialog recovery coverage",
  );
  await expect(row.locator(".layer-menu-btn")).toBeFocused();

  await row.locator(".layer-menu-btn").click();
  await page
    .locator('.layer-context-menu [data-layer-menu-action="rename-layer"]')
    .click();
  await dialog.locator("[data-composite-name]").fill("Stale rename must not apply");
  await installGatedFatalProcessorMethod(
    page,
    "render",
    "pending rename dialog",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await waitForInjectedFatalRecovery(page);
  await expect(dialog).toBeHidden();
  await releaseInjectedFatalRecovery(page);
  row = page.locator(".composite-layer-item");
  await expect(row.locator(".layer-label strong")).toHaveText(
    "Dialog recovery coverage",
  );
  await expect(row.locator(".layer-menu-btn")).toBeFocused();

  await loadTwoSources(page);
  await page.locator(".layer-create-composite button").click();
  await dialog.locator("[data-composite-name]").fill("Stale create must not apply");
  for (const source of ["left.gtl", "right.gbl"]) {
    await dialog
      .locator(".composite-source-choice", { hasText: source })
      .locator("input")
      .check();
  }
  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestoreContext = processorPrototype.restore_context;
    const originalRestoreLayer = viewerPrototype.restoreLayerFromSnapshot;
    let rejectCachedRestore = true;
    processorPrototype.restore_context = function rejectRestoreOnce(...args) {
      if (rejectCachedRestore) {
        rejectCachedRestore = false;
        throw new Error("forced fatal recovery test in pending dialog cache restore");
      }
      return originalRestoreContext.apply(this, args);
    };
    viewerPrototype.restoreLayerFromSnapshot = async function rejectOneSource(
      layer,
      ...args
    ) {
      if (layer.name === "right.gbl") {
        throw new Error("forced fatal recovery test in pending dialog source restore");
      }
      return originalRestoreLayer.call(this, layer, ...args);
    };
  });
  await page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    window.__createDialogContextLoss = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__createDialogContextLoss.loseContext();
  });
  await expect(dialog).toBeHidden();
  await page.evaluate(() => window.__createDialogContextLoss.restoreContext());
  await expect(page.locator("#workspace-status")).not.toContainText(/lost|Restoring/, {
    timeout: 30_000,
  });
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(1);
  await expect(page.locator(".composite-layer-item")).toHaveCount(0);
  await expect(page.locator("#select-files-btn")).toBeFocused();
});

test("an open screenshot dialog stays locked through WebGL loss and restores safely", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Screenshot recovery coverage");
  await page.locator("#screenshot-btn").click();
  await expect(page.locator("#screenshot-dialog")).toBeVisible();
  await expect(page.locator("#screenshot-dialog")).toHaveAccessibleName("Export PNG");
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await page.locator("#screenshot-dialog").evaluate(
      (element) => element.contains(document.activeElement),
    )).toBe(true);
  }

  await page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    window.__screenshotDialogContextLoss = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__screenshotDialogContextLoss.loseContext();
  });
  await expect(page.locator("#screenshot-export-btn")).toBeDisabled();
  await expect(page.locator("#screenshot-scale-select")).toBeDisabled();
  await expect(page.locator("#screenshot-background-toggle")).toBeDisabled();
  await page.evaluate(() => window.__screenshotDialogContextLoss.restoreContext());
  await expect(page.locator("#workspace-status")).not.toContainText(/lost|Restoring/, {
    timeout: 30_000,
  });
  await expect(page.locator("#screenshot-export-btn")).toBeEnabled();
  await expect(page.locator("#screenshot-scale-select")).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await expect(page.locator("#screenshot-btn")).toBeFocused();
});

test("fatal WASM reconstruction blocks rendering and controls until recovery completes", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Recovery coverage");
  const readRecoveryPixels = () => page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    const gl = canvas.getContext("webgl2");
    const result = [];
    for (const ratio of [0.35, 0.5, 0.65]) {
      const pixel = new Uint8Array(4);
      gl.readPixels(
        Math.floor(canvas.width * ratio),
        Math.floor(canvas.height * 0.5),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      result.push(...pixel);
    }
    return result;
  });
  const beforeRecovery = await readRecoveryPixels();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalAddLayer = processorPrototype.add_layer;
    const originalAddParsedLayer = processorPrototype.add_parsed_layer;
    const originalAddRenderPayload = processorPrototype.add_render_payload;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    window.__releaseFatalRecovery = releaseRecovery;
    window.__fatalRecoveryStarted = false;
    window.__fatalPatchedMethodCalls = {};
    viewerPrototype.restoreLayerFromSnapshot = async function delayedRestore(...args) {
      window.__fatalRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let shouldFail = true;
    const failOnce = (method, original, receiver, args) => {
      window.__fatalPatchedMethodCalls[method] =
        (window.__fatalPatchedMethodCalls[method] ?? 0) + 1;
      if (shouldFail) {
        shouldFail = false;
        throw new WebAssembly.RuntimeError("unreachable: forced fatal recovery test");
      }
      return original.apply(receiver, args);
    };
    processorPrototype.add_layer = function failRawLayerOnce(...args) {
      return failOnce("add_layer", originalAddLayer, this, args);
    };
    processorPrototype.add_parsed_layer = function failParsedLayerOnce(...args) {
      return failOnce("add_parsed_layer", originalAddParsedLayer, this, args);
    };
    processorPrototype.add_render_payload = function failRenderPayloadOnce(...args) {
      return failOnce("add_render_payload", originalAddRenderPayload, this, args);
    };
  });

  await page.locator("#file-input").setInputFiles({
    name: "fatal-trigger.gtl",
    mimeType: "text/plain",
    buffer: Buffer.from(leftSource),
  });
  await expect.poll(() => page.evaluate(() => window.__fatalPatchedMethodCalls)).not.toEqual({});
  await expect.poll(async () => ({
    started: await page.evaluate(() => window.__fatalRecoveryStarted),
    calls: await page.evaluate(() => window.__fatalPatchedMethodCalls),
  })).toEqual({ started: true, calls: { add_render_payload: 1 } });
  await expect(page.locator("#workspace-status")).toHaveText("Rebuilding renderer");
  await expect(page.locator("#file-input")).toBeDisabled();
  await expect(page.locator("#screenshot-btn")).toBeDisabled();
  await expect(page.locator("#board-outline-select")).toBeDisabled();
  await expect(page.locator(".layer-checkbox").first()).toBeDisabled();

  await page.evaluate(() => window.__releaseFatalRecovery());
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer");
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(2);
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
  await expect(page.locator("#file-input")).toBeEnabled();
  await page.waitForTimeout(50);
  expect(await readRecoveryPixels()).toEqual(beforeRecovery);
});

test("parallel layer continuations never reuse a processor abandoned by fatal recovery", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const prototype = GerberViewer.prototype;
    let staleProcessorCalls = 0;
    let freshProcessorCalls = 0;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    const boundary = { min_x: 0, max_x: 1, min_y: 0, max_y: 1 };
    const staleProcessor = {
      add_render_payload() {
        staleProcessorCalls += 1;
        if (staleProcessorCalls === 1) {
          throw new WebAssembly.RuntimeError("forced concurrent layer recovery");
        }
        throw new Error("abandoned processor was reused");
      },
      get_layer_boundary: () => boundary,
    };
    const freshProcessor = {
      add_render_payload() {
        freshProcessorCalls += 1;
        return 9;
      },
      get_layer_boundary: () => boundary,
    };
    const context = {
      wasmProcessor: staleProcessor,
      pendingFatalWasmRecovery: false,
      isRecoveringWasmProcessor: false,
      wasmRecoveryPromise: null,
      wasmMemoryExhausted: false,
      isWebGlContextLost: false,
      waitForWasmProcessorRecovery: prototype.waitForWasmProcessorRecovery,
      ensureRenderPayloadMemoryHeadroom() {},
      createLayerMetadata: prototype.createLayerMetadata,
      async recoverWasmProcessorAfterFatalError() {
        this.isRecoveringWasmProcessor = true;
        this.wasmRecoveryPromise = recoveryGate.then(() => {
          this.wasmProcessor = freshProcessor;
          this.isRecoveringWasmProcessor = false;
          this.wasmRecoveryPromise = null;
        });
        await this.wasmRecoveryPromise;
      },
    };

    const originalConsoleError = console.error;
    console.error = () => {};
    const first = prototype.createParsedLayerRecord.call(
      context,
      "first.gtl",
      { payload: 1 },
      { sourceContent: "first" },
    );
    const second = prototype.createParsedLayerRecord.call(
      context,
      "second.gtl",
      { payload: 2 },
      { sourceContent: "second" },
    );

    for (let index = 0; index < 10 && !context.isRecoveringWasmProcessor; index += 1) {
      await Promise.resolve();
    }
    const callsWhileRecoveryIsGated = staleProcessorCalls;
    releaseRecovery();
    const settlements = await Promise.allSettled([first, second]);
    console.error = originalConsoleError;

    return {
      callsWhileRecoveryIsGated,
      staleProcessorCalls,
      freshProcessorCalls,
      settlements: settlements.map((settlement) => ({
        status: settlement.status,
        reason: settlement.status === "rejected"
          ? String(settlement.reason?.message ?? settlement.reason)
          : null,
      })),
    };
  });

  expect(result.callsWhileRecoveryIsGated).toBe(1);
  expect(result.staleProcessorCalls).toBe(1);
  expect(result.freshProcessorCalls).toBe(0);
  expect(result.settlements).toEqual([
    { status: "rejected", reason: "forced concurrent layer recovery" },
    { status: "rejected", reason: "WASM memory limit reached" },
  ]);
});

test("WebGL fallback recovery owns rendered pending load records and leaves the next action usable", async ({ page }) => {
  await loadTwoSources(page);
  let composite = await createComposite(page, "Pending load recovery coverage");
  const compositeCheckbox = composite.locator(".layer-checkbox");
  await compositeCheckbox.focus();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalAddParsed = viewerPrototype.addParsedLayerSource;
    const originalRestoreContext = processorPrototype.restore_context;
    let releaseSecondLoad;
    const secondLoadGate = new Promise((resolve) => {
      releaseSecondLoad = resolve;
    });
    window.__releasePendingLoadRecovery = releaseSecondLoad;
    window.__pendingLoadRecoveryGateStarted = false;
    window.__pendingLoadRecoveryViewer = null;
    let addCall = 0;
    viewerPrototype.addParsedLayerSource = async function gateSecondRenderedLayer(...args) {
      addCall += 1;
      window.__pendingLoadRecoveryViewer = this;
      if (addCall === 2) {
        window.__pendingLoadRecoveryGateStarted = true;
        await secondLoadGate;
      }
      return originalAddParsed.apply(this, args);
    };
    let rejectCachedRestore = true;
    processorPrototype.restore_context = function forceFallbackRebuild(...args) {
      if (rejectCachedRestore) {
        rejectCachedRestore = false;
        throw new Error("forced pending-load restore_context fallback");
      }
      return originalRestoreContext.apply(this, args);
    };
  });

  await page.locator("#file-input").setInputFiles([
    { name: "pending-a.gto", mimeType: "text/plain", buffer: Buffer.from(centerSource) },
    { name: "pending-b.gbo", mimeType: "text/plain", buffer: Buffer.from(disconnectedSource) },
  ]);
  await expect.poll(() => page.evaluate(() => window.__pendingLoadRecoveryGateStarted)).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    window.__pendingLoadRecoveryViewer?.pendingLayerRecordsForRecovery
      ?.filter(Boolean).length ?? 0)).toBe(1);
  await expect(page.locator("#loading-modal")).toBeVisible();

  await page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    window.__pendingLoadContextLoss = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__pendingLoadContextLoss.loseContext();
  });
  await expect.poll(() => page.evaluate(() =>
    window.__pendingLoadRecoveryViewer?.isWebGlContextLost)).toBe(true);
  await expect(page.locator("#workspace-status")).toHaveText("Loading files");
  await page.evaluate(() => window.__pendingLoadContextLoss.restoreContext());
  await expect.poll(() => page.evaluate(() => {
    const viewer = window.__pendingLoadRecoveryViewer;
    return Boolean(
      viewer &&
      !viewer.isWebGlContextLost &&
      !viewer.isRestoringWebGlContext &&
      !viewer.webGlRestorePromise,
    );
  }), { timeout: 30_000 }).toBe(true);

  await page.evaluate(() => window.__releasePendingLoadRecovery());
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(4);
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
  const rendererState = await page.evaluate(() => {
    const viewer = window.__pendingLoadRecoveryViewer;
    const gerbers = viewer.layers.filter((layer) => layer.kind === "gerber");
    const compositeLayer = viewer.layers.find((layer) => layer.kind === "composite");
    const names = new Map(viewer.layers.map((layer) => [layer.id, layer.name]));
    return {
      gerberRendererIds: gerbers.map((layer) => layer.layerId),
      sourceNames: compositeLayer.sourceIds.map((id) => names.get(id)),
      pendingRecords: viewer.pendingLayerRecordsForRecovery,
      busy: viewer.isRendererBusy(),
    };
  });
  expect(new Set(rendererState.gerberRendererIds).size).toBe(4);
  expect(rendererState.sourceNames).toEqual(["left.gtl", "right.gbl"]);
  expect(rendererState.pendingRecords).toBeNull();
  expect(rendererState.busy).toBe(false);

  composite = page.locator(".composite-layer-item");
  await expect(composite.locator(".layer-checkbox")).toBeFocused();
  await composite.locator(".layer-menu-btn").click();
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  await page.locator("#screenshot-btn").click();
  await expect(page.locator("#screenshot-dialog")).toBeVisible();
  await page.locator("#screenshot-cancel-btn").click();
  await expect(page.locator("#screenshot-dialog")).toBeHidden();
  await expect(page.locator(".layer-item-error")).toHaveCount(0);
});

test("WebGL loss during fatal WASM recovery preserves the authoritative composite snapshot", async ({ page }) => {
  await loadTwoSources(page);
  const composite = await createComposite(page, "Overlapped recovery coverage");
  const rightRow = page
    .locator(".gerber-layer-item:not(.composite-layer-item)")
    .filter({ hasText: "right.gbl" });
  await rightRow.locator(".layer-checkbox").uncheck();
  await composite.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await page.waitForTimeout(50);
  const canvas = page.locator("#gerber-canvas");
  const readRecoveryPixels = () => page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    const gl = canvas.getContext("webgl2");
    const result = [];
    for (const ratio of [0.35, 0.5, 0.65]) {
      const pixel = new Uint8Array(4);
      gl.readPixels(
        Math.floor(canvas.width * ratio),
        Math.floor(canvas.height * 0.5),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      result.push(...pixel);
    }
    return result;
  });
  const beforeRecovery = await readRecoveryPixels();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalRestore = viewerPrototype.restoreLayerFromSnapshot;
    const originalAddLayer = processorPrototype.add_layer;
    const originalAddParsedLayer = processorPrototype.add_parsed_layer;
    const originalAddRenderPayload = processorPrototype.add_render_payload;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    const summarize = (layers) => layers.map((layer) => ({
      id: layer.id,
      kind: layer.kind,
      name: layer.name,
      visible: layer.visible,
      inverted: layer.inverted,
      sourceIds: layer.sourceIds ? [...layer.sourceIds] : null,
      slotSourceIds: layer.slotSourceIds ? [...layer.slotSourceIds] : null,
      visibleBitset: layer.visibleBitset ? [...layer.visibleBitset] : null,
    }));
    window.__summarizeRecoveryLayers = summarize;
    window.__releaseOverlappedFatalRecovery = releaseRecovery;
    window.__overlappedFatalRecoveryStarted = false;
    viewerPrototype.restoreLayerFromSnapshot = async function delayedRestore(...args) {
      window.__overlappedRecoveryViewer = this;
      window.__overlappedAuthoritativeState = summarize(
        this.activeWasmRecoveryState.layerSnapshot,
      );
      window.__overlappedFatalRecoveryStarted = true;
      await recoveryGate;
      return originalRestore.apply(this, args);
    };
    let shouldFail = true;
    const failOnce = (original, receiver, args) => {
      if (shouldFail) {
        shouldFail = false;
        throw new WebAssembly.RuntimeError("unreachable: forced fatal recovery test");
      }
      return original.apply(receiver, args);
    };
    processorPrototype.add_layer = function failRawLayerOnce(...args) {
      return failOnce(originalAddLayer, this, args);
    };
    processorPrototype.add_parsed_layer = function failParsedLayerOnce(...args) {
      return failOnce(originalAddParsedLayer, this, args);
    };
    processorPrototype.add_render_payload = function failRenderPayloadOnce(...args) {
      return failOnce(originalAddRenderPayload, this, args);
    };
  });

  await page.locator("#file-input").setInputFiles({
    name: "overlapped-fatal-trigger.gtl",
    mimeType: "text/plain",
    buffer: Buffer.from(leftSource),
  });
  await expect
    .poll(() => page.evaluate(() => window.__overlappedFatalRecoveryStarted))
    .toBe(true);

  await page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    window.__overlappedContextLoss = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__overlappedContextLoss.loseContext();
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__overlappedRecoveryViewer.isWebGlContextLost),
    )
    .toBe(true);
  await page.evaluate(() => window.__releaseOverlappedFatalRecovery());
  await expect(page.locator("#workspace-status")).not.toHaveText("Rebuilding renderer");
  await page.evaluate(() => window.__overlappedContextLoss.restoreContext());
  await expect(page.locator("#workspace-status")).not.toContainText(/lost|Restoring|Rebuilding/, {
    timeout: 30_000,
  });

  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item)")).toHaveCount(2);
  await expect(page.locator(".composite-layer-item")).toHaveCount(1);
  await expect(composite).toHaveClass(/layer-item-inverted/);
  await expect(rightRow.locator(".layer-checkbox")).not.toBeChecked();
  const states = await page.evaluate(() => ({
    authoritative: window.__overlappedAuthoritativeState,
    restored: window.__summarizeRecoveryLayers(
      window.__overlappedRecoveryViewer.layers,
    ),
  }));
  expect(states.restored).toEqual(states.authoritative);
  await page.waitForTimeout(50);
  expect(await readRecoveryPixels()).toEqual(beforeRecovery);
});

test("repeated WebGL loss serializes restore ownership and keeps the authoritative snapshot locked", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Repeated restore coverage");
  const stateBefore = await page.locator("#layer-list > .gerber-layer-item").evaluateAll(
    (rows) => rows.map((row) => ({
      id: row.dataset.layerId,
      name: row.querySelector(".layer-label strong")?.textContent,
    })),
  );

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const viewerPrototype = GerberViewer.prototype;
    const processorPrototype = wasm.GerberProcessor.prototype;
    const originalLossHandler = viewerPrototype.handleWebGlContextLost;
    const originalRestoreHandler = viewerPrototype.handleWebGlContextRestored;
    const originalRestoreLayer = viewerPrototype.restoreLayerFromSnapshot;
    const originalRestoreContext = processorPrototype.restore_context;
    let releaseFirstLayerRestore;
    const firstLayerRestoreGate = new Promise((resolve) => {
      releaseFirstLayerRestore = resolve;
    });
    window.__releaseFirstRepeatedRestore = releaseFirstLayerRestore;
    window.__repeatedRestoreStats = {
      handlerEntries: 0,
      layerRestoreEntries: 0,
      activeLayerRestores: 0,
      maxActiveLayerRestores: 0,
      firstLayerRestoreStarted: false,
    };
    viewerPrototype.handleWebGlContextLost = function trackLoss(...args) {
      window.__repeatedRestoreViewer = this;
      return originalLossHandler.apply(this, args);
    };
    viewerPrototype.handleWebGlContextRestored = async function trackRestore(...args) {
      window.__repeatedRestoreViewer = this;
      window.__repeatedRestoreStats.handlerEntries += 1;
      return originalRestoreHandler.apply(this, args);
    };
    viewerPrototype.restoreLayerFromSnapshot = async function gateFirstRestore(...args) {
      const stats = window.__repeatedRestoreStats;
      stats.layerRestoreEntries += 1;
      stats.activeLayerRestores += 1;
      stats.maxActiveLayerRestores = Math.max(
        stats.maxActiveLayerRestores,
        stats.activeLayerRestores,
      );
      try {
        if (!stats.firstLayerRestoreStarted) {
          stats.firstLayerRestoreStarted = true;
          await firstLayerRestoreGate;
        }
        return await originalRestoreLayer.apply(this, args);
      } finally {
        stats.activeLayerRestores -= 1;
      }
    };
    let failCachedRestore = true;
    processorPrototype.restore_context = function forceFirstRebuild(...args) {
      if (failCachedRestore) {
        failCachedRestore = false;
        throw new Error("forced first WebGL rebuild");
      }
      return originalRestoreContext.apply(this, args);
    };

    const canvas = document.querySelector("#gerber-canvas");
    window.__repeatedRestoreExtension = canvas
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__repeatedRestoreExtension.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => window.__repeatedRestoreViewer?.isWebGlContextLost))
    .toBe(true);
  await page.evaluate(() => window.__repeatedRestoreExtension.restoreContext());
  await expect
    .poll(() => page.evaluate(() => window.__repeatedRestoreStats.firstLayerRestoreStarted))
    .toBe(true);

  await page.evaluate(() => window.__repeatedRestoreExtension.loseContext());
  await expect
    .poll(() => page.evaluate(() => window.__repeatedRestoreViewer.webGlContextGeneration))
    .toBe(2);
  await page.evaluate(() => window.__repeatedRestoreExtension.restoreContext());
  await expect
    .poll(() => page.evaluate(() => window.__repeatedRestoreStats.handlerEntries))
    .toBe(2);
  await expect(page.locator("#file-input")).toBeDisabled();
  const gatedState = await page.evaluate(() => ({
    busy: window.__repeatedRestoreViewer.isRendererBusy(),
    restoring: window.__repeatedRestoreViewer.isRestoringWebGlContext,
    activeLayerRestores: window.__repeatedRestoreStats.activeLayerRestores,
    maxActiveLayerRestores: window.__repeatedRestoreStats.maxActiveLayerRestores,
  }));
  expect(gatedState).toEqual({
    busy: true,
    restoring: true,
    activeLayerRestores: 1,
    maxActiveLayerRestores: 1,
  });

  await page.evaluate(() => window.__releaseFirstRepeatedRestore());
  await expect(page.locator("#workspace-status")).not.toContainText(
    /lost|Restoring|Rebuilding/,
    { timeout: 30_000 },
  );
  await expect(page.locator("#file-input")).toBeEnabled();
  const finalState = await page.locator("#layer-list > .gerber-layer-item").evaluateAll(
    (rows) => rows.map((row) => ({
      id: row.dataset.layerId,
      name: row.querySelector(".layer-label strong")?.textContent,
    })),
  );
  expect(finalState).toEqual(stateBefore);
  expect(
    await page.evaluate(() => window.__repeatedRestoreStats.maxActiveLayerRestores),
  ).toBe(1);
});

test("WebGL recovery cancels a pending composite mouse tap before the new renderer can receive it", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Mouse recovery coverage");
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const prototype = GerberViewer.prototype;
    const originalMouseDown = prototype.handleMouseDown;
    const originalPick = prototype.selectFeatureAtCanvasPoint;
    const originalToggle = prototype.toggleCompositeAreaAtClient;
    window.__mouseRecoveryActions = { picks: 0, toggles: 0 };
    prototype.handleMouseDown = function captureMouseViewer(...args) {
      window.__mouseRecoveryViewer = this;
      return originalMouseDown.apply(this, args);
    };
    prototype.selectFeatureAtCanvasPoint = function countPick(...args) {
      window.__mouseRecoveryActions.picks += 1;
      return originalPick.apply(this, args);
    };
    prototype.toggleCompositeAreaAtClient = function countToggle(...args) {
      window.__mouseRecoveryActions.toggles += 1;
      return originalToggle.apply(this, args);
    };
  });
  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect
    .poll(() => page.evaluate(() => window.__mouseRecoveryViewer?.isPanning))
    .toBe(true);

  await page.evaluate(() => {
    const canvasElement = document.querySelector("#gerber-canvas");
    window.__mouseRecoveryExtension = canvasElement
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context");
    window.__mouseRecoveryExtension.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => window.__mouseRecoveryViewer.isWebGlContextLost))
    .toBe(true);
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  expect(await page.evaluate(() => window.__mouseRecoveryViewer.isPanning)).toBe(false);
  await page.evaluate(() => window.__mouseRecoveryExtension.restoreContext());
  await expect(page.locator("#workspace-status")).not.toContainText(/lost|Restoring/, {
    timeout: 30_000,
  });
  await page.mouse.up();
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.__mouseRecoveryActions)).toEqual({
    picks: 0,
    toggles: 0,
  });
  expect(await page.evaluate(() => ({
    isPanning: window.__mouseRecoveryViewer.isPanning,
    mouseGeneration: window.__mouseRecoveryViewer.mouseGestureRendererGeneration,
  }))).toEqual({ isPanning: false, mouseGeneration: null });
});

test("fatal recovery cancels a pending composite touch tap and clears all gesture state", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Touch recovery coverage");
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="select-visible-area"]').click();
  await expect(page.locator(".composite-selection-bar")).toBeVisible();
  await page.waitForTimeout(50);
  await installGatedFatalProcessorMethod(
    page,
    "render_composite_selection",
    "pending composite touch tap",
  );
  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const prototype = GerberViewer.prototype;
    const originalTouchStart = prototype.handleTouchStart;
    const originalPick = prototype.selectFeatureAtCanvasPoint;
    const originalToggle = prototype.toggleCompositeAreaAtClient;
    window.__touchRecoveryActions = { picks: 0, toggles: 0 };
    prototype.handleTouchStart = function captureTouchViewer(...args) {
      window.__touchRecoveryViewer = this;
      return originalTouchStart.apply(this, args);
    };
    prototype.selectFeatureAtCanvasPoint = function countPick(...args) {
      window.__touchRecoveryActions.picks += 1;
      return originalPick.apply(this, args);
    };
    prototype.toggleCompositeAreaAtClient = function countToggle(...args) {
      window.__touchRecoveryActions.toggles += 1;
      return originalToggle.apply(this, args);
    };
    const target = document.querySelector("#gerber-canvas");
    const rect = target.getBoundingClientRect();
    const touch = new Touch({
      identifier: 91,
      target,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    window.__pendingRecoveryTouch = touch;
    target.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
    }));
    window.__touchRecoveryViewer.requestRender();
  });
  await waitForInjectedFatalRecovery(page);
  await expect(page.locator(".composite-selection-bar")).toBeHidden();
  expect(await page.evaluate(() => ({
    isTouching: window.__touchRecoveryViewer.isTouching,
    touches: window.__touchRecoveryViewer.touches.length,
    touchCandidate: window.__touchRecoveryViewer.touchTapCandidate,
    touchGeneration: window.__touchRecoveryViewer.touchGestureRendererGeneration,
  }))).toEqual({
    isTouching: false,
    touches: 0,
    touchCandidate: false,
    touchGeneration: null,
  });
  await releaseInjectedFatalRecovery(page);
  await page.evaluate(() => {
    const target = document.querySelector("#gerber-canvas");
    const touch = window.__pendingRecoveryTouch;
    target.dispatchEvent(new TouchEvent("touchend", {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: [touch],
    }));
  });
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.__touchRecoveryActions)).toEqual({
    picks: 0,
    toggles: 0,
  });
  await expect(page.locator("#file-input")).toBeEnabled();
});

test("screenshot export skips one failed composite and records a diagnostic", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Failing screenshot composite");
  for (const checkbox of await page.locator(
    ".gerber-layer-item:not(.composite-layer-item) .layer-checkbox",
  ).all()) {
    await checkbox.uncheck();
  }
  const diagnosticsBefore = Number(await page.locator("#diagnostics-count").textContent());

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    window.__originalCompositeErrorReader = prototype.get_composite_error;
    prototype.get_composite_error = () => "forced screenshot composite allocation failure";
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__failedCompositeScreenshotBlob = blob;
      return originalCreateObjectUrl(blob);
    };
  });

  await page.locator("#screenshot-btn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await expect(page.locator("#diagnostics-count")).toHaveText(
    String(diagnosticsBefore + 1),
  );
  await page.locator('[data-panel-tab="diagnostics"]').click();
  await expect(page.locator("#diagnostic-list")).toContainText(
    "Screenshot skipped composite: Failing screenshot composite",
  );
  const pixelsAreTransparent = await page.evaluate(async () => {
    const bitmap = await createImageBitmap(window.__failedCompositeScreenshotBlob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    bitmap.close();
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] !== 0) return false;
    }
    return true;
  });
  expect(pixelsAreTransparent).toBe(true);
});

test("screenshot renderer cleans up pre-initialization failures", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { ScreenshotExporter } = await import(
      "/js/rendering/screenshot-exporter.js"
    );
    let missingModuleContextCalls = 0;
    const missingModuleExporter = new ScreenshotExporter({
      canvas: {
        getContext() {
          missingModuleContextCalls += 1;
          return {};
        },
      },
      getWasmModule: () => null,
    });
    let missingModuleError = "";
    try {
      missingModuleExporter.createRenderer({}, false);
    } catch (error) {
      missingModuleError = error.message;
    }

    let constructorLoseCalls = 0;
    const fakeGl = {
      getExtension(name) {
        if (name !== "WEBGL_lose_context") return null;
        return {
          loseContext() {
            constructorLoseCalls += 1;
          },
        };
      },
    };
    const constructorCanvas = {
      width: 1,
      height: 1,
      getContext: () => fakeGl,
    };
    const constructorExporter = new ScreenshotExporter({
      canvas: constructorCanvas,
      getWasmModule: () => ({
        GerberProcessor: class {
          constructor() {
            throw new Error("forced screenshot processor constructor failure");
          }
        },
      }),
    });
    let constructorError = "";
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = (name, options) =>
      name.toLowerCase() === "canvas"
        ? constructorCanvas
        : originalCreateElement(name, options);
    try {
      constructorExporter.createRenderer({}, false);
    } catch (error) {
      constructorError = error.message;
    } finally {
      document.createElement = originalCreateElement;
    }
    return {
      missingModuleContextCalls,
      missingModuleError,
      constructorLoseCalls,
      constructorCanvasSize: [constructorCanvas.width, constructorCanvas.height],
      constructorError,
    };
  });

  expect(result).toEqual({
    missingModuleContextCalls: 0,
    missingModuleError: "WASM module is unavailable for screenshot export.",
    constructorLoseCalls: 1,
    constructorCanvasSize: [0, 0],
    constructorError: "forced screenshot processor constructor failure",
  });
});

test("screenshot setup failure frees its temporary processor and context", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Screenshot cleanup coverage");

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalInteractions = prototype.set_interactions_enabled;
    const originalPreserve = prototype.set_preserve_arc_regions;
    const originalClear = prototype.clear;
    const originalFree = prototype.free;
    const tracked = new WeakSet();
    let shouldFail = true;
    window.__screenshotSetupCleanup = { clear: 0, free: 0, lose: 0 };
    prototype.set_interactions_enabled = function trackScreenshotProcessor(...args) {
      tracked.add(this);
      return originalInteractions.apply(this, args);
    };
    prototype.set_preserve_arc_regions = function failScreenshotSetupOnce(...args) {
      if (tracked.has(this) && shouldFail) {
        shouldFail = false;
        throw new Error("forced screenshot renderer setup failure");
      }
      return originalPreserve.apply(this, args);
    };
    prototype.clear = function trackClear(...args) {
      if (tracked.has(this)) window.__screenshotSetupCleanup.clear += 1;
      return originalClear.apply(this, args);
    };
    prototype.free = function trackFree(...args) {
      if (tracked.has(this)) window.__screenshotSetupCleanup.free += 1;
      return originalFree.apply(this, args);
    };
    const glPrototype = WebGL2RenderingContext.prototype;
    const originalGetExtension = glPrototype.getExtension;
    glPrototype.getExtension = function trackLoseContext(name) {
      const extension = originalGetExtension.call(this, name);
      if (name !== "WEBGL_lose_context" || !extension) return extension;
      return {
        loseContext: () => {
          window.__screenshotSetupCleanup.lose += 1;
          extension.loseContext();
        },
        restoreContext: () => extension.restoreContext(),
      };
    };
  });

  await page.locator("#screenshot-btn").click();
  await page.locator("#screenshot-export-btn").click();
  await expect
    .poll(() => page.evaluate(() => window.__screenshotSetupCleanup))
    .toEqual({ clear: 1, free: 1, lose: 1 });
  await expect(page.locator("#screenshot-dialog")).toBeVisible();
  await expect(page.locator("#screenshot-export-btn")).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
});

test("streamed screenshot preflight excludes a composite that fails in a later band", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Late screenshot failure");
  for (const checkbox of await page.locator(
    ".gerber-layer-item:not(.composite-layer-item) .layer-checkbox",
  ).all()) {
    await checkbox.uncheck();
  }
  const diagnosticsBefore = Number(await page.locator("#diagnostics-count").textContent());

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const { ScreenshotExporter } = await import(
      "/js/rendering/screenshot-exporter.js"
    );
    const prototype = wasm.GerberProcessor.prototype;
    const originalRenderTile = prototype.render_tile;
    const originalRenderTileWithBlendModes = prototype.render_tile_with_blend_modes;
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    let renderedLaterBand = false;
    let failureReported = false;
    const trackBand = (original, receiver, args) => {
      renderedLaterBand ||= Number(args[5]) > 0;
      return original.apply(receiver, args);
    };
    prototype.render_tile = function trackRenderTile(...args) {
      return trackBand(originalRenderTile, this, args);
    };
    prototype.render_tile_with_blend_modes = function trackBlendTile(...args) {
      return trackBand(originalRenderTileWithBlendModes, this, args);
    };
    prototype.get_composite_error = () => {
      if (!renderedLaterBand || failureReported) return "";
      failureReported = true;
      return "forced late-band screenshot composite failure";
    };
    ScreenshotExporter.prototype.getStreamTileDimensions = function forceBands(
      exportWidth,
      exportHeight,
    ) {
      return {
        width: exportWidth,
        height: Math.max(1, Math.floor(exportHeight / 3)),
      };
    };
    URL.createObjectURL = (blob) => {
      window.__lateBandScreenshotBlob = blob;
      return originalCreateObjectUrl(blob);
    };
  });

  await page.locator("#screenshot-btn").click();
  await page.locator("#screenshot-scale-select").selectOption("2");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  await downloadPromise;
  await expect(page.locator("#diagnostics-count")).toHaveText(
    String(diagnosticsBefore + 1),
  );
  const pixelsAreTransparent = await page.evaluate(async () => {
    const bitmap = await createImageBitmap(window.__lateBandScreenshotBlob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    bitmap.close();
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] !== 0) return false;
    }
    return true;
  });
  expect(pixelsAreTransparent).toBe(true);
});

test("screenshot export skips a construction failure and renders the next composite", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page, "Construction failure");
  await createComposite(page, "Healthy later composite");
  for (const checkbox of await page.locator(
    ".gerber-layer-item:not(.composite-layer-item) .layer-checkbox",
  ).all()) {
    await checkbox.uncheck();
  }
  const diagnosticsBefore = Number(await page.locator("#diagnostics-count").textContent());

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalAddComposite = prototype.add_composite_layer_with_bounds;
    window.__screenshotCompositeConstructionCalls = 0;
    prototype.add_composite_layer_with_bounds = function forceFirstConstructionFailure(...args) {
      window.__screenshotCompositeConstructionCalls += 1;
      if (window.__screenshotCompositeConstructionCalls === 1) {
        throw new Error("forced screenshot composite construction failure");
      }
      return originalAddComposite.apply(this, args);
    };
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__lastScreenshotBlob = blob;
      return originalCreateObjectUrl(blob);
    };
  });

  await page.locator("#screenshot-btn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
  await expect(page.locator("#diagnostics-count")).toHaveText(
    String(diagnosticsBefore + 1),
  );
  expect(await page.evaluate(() => window.__screenshotCompositeConstructionCalls)).toBe(2);
  const hasRenderedPixel = await page.evaluate(async () => {
    const bitmap = await createImageBitmap(window.__lastScreenshotBlob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    bitmap.close();
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 0) return true;
    }
    return false;
  });
  expect(hasRenderedPixel).toBe(true);
});

test("single and streamed screenshots isolate a failed hidden composite dependency", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "left.gtl", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
    { name: "right.gbl", mimeType: "text/plain", buffer: Buffer.from(rightSource) },
    {
      name: "center.gtl",
      mimeType: "text/plain",
      buffer: Buffer.from(rightSource.replace("X015000", "X000000")),
    },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await createCompositeFromSources(page, "Failed dependency", [
    "left.gtl",
    "right.gbl",
  ]);
  await createCompositeFromSources(page, "Healthy independent composite", [
    "right.gbl",
    "center.gtl",
  ]);
  for (const name of ["left.gtl", "right.gbl"]) {
    await page
      .locator(".gerber-layer-item:not(.composite-layer-item)", { hasText: name })
      .locator(".layer-checkbox")
      .uncheck();
  }
  const diagnosticsBefore = Number(
    await page.locator("#diagnostics-count").textContent(),
  );

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalAddLayer = prototype.add_layer;
    const originalAddComposite = prototype.add_composite_layer_with_bounds;
    window.__hiddenDependencyScreenshot = {
      healthyCompositeCalls: 0,
    };
    prototype.add_layer = function failHiddenDependency(content, ...args) {
      if (String(content).includes("X-015000")) {
        throw new Error("forced hidden composite dependency rebuild failure");
      }
      return originalAddLayer.call(this, content, ...args);
    };
    prototype.add_composite_layer_with_bounds = function countHealthyComposite(...args) {
      window.__hiddenDependencyScreenshot.healthyCompositeCalls += 1;
      return originalAddComposite.apply(this, args);
    };
  });

  await page.locator("#screenshot-btn").click();
  let downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  await downloadPromise;
  await expect(page.locator("#screenshot-dialog")).toBeHidden();
  expect(
    await page.evaluate(
      () => window.__hiddenDependencyScreenshot.healthyCompositeCalls,
    ),
  ).toBe(1);

  await page.locator("#screenshot-btn").click();
  await page.locator("#screenshot-scale-select").selectOption("2");
  downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  await downloadPromise;
  await expect(page.locator("#screenshot-dialog")).toBeHidden();
  expect(
    await page.evaluate(
      () => window.__hiddenDependencyScreenshot.healthyCompositeCalls,
    ),
  ).toBe(2);
  await expect(page.locator("#diagnostics-count")).toHaveText(
    String(diagnosticsBefore + 2),
  );
  await page.locator('[data-panel-tab="diagnostics"]').click();
  await expect(page.locator("#diagnostic-list")).toContainText(
    "Screenshot skipped composite: Failed dependency",
  );
});

test("screenshot outline traps never reuse the poisoned processor for Bounds fallback", async ({ page }) => {
  await loadThreeSources(page);
  const composite = await createCompositeFromSources(
    page,
    "Fatal screenshot outline",
    ["left.gtl", "right.gbl"],
  );

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalCompositeOutline =
      prototype.add_composite_layer_with_outline_content;
    const originalCompositeBounds = prototype.add_composite_layer_with_bounds;
    let failCompositeOutline = true;
    window.__fatalScreenshotOutline = {
      compositeTrapped: false,
      compositeBoundsAfterTrap: 0,
      invertedTrapped: false,
      invertedBoundsAfterTrap: 0,
      downloads: 0,
    };
    prototype.add_composite_layer_with_outline_content =
      function failCompositeOutlineOnce(...args) {
        if (failCompositeOutline) {
          failCompositeOutline = false;
          window.__fatalScreenshotOutline.compositeTrapped = true;
          throw new WebAssembly.RuntimeError(
            "unreachable: forced fatal recovery test in screenshot composite outline",
          );
        }
        return originalCompositeOutline.apply(this, args);
      };
    prototype.add_composite_layer_with_bounds = function countCompositeFallback(...args) {
      if (window.__fatalScreenshotOutline.compositeTrapped) {
        window.__fatalScreenshotOutline.compositeBoundsAfterTrap += 1;
      }
      return originalCompositeBounds.apply(this, args);
    };
    HTMLAnchorElement.prototype.click = function countUnexpectedDownload() {
      window.__fatalScreenshotOutline.downloads += 1;
    };
  });

  const dialog = page.locator("#screenshot-dialog");
  await page.locator("#screenshot-btn").click();
  await page.locator("#screenshot-export-btn").click();
  await expect(page.locator("#screenshot-export-btn")).toBeEnabled();
  expect(await page.evaluate(() => window.__fatalScreenshotOutline)).toMatchObject({
    compositeTrapped: true,
    compositeBoundsAfterTrap: 0,
    downloads: 0,
  });
  await page.locator("#screenshot-dismiss-btn").click();
  await expect(dialog).toBeHidden();

  await composite.locator(".layer-checkbox").uncheck();
  const source = page
    .locator(".gerber-layer-item:not(.composite-layer-item)")
    .filter({ hasText: "left.gtl" });
  await source.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect(source).toHaveClass(/layer-item-inverted/);
  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalInvertedOutline = prototype.add_inverted_layer_with_outline;
    const originalInvertedBounds = prototype.add_inverted_layer_with_bounds;
    let failInvertedOutline = true;
    prototype.add_inverted_layer_with_outline = function failInvertedOutlineOnce(...args) {
      if (failInvertedOutline) {
        failInvertedOutline = false;
        window.__fatalScreenshotOutline.invertedTrapped = true;
        throw new WebAssembly.RuntimeError(
          "unreachable: forced fatal recovery test in screenshot inverted outline",
        );
      }
      return originalInvertedOutline.apply(this, args);
    };
    prototype.add_inverted_layer_with_bounds = function countInvertedFallback(...args) {
      if (window.__fatalScreenshotOutline.invertedTrapped) {
        window.__fatalScreenshotOutline.invertedBoundsAfterTrap += 1;
      }
      return originalInvertedBounds.apply(this, args);
    };
  });

  await page.locator("#screenshot-btn").click();
  await page.locator("#screenshot-export-btn").click();
  await expect(page.locator("#screenshot-export-btn")).toBeEnabled();
  expect(await page.evaluate(() => window.__fatalScreenshotOutline)).toEqual({
    compositeTrapped: true,
    compositeBoundsAfterTrap: 0,
    invertedTrapped: true,
    invertedBoundsAfterTrap: 0,
    downloads: 0,
  });
});

test("screenshot composites use a raw token for a visible inverted outline", async ({ page }) => {
  await loadThreeSources(page);
  await page.locator("#board-outline-select").selectOption({ label: "board-outline.gko" });
  await createCompositeFromSources(page, "Outline excluded", ["left.gtl", "right.gbl"]);
  await createCompositeFromSources(page, "Outline included", ["board-outline.gko", "left.gtl"]);

  const outlineRow = page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
    has: page.locator(".layer-label strong", { hasText: "board-outline.gko" }),
  });
  await outlineRow.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect(outlineRow).toHaveClass(/layer-item-inverted/);
  for (const name of ["left.gtl", "right.gbl"]) {
    await page
      .locator(".gerber-layer-item:not(.composite-layer-item)", {
        has: page.locator(".layer-label strong", { hasText: name }),
      })
      .locator(".layer-checkbox")
      .uncheck();
  }
  const diagnosticsBefore = Number(await page.locator("#diagnostics-count").textContent());

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const { ScreenshotExporter } = await import(
      "/js/rendering/screenshot-exporter.js"
    );
    const processorPrototype = wasm.GerberProcessor.prototype;
    const exporterCreateRenderer = ScreenshotExporter.prototype.createRenderer;
    const outlineMarker = "%ADD10C,0.200*%";
    window.__invertedOutlineScreenshot = {
      rawIds: [],
      effectiveIds: [],
      compositeCalls: [],
      outlineBounds: null,
      outlineRenderBounds: null,
    };
    ScreenshotExporter.prototype.createRenderer = function forceTransparentOutline(...args) {
      const layers = this.getLayers();
      for (const layer of layers) {
        if (layer.name === "board-outline.gko") {
          window.__invertedOutlineScreenshot.outlineBounds = { ...layer.bounds };
          window.__invertedOutlineScreenshot.outlineRenderBounds = {
            ...layer.renderBounds,
          };
          layer.alpha = 0;
        }
        if (layer.kind === "composite") {
          layer.color = [0, 1, 0];
          layer.alpha = 1;
        }
      }
      return exporterCreateRenderer.apply(this, args);
    };
    for (const method of ["add_layer", "add_layer_with_offset"]) {
      const original = processorPrototype[method];
      processorPrototype[method] = function trackRawOutline(content, ...args) {
        const id = original.call(this, content, ...args);
        if (String(content).includes(outlineMarker)) {
          window.__invertedOutlineScreenshot.rawIds.push(Number(id));
        }
        return id;
      };
    }
    for (const method of [
      "add_inverted_layer_with_bounds",
      "add_inverted_layer_with_outline",
    ]) {
      const original = processorPrototype[method];
      processorPrototype[method] = function trackEffectiveOutline(content, ...args) {
        const id = original.call(this, content, ...args);
        if (String(content).includes(outlineMarker)) {
          window.__invertedOutlineScreenshot.effectiveIds.push(Number(id));
        }
        return id;
      };
    }
    const originalAddComposite =
      processorPrototype.add_composite_layer_with_outline_content;
    processorPrototype.add_composite_layer_with_outline_content = function trackOutlineToken(
      sourceIds,
      bits,
      inverted,
      outlineId,
      ...args
    ) {
      window.__invertedOutlineScreenshot.compositeCalls.push({
        sourceIds: [...sourceIds],
        outlineId: Number(outlineId),
      });
      return originalAddComposite.call(
        this,
        sourceIds,
        bits,
        inverted,
        outlineId,
        ...args,
      );
    };
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__invertedOutlineScreenshotBlob = blob;
      return originalCreateObjectUrl(blob);
    };
  });

  await page.locator("#screenshot-btn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  await downloadPromise;
  await expect(page.locator("#diagnostics-count")).toHaveText(String(diagnosticsBefore));
  const result = await page.evaluate(async () => {
    const state = window.__invertedOutlineScreenshot;
    const bitmap = await createImageBitmap(window.__invertedOutlineScreenshotBlob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    bitmap.close();
    return {
      ...state,
      hasCompositePixel: Array.from({ length: pixels.length / 4 }, (_, index) =>
        pixels[index * 4 + 3]
      ).some((alpha) => alpha > 0),
    };
  });
  expect(result.rawIds).toHaveLength(1);
  expect(result.effectiveIds).toHaveLength(1);
  expect(result.compositeCalls).toHaveLength(2);
  expect(result.compositeCalls.every((call) => call.outlineId === result.rawIds[0])).toBe(true);
  expect(result.compositeCalls.some((call) => call.sourceIds.includes(result.effectiveIds[0]))).toBe(true);
  expect(result.rawIds[0]).not.toBe(result.effectiveIds[0]);
  expect(result.outlineBounds.minX).toBeGreaterThan(
    result.outlineRenderBounds.minX,
  );
  expect(result.outlineBounds.maxX).toBeLessThan(
    result.outlineRenderBounds.maxX,
  );
  expect(result.hasCompositePixel).toBe(true);
});

test("single-image screenshot stays modal and disables controls until encoding completes", async ({ page }) => {
  await loadTwoSources(page);
  await page.evaluate(() => {
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    window.__singleScreenshotEncodingStarted = false;
    HTMLCanvasElement.prototype.toBlob = function gateScreenshotBlob(callback, ...args) {
      window.__singleScreenshotEncodingStarted = true;
      window.__releaseSingleScreenshotEncoding = () =>
        originalToBlob.call(this, callback, ...args);
    };
  });

  await page.locator("#screenshot-btn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  await expect
    .poll(() => page.evaluate(() => window.__singleScreenshotEncodingStarted))
    .toBe(true);
  await expect(page.locator("#screenshot-background-toggle")).toBeDisabled();
  await expect(page.locator("#screenshot-scale-select")).toBeDisabled();
  await expect(page.locator("#screenshot-cancel-btn")).toBeDisabled();
  await expect(page.locator("#screenshot-dismiss-btn")).toBeDisabled();
  await expect(page.locator("#screenshot-export-btn")).toBeDisabled();
  await expect(page.locator("#screenshot-export-btn")).toHaveText("Exporting");
  await page.keyboard.press("Escape");
  await expect(page.locator("#screenshot-dialog")).toBeVisible();

  await page.evaluate(() => window.__releaseSingleScreenshotEncoding());
  await downloadPromise;
  await expect(page.locator("#screenshot-dialog")).toBeHidden();
});

test("touch long press opens composite actions and movement cancels it", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page);

  const dispatchTouch = async (type, targetSelector, xOffset = 0, yOffset = 0) => {
    await page.evaluate(({ type, targetSelector, xOffset, yOffset }) => {
      const target = document.querySelector(targetSelector);
      const rect = target.getBoundingClientRect();
      const touch = new Touch({
        identifier: 7,
        target,
        clientX: rect.left + rect.width / 2 + xOffset,
        clientY: rect.top + rect.height / 2 + yOffset,
      });
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [touch],
        targetTouches: type === "touchend" ? [] : [touch],
        changedTouches: [touch],
      }));
    }, { type, targetSelector, xOffset, yOffset });
  };

  await dispatchTouch("touchstart", ".composite-layer-item .layer-label");
  await page.waitForTimeout(550);
  await expect(page.locator(".layer-context-menu")).toBeVisible();
  await dispatchTouch("touchend", ".composite-layer-item .layer-label");
  await page.keyboard.press("Escape");

  await dispatchTouch("touchstart", ".composite-layer-item .layer-label");
  await dispatchTouch("touchmove", ".composite-layer-item .layer-label", 20, 0);
  await page.waitForTimeout(550);
  await expect(page.locator(".layer-context-menu")).toBeHidden();
  await dispatchTouch("touchend", ".composite-layer-item .layer-label", 20, 0);
  await expect(row).toHaveCount(1);
});

test("bulk visibility and source deletion preserve composite lifecycle rules", async ({ page }) => {
  await loadTwoSources(page);
  await createComposite(page);

  await page.locator("#unselect-all-btn").click();
  await expect(page.locator(".layer-checkbox:checked")).toHaveCount(0);
  await page.locator("#select-all-btn").click();
  await expect(page.locator(".layer-checkbox:checked")).toHaveCount(3);

  const sourceRow = page.locator(".gerber-layer-item").filter({
    has: page.locator(".layer-label strong", { hasText: "left.gtl" }),
  });
  page.once("dialog", (dialog) => dialog.accept());
  await sourceRow.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="delete-layer"]').click();
  await expect(page.locator(".composite-layer-item")).toHaveCount(0);
  await expect(page.locator(".gerber-layer-item")).toHaveCount(1);
  await expect(page.locator(".gerber-layer-item .layer-label strong")).toHaveText("right.gbl");
});

test("composite inversion is outline-clipped and composites never become outline candidates", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "board-outline.gko");

  const outlineOptions = await page.locator("#board-outline-select option").allTextContents();
  expect(outlineOptions.every((text) => !text.includes("board-outline.gko"))).toBe(true);

  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect(row).toHaveClass(/layer-item-inverted/);
  await expect(row.locator(".layer-checkbox")).toHaveAttribute(
    "aria-label",
    /inverted/,
  );

  await page.locator("#screenshot-btn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
});

test("inverted outline dependencies retain the raw Gerber bounds", async ({ page }) => {
  await loadThreeSources(page);
  await page.locator("#board-outline-select").selectOption({ label: "board-outline.gko" });
  await createCompositeFromSources(page, "Raw outline bounds", ["left.gtl", "right.gbl"]);

  const outlineRow = page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
    has: page.locator(".layer-label strong", { hasText: "board-outline.gko" }),
  });
  await outlineRow.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect(outlineRow).toHaveClass(/layer-item-inverted/);

  const captured = await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const prototype = GerberViewer.prototype;
    const original = prototype.getCompositeOutlineSource;
    let value = null;
    prototype.getCompositeOutlineSource = function captureRawOutline(layer) {
      const result = original.call(this, layer);
      if (layer.name === "Raw outline bounds" && result?.type === "outline") {
        value = {
          dependencyBounds: { ...result.bounds },
          rawBounds: { ...result.outline.bounds },
          displayBounds: { ...result.outline.renderBounds },
        };
      }
      return result;
    };
    const composite = document.querySelector(".composite-layer-item");
    composite.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 20,
      clientY: 20,
    }));
    return value;
  });
  expect(captured.dependencyBounds).toEqual(captured.rawBounds);
  expect(captured.displayBounds.minX).toBeLessThan(captured.rawBounds.minX);
  expect(captured.displayBounds.maxX).toBeGreaterThan(captured.rawBounds.maxX);
});

test("composite inversion rolls back nonfatal mutations and disables missing outlines", async ({ page }) => {
  await loadTwoSources(page);
  const row = await createComposite(page, "Transactional inversion");
  await page.waitForTimeout(100);
  const readFramebufferHash = () => page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    const gl = canvas.getContext("webgl2");
    gl.finish();
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(
      0,
      0,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    let hash = 2166136261;
    for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
  });
  const before = await readFramebufferHash();

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const original = prototype.set_composite_inverted;
    let fail = true;
    window.__inversionMutationCalls = 0;
    prototype.set_composite_inverted = function failOnce(...args) {
      window.__inversionMutationCalls += 1;
      if (fail) {
        fail = false;
        throw new Error("forced nonfatal composite inversion failure");
      }
      return original.apply(this, args);
    };
  });
  await row.click({ button: "right" });
  await page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]').click();
  await expect.poll(() => page.evaluate(() => window.__inversionMutationCalls)).toBe(2);
  await expect(row).not.toHaveClass(/layer-item-inverted/);
  await expect(row).not.toHaveClass(/layer-item-error/);
  await page.waitForTimeout(100);
  expect(await readFramebufferHash()).toBe(before);

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    GerberViewer.prototype.getCompositeOutlineSource = () => null;
  });
  await row.click({ button: "right" });
  const invert = page.locator('.layer-context-menu [data-layer-menu-action="invert-layer"]');
  await expect(invert).toBeDisabled();
  await expect(invert).toHaveAttribute("title", /board outline/i);
});

test("Viewer composite visual controls preserve mask caches and screenshot stack pixels", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "overlap-top.gtl", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
    { name: "overlap-bottom.gbl", mimeType: "text/plain", buffer: Buffer.from(leftSource) },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  let composite = await createCompositeFromSources(
    page,
    "Visual state coverage",
    ["overlap-top.gtl", "overlap-bottom.gbl"],
  );
  const sourceRows = page.locator(".gerber-layer-item:not(.composite-layer-item)");

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    window.__viewerCompositeEncodeCounts = [];
    for (const method of ["render", "render_with_clear_and_blend_modes"]) {
      const original = prototype[method];
      prototype[method] = function trackCompositeEncoding(activeIds, ...args) {
        const result = original.call(this, activeIds, ...args);
        for (const id of activeIds) {
          try {
            const diagnostics = this.get_composite_diagnostics(id);
            window.__viewerCompositeEncodeCounts.push(
              Number(diagnostics.membershipEncodeCount),
            );
          } catch (_error) {
            // Ordinary Gerber IDs are intentionally ignored.
          }
        }
        return result;
      };
    }
  });

  await saveLayerPickrColor(page, sourceRows.first(), "rgba(255, 0, 0, 1)");
  composite = page.locator(".composite-layer-item").filter({ hasText: "Visual state coverage" });
  await saveLayerPickrColor(page, composite, "rgba(0, 0, 255, 1)");
  await expect(composite.locator(".layer-color-picker")).toHaveClass(/has-alpha-override/);
  await expect(composite.locator(".layer-color-picker")).toHaveAccessibleName(
    "Visual state coverage color, custom alpha",
  );
  await expect(composite.locator(".layer-color-picker")).toHaveAttribute(
    "title",
    "Layer color; custom alpha",
  );
  await sourceRows.nth(1).locator(".layer-checkbox").uncheck();
  await page.waitForTimeout(75);

  const blended = await readCanvasPixel(page);
  expect(blended[0]).toBeGreaterThan(150);
  expect(blended[2]).toBeGreaterThan(150);

  await page.locator("#alpha-slider").fill("25");
  await page.locator("#alpha-slider").dispatchEvent("input");
  await page.waitForTimeout(50);

  await page.locator('[data-panel-tab="options"]').click();
  await page.locator('label:has(#composite-mode-stack)').click();
  await page.locator('[data-panel-tab="layers"]').click();
  await page.waitForTimeout(75);
  const stackedCompositeOnTop = await readCanvasPixel(page);
  expect(stackedCompositeOnTop[0]).toBeLessThan(30);
  expect(stackedCompositeOnTop[2]).toBeGreaterThan(220);

  await page.evaluate(() => {
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__viewerVisualScreenshotBlob = blob;
      return originalCreateObjectUrl(blob);
    };
  });
  await page.locator("#screenshot-btn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#screenshot-export-btn").click();
  await downloadPromise;
  const screenshotCenter = await page.evaluate(async () => {
    const bitmap = await createImageBitmap(window.__viewerVisualScreenshotBlob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixel = context.getImageData(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1,
      1,
    ).data;
    bitmap.close();
    return [...pixel];
  });
  expect(screenshotCenter[0]).toBeLessThan(30);
  expect(screenshotCenter[2]).toBeGreaterThan(220);

  const lastSource = sourceRows.last();
  await composite.dragTo(lastSource);
  await expect(page.locator("#layer-list > .composite-layer-item")).toHaveCount(1);
  await page.waitForTimeout(75);
  const stackedCompositeStillOnTop = await readCanvasPixel(page);
  expect(stackedCompositeStillOnTop[0]).toBeLessThan(30);
  expect(stackedCompositeStillOnTop[2]).toBeGreaterThan(220);

  await page.locator('[data-panel-tab="options"]').click();
  await page.locator('label:has(#composite-mode-blend)').click();
  await page.locator('[data-panel-tab="layers"]').click();
  composite = page.locator(".composite-layer-item").filter({ hasText: "Visual state coverage" });
  await saveLayerPickrColor(page, composite, "rgba(0, 0, 255, 0.25)", {
    useGlobalAlpha: true,
  });
  await expect(composite.locator(".layer-color-picker")).not.toHaveClass(/has-alpha-override/);
  await expect(composite.locator(".layer-color-picker")).toHaveAccessibleName(
    "Visual state coverage color, global alpha",
  );
  await expect(composite.locator(".layer-color-picker")).toHaveAttribute(
    "title",
    "Layer color; uses Global Alpha",
  );
  await expect(composite.locator(".layer-color-picker")).toHaveCSS("--layer-alpha", "0.25");

  const encodeCounts = await page.evaluate(() => window.__viewerCompositeEncodeCounts);
  expect(encodeCounts.length).toBeGreaterThan(2);
  expect(new Set(encodeCounts).size).toBe(1);
});

test("selection maps CSS pixels, clips code zero, throttles hover, and toggles disconnected codes globally", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "islands.gtl", mimeType: "text/plain", buffer: Buffer.from(disconnectedSource) },
    { name: "center.gbl", mimeType: "text/plain", buffer: Buffer.from(centerSource) },
    { name: "selection-outline.gko", mimeType: "text/plain", buffer: Buffer.from(outlineSource) },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog.locator("[data-composite-name]").fill("Selection map coverage");
  for (const sourceName of ["islands.gtl", "center.gbl"]) {
    await dialog
      .locator(".composite-source-choice", { hasText: sourceName })
      .locator("input")
      .check();
  }
  await dialog.locator('[data-composite-preset="difference"]').click();
  await dialog.locator("[data-composite-submit]").click();
  let composite = page.locator(".composite-layer-item").filter({
    hasText: "Selection map coverage",
  });
  await page.locator(".gerber-layer-item:not(.composite-layer-item) .layer-checkbox")
    .evaluateAll((checkboxes) => {
      for (const checkbox of checkboxes) {
        if (checkbox.checked) checkbox.click();
      }
    });

  await composite.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="select-visible-area"]').click();
  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  const mapping = await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const context = {
      canvas: {
        width: 400,
        height: 200,
        getBoundingClientRect: () => ({
          left: 10,
          top: 20,
          right: 210,
          bottom: 120,
          width: 200,
          height: 100,
        }),
      },
    };
    return {
      topLeftQuarter: GerberViewer.prototype.getCompositeCanvasPixel.call(
        context,
        60,
        45,
      ),
      bottomRight: GerberViewer.prototype.getCompositeCanvasPixel.call(
        context,
        209.9,
        119.9,
      ),
      outside: GerberViewer.prototype.getCompositeCanvasPixel.call(context, 210, 120),
    };
  });
  expect(mapping).toEqual({
    topLeftQuarter: { x: 100, y: 149 },
    bottomRight: { x: 399, y: 0 },
    outside: null,
  });

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalPick = prototype.pick_composite_code;
    const originalByte = prototype.set_composite_visible_byte;
    const originalBits = prototype.set_composite_visible_bits;
    window.__viewerSelectionPickCalls = [];
    window.__viewerSelectionByteCalls = [];
    window.__viewerSelectionBitsCalls = 0;
    prototype.pick_composite_code = function trackPick(id, x, y) {
      const code = Number(originalPick.call(this, id, x, y));
      window.__viewerSelectionPickCalls.push({ x, y, code });
      return code;
    };
    prototype.set_composite_visible_byte = function trackByte(...args) {
      window.__viewerSelectionByteCalls.push([...args]);
      return originalByte.apply(this, args);
    };
    prototype.set_composite_visible_bits = function trackBits(...args) {
      window.__viewerSelectionBitsCalls += 1;
      return originalBits.apply(this, args);
    };
  });

  const move = async (xRatio, yRatio = 0.5) => {
    await page.mouse.move(box.x + box.width * xRatio, box.y + box.height * yRatio);
    await page.waitForTimeout(30);
  };
  const islandSamples = [];
  let sawZero = false;
  let sawOutside = false;
  for (let step = 1; step < 40; step += 1) {
    const ratio = step / 40;
    await move(ratio);
    const names = await page.locator("#composite-selection-info").textContent();
    if (names === "islands.gtl") islandSamples.push(ratio);
    sawZero ||= names === "No source layers";
    sawOutside ||= names === "Outside outline";
  }
  const islandClusters = [];
  for (const ratio of islandSamples) {
    const cluster = islandClusters.at(-1);
    if (!cluster || ratio - cluster.at(-1) > 0.03) {
      islandClusters.push([ratio]);
    } else {
      cluster.push(ratio);
    }
  }
  expect(islandClusters.length).toBe(2);
  const [leftRatio, rightRatio] = islandClusters.map(
    (cluster) => cluster[Math.floor(cluster.length / 2)],
  );
  expect(rightRatio - leftRatio).toBeGreaterThan(0.15);
  await move(leftRatio);
  await expect(page.locator("#composite-selection-info")).toHaveText("islands.gtl");
  const leftBefore = await readCanvasPixel(page, leftRatio, 0.5);
  const rightBefore = await readCanvasPixel(page, rightRatio, 0.5);
  await canvas.click({ position: { x: box.width * leftRatio, y: box.height * 0.5 } });
  await page.waitForTimeout(60);
  const leftAfter = await readCanvasPixel(page, leftRatio, 0.5);
  const rightAfter = await readCanvasPixel(page, rightRatio, 0.5);
  expect(leftAfter.slice(0, 3)).toEqual(leftBefore.slice(0, 3));
  expect(rightAfter.slice(0, 3)).toEqual(rightBefore.slice(0, 3));
  expect(leftAfter[3]).toBeLessThan(leftBefore[3]);
  expect(rightAfter[3]).toBeLessThan(rightBefore[3]);
  expect(await page.evaluate(() => window.__viewerSelectionByteCalls.length)).toBe(1);

  // The horizontal scan must observe both finite zero-code fill and the
  // non-selectable area outside the outline.
  expect(sawZero).toBe(true);
  expect(sawOutside).toBe(true);

  await move(0.4);
  await page.evaluate(() => {
    window.__viewerSelectionPickCalls.length = 0;
    const canvas = document.querySelector("#gerber-canvas");
    const rect = canvas.getBoundingClientRect();
    for (let index = 0; index < 20; index += 1) {
      canvas.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: rect.left + rect.width * 0.41,
        clientY: rect.top + rect.height * 0.5,
      }));
    }
  });
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => window.__viewerSelectionPickCalls.length)).toBe(1);
  await page.evaluate(() => {
    const canvas = document.querySelector("#gerber-canvas");
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      clientX: rect.left + rect.width * 0.41,
      clientY: rect.top + rect.height * 0.5,
    }));
  });
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => window.__viewerSelectionPickCalls.length)).toBe(1);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(60);
  const committedLeft = await readCanvasPixel(page, leftRatio, 0.5);
  expect(committedLeft).not.toEqual(leftBefore);

  const islands = page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
    has: page.getByText("islands.gtl", { exact: true }),
  });
  await islands.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="rename-layer"]').click();
  await dialog.locator("[data-composite-name]").fill("Renamed islands");
  await dialog.locator("[data-composite-submit]").click();
  composite = page.locator(".composite-layer-item").filter({ hasText: "Selection map coverage" });
  await composite.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="edit-composite"]').click();
  await dialog.getByRole("button", { name: /Move Renamed islands down/ }).click();
  await dialog.locator("[data-composite-submit]").click();
  await composite.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="select-visible-area"]').click();
  await move(leftRatio);
  await expect(page.locator("#composite-selection-info")).toHaveText("Renamed islands");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__viewerSelectionBitsCalls)).toBe(0);

  // A one-byte draft change is rolled back with one byte, not a full LUT
  // upload (which reaches 2 MiB at 24 sources); a no-op cancel uploads nothing.
  await composite.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="select-visible-area"]').click();
  await move(leftRatio);
  const byteCallsBeforeRollback = await page.evaluate(() =>
    window.__viewerSelectionByteCalls.length);
  await canvas.click({ position: { x: box.width * leftRatio, y: box.height * 0.5 } });
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__viewerSelectionByteCalls.length)).toBe(
    byteCallsBeforeRollback + 2,
  );
  expect(await page.evaluate(() => window.__viewerSelectionBitsCalls)).toBe(0);
});

test("normal mode selects only visible composite areas and accepts active code zero", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    { name: "islands.gtl", mimeType: "text/plain", buffer: Buffer.from(disconnectedSource) },
    { name: "center.gbl", mimeType: "text/plain", buffer: Buffer.from(centerSource) },
    { name: "normal-pick-outline.gko", mimeType: "text/plain", buffer: Buffer.from(outlineSource) },
  ]);
  await expect(page.locator("#loading-modal")).toBeHidden({ timeout: 30_000 });
  await page.locator(".layer-create-composite button").click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog.locator("[data-composite-name]").fill("Normal area coverage");
  for (const sourceName of ["islands.gtl", "center.gbl"]) {
    await dialog
      .locator(".composite-source-choice", { hasText: sourceName })
      .locator("input")
      .check();
  }
  await dialog.locator('[data-composite-preset="difference"]').click();
  await dialog.locator("[data-composite-submit]").click();
  const composite = page.locator(".composite-layer-item").filter({
    hasText: "Normal area coverage",
  });
  await page.locator(".gerber-layer-item:not(.composite-layer-item) .layer-checkbox")
    .evaluateAll((checkboxes) => {
      for (const checkbox of checkboxes) {
        if (checkbox.checked) checkbox.click();
      }
    });

  await composite.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="select-visible-area"]').click();
  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const samples = [];
  for (let step = 2; step < 39; step += 1) {
    const ratio = step / 40;
    await page.mouse.move(box.x + box.width * ratio, box.y + box.height * 0.5);
    await page.waitForTimeout(25);
    samples.push({
      ratio,
      label: await page.locator("#composite-selection-info").textContent(),
    });
  }
  const islandRatios = samples
    .filter(({ label }) => label === "islands.gtl")
    .map(({ ratio }) => ratio);
  const zeroRatio = samples.find(
    ({ ratio, label }) => label === "No source layers" && ratio > 0.5,
  )?.ratio;
  expect(islandRatios.length).toBeGreaterThan(1);
  expect(zeroRatio).toBeDefined();
  const leftIslandRatio = islandRatios[0];
  await canvas.click({
    position: { x: box.width * zeroRatio, y: box.height * 0.5 },
  });
  await page.keyboard.press("Enter");
  await expect(page.locator(".composite-selection-bar")).toBeHidden();

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const originalPick = prototype.pick_composite_area;
    const originalHighlight = prototype.render_composite_area_highlight;
    window.__normalCompositeAreaPicks = [];
    window.__normalCompositeAreaHighlights = [];
    prototype.pick_composite_area = function trackNormalAreaPick(...args) {
      const code = Number(originalPick.apply(this, args));
      window.__normalCompositeAreaPicks.push(code);
      return code;
    };
    prototype.render_composite_area_highlight = function trackNormalAreaHighlight(...args) {
      window.__normalCompositeAreaHighlights.push(Number(args[1]));
      return originalHighlight.apply(this, args);
    };
  });

  await canvas.click({
    position: { x: box.width * leftIslandRatio, y: box.height * 0.5 },
  });
  await expect(page.locator("#bounds-readout")).toContainText(
    "Normal area coverage | Composite area",
  );
  await expect.poll(() => page.evaluate(() =>
    window.__normalCompositeAreaHighlights.includes(1))).toBe(true);
  expect((await page.evaluate(() => window.__normalCompositeAreaPicks)).at(-1)).toBe(1);

  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
  await expect(page.locator("#bounds-readout")).not.toContainText("Composite area");
  expect((await page.evaluate(() => window.__normalCompositeAreaPicks)).at(-1)).toBe(-1);

  await canvas.click({
    position: { x: box.width * zeroRatio, y: box.height * 0.5 },
  });
  await expect(page.locator("#bounds-readout")).toContainText(
    "Normal area coverage | Composite area",
  );
  await expect.poll(() => page.evaluate(() =>
    window.__normalCompositeAreaHighlights.includes(0))).toBe(true);
  expect((await page.evaluate(() => window.__normalCompositeAreaPicks)).at(-1)).toBe(0);
});

test("selection mouse pan, touch pan, and pinch never toggle before the next tap", async ({ page }) => {
  await loadTwoSources(page);
  const composite = await createComposite(page, "Gesture coverage");
  await composite.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="select-visible-area"]').click();
  const canvas = page.locator("#gerber-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  await page.evaluate(async () => {
    const wasm = await import("/wasm/pkg/wasm_gerber_processor.js");
    const prototype = wasm.GerberProcessor.prototype;
    const original = prototype.set_composite_visible_byte;
    window.__gestureCompositeByteCalls = 0;
    prototype.set_composite_visible_byte = function trackGestureToggle(...args) {
      window.__gestureCompositeByteCalls += 1;
      return original.apply(this, args);
    };
  });

  const initial = await canvas.screenshot();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35 + 70, box.y + box.height * 0.5 + 20, {
    steps: 4,
  });
  await page.mouse.up();
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.__gestureCompositeByteCalls)).toBe(0);
  expect((await canvas.screenshot()).equals(initial)).toBe(false);

  const dispatchTouchGesture = (kind) => page.evaluate((kind) => {
    const canvas = document.querySelector("#gerber-canvas");
    const rect = canvas.getBoundingClientRect();
    const touch = (identifier, x, y) => new Touch({
      identifier,
      target: canvas,
      clientX: rect.left + rect.width * x,
      clientY: rect.top + rect.height * y,
    });
    const send = (type, touches, changedTouches = touches) => {
      canvas.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches,
        targetTouches: touches,
        changedTouches,
      }));
    };
    if (kind === "pan") {
      const start = touch(31, 0.45, 0.5);
      const moved = touch(31, 0.62, 0.56);
      send("touchstart", [start]);
      send("touchmove", [moved]);
      send("touchend", [], [moved]);
    } else if (kind === "pinch") {
      const first = touch(41, 0.4, 0.5);
      const second = touch(42, 0.6, 0.5);
      const movedFirst = touch(41, 0.25, 0.46);
      const movedSecond = touch(42, 0.78, 0.54);
      send("touchstart", [first, second]);
      send("touchmove", [movedFirst, movedSecond]);
      send("touchend", [], [movedFirst, movedSecond]);
    } else {
      const point = touch(51, 0.35, 0.5);
      send("touchstart", [point]);
      send("touchend", [], [point]);
    }
  }, kind);

  const afterMouse = await canvas.screenshot();
  await dispatchTouchGesture("pan");
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.__gestureCompositeByteCalls)).toBe(0);
  expect((await canvas.screenshot()).equals(afterMouse)).toBe(false);

  const afterTouchPan = await canvas.screenshot();
  await dispatchTouchGesture("pinch");
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.__gestureCompositeByteCalls)).toBe(0);
  expect((await canvas.screenshot()).equals(afterTouchPan)).toBe(false);

  await dispatchTouchGesture("tap");
  await expect.poll(() => page.evaluate(() => window.__gestureCompositeByteCalls)).toBe(1);
  await expect(page.locator("#composite-selection-info")).not.toHaveText("No area selected");
  const lastNames = await page.locator("#composite-selection-info").textContent();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(30);
  expect(await page.locator("#composite-selection-info").textContent()).toBe(lastNames);
  await page.keyboard.press("Escape");
});

test("visible composites drive fit bounds and keep touch reorder within their section", async ({ page }) => {
  await loadTwoSources(page);
  const composite = await createComposite(page, "Fit and touch order");
  await page.locator(".gerber-layer-item:not(.composite-layer-item) .layer-checkbox").evaluateAll(
    (checkboxes) => {
      for (const checkbox of checkboxes) {
        if (checkbox.checked) checkbox.click();
      }
    },
  );
  await expect(page.locator(".gerber-layer-item:not(.composite-layer-item) .layer-checkbox:checked"))
    .toHaveCount(0);

  await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/main.js");
    const prototype = GerberViewer.prototype;
    const original = prototype.getViewportFitLayers;
    window.__viewerCompositeFitProbe = null;
    prototype.getViewportFitLayers = function captureCompositeFit(selectedIds) {
      const layers = original.call(this, selectedIds);
      window.__viewerCompositeFitProbe = {
        selected: [...selectedIds],
        layers: layers.map((layer) => ({
          id: layer.id,
          kind: layer.kind ?? "gerber",
          visible: layer.visible,
          bounds: layer.renderBounds ?? layer.bounds ?? null,
        })),
      };
      return layers;
    };
  });
  await page.locator("#fit-view-btn").click();
  const fitProbe = await page.evaluate(() => window.__viewerCompositeFitProbe);
  const compositeId = await composite.getAttribute("data-layer-id");
  expect(fitProbe.selected).toEqual([compositeId]);
  const compositeFitLayer = fitProbe.layers.find((layer) => layer.id === compositeId);
  expect(compositeFitLayer.kind).toBe("composite");
  expect(compositeFitLayer.visible).toBe(true);
  expect(Object.values(compositeFitLayer.bounds).every(Number.isFinite)).toBe(true);
  expect(fitProbe.layers.filter((layer) => layer.kind !== "composite").every(
    (layer) => layer.visible === false,
  )).toBe(true);

  const secondComposite = await createComposite(page, "Second touch order");
  const names = page.locator("#layer-list > .composite-layer-item .layer-label strong");
  await expect(names).toHaveText(["Second touch order", "Fit and touch order"]);
  await page.evaluate(() => {
    const handle = document.querySelector(
      '.composite-layer-item [data-layer-touch-reorder="true"]',
    );
    const rect = handle.getBoundingClientRect();
    const touch = new Touch({
      identifier: 61,
      target: handle,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    handle.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
    }));
  });
  await page.waitForTimeout(550);
  await expect(secondComposite).toHaveClass(/touch-dragging/);
  await page.evaluate(() => {
    const handle = document.querySelector(
      '.composite-layer-item [data-layer-touch-reorder="true"]',
    );
    const target = document.querySelectorAll(".composite-layer-item");
    const targetRect = target[target.length - 1].getBoundingClientRect();
    const moved = new Touch({
      identifier: 61,
      target: handle,
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.bottom - 2,
    });
    handle.dispatchEvent(new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [moved],
      targetTouches: [moved],
      changedTouches: [moved],
    }));
    handle.dispatchEvent(new TouchEvent("touchend", {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: [moved],
    }));
  });
  await expect(names).toHaveText(["Fit and touch order", "Second touch order"]);
});

test("source limits and context lifecycle commands keep stable composite dependencies", async ({ page }) => {
  await page.goto("/");
  const dialogLimits = await page.evaluate(async () => {
    const { CompositeLayerDialog } = await import("/js/ui/composite-layer-dialog.js");
    const sources = Array.from({ length: 25 }, (_unused, index) => ({
      id: `limit-source-${index}`,
      name: `Limit Source ${index + 1}`,
      sourceName: `limit-${index + 1}.gbr`,
    }));
    const dialog = new CompositeLayerDialog({ getGerberLayers: () => sources });
    const promise = dialog.openCreate("Limit coverage");
    const choice = (index) => dialog.form.querySelectorAll(
      ".composite-source-choice input",
    )[index];
    const submitDisabledAtZero = dialog.submit.disabled;
    choice(0).click();
    const submitDisabledAtOne = dialog.submit.disabled;
    choice(1).click();
    const submitEnabledAtTwo = !dialog.submit.disabled;
    for (let index = 2; index < 24; index += 1) choice(index).click();
    const result = {
      submitDisabledAtZero,
      submitDisabledAtOne,
      submitEnabledAtTwo,
      count: dialog.count.textContent,
      selected: dialog.selectedSourceIds.length,
      twentyFifthDisabled: dialog.form.querySelectorAll(
        ".composite-source-choice input",
      )[24].disabled,
    };
    dialog.finish(null);
    await promise;
    dialog.dialog.remove();
    return result;
  });
  expect(dialogLimits).toEqual({
    submitDisabledAtZero: true,
    submitDisabledAtOne: true,
    submitEnabledAtTwo: true,
    count: "24 / 24",
    selected: 24,
    twentyFifthDisabled: true,
  });

  await loadTwoSources(page);
  let composite = await createComposite(page, "Stable lifecycle");
  const left = page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
    has: page.getByText("left.gtl", { exact: true }),
  });
  await left.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="rename-layer"]').click();
  const dialog = page.locator(".composite-layer-dialog");
  await dialog.locator("[data-composite-name]").fill("renamed-top.gtl");
  await dialog.locator("[data-composite-submit]").click();
  await expect(composite).not.toHaveClass(/layer-item-error/);

  await composite.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="show-top"]').click();
  await expect(page.locator(".layer-checkbox:checked")).toHaveCount(1);
  await expect(
    page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
      has: page.getByText("renamed-top.gtl", { exact: true }),
    }).locator(".layer-checkbox"),
  ).toBeChecked();

  composite = page.locator(".composite-layer-item").filter({ hasText: "Stable lifecycle" });
  await composite.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="show-bottom"]').click();
  await expect(page.locator(".layer-checkbox:checked")).toHaveCount(1);
  await expect(
    page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
      has: page.getByText("right.gbl", { exact: true }),
    }).locator(".layer-checkbox"),
  ).toBeChecked();

  const disposable = await createComposite(page, "Standalone delete");
  await disposable.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="delete-layer"]').click();
  await expect(page.locator(".composite-layer-item").filter({ hasText: "Standalone delete" }))
    .toHaveCount(0);

  let confirmationMessage = null;
  page.once("dialog", async (browserDialog) => {
    confirmationMessage = browserDialog.message();
    await browserDialog.accept();
  });
  const renamed = page.locator(".gerber-layer-item:not(.composite-layer-item)").filter({
    has: page.getByText("renamed-top.gtl", { exact: true }),
  });
  await renamed.locator(".layer-menu-btn").click();
  await page.locator('[data-layer-menu-action="delete-layer"]').click();
  await expect(page.locator(".composite-layer-item")).toHaveCount(0);
  expect(confirmationMessage).toMatch(
    /Delete renamed-top\.gtl and 1 dependent composite layer\?/,
  );
});
