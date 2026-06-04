#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { createNodeGerberRenderer, fileLayer } from "../node.js";

const USAGE = `Usage:
  gerber-renderer <input.gbr|input.tar.gz...> [options]

Options:
  -o, --output <path>              PNG output path (required for multiple inputs)
  --width <px>                     Output width (default: 1200)
  --height <px>                    Output height (default: 800)
  --padding <px>                   Fit padding in pixels (default: 0)
  --background <color>             Background color, e.g. #05070c (default: transparent)
  --alpha <0-1>                    Global layer alpha (default: 0.7)
  --minimum-feature-pixels <px>    Minimum line/arc display width (default: 1)
  --max-render-target-bytes <size> Per-render target memory cap, e.g. 2g, 512m
  --approx-region-arcs             Approximate region arcs before rendering (default: false)
  --arc-quality <0|1|2>            Approx arc quality: low, normal, high (default: 1)
  --flip-x                         Mirror the output horizontally
  --flip-y                         Mirror the output vertically
  --no-drill                       Skip NC drill layers
  --no-fit                         Use identity view instead of fit view (default: fit enabled)
  --skill                          Print AI usage notes
  -h, --help                       Show this help

AI guide: run \`gerber-renderer --skill\` for usage notes.
`;

const TAR_GZ_EXTENSIONS = [".tar.gz", ".tgz"];
const GENERIC_GERBER_EXTENSIONS = [".art", ".gbr", ".gdo", ".ger", ".pho"];
const SKILL_URL = new URL("../SKILL.md", import.meta.url);

async function main() {
  const { inputs, output, frameOptions, showSkill } = parseArgs(
    process.argv.slice(2),
  );
  if (showSkill) {
    process.stdout.write(await readFile(SKILL_URL, "utf8"));
    return;
  }

  if (inputs.length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const outputPath = output || inferOutputPath(inputs);

  const layers = await collectInputLayers(inputs);
  if (layers.length === 0) {
    throw new Error("No Gerber layers found in input files.");
  }

  const skippedLayers = [];
  frameOptions.onLayerError = ({ name, error }) => {
    skippedLayers.push(name);
    process.stderr.write(`Skipped ${name}: ${errorMessage(error)}\n`);
  };
  const renderer = await createNodeGerberRenderer();
  let renderResult = { renderedCount: 0, failures: [] };
  try {
    await renderer.withFrame(frameOptions, async () => {
      renderResult = await renderer.renderLayers(layers, frameOptions);
    });
    await renderer.exportPngFile(outputPath, { background: frameOptions.background });
  } finally {
    renderer.dispose();
  }
  process.stdout.write(
    `Rendered ${renderResult.renderedCount}/${layers.length} layer(s) to ${outputPath}\n`,
  );
}

function parseArgs(args) {
  const inputs = [];
  const frameOptions = {};
  let output = "";
  let showSkill = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === "--skill") {
      showSkill = true;
    } else if (arg === "-o" || arg === "--output") {
      output = readOptionValue(args, ++index, arg);
    } else if (arg === "--width") {
      frameOptions.width = readPositiveInteger(args, ++index, arg);
    } else if (arg === "--height") {
      frameOptions.height = readPositiveInteger(args, ++index, arg);
    } else if (arg === "--padding") {
      frameOptions.padding = readNumber(args, ++index, arg);
    } else if (arg === "--background") {
      frameOptions.background = readOptionValue(args, ++index, arg);
    } else if (arg === "--alpha") {
      frameOptions.globalAlpha = readNumber(args, ++index, arg);
    } else if (arg === "--minimum-feature-pixels") {
      frameOptions.minimumFeaturePixels = readNumber(args, ++index, arg);
    } else if (arg === "--max-render-target-bytes") {
      frameOptions.maxRenderTargetBytes = readByteSize(args, ++index, arg);
    } else if (arg === "--approx-region-arcs") {
      frameOptions.preserveArcRegions = false;
    } else if (arg === "--arc-quality") {
      frameOptions.arcTessellationQuality = readNonNegativeInteger(args, ++index, arg);
    } else if (arg === "--flip-x") {
      frameOptions.flipX = true;
    } else if (arg === "--flip-y") {
      frameOptions.flipY = true;
    } else if (arg === "--no-drill") {
      frameOptions.renderDrills = false;
    } else if (arg === "--no-fit") {
      frameOptions.fit = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }

  return { inputs, output, frameOptions, showSkill };
}

