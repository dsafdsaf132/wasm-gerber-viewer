import { expect, test } from "@playwright/test";

test("parallel reports sum progress without switching the earliest active file", async ({ page }) => {
  await page.goto("/");
  const snapshots = await page.evaluate(async () => {
    const { GerberViewer } = await import("/js/core/viewer.js");
    const viewer = Object.create(GerberViewer.prototype);
    for (const [field, id] of Object.entries({
      loadingTitle: "loading-title",
      loadingStage: "loading-stage",
      loadingFileName: "loading-file-name",
      loadingProgressCount: "loading-progress-count",
      loadingProgressBar: "loading-progress-bar",
      loadingProgressValue: "loading-progress-value",
    })) viewer[field] = document.getElementById(id);
    const progress = viewer.createLayerLoadProgress(3);
    const handlers = [0, 1, 2].map(index => viewer.createLayerParseProgressHandler(
      progress, { index, name: `file-${index}`, share: 1 },
    ));
    const snapshot = () => ({
      name: viewer.loadingFileName.textContent,
      stage: viewer.loadingStage.textContent,
      percent: viewer.loadingProgressValue.textContent,
      count: viewer.loadingProgressCount.textContent,
    });
    for (const index of [0, 1, 2]) viewer.updateLayerLoadModal(progress, {
      index, fileName: `file-${index}`, stage: "Reading",
    });
    handlers[2]({ stage: "commands", done: 1, total: 1 });
    handlers[1]({ stage: "commands", done: 1, total: 2 });
    const reading = snapshot();
    viewer.updateLayerLoadModal(progress, { index: 0, fileName: "file-0", stage: "Rendering" });
    handlers[2]({ stage: "geometry", done: 1, total: 1 });
    const rendering = snapshot();
    viewer.markLayerLoadComplete(progress, 0);
    viewer.updateLayerLoadModal(progress, { index: 0, fileName: "file-0", stage: "Loaded" });
    const next = snapshot();
    handlers[0]({ stage: "commands", done: 0, total: 1 });
    const stale = snapshot();
    return { reading, rendering, next, stale };
  });
  expect(snapshots.reading).toMatchObject({ name: "file-0", stage: "Reading", percent: "30%", count: "0 / 3" });
  expect(snapshots.rendering).toMatchObject({ name: "file-0", stage: "Rendering", percent: "35%" });
  expect(snapshots.next).toMatchObject({ name: "file-1", stage: "Parsing", percent: "68%", count: "1 / 3" });
  expect(snapshots.stale).toEqual(snapshots.next);
});
