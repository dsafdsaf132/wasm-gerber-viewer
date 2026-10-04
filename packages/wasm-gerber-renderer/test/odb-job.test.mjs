import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { collectLayerSources } from "../../../js/loading/source-loader.js";
import { isStandardSymbolName } from "../../../js/loading/odb/job-loader.js";
import { assignLayerFileNames } from "../../../js/loading/odb/layer-naming.js";
import { parseMatrix } from "../../../js/loading/odb/matrix.js";
import { LayerFilterStore } from "../../../js/layers/layer-filters.js";
import { isBoardOutlineLayerName } from "../shared.js";
import { buildSampleJobFiles as buildFixture, matrixFile, toBytes, writeTar, writeTgz } from "./helpers/odb-fixture.mjs";
import { buildSymbolGalleryJobFiles, SYMBOL_GALLERY_NAMES } from "./helpers/odb-symbol-gallery.mjs";
import { loadUnixZDecoder } from "./helpers/wasm-module.mjs";

const decoder = new TextDecoder();
// The sample job stores one layer as `features.Z`, which the WASM module
// decodes. Without a built package the fixture keeps that layer uncompressed
// so the loader tests still run.
const decompressUnixZ = await loadUnixZDecoder();
const buildSampleJobFiles = (options = {}) =>
  buildFixture({ compressTopLayer: decompressUnixZ !== null, ...options });

function makeArchiveFile(bytes, name, type = "") {
  const blob = new Blob([bytes], { type });
  return {
    name,
    type,
    size: blob.size,
    slice: (...args) => blob.slice(...args),
    text: () => blob.text(),
    arrayBuffer: () => blob.arrayBuffer(),
  };
}

function makeZip(files) {
  const zipFiles = {};
  for (const [path, content] of Object.entries(files)) {
    const bytes = toBytes(content);
    zipFiles[path] = {
      dir: false,
      name: path,
      _data: { uncompressedSize: bytes.byteLength, compressedSize: bytes.byteLength },
      async async(type, onProgress) {
        onProgress?.({ percent: 100 });
        return type === "uint8array" ? bytes : decoder.decode(bytes);
      },
    };
  }
  return { files: zipFiles };
}

function collectDiagnostics() {
  const warnings = [];
  const infos = [];
  const errors = [];
  return {
    warnings,
    infos,
    errors,
    callbacks: {
      onArchiveWarning: (name, message) => warnings.push(`${name}: ${message}`),
      onArchiveInfo: (name, message) => infos.push(`${name}: ${message}`),
      onArchiveError: (name, error) => errors.push({ name, error }),
      decompressUnixZ,
    },
  };
}

const EXPECTED_NAMES = [
  "profile.gko",
  "sst.gto",
  "spt.gtp",
  "smt.gts",
  "top.gtl",
  "bottom.gbl",
  "smb.gbs",
  "drill-pth.drl",
  "drill-npth.drl",
  "rout-npth.drl",
];

