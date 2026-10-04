import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { gunzip, isGzipBytes } from "../../../js/loading/odb/archive/gzip.js";
import { parseTar } from "../../../js/loading/odb/archive/tar.js";
import {
  JobTree,
  createTarJobTree,
  createZipJobTree,
  findOdbRoot,
  isUnixZBytes,
} from "../../../js/loading/odb/archive/job-tree.js";
import {
  isOdbArchiveFile,
  isOdbFileList,
  isOdbZip,
} from "../../../js/loading/odb/archive/detect.js";
import { compressLzw } from "./helpers/lzw-encoder.mjs";
import { toBytes, writeTar } from "./helpers/odb-fixture.mjs";
import { loadUnixZDecoder } from "./helpers/wasm-module.mjs";

const decoder = new TextDecoder();
// `.Z` files are decoded by the WASM module; tests that need it skip when the
// package has not been built (CI builds it before running these tests).
const decompressUnixZ = await loadUnixZDecoder();
const needsWasm = { skip: decompressUnixZ ? false : "wasm/pkg is not built" };

test("parseTar reads regular files, ustar prefixes, and ignores directories", () => {
  const longDir = "a".repeat(60) + "/" + "b".repeat(60);
  const bytes = writeTar({
    "job/matrix/matrix": "STEP {\nNAME=pcb\n}\n",
    [`${longDir}/features`]: "UNITS=MM\n",
    "__MACOSX/._junk": "x",
  });
  const entries = parseTar(bytes, { archiveName: "job.tar" });
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["job/matrix/matrix", `${longDir}/features`],
  );
  assert.equal(decoder.decode(entries[0].bytes), "STEP {\nNAME=pcb\n}\n");
});

test("parseTar rejects empty and control-character paths", () => {
  assert.throws(
    () => parseTar(writeTar({ "": "empty" }), { archiveName: "empty-path.tar" }),
    /invalid path/,
  );
  assert.throws(
    () => parseTar(writeTar({ "job/steps/pcb/\nfeatures": "bad" }), { archiveName: "control-path.tar" }),
    /invalid path/,
  );
});

test("parseTar accepts the thousands of entries a production job ships", () => {
  // A real 4-up panel job holds ~2500 files (symbols, fonts, wheels, 14 steps).
  const files = { "job/matrix/matrix": "STEP {\nNAME=pcb\n}\n" };
  for (let index = 0; index < 2600; index++) {
    files[`job/symbols/sym${index}/features`] = "UNITS=MM\n";
  }
  const entries = parseTar(writeTar(files), { archiveName: "big.tar" });
  assert.equal(entries.length, 2601);
});

test("parseTar rejects truncated archives and checksum mismatches", () => {
  const bytes = writeTar({ "job/matrix/matrix": "x".repeat(700) });
  assert.throws(
    () => parseTar(bytes.subarray(0, 900), { archiveName: "cut.tar" }),
    /truncated/,
  );
  const corrupt = Uint8Array.from(bytes);
  corrupt[10] ^= 0xff;
  assert.throws(() => parseTar(corrupt, { archiveName: "bad.tar" }), /checksum/);
});

test("parseTar stops at the end marker and accepts archives that lack one", () => {
  const bytes = writeTar({ "job/matrix/matrix": "STEP {\nNAME=pcb\n}\n" });
  const endMarker = bytes.length - 1024;

  // Trailing bytes after the end-of-archive marker are not inspected.
  const trailing = new Uint8Array(bytes.length + 4096);
  trailing.set(bytes);
  trailing.fill(0x41, bytes.length);
  assert.equal(parseTar(trailing, { archiveName: "trailing.tar" }).length, 1);

  // No end marker at all: every entry read is complete, so the archive is fine.
  const unterminated = bytes.subarray(0, endMarker);
  assert.equal(parseTar(unterminated, { archiveName: "open.tar" }).length, 1);

  // An entry whose data is cut off is still an error.
  assert.throws(
    () => parseTar(bytes.subarray(0, endMarker - 8), { archiveName: "cut.tar" }),
    /truncated/,
  );
});

