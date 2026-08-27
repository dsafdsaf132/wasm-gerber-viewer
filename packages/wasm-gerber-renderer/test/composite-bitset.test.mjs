import assert from "node:assert/strict";
import fs from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { GerberRenderer } from "../index.js";
import { fileLayer, NodeGerberRenderer } from "../node.js";
import { createCompositeVisibleBitset, sourceToText } from "../shared.js";

import {
  addCompositeSource,
  compositeCodeToPattern,
  compositePatternToCode,
  createCompositeLayerPresetBitset,
  createCompositePresetBitset,
  getCompositeAreaVisible,
  getCompositeBitsetByteLength,
  reconcileCompositeSources,
  removeCompositeSource,
  visibleAreaPatternsToBitset,
} from "../../../js/layers/composite-layers.js";

for (const count of [2, 8, 16, 24]) {
  test(`composite presets support ${count} sources`, () => {
    const union = createCompositePresetBitset(count, "union");
    assert.equal(getCompositeAreaVisible(union, 0), false);
    assert.equal(getCompositeAreaVisible(union, 2 ** count - 1), true);
    const intersection = createCompositePresetBitset(count, "intersection");
    assert.equal(getCompositeAreaVisible(intersection, 2 ** count - 1), true);
    assert.equal(intersection.reduce((sum, byte) => sum + popcount(byte), 0), 1);
    const difference = createCompositePresetBitset(count, "difference");
    assert.equal(getCompositeAreaVisible(difference, 1), true);
    assert.equal(difference.reduce((sum, byte) => sum + popcount(byte), 0), 1);
  });
}

test("fixed-seed public bitsets match an independent reference for every source count", () => {
  let randomState = 0x6d2b79f5;
  const nextRandom = () => {
    randomState =
      (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState;
  };

  for (let sourceCount = 2; sourceCount <= 24; sourceCount += 1) {
    const patterns = [];
    const expected = new Uint8Array(getCompositeBitsetByteLength(sourceCount));
    const codeLimit = 2 ** sourceCount;
    for (let sample = 0; sample < 96; sample += 1) {
      const code = nextRandom() % codeLimit;
      const pattern = Array.from(
        { length: sourceCount },
        (_unused, slot) => ((code >>> slot) & 1 ? "1" : "0"),
      ).join("");
      patterns.push(pattern);
      if (sample % 11 === 0) patterns.push(pattern);
      expected[code >>> 3] |= 1 << (code & 7);
    }

    assert.deepEqual(
      createCompositeVisibleBitset(sourceCount, { visibleAreas: patterns }),
      expected,
      `${sourceCount}-source explicit patterns`,
    );
  }
});

test("fixed-seed source reconciliation preserves the reference coverage relation", () => {
  let randomState = 0xa341316c;
  const nextRandom = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
  };
  const sourcePool = Array.from(
    { length: 14 },
    (_unused, index) => `source-${index}`,
  );

  for (let trial = 0; trial < 384; trial += 1) {
    const sourceCount = 2 + (nextRandom() % 9);
    const nextSourceCount = 2 + (nextRandom() % 9);
    const slotSourceIds = sourcePool.slice(0, sourceCount);
    const visibleBitset = new Uint8Array(
      getCompositeBitsetByteLength(sourceCount),
    );
    for (let index = 0; index < visibleBitset.length; index += 1) {
      visibleBitset[index] = nextRandom();
    }
    const nextSourceIds = fixedSeedShuffle(sourcePool, nextRandom).slice(
      0,
      nextSourceCount,
    );
    const reconciled = reconcileCompositeSources(
      {
        kind: "composite",
        sourceIds: [...slotSourceIds],
        slotSourceIds,
        visibleBitset,
      },
      nextSourceIds,
    );

    for (let code = 0; code < 2 ** nextSourceCount; code += 1) {
      assert.equal(
        getCompositeAreaVisible(reconciled.visibleBitset, code),
        referenceReconciledVisibility(
          visibleBitset,
          slotSourceIds,
          reconciled.slotSourceIds,
          nextSourceIds,
          code,
        ),
        `trial ${trial}, code ${code}`,
      );
    }
  }
});

test("explicit patterns use leftmost source as slot zero and deduplicate", () => {
  const bitset = visibleAreaPatternsToBitset(["100", "001", "100"], 3);
  assert.equal(compositePatternToCode("100"), 1);
  assert.equal(compositePatternToCode("001"), 4);
  assert.equal(getCompositeAreaVisible(bitset, 1), true);
  assert.equal(getCompositeAreaVisible(bitset, 4), true);
  assert.equal(compositeCodeToPattern(5, [0, 1, 2]), "101");
  assert.throws(() => visibleAreaPatternsToBitset([], 3), /cannot be empty/);
  assert.throws(() => visibleAreaPatternsToBitset(["10x"], 3), /binary digits/);
});

test("source add inherits both branches and remove OR-merges", () => {
  const original = createCompositePresetBitset(2, "difference");
  const added = addCompositeSource(original, 2);
  assert.equal(getCompositeAreaVisible(added, 1), true);
  assert.equal(getCompositeAreaVisible(added, 5), true);
  const removed = removeCompositeSource(added, 3, 2);
  assert.deepEqual(removed, original);
});

test("packed source removal exactly matches per-code OR compaction", () => {
  // Exhaust every possible 3-source bitset, including the unused upper nibble
  // in the resulting 2-source byte, for every removable slot.
  for (let byte = 0; byte <= 0xff; byte += 1) {
    const bitset = new Uint8Array([byte]);
    for (let removedSlot = 0; removedSlot < 3; removedSlot += 1) {
      assertCompositeRemovalMatchesReference(bitset, 3, removedSlot);
    }
  }

  // Exercise byte-internal and byte-aligned branches with deterministic random
  // payloads across ordinary source counts.
  let randomState = 0x9e3779b9;
  const nextRandomByte = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState & 0xff;
  };
  for (let sourceCount = 4; sourceCount <= 16; sourceCount += 1) {
    const bitset = new Uint8Array(getCompositeBitsetByteLength(sourceCount));
    for (let index = 0; index < bitset.byteLength; index += 1) {
      bitset[index] = nextRandomByte();
    }
    for (let removedSlot = 0; removedSlot < sourceCount; removedSlot += 1) {
      assertCompositeRemovalMatchesReference(bitset, sourceCount, removedSlot);
    }
  }
});

