import assert from "node:assert/strict";
import test from "node:test";

import {
  getLayerSourceKind,
} from "../../../js/loading/file-utils.js";
import {
  fetchRemoteFile,
  getInitialSourceRepeat,
  collectLayerSources,
  repeatLayerSources,
} from "../../../js/loading/source-loader.js";
import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_ENTRY_COUNT,
  MAX_ARCHIVE_TOTAL_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  MAX_LAYER_COUNT,
  MAX_SOURCE_REPEAT,
} from "../../../js/core/config.js";
import { GerberRenderer } from "../index.js";
import { fileLayer, NodeGerberRenderer } from "../node.js";
import {
  createBaseFrameOptions,
  isBoardOutlineLayerName,
  normalizeCompositeMode,
  normalizeLayerKind,
} from "../shared.js";

const DRILL_CONTENT = `M48
METRIC,LZ
T01C0.6
%
T01
X00090000Y00100000
M30`;

const GERBER_CONTENT = `%FSLAX26Y26*%
%MOMM*%
%ADD10C,1*%
D10*
X0Y0D03*
M02*`;

test("viewer layer kind keeps ambiguous .drd Gerbers as Gerber", () => {
  assert.equal(getLayerSourceKind("board.drd", GERBER_CONTENT), "gerber");
  assert.equal(getLayerSourceKind("holes.drd", DRILL_CONTENT), "drill");
  assert.equal(getLayerSourceKind("holes.drl", GERBER_CONTENT), "drill");
});

test("viewer source loader inspects regular .drd file previews", async () => {
  const sources = await collectLayerSources([
    makeFile(DRILL_CONTENT, "holes.drd", "text/plain"),
    makeFile(GERBER_CONTENT, "board.drd", "text/plain"),
  ]);

  assert.equal(sources.length, 2);
  assert.equal(sources[0].kind, "drill");
  assert.equal(sources[1].kind, "gerber");
  assert.equal(await sources[0].readText(), DRILL_CONTENT);
  assert.equal(await sources[1].readText(), GERBER_CONTENT);
});

test("viewer ZIP .drd preview failure does not poison readText", async () => {
  let readCount = 0;
  const entry = {
    dir: false,
    name: "board.drd",
    _data: { uncompressedSize: GERBER_CONTENT.length },
    async async(_type, onProgress) {
      readCount += 1;
      onProgress?.({ percent: 100 });
      if (readCount === 1) {
        throw new Error("preview failed");
      }
      return GERBER_CONTENT;
    },
  };
  const warnings = [];
  const sources = await collectLayerSources(
    [makeFile("zip", "layers.zip", "application/zip")],
    {
      jsZip: {
        async loadAsync() {
          return { files: { "board.drd": entry } };
        },
      },
      onArchiveWarning(_name, message) {
        warnings.push(message);
      },
    },
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, "gerber");
  assert.match(warnings[0], /Could not inspect board\.drd/);
  assert.equal(await sources[0].readText(), GERBER_CONTENT);
  assert.equal(readCount, 2);
});

test("viewer ZIP loads unknown text entries that look like Gerber", async () => {
  const sources = await collectLayerSources(
    [makeFile("zip", "layers.zip", "application/zip")],
    {
      jsZip: {
        async loadAsync() {
          return {
            files: {
              "layers/board.ly3": makeZipEntry(GERBER_CONTENT, "layers/board.ly3"),
              "layers/readme.txt": makeZipEntry("not a Gerber layer", "layers/readme.txt"),
              "layers/image.bin": makeZipEntry(
                new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]),
                "layers/image.bin",
              ),
            },
          };
        },
      },
    },
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, "board.ly3");
  assert.equal(sources[0].kind, "gerber");
  assert.equal(await sources[0].readText(), GERBER_CONTENT);
});

test("viewer ZIP loads unknown text entries that look like drills", async () => {
  const sources = await collectLayerSources(
    [makeFile("zip", "layers.zip", "application/zip")],
    {
      jsZip: {
        async loadAsync() {
          return {
            files: {
              "layers/holes.tap": makeZipEntry(DRILL_CONTENT, "layers/holes.tap"),
            },
          };
        },
      },
    },
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, "holes.tap");
  assert.equal(sources[0].kind, "drill");
  assert.equal(await sources[0].readText(), DRILL_CONTENT);
});

