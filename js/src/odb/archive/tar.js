import {
  MAX_ODB_ARCHIVE_ENTRY_COUNT,
  MAX_ARCHIVE_METADATA_SIZE_BYTES,
  MAX_ARCHIVE_PATH_SIZE_BYTES,
  MAX_ARCHIVE_TOTAL_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  isArchiveMetadataPath,
} from "../config.js";

const BLOCK_SIZE = 512;
const REGULAR_TYPES = new Set(["0", "\0", "7"]);

/**
 * Parse a TAR archive into its regular-file entries.
 *
 * Mirrors the hardened reader used by the CLI: ustar checksum validation, GNU
 * long names (`L`), PAX extended headers (`x`/`g`), size/entry limits, path
 * normalization, and rejection of truncated entries. Reading stops at the
 * first zero block; callers may require an end marker or reject trailing data
 * when matching a stricter archive contract.
 */
export function parseTar(
  bytes,
  {
    archiveName = "archive",
    maxEntryCount = MAX_ODB_ARCHIVE_ENTRY_COUNT,
    requireEndMarker = false,
    rejectTrailingBytes = false,
  } = {},
) {
  const entries = [];
  let offset = 0;
  let entryCount = 0;
  let totalBytes = 0;
  let nextLongName = null;
  let nextPaxHeaders = null;
  let sawEndMarker = false;

  while (offset + BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) {
      // End-of-archive marker. Whatever follows (padding, a second marker,
      // trailing bytes) is not part of the archive and is not inspected.
      sawEndMarker = true;
      if (rejectTrailingBytes && !isZeroTail(bytes.subarray(offset))) {
        throw new Error(`${archiveName} contains non-zero data after its TAR end marker`);
      }
      break;
    }

    entryCount += 1;
    if (entryCount > maxEntryCount) {
      throw new RangeError(
        `${archiveName} contains more than ${maxEntryCount} TAR entries`,
      );
    }
    validateChecksum(header, archiveName, entryCount);

    const typeFlag = String.fromCharCode(header[156] || 0);
    const isExtensionHeader = typeFlag === "L" || typeFlag === "x" || typeFlag === "g";
    const headerSize = readSize(header, archiveName, entryCount);
    const size =
      !isExtensionHeader && nextPaxHeaders?.size != null
        ? nextPaxHeaders.size
        : headerSize;

    if (isExtensionHeader && size > MAX_ARCHIVE_METADATA_SIZE_BYTES) {
      throw new RangeError(
        `${archiveName} TAR entry ${entryCount} metadata exceeds ${MAX_ARCHIVE_METADATA_SIZE_BYTES} bytes`,
      );
    }
    if (REGULAR_TYPES.has(typeFlag) && size > MAX_FILE_SIZE_BYTES) {
      throw new RangeError(
        `${archiveName} TAR entry ${entryCount} is ${size} bytes; the per-file limit is ${MAX_FILE_SIZE_BYTES} bytes`,
      );
    }

    const dataOffset = offset + BLOCK_SIZE;
    const dataEnd = dataOffset + size;
    const nextOffset = dataOffset + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (
      !Number.isSafeInteger(dataEnd) ||
      !Number.isSafeInteger(nextOffset) ||
      dataEnd > bytes.length ||
      nextOffset > bytes.length
    ) {
      throw new Error(
        `${archiveName} TAR entry ${entryCount} is truncated (declares ${size} data bytes)`,
      );
    }
    const data = bytes.subarray(dataOffset, dataEnd);
    offset = nextOffset;

    if (typeFlag === "L") {
      nextLongName = validatePath(
        decodeText(data).replace(/\0+$/, "").replace(/\n$/, ""),
        archiveName,
        entryCount,
      );
      continue;
    }
    if (typeFlag === "x") {
      nextPaxHeaders = readPaxHeaders(data, archiveName, entryCount);
      if (nextPaxHeaders.path != null) {
        nextPaxHeaders.path = validatePath(nextPaxHeaders.path, archiveName, entryCount);
      }
      continue;
    }
    if (typeFlag === "g") {
      readPaxHeaders(data, archiveName, entryCount);
      continue;
    }

    const rawName = nextPaxHeaders?.path || nextLongName || readPath(header);
    nextLongName = null;
    nextPaxHeaders = null;

    if (!REGULAR_TYPES.has(typeFlag)) {
      continue;
    }

    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_TOTAL_SIZE_BYTES) {
      throw new RangeError(
        `${archiveName} contents exceed the ${MAX_ARCHIVE_TOTAL_SIZE_BYTES}-byte archive limit`,
      );
    }

    const path = normalizeArchivePath(validatePath(rawName, archiveName, entryCount));
    if (path && !isArchiveMetadataPath(path)) {
      entries.push({ path, bytes: data });
    }
  }

  if (!sawEndMarker && (entryCount === 0 || requireEndMarker)) {
    if (requireEndMarker) {
      const trailingBytes = bytes.length - offset;
      throw new Error(
        `${archiveName} is a truncated TAR archive (missing end marker${trailingBytes ? `; ${trailingBytes} trailing bytes` : ""})`,
      );
    }
    throw new Error(`${archiveName} is not a TAR archive (no entries found)`);
  }
  if (nextLongName != null || nextPaxHeaders != null) {
    throw new Error(`${archiveName} ends with TAR metadata that has no following entry`);
  }

  return entries;
}

