import assert from "node:assert/strict";
import test from "node:test";
import {
  createLayerLoadProgress,
  getLayerLoadModalFields,
  markLayerLoadComplete,
} from "../js/loading/layer-load-progress.js";

test("progress sums independent file fractions with equal weight", () => {
  const progress = createLayerLoadProgress(3);
  progress.partialLayers.set(0, 0.2);
  progress.partialLayers.set(1, 0.7);
  markLayerLoadComplete(progress, 2);
  const fields = getLayerLoadModalFields(progress, {});
  assert.equal(fields.current, 1);
  assert.equal(fields.total, 3);
  assert.ok(Math.abs(fields.partial - 0.9) < 1e-10);
  assert.ok(Math.abs((fields.current + fields.partial) / fields.total - 1.9 / 3) < 1e-10);
});

test("interleaved reports preserve the minimum active index name and stage", () => {
  const progress = createLayerLoadProgress(4);
  const update = (index, stage) => getLayerLoadModalFields(progress, {
    index, stage, fileName: `layer-${index}`,
  });
  update(2, "Parsing");
  update(0, "Reading");
  update(1, "Parsing");
  assert.equal(update(2, "Rendering").fileName, "layer-0");
  assert.equal(update(1, "Rendering").stage, "Reading");
  update(0, "Rendering");
  assert.equal(update(2, "Loaded").stage, "Rendering");
  markLayerLoadComplete(progress, 0);
  const next = update(0, "Loaded");
  assert.equal(next.fileName, "layer-1");
  assert.equal(next.stage, "Rendering");
  assert.equal(progress.activeLayers.has(0), false);
});

test("out-of-order completion and skipped files count once without retaining partials", () => {
  const progress = createLayerLoadProgress(2);
  progress.partialLayers.set(1, 0.9);
  markLayerLoadComplete(progress, 1);
  markLayerLoadComplete(progress, 1);
  assert.equal(progress.completedLayers, 1);
  assert.equal(progress.partialLayers.size, 0);
  markLayerLoadComplete(progress, 0);
  assert.deepEqual(getLayerLoadModalFields(progress, { stage: "Skipped" }), {
    stage: "Skipped", current: 2, total: 2, partial: 0, showPercent: true,
  });
});

test("serial loading can begin after previously completed files", () => {
  const progress = createLayerLoadProgress(5);
  progress.completedLayers = 3;
  progress.partialLayers.set(3, 0.5);
  assert.equal(getLayerLoadModalFields(progress, {}).current, 3);
  markLayerLoadComplete(progress, 3);
  assert.equal(getLayerLoadModalFields(progress, {}).current, 4);
});