test("viewer ZIP preserves known extension behavior without sniffing", async () => {
  const plainText = "not a Gerber layer";
  const sources = await collectLayerSources(
    [makeFile("zip", "layers.zip", "application/zip")],
    {
      jsZip: {
        async loadAsync() {
          return {
            files: {
              "layers/plain.gbr": makeZipEntry(plainText, "layers/plain.gbr"),
              "layers/plain.drl": makeZipEntry(plainText, "layers/plain.drl"),
              "layers/plain.ly3": makeZipEntry(plainText, "layers/plain.ly3"),
              "layers/plain.outline": makeZipEntry(plainText, "layers/plain.outline"),
            },
          };
        },
      },
    },
  );

  assert.equal(sources.length, 3);
  assert.deepEqual(
    sources.map((source) => [source.name, source.kind]),
    [
      ["plain.drl", "drill"],
      ["plain.gbr", "gerber"],
      ["plain.outline", "gerber"],
    ],
  );
  assert.equal(await sources[0].readText(), plainText);
  assert.equal(await sources[1].readText(), plainText);
  assert.equal(await sources[2].readText(), plainText);
});

test("viewer ZIP sniffs only the first 30 lines for unknown entries", async () => {
  const lateGerberContent = `${Array.from({ length: 30 }, (_, index) => (
    `comment line ${index + 1}`
  )).join("\n")}
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1*%
D10*
X0Y0D03*
M02*`;
  const sources = await collectLayerSources(
    [makeFile("zip", "layers.zip", "application/zip")],
    {
      jsZip: {
        async loadAsync() {
          return {
            files: {
              "layers/late.ly3": makeZipEntry(lateGerberContent, "layers/late.ly3"),
            },
          };
        },
      },
    },
  );

  assert.equal(sources.length, 0);
});

test("viewer source repeat enforces repeat and resulting layer limits", () => {
  assert.equal(getInitialSourceRepeat(`?repeat=${MAX_SOURCE_REPEAT}`), MAX_SOURCE_REPEAT);
  assert.throws(
    () => getInitialSourceRepeat(`?repeat=${MAX_SOURCE_REPEAT + 1}`),
    /cannot exceed/,
  );
  assert.throws(
    () => repeatLayerSources([{ name: "layer.gbr" }], MAX_SOURCE_REPEAT + 1),
    /must be an integer/,
  );

  const sources = Array.from(
    { length: Math.floor(MAX_LAYER_COUNT / MAX_SOURCE_REPEAT) + 1 },
    (_, index) => ({ name: `layer-${index}.gbr` }),
  );
  assert.throws(
    () => repeatLayerSources(sources, MAX_SOURCE_REPEAT),
    /cannot exceed.*layers/,
  );
});

test("viewer remote loader rejects oversized Content-Length before reading", async () => {
  let cancelled = false;
  const response = {
    ok: true,
    headers: makeHeaders({ "content-length": String(MAX_FILE_SIZE_BYTES + 1) }),
    body: {
      async cancel() {
        cancelled = true;
      },
    },
  };

  await assert.rejects(
    fetchRemoteFile(new URL("https://example.test/board.gbr"), {
      fetchImpl: async () => response,
    }),
    /limit is/,
  );
  assert.equal(cancelled, true);
});

