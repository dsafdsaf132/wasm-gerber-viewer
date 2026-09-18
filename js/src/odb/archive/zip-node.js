import { inflateRawSync } from "node:zlib";

import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_FILE_SIZE_BYTES,
  MAX_ODB_ARCHIVE_ENTRY_COUNT,
  isArchiveMetadataPath,
} from "../config.js";
import { JobTree } from "./job-tree.js";
import { normalizeArchivePath } from "./tar.js";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_FILE = 0x02014b50;
const LOCAL_FILE = 0x04034b50;
const ZIP_COMMENT_MAX_BYTES = 0xffff;
const FLAG_ENCRYPTED = 1;

/**
 * Create an ODB++ job tree from a Node ZIP buffer. ZIP entries are inflated
 * lazily, while the central directory is validated before any path is exposed.
 * ZIP64 and encrypted entries are rejected rather than partially interpreted.
 */
export function createNodeZipJobTree(bytes, { archiveName = "archive.zip", ...options } = {}) {
  const data = toUint8Array(bytes);
  const endOffset = findEndOfCentralDirectory(data, archiveName);
  const diskNumber = readU16(data, endOffset + 4, archiveName);
  const centralDisk = readU16(data, endOffset + 6, archiveName);
  const entryCountOnDisk = readU16(data, endOffset + 8, archiveName);
  const entryCount = readU16(data, endOffset + 10, archiveName);
  const centralSize = readU32(data, endOffset + 12, archiveName);
  const centralOffset = readU32(data, endOffset + 16, archiveName);
  if (diskNumber !== 0 || centralDisk !== 0 || entryCountOnDisk !== entryCount) {
    throw new Error(`${archiveName} is a multi-disk ZIP archive, which is unsupported`);
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error(`${archiveName} uses ZIP64, which is unsupported`);
  }
  if (entryCount > MAX_ODB_ARCHIVE_ENTRY_COUNT) {
    throw new RangeError(
      `${archiveName} contains more than the ${MAX_ODB_ARCHIVE_ENTRY_COUNT}-entry limit`,
    );
  }
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralEnd > data.length) {
    throw new Error(`${archiveName} has a truncated central directory`);
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(data, offset, archiveName) !== CENTRAL_DIRECTORY_FILE) {
      throw new Error(`${archiveName} has an invalid central-directory entry`);
    }
    const flags = readU16(data, offset + 8, archiveName);
    const method = readU16(data, offset + 10, archiveName);
    const crc = readU32(data, offset + 16, archiveName);
    const compressedSize = readU32(data, offset + 20, archiveName);
    const uncompressedSize = readU32(data, offset + 24, archiveName);
    const nameLength = readU16(data, offset + 28, archiveName);
    const extraLength = readU16(data, offset + 30, archiveName);
    const commentLength = readU16(data, offset + 32, archiveName);
    const localOffset = readU32(data, offset + 42, archiveName);
    const headerEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (!Number.isSafeInteger(headerEnd) || headerEnd > centralEnd) {
      throw new Error(`${archiveName} has a truncated central-directory entry`);
    }
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new Error(`${archiveName} contains an encrypted ZIP entry`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`${archiveName} uses unsupported ZIP compression method ${method}`);
    }
    if (uncompressedSize > MAX_FILE_SIZE_BYTES) {
      throw new RangeError(
        `${archiveName} ZIP entry ${index + 1} exceeds the ${MAX_FILE_SIZE_BYTES}-byte per-file limit`,
      );
    }
    if (
      compressedSize > 0 &&
      uncompressedSize / compressedSize > MAX_ARCHIVE_COMPRESSION_RATIO
    ) {
      throw new RangeError(
        `${archiveName} ZIP entry ${index + 1} exceeds the supported compression ratio of ${MAX_ARCHIVE_COMPRESSION_RATIO}:1`,
      );
    }
    if (compressedSize === 0 && uncompressedSize > 0) {
      throw new Error(`${archiveName} ZIP entry ${index + 1} has an invalid compressed size`);
    }

    const path = decodePath(data.subarray(offset + 46, offset + 46 + nameLength));
    offset = headerEnd;
    if (path.endsWith("/")) continue;
    const normalizedPath = validateEntryPath(path, archiveName, index + 1);
    if (!normalizedPath || isArchiveMetadataPath(normalizedPath)) continue;
    entries.push({
      path: normalizedPath,
      sizeBytes: uncompressedSize,
      readBytes: () => readZipEntry(
        data,
        localOffset,
        compressedSize,
        uncompressedSize,
        method,
        crc,
        archiveName,
      ),
    });
  }
  if (offset !== centralEnd) {
    throw new Error(`${archiveName} has trailing central-directory data`);
  }
  return new JobTree(entries, options);
}

function findEndOfCentralDirectory(data, archiveName) {
  const start = Math.max(0, data.length - (ZIP_COMMENT_MAX_BYTES + 22));
  for (let offset = data.length - 22; offset >= start; offset -= 1) {
    if (readU32(data, offset, archiveName, false) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error(`${archiveName} is not a ZIP archive (end record not found)`);
}

function readZipEntry(
  data,
  localOffset,
  compressedSize,
  uncompressedSize,
  method,
  expectedCrc,
  archiveName,
) {
  if (readU32(data, localOffset, archiveName) !== LOCAL_FILE) {
    throw new Error(`${archiveName} has an invalid local ZIP entry`);
  }
  const nameLength = readU16(data, localOffset + 26, archiveName);
  const extraLength = readU16(data, localOffset + 28, archiveName);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (!Number.isSafeInteger(end) || end > data.length) {
    throw new Error(`${archiveName} has a truncated local ZIP entry`);
  }
  const input = data.subarray(start, end);
  let output;
  if (method === 0) {
    output = input;
  } else {
    try {
      output = new Uint8Array(
        inflateRawSync(input, { maxOutputLength: uncompressedSize }),
      );
    } catch (error) {
      throw new Error(`${archiveName} has an invalid deflate ZIP entry: ${errorMessage(error)}`);
    }
  }
  if (output.byteLength !== uncompressedSize) {
    throw new Error(`${archiveName} ZIP entry size does not match its central directory`);
  }
  if (crc32(output) !== expectedCrc) {
    throw new Error(`${archiveName} ZIP entry CRC does not match its central directory`);
  }
  return output;
}

function validateEntryPath(path, archiveName, index) {
  if (path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`${archiveName} ZIP entry ${index} has an unsafe path`);
  }
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${archiveName} ZIP entry ${index} has an unsafe path`);
  }
  return normalizeArchivePath(path);
}

function decodePath(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function readU16(data, offset, archiveName, required = true) {
  if (offset < 0 || offset + 2 > data.length) {
    if (!required) return null;
    throw new Error(`${archiveName} is truncated`);
  }
  return data[offset] | (data[offset + 1] << 8);
}

function readU32(data, offset, archiveName, required = true) {
  if (offset < 0 || offset + 4 > data.length) {
    if (!required) return null;
    throw new Error(`${archiveName} is truncated`);
  }
  return (
    data[offset] +
    data[offset + 1] * 0x100 +
    data[offset + 2] * 0x10000 +
    data[offset + 3] * 0x1000000
  );
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("ZIP input must be an ArrayBuffer or Uint8Array.");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

let crcTable = null;

function crc32(bytes) {
  const table = crcTable ??= createCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