test("LZW decoding time grows linearly with the output size", needsWasm, () => {
  // The first JS decoder grew its output buffer to the exact size on every
  // chunk (quadratic); a 1 MB text took seconds. The WASM decoder must stay linear.
  let text = "";
  for (let index = 0; index < 45000; index++) {
    text += `P ${(index * 7919) % 100000} ${(index * 104729) % 100000} ${index % 13} P 0 ${index % 9}\n`;
  }
  const input = toBytes(text);
  assert.ok(input.length > 800 * 1024, `input is ${input.length} bytes`);
  const packed = compressLzw(input, { maxBits: 16 });
  const start = performance.now();
  const output = decompressUnixZ(packed, input.length);
  const elapsed = performance.now() - start;
  assert.equal(output.length, input.length);
  assert.ok(elapsed < 1000, `decoding ${input.length} bytes took ${elapsed.toFixed(0)} ms`);
});

test("gunzip inflates and enforces the output cap", async () => {
  const text = "G04 hello*\n".repeat(500);
  const compressed = new Uint8Array(gzipSync(text));
  assert.equal(isGzipBytes(compressed), true);
  const inflated = await gunzip(compressed, { maxOutputBytes: text.length });
  assert.equal(decoder.decode(inflated), text);
  await assert.rejects(gunzip(compressed, { maxOutputBytes: 100 }), RangeError);
});

test("LZW round-trips across code width changes, a CLEAR, and a full table", needsWasm, () => {
  let text = "";
  for (let index = 0; index < 4000; index++) {
    text += `P ${(index * 7919) % 1000} ${(index * 104729) % 1000} ${index % 13} P 0 ${index % 9}\n`;
  }
  const input = toBytes(text);

  for (const options of [
    { maxBits: 16 },
    { maxBits: 12 },
    { maxBits: 9 },
    { maxBits: 16, clearAfterCodes: 700 },
    { maxBits: 10, clearAfterCodes: 3000 },
  ]) {
    const compressed = compressLzw(input, options);
    assert.equal(isUnixZBytes(compressed), true);
    const output = decompressUnixZ(compressed, input.length);
    assert.equal(decoder.decode(output), text, JSON.stringify(options));
  }
});

test("LZW handles the KwKwK case and small inputs", needsWasm, () => {
  for (const sample of ["", "a", "aaaaaaaaaaaaaaaaaaaaaaaa", "abababababababab", "TOBEORNOTTOBEORTOBEORNOT"]) {
    const output = decompressUnixZ(compressLzw(toBytes(sample)), 1024);
    assert.equal(decoder.decode(output), sample, JSON.stringify(sample));
  }
});

test("LZW rejects bad magic and caps output", needsWasm, () => {
  assert.equal(isUnixZBytes(Uint8Array.from([1, 2, 3])), false);
  assert.throws(() => decompressUnixZ(Uint8Array.from([1, 2, 3]), 1024), /not in UNIX compress/);
  const compressed = compressLzw(toBytes("x".repeat(10_000)));
  assert.throws(() => decompressUnixZ(compressed, 100), /could not be decompressed/);
});

test("JobTree reports .Z files clearly when no decoder is available", async () => {
  const tar = writeTar({
    "job/matrix/matrix": "STEP {\nNAME=pcb\n}\n",
    "job/steps/pcb/layers/top/features.Z": compressLzw(toBytes("UNITS=MM\n")),
  });
  const tree = createTarJobTree(parseTar(tar));
  await assert.rejects(tree.readBytes("steps/pcb/layers/top/features"), /requires the WASM module/);
});

