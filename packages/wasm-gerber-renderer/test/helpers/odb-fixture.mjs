// Builds small in-memory ODB++ jobs as TAR (optionally gzip) archives for
// tests and for the committed demo sample.
import { deflateRawSync, gzipSync } from "node:zlib";

import { compressLzw } from "./lzw-encoder.mjs";

const encoder = new TextEncoder();

export function toBytes(content) {
  return content instanceof Uint8Array ? content : encoder.encode(String(content));
}

/**
 * Write a ustar TAR archive. `files` maps paths to string/Uint8Array content;
 * directories are implied. `mtime` is fixed so output is deterministic.
 */
export function writeTar(files, { mtime = 1_700_000_000 } = {}) {
  const blocks = [];
  for (const [path, content] of Object.entries(files)) {
    const bytes = toBytes(content);
    blocks.push(tarHeader(path, bytes.length, mtime));
    blocks.push(bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  return concat(blocks);
}

export function writeTgz(files, options = {}) {
  return new Uint8Array(gzipSync(writeTar(files, options), { level: 9, mtime: 0 }));
}

export function writeZip(files, { compress = true } = {}) {
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
    central.writeUInt32LE(crc32(data), 16);
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

function tarHeader(path, size, mtime) {
  const header = new Uint8Array(512);
  let name = path;
  let prefix = "";
  if (name.length > 100) {
    const split = name.lastIndexOf("/", 154);
    if (split <= 0 || name.length - split - 1 > 100) {
      throw new RangeError(`TAR path too long for ustar: ${path}`);
    }
    prefix = name.slice(0, split);
    name = name.slice(split + 1);
  }
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, "0000644\0");
  writeField(header, 108, 8, "0000000\0");
  writeField(header, 116, 8, "0000000\0");
  writeField(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeField(header, 136, 12, `${mtime.toString(8).padStart(11, "0")}\0`);
  writeField(header, 148, 8, "        ");
  header[156] = "0".charCodeAt(0);
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  writeField(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeField(block, offset, length, value) {
  const bytes = encoder.encode(value).subarray(0, length);
  block.set(bytes, offset);
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Helpers for authoring features files in tests. */
export function matrixFile({ steps = ["pcb"], layers = [] } = {}) {
  const lines = [];
  steps.forEach((name, index) => {
    lines.push("STEP {", `    COL=${index + 1}`, `    NAME=${name}`, "}", "");
  });
  layers.forEach((layer, index) => {
    lines.push(
      "LAYER {",
      `    ROW=${index + 1}`,
      `    CONTEXT=${layer.context ?? "BOARD"}`,
      `    TYPE=${layer.type}`,
      `    NAME=${layer.name}`,
      `    POLARITY=${layer.polarity ?? "POSITIVE"}`,
      `    START_NAME=${layer.startName ?? ""}`,
      `    END_NAME=${layer.endName ?? ""}`,
      "    OLD_NAME=",
      "}",
      "",
    );
  });
  return lines.join("\n");
}

export function featuresFile({ units = null, symbols = [], records = [] } = {}) {
  const lines = [];
  if (units) lines.push(`UNITS=${units}`);
  lines.push("#", "#Feature symbol names", "#");
  symbols.forEach((name, index) => lines.push(`$${index} ${name}`));
  lines.push("#", "#Layer features", "#");
  lines.push(...records);
  return `${lines.join("\n")}\n`;
}

export function toolsFile(tools, { units = null } = {}) {
  const lines = [];
  if (units) lines.push(`UNITS=${units}`);
  lines.push("THICKNESS=0", "USER_PARAMS=", "");
  tools.forEach((tool, index) => {
    lines.push(
      "TOOLS {",
      `    NUM=${index + 1}`,
      `    TYPE=${tool.type ?? "PLATED"}`,
      "    MIN_TOL=0",
      "    MAX_TOL=0",
      "    BIT=",
      `    FINISH_SIZE=${tool.size}`,
      `    DRILL_SIZE=${tool.size}`,
      "}",
      "",
    );
  });
  return lines.join("\n");
}

/**
 * A representative synthetic job (metric) covering every emitter path. Used
 * by both the unit tests and `scripts/generate-odb-sample.mjs`.
 *
 * `includeDiagnosticCases` adds the things the importer reports rather than
 * draws (non-board layers and a text record) so tests can check those
 * diagnostics; the committed demo leaves them out and loads without warnings.
 */
export function buildSampleJobFiles({
  root = "demo_board",
  compressTopLayer = true,
  includeDiagnosticCases = false,
} = {}) {
  const px = (value) => value.toFixed(3);
  const layers = [
    ...(includeDiagnosticCases ? [{ type: "COMPONENT", name: "COMP_+_TOP" }] : []),
    { type: "SILK_SCREEN", name: "SST" },
    { type: "SOLDER_PASTE", name: "SPT" },
    { type: "SOLDER_MASK", name: "SMT" },
    { type: "SIGNAL", name: "TOP" },
    { type: "SIGNAL", name: "BOTTOM" },
    { type: "SOLDER_MASK", name: "SMB" },
    { type: "DRILL", name: "DRILL", startName: "TOP", endName: "BOTTOM" },
    { type: "ROUT", name: "ROUT", startName: "TOP", endName: "BOTTOM" },
    ...(includeDiagnosticCases ? [{ type: "DOCUMENT", name: "ASSEMBLY_NOTES", context: "MISC" }] : []),
  ];

  // Board layout (mm, origin bottom-left, 40 x 30 with one rounded corner):
  //   y=26  ten through-hole pads, one per standard symbol family, with vias
  //   y=22  SMD rectangles showing every orient form (0..7, 8/9 <angle>)
  //   y=18  resized pad, square donut, negative pad, triangle
  //   y=12..14  traces, arcs and a full circle
  //   y=4..10   two copper surfaces, the left one with a hole and an arc edge
  //   mounting holes at (3.5, 16) and (36.5, 16); silk frame 2.5 mm inside the
  //   profile; rout path 1 mm inside the profile with a 2 mm tool.
  //   User-defined symbols: `fiducial` (inch units, dot + ring) at (36, 26) and
  //   (36, 6) on TOP, and `logo` on SST at (34, 19), which nests `arrow`.
  // Islands are clockwise and holes counter-clockwise as the spec requires.
  // Coordinates in mm, symbol dimensions in microns.
  const topSymbols = [
    "r600", // 0 round 0.6
    "s800", // 1 square 0.8
    "rect1400x800", // 2 rectangle
    "rect1400x800xr250", // 3 rounded rectangle
    "rect1400x800xc250x13", // 4 chamfered, corners 1 and 3
    "oval1600x800", // 5 oval
    "di1000x1000", // 6 diamond
    "oct1000x1000x250", // 7 octagon
    "donut_r1200x600", // 8 round donut
    "thr1600x1000x45x4x300", // 9 thermal
    "r200", // 10 trace pen
    "s300", // 11 square pen
    "hex_l1000x800x200", // 12 hexagon
    "el1200x800", // 13 ellipse
    "tri1000x800", // 14 triangle
    "donut_s1200x600", // 15 square donut
    "fiducial", // 16 user-defined symbol
  ];
  // The SMD row keeps the same orient values on paste and mask so the
  // openings follow the copper.
  const smdRow = [
    ["4", "0 1"],
    ["7", "0 2"],
    ["10", "0 3"],
    ["13", "0 4"],
    ["16", "0 5"],
    ["19", "0 8 30"],
    ["22", "0 9 30"],
    ["25", "0 8 60"],
    ["28", "0 8 45"],
    ["31", "0 0"],
    ["34", "0 0"],
  ];
  const topRecords = [
    // pads across the top edge: sym index = column
    ...topSymbols.slice(0, 10).map((_, i) => `P ${px(4 + i * 3)} 26 ${i} P 0 0`),
    // SMD row: rectangles show every orient form, then hexagon and ellipse
    ...smdRow.map(([x, orient], i) => `P ${x} 22 ${[2, 2, 2, 4, 4, 4, 4, 3, 5, 12, 13][i]} P ${orient}`),
    // resized pad and a negative pad
    "P 4 18 -1 0 200 P 0 0",
    "P 7 18 15 P 0 0",
    "P 7 18 0 N 0 0",
    "P 10 18 14 P 0 0",
    // round traces and a square-ended trace
    "L 4 14 20 14 10 P 0",
    "L 4 12 20 12 11 P 0",
    "L 22 12 22 12 11 P 0",
    // arcs: ccw quarter, cw quarter, full circle
    "A 24 12 26 14 24 14 10 P 0 N",
    "A 28 12 30 14 30 12 10 P 0 Y",
    "A 33 14 33 14 34 14 10 P 0 N",
    // surface: clockwise island with a counter-clockwise hole and one arc edge
    "S P 0",
    "OB 4 4 I",
    "OS 4 10",
    "OS 18 10",
    "OC 20 8 18 8 Y",
    "OS 20 4",
    "OS 4 4",
    "OE",
    "OB 8 6 H",
    "OS 12 6",
    "OS 12 8",
    "OS 8 8",
    "OS 8 6",
    "OE",
    "SE",
    // second surface, a plain clockwise island
    "S P 0",
    "OB 24 4 I",
    "OS 24 9",
    "OS 34 9",
    "OS 34 4",
    "OS 24 4",
    "OE",
    "SE",
    // fiducials drawn with a user-defined symbol
    "P 36 26 16 P 0 0",
    "P 36 6 16 P 0 0",
    // text is not rendered yet
    ...(includeDiagnosticCases ? ["T 4 1 standard P 0 1 1 1 'ODB++ SAMPLE' 1"] : []),
  ];
  const topFeatures = featuresFile({ units: "MM", symbols: topSymbols, records: topRecords });

  const bottomFeatures = featuresFile({
    units: "MM",
    symbols: ["r600", "r200", "rect1400x800"],
    records: [
      ...Array.from({ length: 10 }, (_, i) => `P ${px(4 + i * 3)} 26 0 P 0 0`),
      "L 4 8 34 8 1 P 0",
      "P 22 6 2 P 0 8 90",
    ],
  });
  const maskFeatures = (extra) =>
    featuresFile({
      units: "MM",
      symbols: ["r800", "rect1600x1000", "r2600"],
      records: [
        ...Array.from({ length: 10 }, (_, i) => `P ${px(4 + i * 3)} 26 0 P 0 0`),
        ...extra,
      ],
    });
  // Silk: a frame 2.5 mm inside the profile whose corner is concentric with
  // the profile arc, plus a logo built from user-defined symbols.
  const silkFeatures = featuresFile({
    units: "MM",
    symbols: ["r150", "logo"],
    records: [
      "L 2.5 27.5 37.5 27.5 0 P 0",
      "L 2.5 27.5 2.5 2.5 0 P 0",
      "L 2.5 2.5 36 2.5 0 P 0",
      "A 36 2.5 37.5 4 36 4 0 P 0 N",
      "L 37.5 4 37.5 27.5 0 P 0",
      "P 34 19 1 P 0 0",
    ],
  });
  // User-defined symbols. `fiducial` has no UNITS line, so like most real
  // symbol files it is in inches with symbol sizes in mils.
  const fiducialSymbol = featuresFile({
    symbols: ["r39.37", "r5.906"],
    records: ["P 0 0 0 P 0 0", "A 0.03937 0 0.03937 0 0 0 1 P 0 Y"],
  });
  const arrowSymbol = featuresFile({
    units: "MM",
    symbols: ["r150"],
    records: ["L -0.6 0 0.6 0 0 P 0", "L 0.6 0 0.2 0.35 0 P 0", "L 0.6 0 0.2 -0.35 0 P 0"],
  });
  const logoSymbol = featuresFile({
    units: "MM",
    symbols: ["arrow", "r150"],
    records: [
      "P -0.9 0 0 P 0 0",
      "P 0.9 0 0 P 0 2",
      "L -1.7 0.7 1.7 0.7 1 P 0",
      "L -1.7 -0.7 1.7 -0.7 1 P 0",
    ],
  });
  const pasteFeatures = featuresFile({
    units: "MM",
    symbols: ["rect1200x600"],
    records: smdRow.map(([x, orient]) => `P ${x} 22 0 P ${orient}`),
  });
  const drillFeatures = featuresFile({
    units: "MM",
    symbols: ["r300", "r1000", "r600"],
    records: [
      ...Array.from({ length: 10 }, (_, i) => `P ${px(4 + i * 3)} 26 0 P 1 0`),
      "P 3.5 16 1 P 2 0",
      "P 36.5 16 1 P 2 0",
      "L 20 16 24 16 2 P 3 0",
    ],
  });
  const drillTools = toolsFile(
    [
      { type: "VIA", size: 300 },
      { type: "NON_PLATED", size: 1000 },
      { type: "PLATED", size: 600 },
    ],
    { units: "MM" },
  );
  // Rout: tool center 1 mm inside the profile so the 2 mm cut ends exactly
  // at the board edge; the corner arc is concentric with the profile arc.
  const routFeatures = featuresFile({
    units: "MM",
    symbols: ["r2000"],
    records: [
      "L 1 1 36 1 0 P 1 0",
      "A 36 1 39 4 36 4 0 P 1 0 N",
      "L 39 4 39 29 0 P 1 0",
      "L 39 29 1 29 0 P 1 0",
      "L 1 29 1 1 0 P 1 0",
    ],
  });
  const routTools = toolsFile([{ type: "NON_PLATED", size: 2000 }], { units: "MM" });
  const profile = featuresFile({
    units: "MM",
    records: [
      "S P 0",
      "OB 0 0 I",
      "OS 0 30",
      "OS 40 30",
      "OS 40 4",
      "OC 36 0 36 4 Y",
      "OS 0 0",
      "OE",
      "SE",
    ],
  });
  const componentFeatures = featuresFile({ units: "MM", records: [] });
  const notesFeatures = featuresFile({
    units: "MM",
    symbols: ["r100"],
    records: ["L 0 -2 40 -2 0 P 0"],
  });

  const files = {
    [`${root}/misc/info`]: [
      "UNITS=MM",
      `JOB_NAME=${root}`,
      "ODB_VERSION_MAJOR=8",
      "ODB_VERSION_MINOR=1",
      "ODB_SOURCE=wasm-gerber-viewer sample generator",
      "",
    ].join("\n"),
    [`${root}/matrix/matrix`]: matrixFile({ steps: ["pcb"], layers }),
    [`${root}/steps/pcb/stephdr`]: "X_DATUM=0\nY_DATUM=0\nX_ORIGIN=0\nY_ORIGIN=0\n",
    [`${root}/steps/pcb/profile`]: profile,
    [`${root}/steps/pcb/layers/sst/features`]: silkFeatures,
    [`${root}/steps/pcb/layers/spt/features`]: pasteFeatures,
    [`${root}/steps/pcb/layers/smt/features`]: maskFeatures([
      ...smdRow.map(([x, orient]) => `P ${x} 22 1 P ${orient}`),
      "P 36 26 2 P 0 0",
      "P 36 6 2 P 0 0",
    ]),
    [`${root}/symbols/fiducial/features`]: fiducialSymbol,
    [`${root}/symbols/arrow/features`]: arrowSymbol,
    [`${root}/symbols/logo/features`]: logoSymbol,
    [`${root}/steps/pcb/layers/bottom/features`]: bottomFeatures,
    [`${root}/steps/pcb/layers/smb/features.gz`]: new Uint8Array(
      gzipSync(maskFeatures(["P 22 6 1 P 0 8 90"]), { level: 9, mtime: 0 }),
    ),
    [`${root}/steps/pcb/layers/drill/features`]: drillFeatures,
    [`${root}/steps/pcb/layers/drill/tools`]: drillTools,
    [`${root}/steps/pcb/layers/rout/features`]: routFeatures,
    [`${root}/steps/pcb/layers/rout/tools`]: routTools,
  };
  if (includeDiagnosticCases) {
    files[`${root}/steps/pcb/layers/comp_+_top/features`] = componentFeatures;
    files[`${root}/steps/pcb/layers/assembly_notes/features`] = notesFeatures;
  }
  if (compressTopLayer) {
    files[`${root}/steps/pcb/layers/top/features.Z`] = compressLzw(toBytes(topFeatures), {
      maxBits: 12,
    });
  } else {
    files[`${root}/steps/pcb/layers/top/features`] = topFeatures;
  }
  return { files, topFeatures };
}
