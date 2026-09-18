import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import { NodeGerberRenderer } from "../node.js";
import { buildSampleJobFiles, writeTgz } from "./helpers/odb-fixture.mjs";

test("Node renderer loads an ODB++ tgz through the packaged job loader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "node-odb-job-"));
  try {
    const archivePath = join(directory, "board.tgz");
    const { files } = buildSampleJobFiles({
      compressTopLayer: false,
      includeDiagnosticCases: true,
    });
    await writeFile(archivePath, writeTgz(files));

    const renderer = new NodeGerberRenderer({}, {});
    const warnings = [];
    const infos = [];
    const layers = await renderer.loadOdbJob(archivePath, {
      onWarning: (_job, message) => warnings.push(message),
      onInfo: (_job, message) => infos.push(message),
    });

    assert.deepEqual(
      layers.map((layer) => [layer.name, layer.kind]),
      [
        ["profile.gko", "gerber"],
        ["sst.gto", "gerber"],
        ["spt.gtp", "gerber"],
        ["smt.gts", "gerber"],
        ["top.gtl", "gerber"],
        ["bottom.gbl", "gerber"],
        ["smb.gbs", "gerber"],
        ["drill-pth.drl", "drill"],
        ["drill-npth.drl", "drill"],
        ["rout-npth.drl", "drill"],
      ],
    );
    assert.match(layers[4].source, /^%ODB\+\+LAYER%\nkind=signal\n/);
    assert.ok(infos.some((message) => /10 ODB\+\+ layers imported/.test(message)));
    assert.ok(warnings.some((message) => /Skipped 2 non-board layers/.test(message)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node renderer loads a deflated ODB++ ZIP job through the packaged job loader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "node-odb-zip-job-"));
  try {
    const archivePath = join(directory, "board.zip");
    const { files } = buildSampleJobFiles({ compressTopLayer: false });
    await writeFile(archivePath, writeStoredZip(files, { compress: true }));

    const renderer = new NodeGerberRenderer({}, {});
    const layers = await renderer.loadOdbJob(archivePath);

    assert.deepEqual(
      layers.map((layer) => layer.name),
      [
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
      ],
    );
    assert.match(layers[4].source, /^%ODB\+\+LAYER%\nkind=signal\n/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node ODB++ ZIP loader rejects a corrupt central-directory CRC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "node-odb-zip-crc-"));
  try {
    const archivePath = join(directory, "board.zip");
    const { files } = buildSampleJobFiles({ compressTopLayer: false });
    await writeFile(archivePath, writeStoredZip(files, { corruptCrc: true }));

    const renderer = new NodeGerberRenderer({}, {});
    await assert.rejects(renderer.loadOdbJob(archivePath), /CRC does not match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function writeStoredZip(files, { corruptCrc = false, compress = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let count = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path, "utf8");
    const data = Buffer.from(content);
    const compressed = compress ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(compress ? 8 : 0, 10);
    central.writeUInt32LE((crc32(data) ^ (corruptCrc ? 1 : 0)) >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
    count += 1;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

let crcTable = null;

function crc32(bytes) {
  const table = crcTable ??= Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return value >>> 0;
  });
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