test("a .tgz ODB++ job becomes ordered layer sources with Gerber-style names", async () => {
  const { files, topFeatures } = buildSampleJobFiles({ includeDiagnosticCases: true });
  const diagnostics = collectDiagnostics();
  const sources = await collectLayerSources(
    [makeArchiveFile(writeTgz(files), "demo_board.tgz")],
    diagnostics.callbacks,
  );

  assert.deepEqual(sources.map((source) => source.name), EXPECTED_NAMES);
  assert.deepEqual(
    sources.map((source) => source.kind),
    ["gerber", "gerber", "gerber", "gerber", "gerber", "gerber", "gerber", "drill", "drill", "drill"],
  );
  assert.equal(diagnostics.errors.length, 0);

  const top = sources.find((source) => source.name === "top.gtl");
  assert.equal(top.sizeBytes, toBytes(topFeatures).byteLength, "a features.Z layer is decompressed for sizing");
  // The layer text is an envelope of the original ODB++ files: the features
  // file plus every user-defined symbol it references, nested ones included.
  const envelope = await top.readText();
  assert.match(envelope, /^%ODB\+\+LAYER%\nkind=signal\nname=TOP\n%ODB\+\+FILE features%\n/);
  assert.ok(envelope.includes(topFeatures), "features file travels verbatim");
  assert.match(envelope, /%ODB\+\+FILE symbols\/fiducial%\n/);
  assert.match(envelope, /%ODB\+\+END%\n$/);
  assert.ok(!envelope.includes("symbols/logo"), "only symbols this layer references");
  assert.equal(await top.readText(), envelope, "the envelope is memoised");

  const silk = sources.find((source) => source.name === "sst.gto");
  const silkEnvelope = await silk.readText();
  assert.match(silkEnvelope, /%ODB\+\+FILE symbols\/logo%\n/);
  assert.match(silkEnvelope, /%ODB\+\+FILE symbols\/arrow%\n/, "nested symbol collected");

  const profile = sources.find((source) => source.name === "profile.gko");
  assert.match(await profile.readText(), /^%ODB\+\+LAYER%\nkind=profile\n/);

  const smb = sources.find((source) => source.name === "smb.gbs");
  assert.match(await smb.readText(), /%ODB\+\+FILE features%\nUNITS=MM/, "features.gz layer decompressed");

  const drill = sources.find((source) => source.name === "drill-pth.drl");
  const drillEnvelope = await drill.readText();
  assert.match(drillEnvelope, /^%ODB\+\+LAYER%\nkind=drill\nname=DRILL\nplating=plated\n/);
  assert.match(drillEnvelope, /%ODB\+\+FILE tools%\n/);
  const npth = sources.find((source) => source.name === "drill-npth.drl");
  assert.match(await npth.readText(), /plating=non_plated\n/);
  const rout = sources.find((source) => source.name === "rout-npth.drl");
  assert.match(await rout.readText(), /^%ODB\+\+LAYER%\nkind=rout\n/);
  assert.ok(!(await rout.readText()).includes("plating="), "single plating class needs no filter");

  assert.ok(
    diagnostics.warnings.some((line) => /Skipped 2 non-board layers: COMPONENT x1, MISC\/DOCUMENT x1/.test(line)),
    diagnostics.warnings.join("\n"),
  );
  assert.ok(diagnostics.infos.some((line) => /10 ODB\+\+ layers imported from step pcb/.test(line)));
});

test("the symbol gallery demo loads without diagnostics and flashes every standard family", async () => {
  const { files, width, height } = buildSymbolGalleryJobFiles({ root: "symbol_gallery" });
  const diagnostics = collectDiagnostics();
  const sources = await collectLayerSources(
    [makeArchiveFile(writeTgz(files), "symbol_gallery.tgz")],
    diagnostics.callbacks,
  );

  assert.deepEqual(sources.map((source) => source.name), ["profile.gko", "top.gtl"]);
  assert.equal(diagnostics.errors.length, 0);
  assert.deepEqual(diagnostics.warnings, [], "the committed demo converts completely");
  assert.equal(width, 41);
  assert.equal(height, 71);

  const top = await sources.find((source) => source.name === "top.gtl").readText();
  const declared = [...top.matchAll(/^\$\d+ (\S+)/gm)].map((match) => match[1]);
  for (const name of SYMBOL_GALLERY_NAMES) {
    assert.ok(declared.includes(name), `top layer declares ${name}`);
    assert.ok(isStandardSymbolName(name), `${name} follows the standard grammar`);
  }
  // Every appendix A family with a geometry appears at least once.
  const families = [
    "r", "s", "rect", "oval", "oval_h", "di", "oct", "donut_r", "donut_s", "donut_sr", "donut_rc", "donut_o",
    "hex_l", "hex_s", "bfr", "bfs", "tri", "el", "moire", "thr", "ths", "s_ths", "s_tho", "s_thr", "sr_ths",
    "rc_ths", "rc_tho", "o_ths", "oblong_ths", "hplate", "rhplate", "radhplate", "dshape", "cross", "dogbone", "dpack",
  ];
  for (const family of families) {
    assert.ok(
      declared.some((name) => new RegExp(`^${family}\\d`).test(name)),
      `gallery covers ${family}`,
    );
  }
  assert.match(top, /%ODB\+\+FILE symbols\/lshape%\n/, "the asymmetric user symbol travels with the layer");
});