export function normalizeArchivePath(path) {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

function isZeroBlock(block) {
  for (let index = 0; index < block.length; index++) {
    if (block[index] !== 0) return false;
  }
  return true;
}

function isZeroTail(bytes) {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

function validateChecksum(header, archiveName, entryCount) {
  const recorded = parseOctal(header.subarray(148, 156));
  if (recorded == null) {
    throw new Error(`${archiveName} TAR entry ${entryCount} has an invalid checksum field`);
  }
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK_SIZE; index++) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (recorded !== unsigned && recorded !== signed) {
    throw new Error(`${archiveName} TAR entry ${entryCount} has a checksum mismatch`);
  }
}

function readSize(header, archiveName, entryCount) {
  const field = header.subarray(124, 136);
  if (field[0] & 0x80) {
    // GNU base-256 encoding for sizes that do not fit in octal.
    let value = 0;
    for (let index = 1; index < field.length; index++) {
      value = value * 256 + field[index];
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(`${archiveName} TAR entry ${entryCount} declares an oversized entry`);
      }
    }
    return value;
  }
  const size = parseOctal(field);
  if (size == null) {
    throw new Error(`${archiveName} TAR entry ${entryCount} has an invalid size field`);
  }
  return size;
}

function parseOctal(field) {
  let text = "";
  for (const byte of field) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  text = text.trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
}

function readPath(header) {
  const name = readString(header, 0, 100);
  const magic = readString(header, 257, 6);
  const prefix = magic.startsWith("ustar") ? readString(header, 345, 155) : "";
  return prefix ? `${prefix}/${name}` : name;
}

function readString(block, start, length) {
  let end = start;
  while (end < start + length && block[end] !== 0) end += 1;
  return decodeText(block.subarray(start, end));
}

function readPaxHeaders(data, archiveName, entryCount) {
  const headers = {};
  let position = 0;
  while (position < data.length) {
    let spaceIndex = position;
    while (spaceIndex < data.length && data[spaceIndex] !== 0x20) spaceIndex += 1;
    if (spaceIndex === data.length) {
      throw new Error(`${archiveName} TAR entry ${entryCount} has malformed PAX data`);
    }
    const lengthText = decodeText(data.subarray(position, spaceIndex));
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new Error(`${archiveName} TAR entry ${entryCount} has malformed PAX data`);
    }
    const length = Number.parseInt(lengthText, 10);
    const recordEnd = position + length;
    if (
      !Number.isSafeInteger(length) ||
      length <= spaceIndex - position + 2 ||
      recordEnd > data.length ||
      data[recordEnd - 1] !== 0x0a
    ) {
      throw new Error(`${archiveName} TAR entry ${entryCount} has malformed PAX data`);
    }
    const record = decodeText(data.subarray(spaceIndex + 1, recordEnd - 1));
    const equalsIndex = record.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`${archiveName} TAR entry ${entryCount} has malformed PAX data`);
    }
    const key = record.slice(0, equalsIndex);
    const value = record.slice(equalsIndex + 1);
    if (key === "path") headers.path = value;
    if (key === "size") {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`${archiveName} TAR entry ${entryCount} has an invalid PAX size`);
      }
      const size = Number(value);
      if (!Number.isSafeInteger(size)) {
        throw new Error(`${archiveName} TAR entry ${entryCount} has an invalid PAX size`);
      }
      headers.size = size;
    }
    position = recordEnd;
  }
  return headers;
}

function validatePath(path, archiveName, entryCount) {
  if (path.length > MAX_ARCHIVE_PATH_SIZE_BYTES) {
    throw new RangeError(`${archiveName} TAR entry ${entryCount} has an overlong path`);
  }
  if (path.includes("\0")) {
    throw new Error(`${archiveName} TAR entry ${entryCount} has an invalid path`);
  }
  const segments = path.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${archiveName} TAR entry ${entryCount} escapes the archive root`);
  }
  return path;
}

function decodeText(bytes) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

