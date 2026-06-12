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