test("only names that follow the whole standard grammar count as standard symbols", async () => {
  for (const name of [
    "r15.748", "s800", "rect1400x800xr250x13", "hole1000xpx10x10", "thr1600x1000x45x4x300", "DONUT_R1200x600",
    "dogbone2400x1600x400x400x50xr", "cross2400x2400x400x400x50x50xs20", "oblong_ths2800x1600x0x4x300x300xr", "dpack2400x2400x200x200x2x2",
  ]) {
    assert.equal(isStandardSymbolName(name), true, name);
  }
  for (const name of ["r10_tp", "s1_via", "rect_custom", "r10x", "fiducial", "silk_kiro", "construct+71"]) {
    assert.equal(isStandardSymbolName(name), false, name);
  }

  // A user symbol whose name starts like a standard family travels with the layer.
  const { files } = buildSampleJobFiles();
  files["demo_board/symbols/r10_tp/features"] = "UNITS=MM\n$0 r500\nP 0 0 0 P 0 0\n";
  files["demo_board/steps/pcb/layers/bottom/features"] = "UNITS=MM\n$0 r10_tp\nP 5 5 0 P 0 0\n";
  const sources = await collectLayerSources(
    [makeArchiveFile(writeTgz(files), "demo_board.tgz")],
    collectDiagnostics().callbacks,
  );
  const bottom = sources.find((source) => source.name === "bottom.gbl");
  assert.match(await bottom.readText(), /%ODB\+\+FILE symbols\/r10_tp%\n/);
});

test("the same job inside a ZIP and as a dropped folder yields the same sources", async () => {
  const { files } = buildSampleJobFiles();

  const zipDiagnostics = collectDiagnostics();
  const fromZip = await collectLayerSources(
    [makeArchiveFile(new Uint8Array([0x50, 0x4b]), "demo_board.zip", "application/zip")],
    { ...zipDiagnostics.callbacks, jsZip: { loadAsync: async () => makeZip(files) } },
  );
  assert.deepEqual(fromZip.map((source) => source.name), EXPECTED_NAMES);
  assert.equal(zipDiagnostics.errors.length, 0);

  const folderItems = Object.entries(files).map(([path, content]) => {
    const file = makeArchiveFile(toBytes(content), path.split("/").pop());
    return { file, relativePath: path, name: file.name, size: file.size };
  });
  const folderDiagnostics = collectDiagnostics();
  const fromFolder = await collectLayerSources(folderItems, folderDiagnostics.callbacks);
  assert.deepEqual(fromFolder.map((source) => source.name), EXPECTED_NAMES);
  assert.equal(folderDiagnostics.errors.length, 0);
  assert.equal(await fromFolder[4].readText(), await fromZip[4].readText());
});

test("step selection prefers the requested step, then pcb-like names, then non-panel steps", async () => {
  const { files } = buildSampleJobFiles({ root: "job" });
  const layers = parseMatrix(files["job/matrix/matrix"]).layers.map((layer) => ({
    type: layer.type,
    name: layer.name,
    context: layer.context,
    startName: layer.startName,
    endName: layer.endName,
  }));
  files["job/matrix/matrix"] = matrixFile({ steps: ["panel", "array", "pcb"], layers });
  files["job/steps/panel/stephdr"] = "STEP-REPEAT {\nNAME=pcb\nX=0\nY=0\nDX=1\nDY=1\nNX=2\nNY=2\nANGLE=0\nFLIP=NO\nMIRROR=NO\n}\n";
  files["job/steps/array/profile"] = files["job/steps/pcb/profile"];
  files["job/steps/array/layers/top/features"] = "UNITS=MM\n$0 r600\nP 1 1 0 P 0 0\n";

  const diagnostics = collectDiagnostics();
  const defaultSources = await collectLayerSources([makeArchiveFile(writeTgz(files), "job.tgz")], diagnostics.callbacks);
  assert.equal(defaultSources.length, EXPECTED_NAMES.length, "pcb-like step wins");
  assert.ok(diagnostics.warnings.some((line) => /Loaded step pcb; other steps not imported: panel, array/.test(line)));

  const arraySources = await collectLayerSources([makeArchiveFile(writeTgz(files), "job.tgz")], {
    ...diagnostics.callbacks,
    odbStepName: "array",
  });
  assert.deepEqual(arraySources.map((source) => source.name), ["profile.gko", "top.gtl"]);
  assert.ok(diagnostics.warnings.some((line) => /Layer .* has no features file; skipped/.test(line)));

  files["job/matrix/matrix"] = matrixFile({ steps: ["panel", "array"], layers });
  const nonPanel = await collectLayerSources([makeArchiveFile(writeTgz(files), "job.tgz")], diagnostics.callbacks);
  assert.deepEqual(nonPanel.map((source) => source.name), ["profile.gko", "top.gtl"], "first non-panel step");
});

