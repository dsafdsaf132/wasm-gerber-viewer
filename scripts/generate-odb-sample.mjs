// Generates the committed ODB++ demo jobs:
//   demo/odb-sample.tgz        (gzip-compressed TAR, one layer stored as features.Z)
//   demo/odb-sample.zip        (same tree as a ZIP)
//   demo/odb-symbol-gallery.tgz  (every standard symbol family on a grid)
// Usage: node scripts/generate-odb-sample.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import {
  buildSampleJobFiles,
  toBytes,
  writeTgz,
} from "../packages/wasm-gerber-renderer/test/helpers/odb-fixture.mjs";
import { buildSymbolGalleryJobFiles } from "../packages/wasm-gerber-renderer/test/helpers/odb-symbol-gallery.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(here, "../demo");
mkdirSync(demoDir, { recursive: true });

const { files } = buildSampleJobFiles({ root: "demo_board" });

const tgz = writeTgz(files);
writeFileSync(resolve(demoDir, "odb-sample.tgz"), tgz);

const zip = writeZip(files);
writeFileSync(resolve(demoDir, "odb-sample.zip"), zip);

console.log(`demo/odb-sample.tgz ${tgz.length} bytes, demo/odb-sample.zip ${zip.length} bytes, ${Object.keys(files).length} files`);

const gallery = buildSymbolGalleryJobFiles({ root: "symbol_gallery" });
const galleryTgz = writeTgz(gallery.files);
writeFileSync(resolve(demoDir, "odb-symbol-gallery.tgz"), galleryTgz);
console.log(`demo/odb-symbol-gallery.tgz ${galleryTgz.length} bytes, ${Object.keys(gallery.files).length} files`);

/** Minimal deterministic ZIP writer (deflate, fixed DOS timestamp). */
function writeZip(entries) {
  const encoder = new TextEncoder();
  const DOS_TIME = 0;
  const DOS_DATE = 0x2821; // 2000-01-01
  const DOS_ATTR_DIRECTORY = 0x10;
  const DOS_ATTR_ARCHIVE = 0x20;

  // Emit an explicit entry for every directory as well: a few archivers only
  // show a tree when the directory entries are present.
  const directories = new Set();
  for (const path of Object.keys(entries)) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      directories.add(`${segments.slice(0, index).join("/")}/`);
    }
  }
  const members = [
    ...[...directories].sort().map((path) => ({ path, data: new Uint8Array(0), isDirectory: true })),
    ...Object.entries(entries).map(([path, content]) => ({
      path,
      data: toBytes(content),
      isDirectory: false,
    })),
  ];

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const member of members) {
    const { data, isDirectory } = member;
    const compressed = isDirectory
      ? new Uint8Array(0)
      : new Uint8Array(deflateRawSync(data, { level: 9 }));
    const method = isDirectory ? 0 : 8;
    const name = encoder.encode(member.path);
    const crc = isDirectory ? 0 : crc32(data);

    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, method, true);
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, compressed.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true); // extra length
    local.set(name, 30);
    localParts.push(local, compressed);

    const central = new Uint8Array(46 + name.length);
    const cview = new DataView(central.buffer);
    cview.setUint32(0, 0x02014b50, true);
    cview.setUint16(4, 20, true); // version made by (MS-DOS, spec 2.0)
    cview.setUint16(6, 20, true); // version needed
    cview.setUint16(8, 0, true); // flags
    cview.setUint16(10, method, true);
    cview.setUint16(12, DOS_TIME, true);
    cview.setUint16(14, DOS_DATE, true);
    cview.setUint32(16, crc, true);
    cview.setUint32(20, compressed.length, true);
    cview.setUint32(24, data.length, true);
    cview.setUint16(28, name.length, true);
    cview.setUint16(30, 0, true); // extra length
    cview.setUint16(32, 0, true); // comment length
    cview.setUint16(34, 0, true); // disk number
    cview.setUint16(36, 0, true); // internal attributes
    cview.setUint32(38, isDirectory ? DOS_ATTR_DIRECTORY : DOS_ATTR_ARCHIVE, true);
    cview.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true);
  eview.setUint16(8, centralParts.length, true);
  eview.setUint16(10, centralParts.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
