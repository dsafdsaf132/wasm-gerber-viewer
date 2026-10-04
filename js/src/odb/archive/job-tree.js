import { gunzip, isGzipBytes } from "./gzip.js";
import { normalizeArchivePath } from "./tar.js";
import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_TOTAL_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
} from "../config.js";

const MATRIX_PATH_PATTERN = /(?:^|\/)matrix\/matrix(?:\.z|\.gz)?$/i;

/** UNIX `compress` magic (`1F 9D`); the stream itself is decoded in WASM. */
export function isUnixZBytes(bytes) {
  return Boolean(bytes) && bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x9d;
}
const COMPRESSED_SUFFIXES = ["", ".Z", ".z", ".gz"];

/**
 * Find the directory prefix (possibly "") that holds `matrix/matrix`, which
 * marks the root of an ODB++ job. Returns null when the paths do not form a
 * job. When several candidates exist, the shallowest one wins.
 */
export function findOdbRoot(paths) {
  let root = null;
  for (const rawPath of paths) {
    const path = normalizeArchivePath(String(rawPath ?? ""));
    const match = MATRIX_PATH_PATTERN.exec(path);
    if (!match) continue;
    const prefix = path.slice(0, match.index === 0 ? 0 : match.index + 1);
    if (root === null || prefix.length < root.length) {
      root = prefix;
    }
  }
  return root;
}

export function createByteBudget({
  maxTotalBytes = MAX_ARCHIVE_TOTAL_SIZE_BYTES,
  maxFileBytes = MAX_FILE_SIZE_BYTES,
  maxRatio = MAX_ARCHIVE_COMPRESSION_RATIO,
} = {}) {
  let total = 0;
  return {
    get totalBytes() {
      return total;
    },
    charge(inputBytes, outputBytes, label) {
      if (outputBytes > maxFileBytes) {
        throw new RangeError(`${label} is ${outputBytes} bytes; the limit is ${maxFileBytes} bytes`);
      }
      if (inputBytes > 0 && outputBytes / inputBytes > maxRatio) {
        throw new RangeError(`${label} exceeds the supported compression ratio of ${maxRatio}:1`);
      }
      total += outputBytes;
      if (!Number.isSafeInteger(total) || total > maxTotalBytes) {
        throw new RangeError(
          `ODB++ job contents exceed the ${maxTotalBytes}-byte limit`,
        );
      }
    },
  };
}

/**
 * Read-only view over an ODB++ job stored in a TAR, a ZIP, or a dropped folder.
 * Paths are addressed relative to the job root, matched case-insensitively,
 * and `.Z`/`.gz` compressed variants are resolved and decompressed
 * transparently. `.gz` uses `DecompressionStream`; `.Z` (UNIX compress) is
 * decoded by the injected `decompressUnixZ(bytes, maxOutputBytes)`, which the
 * viewer binds to the WASM module's `decompress_unix_z`.
 */
export class JobTree {
  constructor(
    entries,
    { root = null, budget = createByteBudget(), decompressUnixZ = null } = {},
  ) {
    this.decompressUnixZ = decompressUnixZ;
    const normalized = entries
      .map((entry) => ({ ...entry, path: normalizeArchivePath(entry.path) }))
      .filter((entry) => entry.path !== "");
    this.root = root ?? findOdbRoot(normalized.map((entry) => entry.path));
    this.budget = budget;
    this.entries = new Map();
    const prefix = this.root ?? "";
    for (const entry of normalized) {
      if (prefix && !entry.path.startsWith(prefix)) continue;
      const relative = entry.path.slice(prefix.length);
      if (relative === "") continue;
      this.entries.set(relative.toLowerCase(), { ...entry, relativePath: relative });
    }
  }

  get isOdbJob() {
    return this.root !== null;
  }

  paths() {
    return Array.from(this.entries.values(), (entry) => entry.relativePath);
  }

  list(prefix) {
    const lowerPrefix = normalizeArchivePath(prefix).toLowerCase() + "/";
    return this.paths().filter((path) => path.toLowerCase().startsWith(lowerPrefix));
  }

  resolve(path) {
    const normalized = normalizeArchivePath(path).toLowerCase();
    for (const suffix of COMPRESSED_SUFFIXES) {
      const entry = this.entries.get(normalized + suffix.toLowerCase());
      if (entry) return entry;
    }
    return null;
  }

  has(path) {
    return this.resolve(path) !== null;
  }

  async readBytes(path) {
    const entry = this.resolve(path);
    if (!entry) {
      throw new Error(`ODB++ job is missing ${path}`);
    }
    const raw = await entry.readBytes();
    const label = entry.relativePath;
    if (isGzipBytes(raw)) {
      const output = await gunzip(raw, {
        maxOutputBytes: MAX_FILE_SIZE_BYTES,
        label,
      });
      this.budget.charge(raw.byteLength, output.byteLength, label);
      return output;
    }
    if (isUnixZBytes(raw)) {
      if (typeof this.decompressUnixZ !== "function") {
        throw new Error(
          `${label} is compressed with UNIX compress (.Z); decompressing it requires the WASM module`,
        );
      }
      let output;
      try {
        output = await this.decompressUnixZ(raw, MAX_FILE_SIZE_BYTES);
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.budget.charge(raw.byteLength, output.byteLength, label);
      return output;
    }
    this.budget.charge(raw.byteLength, raw.byteLength, label);
    return raw;
  }

  async readText(path) {
    return decodeText(await this.readBytes(path));
  }
}

export function createTarJobTree(tarEntries, options) {
  return new JobTree(
    tarEntries.map((entry) => ({
      path: entry.path,
      sizeBytes: entry.bytes.byteLength,
      readBytes: async () => entry.bytes,
    })),
    options,
  );
}

export function createZipJobTree(zip, options) {
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => ({
      path: entry.name,
      sizeBytes: Number(entry._data?.uncompressedSize) || null,
      readBytes: async () => entry.async("uint8array"),
    }));
  return new JobTree(entries, options);
}

/**
 * Build a tree from dropped or picked files. Items may be `File` objects with
 * `webkitRelativePath`, or `{ file, relativePath }` wrappers.
 */
export function createFileListJobTree(items, options) {
  const entries = [];
  for (const item of items) {
    const file = item?.file ?? item;
    const relativePath =
      item?.relativePath ?? file?.webkitRelativePath ?? file?.name ?? "";
    if (!file || !relativePath) continue;
    entries.push({
      path: relativePath,
      sizeBytes: file.size,
      readBytes: async () => new Uint8Array(await file.arrayBuffer()),
    });
  }
  return new JobTree(entries, options);
}

export function decodeText(bytes) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