test("archives without a job fall back to plain layer sniffing; broken jobs report errors", async () => {
  const gerber = "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX000000Y000000D03*\nM02*\n";
  const plain = await collectLayerSources(
    [makeArchiveFile(writeTgz({ "top.gtl": gerber, "notes.txt": "hello" }), "layers.tgz")],
    collectDiagnostics().callbacks,
  );
  assert.deepEqual(plain.map((source) => [source.name, source.kind]), [["top.gtl", "gerber"]]);
  assert.equal(await plain[0].readText(), gerber);

  const gzipped = new Uint8Array(gzipSync(writeTar({ "top.gtl": gerber })));
  const plainGz = await collectLayerSources([makeArchiveFile(gzipped, "layers.tar.gz")], collectDiagnostics().callbacks);
  assert.equal(plainGz.length, 1);

  const broken = collectDiagnostics();
  const none = await collectLayerSources(
    [makeArchiveFile(writeTgz({ "job/matrix/matrix": "STEP {\nNAME=pcb\n}\n" }), "job.tgz")],
    broken.callbacks,
  );
  assert.deepEqual(none, []);
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0].error.message, /no importable board layers|no profile/);

  const corrupt = collectDiagnostics();
  await collectLayerSources([makeArchiveFile(new Uint8Array([1, 2, 3, 4]), "x.tgz")], corrupt.callbacks);
  assert.equal(corrupt.errors.length, 1);
});

test("generated names drive the viewer's side filters and outline detection", () => {
  const { files } = buildSampleJobFiles();
  const names = assignLayerFileNames(parseMatrix(files["demo_board/matrix/matrix"]).layers);
  assert.equal(names.get("TOP").fileName, "top.gtl");
  assert.equal(names.get("BOTTOM").fileName, "bottom.gbl");
  assert.equal(names.get("SMT").fileName, "smt.gts");
  assert.equal(names.get("SMB").fileName, "smb.gbs");
  assert.equal(names.get("SST").fileName, "sst.gto");
  assert.equal(names.get("SPT").fileName, "spt.gtp");
  assert.equal(names.get("DRILL").fileName, "drill.drl");

  const store = new LayerFilterStore({ storage: null });
  const top = (name) => store.matches({ name }, "top");
  const bottom = (name) => store.matches({ name }, "bottom");
  assert.equal(top("top.gtl"), true);
  assert.equal(bottom("top.gtl"), false);
  assert.equal(bottom("bottom.gbl"), true);
  assert.equal(top("smt.gts"), true);
  assert.equal(bottom("smb.gbs"), true);

  assert.equal(isBoardOutlineLayerName("profile.gko"), true);
  for (const name of ["top.gtl", "bottom.gbl", "smt.gts", "drill-pth.drl"]) {
    assert.equal(isBoardOutlineLayerName(name), false, name);
  }

  const inner = assignLayerFileNames(
    parseMatrix(
      matrixFile({
        layers: [
          { type: "SIGNAL", name: "L1" },
          { type: "SIGNAL", name: "L2" },
          { type: "SIGNAL", name: "L3" },
          { type: "SOLDER_MASK", name: "MASK_B" },
          { type: "SILK_SCREEN", name: "silkscreen_+_top" },
        ],
      }),
    ).layers,
  );
  assert.equal(inner.get("L2").fileName, "l2-inner1.gbr");
  assert.equal(inner.get("L3").fileName, "l3.gbl");
  assert.equal(inner.get("MASK_B").fileName, "mask_b.gbs");
  assert.equal(inner.get("silkscreen_+_top").fileName, "silkscreen_+_top.gto");

  // CAM houses keep scratch copies of copper as MISC-context SIGNAL layers
  // (seen in a production 4-up panel job); they must not become the outer
  // copper of the stack-up.
  const withMisc = assignLayerFileNames(
    parseMatrix(
      matrixFile({
        layers: [
          { type: "SIGNAL", name: "I_2.ORG", context: "MISC" },
          { type: "SIGNAL", name: "I_3.ORG", context: "MISC" },
          { type: "SOLDER_MASK", name: "TOP_R" },
          { type: "SIGNAL", name: "L1" },
          { type: "SIGNAL", name: "L2" },
          { type: "SIGNAL", name: "L3" },
          { type: "SIGNAL", name: "L4" },
          { type: "SOLDER_MASK", name: "BOT_R" },
        ],
      }),
    ).layers,
  );
  assert.equal(withMisc.get("L1").fileName, "l1.gtl");
  assert.equal(withMisc.get("L2").fileName, "l2-inner1.gbr");
  assert.equal(withMisc.get("L3").fileName, "l3-inner2.gbr");
  assert.equal(withMisc.get("L4").fileName, "l4.gbl");
  assert.equal(withMisc.get("TOP_R").fileName, "top_r.gts");
  assert.equal(withMisc.get("BOT_R").fileName, "bot_r.gbs");
});
