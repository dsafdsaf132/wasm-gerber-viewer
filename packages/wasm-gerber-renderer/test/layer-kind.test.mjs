import assert from "node:assert/strict";
import test from "node:test";

import {
  getLayerSourceKind,
} from "../../../js/file-utils.js";
import {
  collectLayerSources,
} from "../../../js/source-loader.js";
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
    _data: { uncompressedSize: options.uncompressedSize ?? bytes.byteLength },
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
