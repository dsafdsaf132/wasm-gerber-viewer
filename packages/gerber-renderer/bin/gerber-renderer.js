#!/usr/bin/env node
import { basename } from "node:path";
import { fileLayer, renderGerberToPngFile } from "../node.js";

const USAGE = `Usage:
  gerber-renderer <input.gbr...> -o <output.png> [options]

Options:
  -o, --output <path>              PNG output path
  --width <px>                     Output width (default: 1200)
  --height <px>                    Output height (default: 800)
  --padding <px>                   Fit padding in pixels
  --background <color>             Background color, e.g. #05070c
  --alpha <0-1>                    Global alpha
  --minimum-feature-pixels <px>    Minimum line/arc display width
  --approx-region-arcs             Approximate region arcs before rendering
  --arc-quality <0|1|2>            Approx arc quality
  --no-fit                         Use identity view instead of fit view
  -h, --help                       Show this help
`;

async function main() {
  const { inputs, output, frameOptions } = parseArgs(process.argv.slice(2));
  if (inputs.length === 0 || !output) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const layers = inputs.map((path) => fileLayer(path, { name: basename(path) }));
  await renderGerberToPngFile(output, layers, frameOptions);
  process.stdout.write(`Rendered ${inputs.length} layer(s) to ${output}\n`);
}

function parseArgs(args) {
  const inputs = [];
  const frameOptions = {};
  let output = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
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
    } else if (arg === "--approx-region-arcs") {
      frameOptions.preserveArcRegions = false;
    } else if (arg === "--arc-quality") {
      frameOptions.arcTessellationQuality = readNonNegativeInteger(args, ++index, arg);
    } else if (arg === "--no-fit") {
      frameOptions.fit = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }

  return { inputs, output, frameOptions };
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