test("findOdbRoot locates the job root, preferring the shallowest match", () => {
  assert.equal(findOdbRoot(["matrix/matrix", "steps/pcb/stephdr"]), "");
  assert.equal(findOdbRoot(["job/matrix/matrix", "job/steps/pcb/stephdr"]), "job/");
  assert.equal(findOdbRoot(["./job/matrix/matrix.Z"]), "job/");
  assert.equal(findOdbRoot(["a/b/matrix/matrix", "b/matrix/matrix"]), "b/");
  assert.equal(findOdbRoot(["top.gbr", "bottom.gbr"]), null);
  assert.equal(findOdbRoot(["job/matrix/matrix.txt"]), null);
});

test("JobTree resolves case-insensitively and decompresses .Z and .gz transparently", needsWasm, async () => {
  const features = "UNITS=MM\n$0 r100\nP 1 2 0 P 0 0\n";
  const tar = writeTar({
    "job/matrix/matrix": "STEP {\nCOL=1\nNAME=pcb\n}\n",
    "job/steps/pcb/layers/top/features.Z": compressLzw(toBytes(features), { maxBits: 12 }),
    "job/steps/pcb/layers/bottom/features.gz": new Uint8Array(gzipSync(features)),
  });
  const tree = createTarJobTree(parseTar(tar), { decompressUnixZ });
  assert.equal(tree.isOdbJob, true);
  assert.equal(tree.root, "job/");
  assert.equal(tree.has("MATRIX/MATRIX"), true);
  assert.equal(tree.has("steps/PCB/layers/TOP/features"), true);
  assert.equal(await tree.readText("steps/pcb/layers/top/features"), features);
  assert.equal(await tree.readText("steps/pcb/layers/bottom/features"), features);
  assert.deepEqual(tree.list("steps/pcb/layers").sort(), [
    "steps/pcb/layers/bottom/features.gz",
    "steps/pcb/layers/top/features.Z",
  ]);
  await assert.rejects(tree.readBytes("steps/pcb/layers/missing/features"), /missing/);
});

test("JobTree byte budget rejects oversized expansions", needsWasm, async () => {
  const tree = new JobTree(
    [
      {
        path: "matrix/matrix",
        sizeBytes: 3,
        readBytes: async () => toBytes("STEP {\nNAME=pcb\n}\n"),
      },
      {
        path: "steps/pcb/layers/top/features.Z",
        sizeBytes: 10,
        readBytes: async () => compressLzw(toBytes("P 0 0 0 P 0 0\n".repeat(5000))),
      },
    ],
    {
      budget: { charge(input, output) { if (output > 1000) throw new RangeError("too big"); } },
      decompressUnixZ,
    },
  );
  await assert.rejects(tree.readBytes("steps/pcb/layers/top/features"), /too big/);
});

test("detect helpers recognize archives, ODB zips, and dropped job folders", () => {
  assert.equal(isOdbArchiveFile({ name: "job.tgz", type: "" }), true);
  assert.equal(isOdbArchiveFile({ name: "JOB.TAR.GZ", type: "" }), true);
  assert.equal(isOdbArchiveFile({ name: "job.tar", type: "" }), true);
  assert.equal(isOdbArchiveFile({ name: "board.gbr.gz", type: "" }), false);
  assert.equal(isOdbArchiveFile({ name: "layers.zip", type: "application/zip" }), false);

  const zip = { files: { "job/": { dir: true }, "job/matrix/matrix": {}, "job/steps/pcb/profile": {} } };
  assert.equal(isOdbZip(zip), true);
  assert.equal(isOdbZip({ files: { "top.gtl": {} } }), false);
  const zipTree = createZipJobTree({
    files: {
      "job/": { dir: true, name: "job/" },
      "job/matrix/matrix": { dir: false, name: "job/matrix/matrix", async: async () => toBytes("x") },
    },
  });
  assert.equal(zipTree.root, "job/");

  assert.equal(isOdbFileList([{ file: {}, relativePath: "job/matrix/matrix" }]), true);
  assert.equal(isOdbFileList([{ name: "top.gtl" }]), false);
});