function inferOutputPath(inputs) {
  if (inputs.length !== 1) {
    throw new Error("Multiple inputs require --output.");
  }

  const input = inputs[0];
  const lowerInput = input.toLowerCase();
  const archiveExtension = TAR_GZ_EXTENSIONS.find((extension) =>
    lowerInput.endsWith(extension),
  );
  if (archiveExtension) {
    return `${input.slice(0, -archiveExtension.length)}.png`;
  }

  const dotIndex = input.lastIndexOf(".");
  if (dotIndex < 0) {
    return `${input}.png`;
  }

  const extension = input.slice(dotIndex).toLowerCase();
  if (GENERIC_GERBER_EXTENSIONS.includes(extension)) {
    return `${input.slice(0, dotIndex)}.png`;
  }

  return `${input}.png`;
}

function readOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function readPositiveInteger(args, index, option) {
  const value = Number(readOptionValue(args, index, option));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return value;
}

function readNonNegativeInteger(args, index, option) {
  const value = Number(readOptionValue(args, index, option));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${option} requires a non-negative integer.`);
  }
  return value;
}

function readNumber(args, index, option) {
  const value = Number(readOptionValue(args, index, option));
  if (!Number.isFinite(value)) {
    throw new Error(`${option} requires a finite number.`);
  }
  return value;
}

function readByteSize(args, index, option) {
  const rawValue = readOptionValue(args, index, option).trim();
  const match = rawValue.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?|bytes?)?$/i);
  if (!match) {
    throw new Error(`${option} requires a byte size such as 2147483648, 512m, or 2g.`);
  }

  const value = Number(match[1]);
  const unit = (match[2] || "b").toLowerCase();
  const multipliers = {
    b: 1,
    byte: 1,
    bytes: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  const multiplier = multipliers[unit];
  const bytes = value * multiplier;
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isSafeInteger(Math.round(bytes))) {
    throw new Error(`${option} requires a positive safe byte size.`);
  }
  return Math.round(bytes);
}

async function collectInputLayers(inputs) {
  const layers = [];

  for (const input of inputs) {
    if (isTarGzPath(input)) {
      const archiveLayers = await readTarGzLayers(input);
      if (archiveLayers.length === 0) {
        process.stderr.write(`Skipped ${input}: no regular files found in archive\n`);
      }
      layers.push(...archiveLayers);
    } else {
      layers.push(fileLayer(input, { name: basename(input) }));
    }
  }

  return layers;
}

async function readTarGzLayers(path) {
  const archive = gunzipSync(await readFile(path));
  const layers = [];
  let offset = 0;
  let nextLongName = null;
  let nextPaxHeaders = null;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;

    const size = readTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 0);
    const name = nextLongName || nextPaxHeaders?.path || readTarPath(header);
    nextLongName = null;
    nextPaxHeaders = null;

    offset += 512;
    const data = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === "L") {
      nextLongName = trimNulls(data.toString("utf8"));
      continue;
    }
    if (typeFlag === "x") {
      nextPaxHeaders = readPaxHeaders(data);
      continue;
    }
    if (typeFlag === "g" || (typeFlag !== "0" && typeFlag !== "\0")) {
      continue;
    }

    const entryPath = normalizeArchivePath(name);
    if (entryPath && !isArchiveMetadataPath(entryPath)) {
      layers.push({
        source: data.toString("utf8"),
        name: `${basename(path)}:${entryPath}`,
      });
    }
  }

  return layers;
}

function isTarGzPath(path) {
  const lowerPath = path.toLowerCase();
  return TAR_GZ_EXTENSIONS.some((extension) => lowerPath.endsWith(extension));
}

function isArchiveMetadataPath(path) {
  const normalizedPath = normalizeArchivePath(path);
  const fileName = normalizedPath.split("/").pop() ?? normalizedPath;
  return normalizedPath.startsWith("__MACOSX/") || fileName.startsWith("._");
}

function readTarPath(header) {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarString(buffer, start, length) {
  return trimNulls(buffer.subarray(start, start + length).toString("utf8"));
}

function readTarOctal(buffer, start, length) {
  const value = readTarString(buffer, start, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function readPaxHeaders(data) {
  const headers = {};
  let offset = 0;

  while (offset < data.length) {
    const spaceIndex = data.indexOf(0x20, offset);
    if (spaceIndex < 0) break;

    const recordLength = Number.parseInt(
      data.subarray(offset, spaceIndex).toString("ascii"),
      10,
    );
    if (!Number.isFinite(recordLength) || recordLength <= 0) break;

    const record = data
      .subarray(spaceIndex + 1, offset + recordLength - 1)
      .toString("utf8");
    const equalsIndex = record.indexOf("=");
    if (equalsIndex > 0) {
      headers[record.slice(0, equalsIndex)] = record.slice(equalsIndex + 1);
    }
    offset += recordLength;
  }

  return headers;
}

function normalizeArchivePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function trimNulls(value) {
  const nullIndex = value.indexOf("\0");
  return nullIndex >= 0 ? value.slice(0, nullIndex) : value;
}

function isZeroBlock(buffer) {
  return buffer.every((byte) => byte === 0);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