test("packed source removal reads exactly two input bytes per output byte", () => {
  const sourceCount = 20;
  const bitset = createCompositePresetBitset(sourceCount, "union");
  const outputByteLength = getCompositeBitsetByteLength(sourceCount - 1);

  for (const removedSlot of [0, 1, 2, 3, 12, 19]) {
    let indexedReads = 0;
    const observedBitset = new Proxy(bitset, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          indexedReads += 1;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const compacted = removeCompositeSource(
      observedBitset,
      sourceCount,
      removedSlot,
    );
    assert.equal(compacted.byteLength, outputByteLength);
    assert.equal(
      indexedReads,
      outputByteLength * 2,
      `slot ${removedSlot} must not regress to per-code reads`,
    );
  }
});

test("24-source removal handles every slot with one packed operation per output byte", () => {
  const sourceCount = 24;
  const bitset = new Uint8Array(getCompositeBitsetByteLength(sourceCount));
  let randomState = 0x243f6a88;
  for (let index = 0; index < bitset.byteLength; index += 1) {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    bitset[index] = randomState >>> 24;
  }

  const expectedPackedOperations = getCompositeBitsetByteLength(sourceCount - 1);
  assert.equal(expectedPackedOperations, 1024 * 1024);
  assert.equal((2 ** (sourceCount - 1)) / expectedPackedOperations, 8);

  for (let removedSlot = 0; removedSlot < sourceCount; removedSlot += 1) {
    const compacted = removeCompositeSource(bitset, sourceCount, removedSlot);
    assert.equal(compacted.byteLength, expectedPackedOperations);
    const sampleCodes = new Set([
      0,
      1,
      2 ** (sourceCount - 1) - 1,
      2 ** Math.min(removedSlot, sourceCount - 2),
      Math.max(0, 2 ** Math.min(removedSlot, sourceCount - 2) - 1),
    ]);
    let sampleState = (0x85ebca6b ^ removedSlot) >>> 0;
    for (let sample = 0; sample < 4096; sample += 1) {
      sampleState = (Math.imul(sampleState, 1103515245) + 12345) >>> 0;
      sampleCodes.add(sampleState & (2 ** (sourceCount - 1) - 1));
    }
    for (const code of sampleCodes) {
      assert.equal(
        getCompositeAreaVisible(compacted, code),
        getReferenceRemovedVisibility(bitset, removedSlot, code),
        `slot ${removedSlot}, code ${code}`,
      );
    }
  }
});

test("source reorder preserves slots and bitset", () => {
  const layer = {
    kind: "composite",
    sourceIds: ["a", "b", "c"],
    slotSourceIds: ["a", "b", "c"],
    visibleBitset: createCompositePresetBitset(3, "difference"),
  };
  const reconciled = reconcileCompositeSources(layer, ["c", "a", "b"]);
  assert.deepEqual(reconciled.slotSourceIds, ["a", "b", "c"]);
  assert.deepEqual(reconciled.sourceIds, ["c", "a", "b"]);
  assert.deepEqual(reconciled.visibleBitset, layer.visibleBitset);
});

test("owned 24-source drafts avoid an input copy during reorder and removal", () => {
  const sourceIds = Array.from({ length: 24 }, (_unused, index) => `source-${index}`);
  const visibleBitset = createCompositePresetBitset(24, "union");
  const layer = {
    kind: "composite",
    sourceIds,
    slotSourceIds: sourceIds,
    visibleBitset,
  };
  const originalSlice = Uint8Array.prototype.slice;
  let inputSlices = 0;
  Uint8Array.prototype.slice = function trackedSlice(...args) {
    if (this === visibleBitset) inputSlices += 1;
    return originalSlice.apply(this, args);
  };
  try {
    const reordered = reconcileCompositeSources(
      layer,
      [...sourceIds].reverse(),
      { takeBitsetOwnership: true },
    );
    assert.equal(reordered.visibleBitset, visibleBitset);
    assert.equal(inputSlices, 0);

    const removed = reconcileCompositeSources(
      layer,
      sourceIds.slice(1),
      { takeBitsetOwnership: true },
    );
    assert.notEqual(removed.visibleBitset, visibleBitset);
    assert.equal(removed.visibleBitset.byteLength, 1024 * 1024);
    assert.equal(inputSlices, 0);

    const pureReorder = reconcileCompositeSources(layer, [...sourceIds].reverse());
    assert.notEqual(pureReorder.visibleBitset, visibleBitset);
    assert.equal(inputSlices, 1);
  } finally {
    Uint8Array.prototype.slice = originalSlice;
  }
});

test("edit draft applies difference in display order before add/remove/reorder transforms", () => {
  let draft = {
    kind: "composite",
    sourceIds: ["c", "a", "b"],
    slotSourceIds: ["a", "b", "c"],
    visibleBitset: createCompositePresetBitset(3, "union"),
  };
  draft.visibleBitset = createCompositeLayerPresetBitset(draft, "difference");
  assert.equal(getCompositeAreaVisible(draft.visibleBitset, 4), true);
  assert.equal(draft.visibleBitset.reduce((sum, byte) => sum + popcount(byte), 0), 1);

  draft = { kind: "composite", ...reconcileCompositeSources(draft, ["c", "a", "b", "d"]) };
  assert.equal(getCompositeAreaVisible(draft.visibleBitset, 4), true);
  assert.equal(getCompositeAreaVisible(draft.visibleBitset, 12), true);

  draft = { kind: "composite", ...reconcileCompositeSources(draft, ["d", "c", "a"]) };
  assert.deepEqual(draft.slotSourceIds, ["a", "c", "d"]);
  assert.deepEqual(draft.sourceIds, ["d", "c", "a"]);
  assert.equal(getCompositeAreaVisible(draft.visibleBitset, 2), true);
  assert.equal(getCompositeAreaVisible(draft.visibleBitset, 6), true);
});

test("24-source bitset is two MiB", () => {
  assert.equal(getCompositeBitsetByteLength(24), 2 * 1024 * 1024);
});

test("public explicit visibleAreas validation rejects unsafe empty and malformed lists", () => {
  assert.throws(
    () => createCompositeVisibleBitset(3, { visibleAreas: [] }),
    /cannot be empty/,
  );
  assert.throws(
    () => createCompositeVisibleBitset(3, { visibleAreas: ["11"] }),
    /exactly 3 bits/,
  );
  assert.throws(
    () => createCompositeVisibleBitset(3, { visibleAreas: ["10x"] }),
    /only '0' and '1'/,
  );
  assert.throws(
    () => createCompositeVisibleBitset(3, {
      preset: "union",
      visibleAreas: ["100"],
    }),
    /cannot be used together/,
  );
  assert.throws(
    () => createCompositeVisibleBitset(3, { preset: null }),
    /preset must be/,
  );
  assert.throws(
    () => createCompositeVisibleBitset(3, { visibleAreas: null }),
    /visibleAreas must be an array/,
  );
});

test("public composite display options reject values outside their declared types", () => {
  for (const options of [
    { name: 42 },
    { visible: "false" },
    { inverted: "true" },
  ]) {
    assert.throws(
      () => createCompositeVisibleBitset(2, options),
      /must be a (string|boolean)/,
    );
  }
});

test("public composite APIs reject oversized source lists before reading elements", async () => {
  let elementRead = false;
  const oversizedSources = new Proxy(new Array(25), {
    get(target, property, receiver) {
      if (property !== "length") {
        elementRead = true;
        throw new Error(`unexpected source access: ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  for (const Renderer of [GerberRenderer, NodeGerberRenderer]) {
    await assert.rejects(
      Renderer.prototype.renderCompositeLayer.call(
        { assertUsable() {}, frame: { layers: [] } },
        oversizedSources,
      ),
      /between 2 and 24 Gerber sources/,
    );
  }
  assert.equal(elementRead, false);
});

test("public composite APIs snapshot source ID accessors exactly once", async () => {
  const browserReads = [0, 0];
  const browserSourceIds = makeChangingSourceIds(browserReads);
  let browserProcessorIds = null;
  const browserFrame = {
    layers: [makeBrowserRecord(0, "a.gbr"), makeBrowserRecord(1, "b.gbr")],
    options: { colors: [[1, 0, 0]] },
    processor: {
      add_composite_layer_with_bounds(sourceIds) {
        browserProcessorIds = [...sourceIds];
        return 2;
      },
      get_layer_boundary() {
        return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
      },
    },
    nextColor() {
      return [1, 0, 0];
    },
    addLayer(layer) {
      this.layers.push(layer);
    },
  };
  await GerberRenderer.prototype.renderCompositeLayer.call(
    {
      assertUsable() {},
      frame: browserFrame,
      reservePublicLayerId: () => 2,
    },
    browserSourceIds,
  );
  assert.deepEqual(browserReads, [1, 1]);
  assert.deepEqual(browserProcessorIds, [0, 1]);
  assert.deepEqual(browserFrame.layers[2].sourceLayerIds, [0, 1]);

  const nodeReads = [0, 0];
  const node = new NodeGerberRenderer({}, {});
  await node.withFrame({}, async () => {
    node.frame.addLayer(makeNodeRecord(0, "a.gbr"));
    node.frame.addLayer(makeNodeRecord(1, "b.gbr"));
    const compositeId = await node.renderCompositeLayer(
      makeChangingSourceIds(nodeReads),
    );
    assert.deepEqual(nodeReads, [1, 1]);
    assert.deepEqual(
      node.frame.layers.find((layer) => layer.id === compositeId).sourceLayerIds,
      [0, 1],
    );
  });
  node.dispose();
});

test("typed-array sources decode their exact view without copying the backing buffer", async () => {
  const bytes = new TextEncoder().encode("ignore:Gerber payload:ignore");
  const view = bytes.subarray(7, 21);
  const originalSlice = ArrayBuffer.prototype.slice;
  let sliceCalls = 0;
  ArrayBuffer.prototype.slice = function (...args) {
    sliceCalls += 1;
    return originalSlice.apply(this, args);
  };
  try {
    assert.equal(await sourceToText(view), "Gerber payload");
    assert.equal(sliceCalls, 0);
  } finally {
    ArrayBuffer.prototype.slice = originalSlice;
  }
});

test("Node path sources reject files that shrink after the initial stat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-node-shrinking-source-"));
  const sourcePath = join(directory, "shrinking.gbr");
  await writeFile(sourcePath, "G04 deterministic shrinking source*\nM02*\n");

  const originalOpen = fs.promises.open;
  fs.promises.open = async function openWithShrink(path, ...args) {
    const handle = await originalOpen.call(fs.promises, path, ...args);
    if (String(path) !== sourcePath) return handle;
    let initialStatRead = false;
    return new Proxy(handle, {
      get(fileHandle, property) {
        if (property === "stat") {
          return async function statWithShrink(...statArgs) {
            const stats = await fileHandle.stat(...statArgs);
            if (!initialStatRead) {
              initialStatRead = true;
              await truncate(sourcePath, stats.size - 1);
            }
            return stats;
          };
        }
        const value = fileHandle[property];
        return typeof value === "function" ? value.bind(fileHandle) : value;
      },
    });
  };
  syncBuiltinESMExports();

  try {
    await assert.rejects(
      NodeGerberRenderer.prototype.createPreparedLayer.call(
        { wasmModule: {} },
        fileLayer(sourcePath),
      ),
      /Layer source changed while it was being read/,
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Browser and Node reject invalid composite options before mutating renderer state", async () => {
  let browserProcessor = null;
  class CompositeSpyProcessor {
    constructor() {
      browserProcessor = this;
      this.compositeAdds = 0;
    }

    init() {}
    clear() {}
    free() {}
    render_with_clear() {}
    get_composite_error() {
      return "";
    }
    add_composite_layer_with_bounds() {
      this.compositeAdds += 1;
      return 2;
    }
    set_composite_bounds() {}
    get_layer_boundary() {
      return { minX: 0, maxX: 2, minY: 0, maxY: 2 };
    }
  }
  const browser = new GerberRenderer(
    { width: 4, height: 4, getContext: () => ({}) },
    { releaseContext: false },
    { GerberProcessor: CompositeSpyProcessor },
  );
  await browser.withFrame({ width: 4, height: 4 }, async () => {
    browser.frame.addLayer(makeBrowserRecord(0, "a.gbr"));
    browser.frame.addLayer(makeBrowserRecord(1, "b.gbr"));
    for (const options of [
      { preset: null },
      { visibleAreas: null },
      { name: 42 },
      { visible: "false" },
      { inverted: "true" },
    ]) {
      await assert.rejects(browser.renderCompositeLayer([0, 1], options));
    }
    await assert.rejects(
      browser.renderCompositeLayer([0, 1], { color: "not-a-color" }),
      /Unsupported color format/,
    );
    assert.equal(browserProcessor.compositeAdds, 0);
    assert.equal(browser.frame.layers.length, 2);
    assert.equal(browser.frame.nextColorIndex, 0);
    assert.equal(browser.nextPublicLayerId, 0);
    assert.equal(
      await browser.renderCompositeLayer([0, 1], { color: "#00ff00" }),
      2,
    );
    assert.equal(browserProcessor.compositeAdds, 1);
    assert.equal(browser.frame.nextColorIndex, 0);
    assert.equal(browser.nextPublicLayerId, 3);
  });
  browser.dispose();

  const node = new NodeGerberRenderer({}, {});
  await node.withFrame({}, async () => {
    node.frame.addLayer(makeNodeRecord(0, "a.gbr"));
    node.frame.addLayer(makeNodeRecord(1, "b.gbr"));
    for (const options of [
      { preset: null },
      { visibleAreas: null },
      { name: 42 },
      { visible: "false" },
      { inverted: "true" },
    ]) {
      await assert.rejects(node.renderCompositeLayer([0, 1], options));
    }
    await assert.rejects(
      node.renderCompositeLayer([0, 1], { color: "not-a-color" }),
      /Unsupported color format/,
    );
    assert.equal(node.frame.layers.length, 2);
    assert.equal(node.frame.nextColorIndex, 0);
    assert.equal(node.nextPublicLayerId, 0);
    assert.equal(
      await node.renderCompositeLayer([0, 1], { color: "#00ff00" }),
      2,
    );
    assert.equal(node.frame.nextColorIndex, 0);
    assert.equal(node.nextPublicLayerId, 3);
  });
});

test("Browser composites resolve modern CSS colors without adopting CSS alpha", async () => {
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  let processor = null;
  class CssCompositeSpyProcessor {
    constructor() {
      processor = this;
      this.compositeAdds = 0;
    }

    init() {}
    clear() {}
    free() {}
    render_with_clear() {}
    get_composite_error() {
      return "";
    }
    add_composite_layer_with_bounds() {
      this.compositeAdds += 1;
      return this.compositeAdds + 1;
    }
    set_composite_bounds() {}
    get_layer_boundary() {
      return { minX: 0, maxX: 2, minY: 0, maxY: 2 };
    }
  }
  class CssParsingOffscreenCanvas {
    getContext(kind) {
      if (kind !== "2d") return null;
      let fillStyle = "#000000";
      return {
        get fillStyle() {
          return fillStyle;
        },
        set fillStyle(value) {
          const normalized = new Map([
            ["hsl(120 100% 50%)", "rgb(0, 255, 0)"],
            ["rgb(0 0 255 / 25%)", "rgba(0, 0, 255, 0.25)"],
          ]).get(value);
          if (normalized) {
            fillStyle = normalized;
          } else if (/^#[0-9a-f]{6}$/i.test(value)) {
            fillStyle = value.toLowerCase();
          }
        },
      };
    }
  }
  globalThis.OffscreenCanvas = CssParsingOffscreenCanvas;

  const browser = new GerberRenderer(
    { width: 4, height: 4, getContext: () => ({}) },
    { releaseContext: false },
    { GerberProcessor: CssCompositeSpyProcessor },
  );
  try {
    await browser.withFrame({ width: 4, height: 4 }, async () => {
      browser.frame.addLayer(makeBrowserRecord(0, "a.gbr"));
      browser.frame.addLayer(makeBrowserRecord(1, "b.gbr"));

      await browser.renderCompositeLayer([0, 1], {
        color: "hsl(120 100% 50%)",
      });
      assert.deepEqual(browser.frame.layers.at(-1).color, [0, 1, 0]);

      await browser.renderCompositeLayer([0, 1], {
        color: "rgb(0 0 255 / 25%)",
      });
      assert.deepEqual(browser.frame.layers.at(-1).color, [0, 0, 1]);
      assert.equal(
        browser.frame.layers.at(-1).alpha,
        null,
        "CSS alpha must not replace CompositeLayerOptions.alpha",
      );

      const layerCount = browser.frame.layers.length;
      await assert.rejects(
        browser.renderCompositeLayer([0, 1], { color: "not-a-css-color" }),
        /Unsupported color format/,
      );
      assert.equal(browser.frame.layers.length, layerCount);
      assert.equal(processor.compositeAdds, 2);
    });
  } finally {
    browser.dispose();
    if (originalOffscreenCanvas === undefined) {
      delete globalThis.OffscreenCanvas;
    } else {
      globalThis.OffscreenCanvas = originalOffscreenCanvas;
    }
  }

  const node = new NodeGerberRenderer({}, {});
  await node.withFrame({}, async () => {
    node.frame.addLayer(makeNodeRecord(0, "a.gbr"));
    node.frame.addLayer(makeNodeRecord(1, "b.gbr"));
    await assert.rejects(
      node.renderCompositeLayer([0, 1], { color: "hsl(120 100% 50%)" }),
      /Unsupported color format/,
    );
    assert.equal(node.frame.layers.length, 2);
  });
  node.dispose();
});

test("Node streaming export owns the renderer until success or failure", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  await renderer.withFrame({ width: 2, height: 2 }, async () => {});

  let releaseWrite;
  let signalWrite;
  const writeReached = new Promise((resolve) => {
    signalWrite = resolve;
  });
  const writeGate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let firstWrite = true;
  const writable = {
    async write() {
      if (!firstWrite) return;
      firstWrite = false;
      signalWrite();
      await writeGate;
    },
  };

  const exportPromise = renderer.exportPngStream(writable);
  await writeReached;
  await assert.rejects(
    renderer.withFrame({ width: 3, height: 3 }, async () => {}),
    /while an export is active/,
  );
  await assert.rejects(renderer.exportPng(), /Node export is already active/);
  await assert.rejects(
    renderer.exportPngStream(writable),
    /Node export is already active/,
  );
  await assert.rejects(
    renderer.exportPngFile("ignored-while-active.png"),
    /Node export is already active/,
  );
  assert.throws(() => renderer.dispose(), /while an export is active/);

  releaseWrite();
  await exportPromise;
  assert.equal(renderer.activeExport, false);
  await renderer.withFrame({ width: 1, height: 1 }, async () => {});
  assert.ok((await renderer.exportPng()).length > 8);
  assert.equal(renderer.activeExport, false);
  renderer.dispose();

  const failedRenderer = new NodeGerberRenderer({}, {});
  await failedRenderer.withFrame({ width: 1, height: 1 }, async () => {});
  await assert.rejects(
    failedRenderer.exportPngStream({
      async write() {
        throw new Error("forced Node stream write failure");
      },
    }),
    /forced Node stream write failure/,
  );
  assert.equal(failedRenderer.activeExport, false);
  assert.doesNotThrow(() => failedRenderer.dispose());

  const falseBackpressureRenderer = new NodeGerberRenderer({}, {});
  await falseBackpressureRenderer.withFrame(
    { width: 1, height: 1 },
    async () => {},
  );
  await assert.rejects(
    falseBackpressureRenderer.exportPngStream({ write: () => false }),
    /must return a Promise for backpressure/,
  );
  assert.equal(falseBackpressureRenderer.activeExport, false);
  falseBackpressureRenderer.dispose();

  const structuralRenderer = new NodeGerberRenderer({}, {});
  await structuralRenderer.withFrame({ width: 1, height: 1 }, async () => {});
  let structuralWrites = 0;
  await structuralRenderer.exportPngStream({
    once() {},
    async write() {
      structuralWrites += 1;
    },
  });
  assert.ok(structuralWrites > 0);
  assert.equal(structuralRenderer.activeExport, false);
  structuralRenderer.dispose();
});

test("Node PNG streaming gives zlib one zero-copy converted band at a time", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  await renderer.withFrame({ width: 3, height: 100 }, async () => {});

  const encodedRowBytes = 1 + 3 * 4;
  const taggedBands = new WeakSet();
  const originalSubarray = Uint8Array.prototype.subarray;
  const originalBufferFrom = Buffer.from;
  const originalDuplexWrite = Duplex.prototype.write;
  let copiedBandCount = 0;
  let zlibInputWriteCount = 0;
  let outstandingZlibInputs = 0;
  let maxOutstandingZlibInputs = 0;
  Uint8Array.prototype.subarray = function tagConvertedBand(...args) {
    const result = originalSubarray.apply(this, args);
    if (result.byteLength === encodedRowBytes && result[0] === 0) {
      taggedBands.add(result);
    }
    return result;
  };
  Buffer.from = function trackCopiedBand(value, ...args) {
    if (value && typeof value === "object" && taggedBands.has(value)) {
      copiedBandCount += 1;
    }
    return originalBufferFrom.call(Buffer, value, ...args);
  };
  Duplex.prototype.write = function trackZlibInput(
    chunk,
    encoding,
    callback,
  ) {
    if (
      this.constructor?.name === "Deflate" &&
      Buffer.isBuffer(chunk) &&
      chunk.byteLength === encodedRowBytes
    ) {
      const consumed = typeof encoding === "function" ? encoding : callback;
      assert.equal(typeof consumed, "function");
      zlibInputWriteCount += 1;
      outstandingZlibInputs += 1;
      maxOutstandingZlibInputs = Math.max(
        maxOutstandingZlibInputs,
        outstandingZlibInputs,
      );
      const wrapped = (...args) => {
        outstandingZlibInputs -= 1;
        return consumed(...args);
      };
      return typeof encoding === "function"
        ? originalDuplexWrite.call(this, chunk, wrapped)
        : originalDuplexWrite.call(this, chunk, encoding, wrapped);
    }
    return originalDuplexWrite.call(this, chunk, encoding, callback);
  };

  try {
    await renderer.exportPngStream(
      { async write() {} },
      { background: null, maxBandBytes: encodedRowBytes },
    );
    assert.equal(copiedBandCount, 0);
    assert.equal(zlibInputWriteCount, 100);
    assert.equal(maxOutstandingZlibInputs, 1);
    assert.equal(outstandingZlibInputs, 0);
  } finally {
    Uint8Array.prototype.subarray = originalSubarray;
    Buffer.from = originalBufferFrom;
    Duplex.prototype.write = originalDuplexWrite;
    renderer.dispose();
  }
});

test("Node dispose cannot invalidate an active frame", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  let releaseFrame;
  let signalFrame;
  const frameGate = new Promise((resolve) => {
    releaseFrame = resolve;
  });
  const frameStarted = new Promise((resolve) => {
    signalFrame = resolve;
  });
  const frame = renderer.withFrame({ width: 1, height: 1 }, async () => {
    assert.throws(() => renderer.dispose(), /render frame is active/);
    signalFrame();
    await frameGate;
  });
  await frameStarted;
  assert.throws(() => renderer.dispose(), /render frame is active/);
  releaseFrame();
  await frame;
  assert.doesNotThrow(() => renderer.dispose());
});

test("Node callback failures invalidate the prior frame and leave the instance reusable", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  await renderer.withFrame({ width: 2, height: 2 }, async () => {});
  assert.ok((await renderer.exportPng()).length > 8);

  for (const callback of [
    () => {
      throw new Error("forced synchronous frame callback failure");
    },
    async () => {
      throw new Error("forced asynchronous frame callback failure");
    },
  ]) {
    await assert.rejects(renderer.withFrame({}, callback), /frame callback failure/);
    assert.equal(renderer.frame, null);
    assert.equal(renderer.activeExport, false);
    await assert.rejects(renderer.exportPng(), /No rendered frame is available/);
  }

  await renderer.withFrame({ width: 1, height: 1 }, async () => {});
  assert.ok((await renderer.exportPng()).length > 8);
  renderer.dispose();
  await assert.rejects(renderer.withFrame({}, async () => {}), /disposed/);
  await assert.rejects(renderer.exportPng(), /disposed/);
});

test("Node PNG export rejects invalid dimensions before sink writes", async () => {
  for (const [width, height, message] of [
    [0x01000001, 1, /PNG dimensions must be safe integers/],
    [100_000_000, 100_000_000, /PNG dimensions must be safe integers/],
  ]) {
    const renderer = new NodeGerberRenderer({}, {});
    await renderer.withFrame({ width, height }, async () => {});
    let writes = 0;
    await assert.rejects(
      renderer.exportPngStream({
        async write() {
          writes += 1;
        },
      }),
      message,
    );
    assert.equal(writes, 0);
    assert.equal(renderer.activeExport, false);
    renderer.dispose();
  }
});

test("Node buffer, stream, and file exports emit deterministic valid PNG chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-node-png-portable-"));
  const renderer = new NodeGerberRenderer({}, {});
  try {
    await renderer.withFrame({ width: 3, height: 2 }, async () => {});
    for (const [label, background, expectedPixel] of [
      ["transparent", null, [0, 0, 0, 0]],
      [
        "alpha",
        [17 / 255, 34 / 255, 51 / 255, 128 / 255],
        [17, 34, 51, 128],
      ],
      ["opaque", [17 / 255, 34 / 255, 51 / 255, 1], [17, 34, 51]],
    ]) {
      const buffered = await renderer.exportPng({ background });
      const streamedChunks = [];
      await renderer.exportPngStream(
        {
          async write(chunk) {
            streamedChunks.push(Buffer.from(chunk));
          },
        },
        { background },
      );
      const streamed = Buffer.concat(streamedChunks);
      const outputPath = join(directory, `${label}-결과.png`);
      await renderer.exportPngFile(outputPath, { background });
      const file = await readFile(outputPath);

      assert.deepEqual(streamed, buffered, `${label} stream bytes`);
      assert.deepEqual(file, buffered, `${label} file bytes`);
      assertPortableBlankPng(buffered, 3, 2, expectedPixel);
    }
  } finally {
    renderer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node file export preserves destinations, cleans temp files, and unlocks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-node-file-export-"));
  const renderer = new NodeGerberRenderer({}, {});
  try {
    const successPath = join(directory, "success.png");
    await renderer.withFrame({ width: 2, height: 2 }, async () => {});
    await renderer.exportPngFile(successPath);
    assert.deepEqual(
      [...(await readFile(successPath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(renderer.activeExport, false);

    const preservedPath = join(directory, "preserved.png");
    const originalBytes = Buffer.from("original destination bytes");
    await writeFile(preservedPath, originalBytes);
    await renderer.withFrame({ width: 2, height: 2 }, async () => {
      renderer.frame.addLayer(makeNodeRecord(0, "forced-render.gbr"));
    });
    renderer.createExportContext = () => {
      throw new Error("forced Node file render failure");
    };
    await assert.rejects(
      renderer.exportPngFile(preservedPath),
      /forced Node file render failure/,
    );
    assert.deepEqual(await readFile(preservedPath), originalBytes);
    assert.equal(renderer.activeExport, false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith(".preserved.png.") && name.endsWith(".tmp")),
      false,
    );

    await renderer.withFrame({ width: 1, height: 1 }, async () => {});
    const recoveredPath = join(directory, "recovered.png");
    await renderer.exportPngFile(recoveredPath);
    assert.ok((await readFile(recoveredPath)).length > 8);

    const blockedPath = join(directory, "blocked-output");
    await mkdir(blockedPath);
    await writeFile(join(blockedPath, "sentinel.txt"), "keep");
    await assert.rejects(renderer.exportPngFile(blockedPath));
    assert.equal(await readFile(join(blockedPath, "sentinel.txt"), "utf8"), "keep");
    assert.equal(renderer.activeExport, false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith(".blocked-output.") && name.endsWith(".tmp")),
      false,
    );

    const cleanupFailurePath = join(directory, "cleanup-failure.png");
    const cleanupFailureBytes = Buffer.from("preserve after cleanup failure");
    await writeFile(cleanupFailurePath, cleanupFailureBytes);
    await renderer.withFrame({ width: 1, height: 1 }, async () => {});
    renderer.__removeTempOutputFile = async () => {
      throw new Error("forced temporary cleanup failure");
    };
    await assert.rejects(
      renderer.exportPngFile(cleanupFailurePath, { maxBandBytes: 1 }),
      (error) => {
        assert.match(error.message, /stream band limit at 1px wide/);
        assert.doesNotMatch(error.message, /forced temporary cleanup failure/);
        return true;
      },
    );
    assert.deepEqual(await readFile(cleanupFailurePath), cleanupFailureBytes);
    assert.equal(renderer.activeExport, false);
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith(".cleanup-failure.png.") && name.endsWith(".tmp")),
      true,
    );
  } finally {
    renderer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node file export preserves unowned temp collisions and observes open failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-node-file-open-"));
  const renderer = new NodeGerberRenderer({}, {});
  const unhandledRejections = [];
  const onUnhandledRejection = (error) => {
    unhandledRejections.push(error);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await renderer.withFrame({ width: 1, height: 1 }, async () => {});
    await assert.rejects(
      renderer.exportPngFile(join(directory, "missing", "output.png")),
      /ENOENT/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
    assert.equal(renderer.activeExport, false);
    await renderer.exportPngFile(join(directory, "after-missing.png"));

    const destination = join(directory, "collision.png");
    const fixedNow = 123456789;
    const fixedRandom = 0.5;
    const randomText = fixedRandom.toString(36).slice(2);
    const collisionPath = join(
      directory,
      `.collision.png.${process.pid}.${fixedNow}.${randomText}.tmp`,
    );
    const sentinel = Buffer.from("pre-existing temp sentinel");
    await writeFile(collisionPath, sentinel);
    const originalNow = Date.now;
    const originalRandom = Math.random;
    Date.now = () => fixedNow;
    Math.random = () => fixedRandom;
    try {
      await assert.rejects(renderer.exportPngFile(destination), /EEXIST/);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
    assert.deepEqual(await readFile(collisionPath), sentinel);
    assert.equal(renderer.activeExport, false);
    await renderer.exportPngFile(join(directory, "after-collision.png"));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    renderer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node file export fixes a validated relative destination at call time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gerber-node-relative-export-"));
  const firstDirectory = join(directory, "first");
  const secondDirectory = join(directory, "second");
  const originalDirectory = process.cwd();
  const renderer = new NodeGerberRenderer({}, {});
  try {
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);
    await renderer.withFrame({ width: 1, height: 1 }, async () => {});

    process.chdir(firstDirectory);
    const filesBeforeInvalidExport = await readdir(firstDirectory);
    await assert.rejects(
      renderer.exportPngFile(""),
      /outputPath must be a non-empty string/,
    );
    assert.deepEqual(await readdir(firstDirectory), filesBeforeInvalidExport);
    assert.equal(renderer.activeExport, false);

    const exportPromise = renderer.exportPngFile("relative.png");
    process.chdir(secondDirectory);
    await exportPromise;

    assert.deepEqual(
      [...(await readFile(join(firstDirectory, "relative.png"))).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    await assert.rejects(readFile(join(secondDirectory, "relative.png")), {
      code: "ENOENT",
    });
    assert.equal(renderer.activeExport, false);
  } finally {
    process.chdir(originalDirectory);
    renderer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node renderCompositeLayer records ordered sources, hidden dependencies, and bounds", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  await renderer.withFrame({}, async () => {
    renderer.frame.addLayer(makeNodeRecord(0, "hidden.gbr", {
      visible: false,
      bounds: { minX: -5, maxX: -4, minY: -3, maxY: -2 },
    }));
    renderer.frame.addLayer(makeNodeRecord(1, "visible.gbr", {
      bounds: { minX: 2, maxX: 4, minY: 6, maxY: 8 },
    }));
    const compositeId = await renderer.renderCompositeLayer([0, 1], {
      visibleAreas: ["10", "01", "10"],
      color: "#00a81c",
    });
    assert.equal(compositeId, 2);
  });

  const composite = renderer.lastRenderPlan.layers[2];
  assert.equal(composite.kind, "composite");
  assert.deepEqual(composite.sourceLayerIds, [0, 1]);
  assert.equal(composite.visibleBits[0], 0b00000110);
  assert.deepEqual(composite.bounds, {
    minX: -5,
    maxX: 4,
    minY: -3,
    maxY: 8,
  });
  assert.deepEqual(renderer.lastFrame.bounds, composite.bounds);
});

test("Node renderCompositeLayer rejects duplicate, stale, drill, and composite sources", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  await renderer.withFrame({}, async () => {
    renderer.frame.addLayer(makeNodeRecord(0, "a.gbr"));
    renderer.frame.addLayer(makeNodeRecord(1, "b.gbr"));
    renderer.frame.addLayer(makeNodeRecord(2, "holes.drl", { kind: "drill" }));
    await assert.rejects(renderer.renderCompositeLayer([0, 0]), /must be unique/);
    await assert.rejects(renderer.renderCompositeLayer([0, 99]), /Invalid or stale/);
    await assert.rejects(renderer.renderCompositeLayer([0, 2]), /ordinary Gerber/);
    const compositeId = await renderer.renderCompositeLayer([0, 1]);
    await assert.rejects(
      renderer.renderCompositeLayer([0, compositeId]),
      /ordinary Gerber/,
    );
  });
});

test("Node composite bounds include a hidden inverted source's resolved outline", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  await renderer.withFrame({}, async () => {
    renderer.frame.addLayer(makeNodeRecord(0, "hidden-mask.gbr", {
      visible: false,
      inverted: true,
      bounds: { minX: 4, maxX: 5, minY: 4, maxY: 5 },
    }));
    renderer.frame.addLayer(makeNodeRecord(1, "visible.gbr", {
      bounds: { minX: 2, maxX: 3, minY: 2, maxY: 3 },
    }));
    renderer.frame.addLayer(makeNodeRecord(2, "board-outline.gko", {
      visible: false,
      bounds: { minX: -10, maxX: 10, minY: -8, maxY: 8 },
    }));
    await renderer.renderCompositeLayer([0, 1]);
  });

  assert.deepEqual(renderer.lastRenderPlan.layers[3].bounds, {
    minX: -10,
    maxX: 10,
    minY: -8,
    maxY: 8,
  });
  assert.deepEqual(renderer.lastRenderPlan.layers[3].fallbackBounds, {
    minX: -10,
    maxX: 10,
    minY: -8,
    maxY: 8,
  });
});

test("multiple Node composites resolve inverted hidden sources against one dependency set", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  await renderer.withFrame({}, async () => {
    renderer.frame.addLayer(makeNodeRecord(0, "first-mask.gbr", {
      visible: false,
      inverted: true,
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
    }));
    renderer.frame.addLayer(makeNodeRecord(1, "visible.gbr", {
      bounds: { minX: 5, maxX: 6, minY: 5, maxY: 6 },
    }));
    renderer.frame.addLayer(makeNodeRecord(2, "second-hidden.gbr", {
      visible: false,
      bounds: { minX: 20, maxX: 21, minY: 20, maxY: 21 },
    }));
    await renderer.renderCompositeLayer([0, 1]);
    await renderer.renderCompositeLayer([2, 1]);
  });

  assert.deepEqual(renderer.lastRenderPlan.layers[3].fallbackBounds, {
    minX: 0,
    maxX: 21,
    minY: 0,
    maxY: 21,
  });
  assert.deepEqual(renderer.lastRenderPlan.layers[4].fallbackBounds, {
    minX: 5,
    maxX: 21,
    minY: 5,
    maxY: 21,
  });
});

test("Node frame ignores unavailable inversion data on hidden non-dependencies", async () => {
  const renderer = new NodeGerberRenderer({}, {});
  await renderer.withFrame({}, async () => {
    renderer.frame.addLayer(makeNodeRecord(0, "first.gbr"));
    renderer.frame.addLayer(makeNodeRecord(1, "second.gbr"));
    renderer.frame.addLayer(
      makeNodeRecord(2, "hidden-unrelated.gbr", {
        content: null,
        visible: false,
        inverted: true,
      }),
    );
    await renderer.renderCompositeLayer([0, 1]);
  });

  assert.equal(renderer.lastRenderPlan.layers.length, 4);
  assert.equal(renderer.lastRenderPlan.layers[2].visible, false);
  assert.equal(renderer.lastRenderPlan.layers[2].inverted, true);
});

function makeNodeRecord(layerId, name, overrides = {}) {
  return {
    kind: "gerber",
    layerId,
    selectorKey: null,
    name,
    sourceName: name,
    content: "synthetic",
    parsedLayer: null,
    parsedDrillLayer: null,
    offsetX: 0,
    offsetY: 0,
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
    color: [1, 0, 0],
    alpha: null,
    visible: true,
    inverted: false,
    outlineStyle: null,
    ...overrides,
  };
}

function makeBrowserRecord(layerId, name) {
  return {
    id: layerId,
    kind: "gerber",
    layerId,
    name,
    content: "synthetic",
    offsetX: 0,
    offsetY: 0,
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
    color: [1, 0, 0],
    alpha: null,
    visible: true,
  };
}

function makeChangingSourceIds(reads) {
  const sourceIds = [];
  Object.defineProperty(sourceIds, 0, {
    enumerable: true,
    get() {
      reads[0] += 1;
      return 0;
    },
  });
  Object.defineProperty(sourceIds, 1, {
    enumerable: true,
    get() {
      reads[1] += 1;
      return reads[1] === 1 ? 1 : 0;
    },
  });
  Object.defineProperty(sourceIds, Symbol.iterator, {
    value() {
      throw new Error("sourceLayerIds iterator must not be used");
    },
  });
  sourceIds.length = 2;
  return sourceIds;
}

function popcount(value) {
  let count = 0;
  for (let byte = value; byte; byte >>>= 1) count += byte & 1;
  return count;
}

function fixedSeedShuffle(values, nextRandom) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = nextRandom() % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

function referenceReconciledVisibility(
  oldBitset,
  oldSlotIds,
  newSlotIds,
  newSourceIds,
  newCode,
) {
  const newValueBySource = new Map(
    newSourceIds.map((sourceId) => [
      sourceId,
      (newCode >>> newSlotIds.indexOf(sourceId)) & 1,
    ]),
  );
  const removedSources = oldSlotIds.filter(
    (sourceId) => !newValueBySource.has(sourceId),
  );
  for (
    let removedValues = 0;
    removedValues < 2 ** removedSources.length;
    removedValues += 1
  ) {
    let oldCode = 0;
    for (let oldSlot = 0; oldSlot < oldSlotIds.length; oldSlot += 1) {
      const sourceId = oldSlotIds[oldSlot];
      const removedIndex = removedSources.indexOf(sourceId);
      const value = removedIndex < 0
        ? newValueBySource.get(sourceId)
        : (removedValues >>> removedIndex) & 1;
      oldCode |= value << oldSlot;
    }
    if (getCompositeAreaVisible(oldBitset, oldCode)) return true;
  }
  return false;
}

function assertPortableBlankPng(buffer, width, height, expectedPixel) {
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkTypes = [];
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, "PNG chunk header is complete");
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length, "PNG chunk payload is complete");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      view.getUint32(offset + 8 + length),
      referenceCrc32(typeBytes, payload),
      `${type} CRC`,
    );
    chunkTypes.push(type);
    if (type === "IDAT") idat.push(payload);
    offset = end;
  }
  assert.equal(offset, bytes.length);
  assert.equal(chunkTypes[0], "IHDR");
  assert.equal(chunkTypes.at(-1), "IEND");
  assert.ok(chunkTypes.slice(1, -1).every((type) => type === "IDAT"));
  assert.equal(view.getUint32(16), width);
  assert.equal(view.getUint32(20), height);
  const channels = bytes[25] === 2 ? 3 : bytes[25] === 6 ? 4 : 0;
  assert.equal(channels, expectedPixel.length);

  const raw = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))));
  const rowStride = 1 + width * channels;
  assert.equal(raw.length, rowStride * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * rowStride], 0, `row ${y} filter`);
    for (let x = 0; x < width; x += 1) {
      const start = y * rowStride + 1 + x * channels;
      assert.deepEqual(
        [...raw.subarray(start, start + channels)],
        expectedPixel,
        `pixel ${x},${y}`,
      );
    }
  }
}

function referenceCrc32(first, second) {
  let crc = 0xffffffff;
  for (const bytes of [first, second]) {
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getReferenceRemovedVisibility(bitset, removedSlot, code) {
  const lowMask = 2 ** removedSlot - 1;
  const withoutRemoved = (code & lowMask) + ((code & ~lowMask) * 2);
  const withRemoved = withoutRemoved + 2 ** removedSlot;
  return getCompositeAreaVisible(bitset, withoutRemoved) ||
    getCompositeAreaVisible(bitset, withRemoved);
}

function assertCompositeRemovalMatchesReference(bitset, sourceCount, removedSlot) {
  const compacted = removeCompositeSource(bitset, sourceCount, removedSlot);
  for (let code = 0; code < 2 ** (sourceCount - 1); code += 1) {
    assert.equal(
      getCompositeAreaVisible(compacted, code),
      getReferenceRemovedVisibility(bitset, removedSlot, code),
      `source count ${sourceCount}, slot ${removedSlot}, code ${code}`,
    );
  }
}