test("viewer remote loader cancels streams that exceed the byte limit", async () => {
  let readIndex = 0;
  let cancelled = false;
  const chunks = [new Uint8Array(6), new Uint8Array(6)];
  const response = {
    ok: true,
    headers: makeHeaders({ "content-length": "5" }),
    body: {
      getReader() {
        return {
          async read() {
            if (readIndex >= chunks.length) return { done: true };
            return { done: false, value: chunks[readIndex++] };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  };

  await assert.rejects(
    fetchRemoteFile(new URL("https://example.test/board.gbr"), {
      maxBytes: 10,
      fetchImpl: async () => response,
    }),
    /limit is 10 bytes/,
  );
  assert.equal(cancelled, true);
});

test("viewer rejects oversized ZIP files before opening the archive", async () => {
  let opened = false;
  const archive = makeFile("zip", "layers.zip", "application/zip");
  archive.size = MAX_FILE_SIZE_BYTES + 1;

  await assert.rejects(
    collectLayerSources([archive], {
      jsZip: {
        async loadAsync() {
          opened = true;
          return { files: {} };
        },
      },
    }),
    /limit is/,
  );
  assert.equal(opened, false);
});

test("viewer ZIP rejects oversized entries before decompression", async () => {
  const errors = [];
  const entry = makeZipEntry(GERBER_CONTENT, "board.gbr", {
    uncompressedSize: MAX_FILE_SIZE_BYTES + 1,
    unreadable: true,
  });

  const sources = await collectLayerSources(
    [makeFile("zip", "layers.zip", "application/zip")],
    {
      jsZip: {
        async loadAsync() {
          return { files: { "board.gbr": entry } };
        },
      },
      onArchiveError(_name, error) {
        errors.push(error);
      },
    },
  );

  assert.deepEqual(sources, []);
  assert.match(errors[0].message, /limit is/);
});

test("viewer ZIP rejects excessive entry counts", async () => {
  const files = Object.fromEntries(
    Array.from({ length: MAX_ARCHIVE_ENTRY_COUNT + 1 }, (_, index) => {
      const name = `layer-${index}.gbr`;
      return [name, makeZipEntry(GERBER_CONTENT, name, { unreadable: true })];
    }),
  );
  const errors = [];

  const sources = await collectLayerSources(
    [makeFile("zip", "layers.zip", "application/zip")],
    {
      jsZip: { async loadAsync() { return { files }; } },
      onArchiveError(_name, error) {
        errors.push(error);
      },
    },
  );

  assert.deepEqual(sources, []);
  assert.match(errors[0].message, /contains 1001 entries/);
});

test("viewer ZIP rejects excessive total expansion and compression ratios", async () => {
  const halfTotal = Math.floor(MAX_ARCHIVE_TOTAL_SIZE_BYTES / 2) + 1;
  const expansionFiles = {
    "first.gbr": makeZipEntry(GERBER_CONTENT, "first.gbr", {
      uncompressedSize: halfTotal,
    }),
    "second.gbr": makeZipEntry(GERBER_CONTENT, "second.gbr", {
      uncompressedSize: halfTotal,
    }),
  };
  const ratioFiles = {
    "ratio.gbr": makeZipEntry(GERBER_CONTENT, "ratio.gbr", {
      uncompressedSize: MAX_ARCHIVE_COMPRESSION_RATIO + 1,
      compressedSize: 1,
    }),
  };

  for (const [files, expected] of [
    [expansionFiles, /uncompressed contents.*limit is/],
    [ratioFiles, /compression ratio/],
  ]) {
    const errors = [];
    const sources = await collectLayerSources(
      [makeFile("zip", "layers.zip", "application/zip")],
      {
        jsZip: { async loadAsync() { return { files }; } },
        onArchiveError(_name, error) {
          errors.push(error);
        },
      },
    );

    assert.deepEqual(sources, []);
    assert.match(errors[0].message, expected);
  }
});

function makeFile(content, name, type = "") {
  const blob = new Blob([content], { type });
  return {
    name,
    type,
    size: blob.size,
    slice: (...args) => blob.slice(...args),
    text: () => blob.text(),
  };
}

function makeZipEntry(content, name, options = {}) {
  const bytes = content instanceof Uint8Array
    ? content
    : new TextEncoder().encode(String(content));
  const text = content instanceof Uint8Array
    ? new TextDecoder("utf-8").decode(content)
    : String(content);

  return {
    dir: false,
    name,
    _data: {
      uncompressedSize: options.uncompressedSize ?? bytes.byteLength,
      compressedSize: options.compressedSize,
    },
    async async(type, onProgress) {
      if (options.unreadable) {
        throw new Error("entry should not be read");
      }
      onProgress?.({ percent: 100 });
      if (type === "uint8array") {
        return bytes;
      }
      return text;
    },
  };
}

function makeHeaders(values = {}) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get(name) {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}

test("package layer kind uses source paths, names, and raw content deliberately", () => {
  assert.equal(normalizeLayerKind(null, { path: "holes.drl" }), "drill");
  assert.equal(normalizeLayerKind(null, { path: "holes.drd" }, "", DRILL_CONTENT), "drill");
  assert.equal(normalizeLayerKind(null, { path: "board.drd" }, "", GERBER_CONTENT), "gerber");
  assert.equal(normalizeLayerKind(null, GERBER_CONTENT, "holes.drl"), "drill");
  assert.equal(normalizeLayerKind(null, DRILL_CONTENT, "", DRILL_CONTENT), "drill");
  assert.equal(normalizeLayerKind(null, DRILL_CONTENT, "Drills", DRILL_CONTENT), "drill");
  assert.equal(normalizeLayerKind(null, DRILL_CONTENT, "board.gbr", DRILL_CONTENT), "gerber");
  assert.equal(normalizeLayerKind("drill", GERBER_CONTENT, "board.gbr"), "drill");
});

test("renderDrills false skips drill sources before reading", async () => {
  const unreadableFile = {
    name: "holes.drl",
    async text() {
      throw new Error("source should not be read");
    },
  };

  const browserRecord = await GerberRenderer.prototype.createLayerRecord.call(
    { frame: { options: { renderDrills: false } } },
    { source: unreadableFile },
    {},
  );
  assert.equal(browserRecord, null);

  const nodeRecord = await NodeGerberRenderer.prototype.createPreparedLayer.call(
    { wasmModule: {} },
    fileLayer("/missing/holes.drl"),
    { renderDrills: false },
  );
  assert.equal(nodeRecord, null);
});

test("node prepared layer rejects late inversion without retained source", async () => {
  const renderer = new NodeGerberRenderer({}, makeParsedReuseWasmModule());
  const prepared = await renderer.loadLayer(GERBER_CONTENT, { name: "mask.gbs" });

  assert.equal(prepared.content, null);
  await assert.rejects(
    renderer.withFrame({}, async () => {
      await renderer.renderLayer(prepared, { inverted: true });
    }),
    /Prepared layer cannot be inverted because its source content was not retained/,
  );
});

test("node explicit prepared outline requires retained source", async () => {
  const renderer = new NodeGerberRenderer({}, makeParsedReuseWasmModule());
  const outline = await renderer.loadLayer(GERBER_CONTENT, { name: "routing.gbr" });
  const mask = await renderer.loadLayer(GERBER_CONTENT, {
    name: "mask.gbs",
    inverted: true,
  });

  assert.equal(outline.content, null);
  assert.equal(typeof mask.content, "string");
  await assert.rejects(
    renderer.withFrame({ invertedOutline: "routing.gbr" }, async () => {
      await renderer.renderLayer(outline);
      await renderer.renderLayer(mask);
    }),
    /Inverted outline layer requires source content: routing\.gbr/,
  );
});

test("package composite mode defaults to blend and validates explicit values", () => {
  assert.equal(createBaseFrameOptions().compositeMode, "blend");
  assert.equal(createBaseFrameOptions({ compositeMode: "stack" }).compositeMode, "stack");
  assert.equal(normalizeCompositeMode("blend"), "blend");
  assert.equal(normalizeCompositeMode("stack"), "stack");
  assert.throws(
    () => normalizeCompositeMode("overlay"),
    /compositeMode must be 'blend' or 'stack'/,
  );
});

test("package board outline detection accepts common outline names", () => {
  assert.equal(isBoardOutlineLayerName("board.gko"), true);
  assert.equal(isBoardOutlineLayerName("Edge.Cuts.gbr"), true);
  assert.equal(isBoardOutlineLayerName("board-outline.gbr"), true);
  assert.equal(isBoardOutlineLayerName("board-outlines.gbr"), true);
  assert.equal(isBoardOutlineLayerName("DrawingOutLineLayer.gbr"), true);
  assert.equal(isBoardOutlineLayerName("top-copper.gtl"), false);
});

test("node render plan preserves internal CLI outline selectors", async () => {
  const selectorKey = "__wasmGerberRendererCliLayer:1";
  const renderer = new NodeGerberRenderer({}, {});

  await renderer.withFrame({ invertedOutline: selectorKey }, async () => {
    renderer.frame.addLayer(makeNodeLayerRecord({
      layerId: 0,
      name: "outline.gko",
      selectorKey,
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    }));
    renderer.frame.addLayer(makeNodeLayerRecord({
      layerId: 1,
      name: "mask.gbs",
      inverted: true,
      bounds: { minX: 100, maxX: 101, minY: 100, maxY: 101 },
    }));
  });

  assert.equal(renderer.lastRenderPlan.layers[0].selectorKey, selectorKey);
  assert.deepEqual(renderer.lastFrame.bounds, { minX: 0, maxX: 10, minY: 0, maxY: 10 });
});

test("node numeric outline selectors keep original input indices after skips", async () => {
  const renderer = new NodeGerberRenderer({}, makeParsedReuseWasmModule());

  await renderer.withFrame({ invertedOutline: 2, renderDrills: false }, async () => {
    await renderer.renderLayers([
      { source: DRILL_CONTENT, name: "holes.drl" },
      { source: GERBER_CONTENT, name: "routing.gbr" },
      { source: GERBER_CONTENT, name: "mask.gbs", inverted: true },
    ]);
  });

  assert.equal(
    renderer.lastRenderPlan.invertedOutline,
    "__wasmGerberRendererCliLayer:2",
  );
  assert.equal(
    renderer.lastRenderPlan.layers[0].selectorKey,
    "__wasmGerberRendererCliLayer:2",
  );
  assert.equal(
    renderer.lastRenderPlan.layers[1].selectorKey,
    "__wasmGerberRendererCliLayer:3",
  );
});

test("node numeric outline selectors include prior renderLayer calls", async () => {
  const renderer = new NodeGerberRenderer({}, makeParsedReuseWasmModule());

  await renderer.withFrame({ invertedOutline: 1 }, async () => {
    await renderer.renderLayer({ source: GERBER_CONTENT, name: "routing.gbr" });
    await renderer.renderLayers([
      { source: GERBER_CONTENT, name: "mask.gbs", inverted: true },
    ]);
  });

  assert.equal(
    renderer.lastRenderPlan.invertedOutline,
    "__wasmGerberRendererCliLayer:1",
  );
  assert.equal(
    renderer.lastRenderPlan.layers[0].selectorKey,
    "__wasmGerberRendererCliLayer:1",
  );
  assert.equal(
    renderer.lastRenderPlan.layers[1].selectorKey,
    "__wasmGerberRendererCliLayer:2",
  );
});

test("node bounds inversion includes the target layer extents", async () => {
  const renderer = new NodeGerberRenderer({}, {});

  await renderer.withFrame({ invertedOutline: "bounds" }, async () => {
    renderer.frame.addLayer(makeNodeLayerRecord({
      layerId: 0,
      name: "silk.gto",
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    }));
    renderer.frame.addLayer(makeNodeLayerRecord({
      layerId: 1,
      name: "mask.gbs",
      inverted: true,
      bounds: { minX: 100, maxX: 101, minY: 100, maxY: 101 },
    }));
  });

  assert.deepEqual(renderer.lastFrame.bounds, { minX: 0, maxX: 101, minY: 0, maxY: 101 });
});

test("node auto outline inversion keeps fallback bounds in the frame", async () => {
  const renderer = new NodeGerberRenderer({}, {});

  await renderer.withFrame({}, async () => {
    renderer.frame.addLayer(makeNodeLayerRecord({
      layerId: 0,
      name: "outline.gko",
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    }));
    renderer.frame.addLayer(makeNodeLayerRecord({
      layerId: 1,
      name: "mask.gbs",
      inverted: true,
      bounds: { minX: 100, maxX: 101, minY: 100, maxY: 101 },
    }));
  });

  assert.deepEqual(renderer.lastFrame.bounds, { minX: 0, maxX: 101, minY: 0, maxY: 101 });
});

function makeNodeLayerRecord(overrides = {}) {
  return {
    kind: "gerber",
    layerId: 0,
    selectorKey: null,
    name: "layer.gbr",
    sourceName: "layer.gbr",
    content: "synthetic",
    parsedLayer: null,
    parsedDrillLayer: null,
    offsetX: 0,
    offsetY: 0,
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
    color: [1, 0, 0],
    alpha: null,
    inverted: false,
    outlineStyle: null,
    ...overrides,
  };
}

function makeParsedReuseWasmModule() {
  function GerberProcessor() {}
  GerberProcessor.prototype.add_parsed_layer = function addParsedLayer() {};
  return {
    GerberProcessor,
    parse_gerber_layer_with_options() {
      return {
        sublayers: [
          {
            boundary: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
          },
        ],
      };
    },
  };
}
