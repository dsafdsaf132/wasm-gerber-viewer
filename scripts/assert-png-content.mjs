#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const [
  ,
  ,
  filePath,
  backgroundArg,
  minimumArg = "100",
  expectedWidthArg,
  expectedHeightArg,
] = process.argv;
if (!filePath || !backgroundArg) {
  throw new Error(
    "Usage: node scripts/assert-png-content.mjs <file> <#rrggbb|transparent> [minimum-pixels] [expected-width expected-height]",
  );
}

const minimumPixels = Number(minimumArg);
if (!Number.isSafeInteger(minimumPixels) || minimumPixels < 1) {
  throw new Error(`Invalid minimum pixel count: ${minimumArg}`);
}
const expectedWidth = parseExpectedDimension(expectedWidthArg, "width");
const expectedHeight = parseExpectedDimension(expectedHeightArg, "height");
if ((expectedWidth == null) !== (expectedHeight == null)) {
  throw new Error("Expected width and height must be provided together");
}

const png = await readFile(filePath);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
if (!png.subarray(0, signature.length).equals(signature)) {
  throw new Error(`${filePath} is not a PNG file`);
}

let width = 0;
let height = 0;
let bitDepth = 0;
let colorType = -1;
let interlace = -1;
const idatChunks = [];
let offset = signature.length;
while (offset + 12 <= png.length) {
  const length = png.readUInt32BE(offset);
  const dataStart = offset + 8;
  const dataEnd = dataStart + length;
  if (dataEnd + 4 > png.length) {
    throw new Error(`${filePath} contains a truncated PNG chunk`);
  }
  const type = png.toString("ascii", offset + 4, dataStart);
  const data = png.subarray(dataStart, dataEnd);
  if (type === "IHDR") {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    bitDepth = data[8];
    colorType = data[9];
    interlace = data[12];
  } else if (type === "IDAT") {
    idatChunks.push(data);
  } else if (type === "IEND") {
    break;
  }
  offset = dataEnd + 4;
}

if (width < 1 || height < 1 || bitDepth !== 8 || interlace !== 0) {
  throw new Error(`${filePath} uses an unsupported PNG layout`);
}
if (
  expectedWidth != null &&
  (width !== expectedWidth || height !== expectedHeight)
) {
  throw new Error(
    `${filePath} is ${width}x${height}; expected ${expectedWidth}x${expectedHeight}`,
  );
}
const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
if (channels === 0) {
  throw new Error(`${filePath} uses unsupported PNG color type ${colorType}`);
}

const stride = width * channels;
const filtered = inflateSync(Buffer.concat(idatChunks));
if (filtered.length !== (stride + 1) * height) {
  throw new Error(`${filePath} has an unexpected decoded byte length`);
}

const background = parseBackground(backgroundArg);
let previous = Buffer.alloc(stride);
let foregroundPixels = 0;
for (let y = 0; y < height; y += 1) {
  const rowStart = y * (stride + 1);
  const filter = filtered[rowStart];
  const current = Buffer.allocUnsafe(stride);
  for (let index = 0; index < stride; index += 1) {
    const source = filtered[rowStart + 1 + index];
    const left = index >= channels ? current[index - channels] : 0;
    const above = previous[index];
    const upperLeft = index >= channels ? previous[index - channels] : 0;
    current[index] = (source + filterPredictor(filter, left, above, upperLeft)) & 0xff;
  }

  for (let x = 0; x < width; x += 1) {
    const pixel = x * channels;
    const alpha = channels === 4 ? current[pixel + 3] : 255;
    const differs = background == null
      ? alpha > 0
      : [0, 1, 2].some((channel) => {
          const value = channels === 4
            ? compositeChannel(current[pixel + channel], alpha, background[channel])
            : current[pixel + channel];
          return value !== background[channel];
        });
    if (differs) foregroundPixels += 1;
  }
  previous = current;
}

if (foregroundPixels < minimumPixels) {
  throw new Error(
    `${filePath} is effectively blank: ${foregroundPixels} foreground pixels, expected at least ${minimumPixels}`,
  );
}

console.log(
  `${filePath}: ${width}x${height}, ${foregroundPixels} foreground pixels, ${png.length} bytes`,
);

function parseBackground(value) {
  if (value === "transparent") return null;
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`Invalid background color: ${value}`);
  const hex = match[1];
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function parseExpectedDimension(value, name) {
  if (value == null) return null;
  const dimension = Number(value);
  if (!Number.isSafeInteger(dimension) || dimension < 1) {
    throw new Error(`Invalid expected ${name}: ${value}`);
  }
  return dimension;
}

function compositeChannel(foreground, alpha, background) {
  return Math.round((foreground * alpha + background * (255 - alpha)) / 255);
}

function filterPredictor(filter, left, above, upperLeft) {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return above;
    case 3:
      return Math.floor((left + above) / 2);
    case 4:
      return paeth(left, above, upperLeft);
    default:
      throw new Error(`Unsupported PNG row filter ${filter}`);
  }
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}
