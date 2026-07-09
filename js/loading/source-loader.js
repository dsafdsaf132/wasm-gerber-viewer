import {
  getBaseFileName,
  isAmbiguousDrdPath,
  getLayerSourceKind,
  isArchiveMetadataPath,
  isLikelyTextBytes,
  isSupportedLayerPath,
  isZipFile,
  looksLikeDrillContent,
  looksLikeGerberContent,
} from "./file-utils.js";
import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_ENTRY_COUNT,
  MAX_ARCHIVE_TOTAL_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  MAX_LAYER_COUNT,
  MAX_SOURCE_REPEAT,
} from "../core/config.js";

const UNKNOWN_ZIP_LAYER_SNIFF_LINES = 30;

export function getInitialSourceUrl(search = globalThis.location?.search ?? "") {
  const params = new URLSearchParams(search);
  return params.get("url") || params.get("source") || params.get("file");
}

export function getInitialSourceRepeat(search = globalThis.location?.search ?? "") {
  const params = new URLSearchParams(search);
  const rawRepeat = params.get("repeat");
  if (!rawRepeat) return 1;

  if (!/^\d+$/.test(rawRepeat)) return 1;
  const repeat = Number(rawRepeat);
  if (!Number.isSafeInteger(repeat)) return 1;
  if (repeat > MAX_SOURCE_REPEAT) {
    throw new RangeError(`Source repeat cannot exceed ${MAX_SOURCE_REPEAT}`);
  }

  return Math.max(repeat, 1);
}

export function getInitialSourceRepeatOffset(
  search = globalThis.location?.search ?? "",
) {
  const params = new URLSearchParams(search);

  return {
    x: getNumberParam(params, "repeatOffsetX", 0),
    y: getNumberParam(params, "repeatOffsetY", 0),
  };
}

export async function fetchRemoteFile(
  url,
  {
    onProgress = () => {},
    maxBytes = MAX_FILE_SIZE_BYTES,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Remote file loading requires fetch support");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Remote file byte limit must be a positive safe integer");
  }
  const response = await fetchImpl(url.href);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${url.href}`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength =
    contentLengthHeader == null ? null : Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try {
      await response.body?.cancel?.();
    } catch (_cancelError) {
      // Preserve the size-limit error.
    }
    throw createFileSizeLimitError(url.href, contentLength, maxBytes);
  }

  let blob;
  if (!response.body) {
    blob = await response.blob();
    if (blob.size > maxBytes) {
      throw createFileSizeLimitError(url.href, blob.size, maxBytes);
    }
    onProgress(1);
  } else {
    const reader = response.body.getReader();
    const chunks = [];
    let receivedLength = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        receivedLength += value.length;
        if (receivedLength > maxBytes) {
          const error = createFileSizeLimitError(url.href, receivedLength, maxBytes);
          await reader.cancel(error).catch(() => {});
          throw error;
        }
        chunks.push(value);
        if (Number.isFinite(contentLength) && contentLength > 0) {
          onProgress(Math.min(receivedLength / contentLength, 1));
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    onProgress(1);

    blob = new Blob(chunks, {
      type: response.headers.get("content-type") || "",
    });
  }

  const fileName = getBaseFileName(decodeURIComponent(url.pathname));
  return new File([blob], fileName, {
    type: response.headers.get("content-type") || "",
  });
}

export async function collectLayerSources(files, callbacks = {}) {
  const layerSources = [];

  if (files.length > MAX_LAYER_COUNT) {
    throw new RangeError(`Cannot load more than ${MAX_LAYER_COUNT} files at once`);
  }

  for (let index = 0; index < files.length; index++) {
    const file = typeof files.item === "function" ? files.item(index) : files[index];
    if (!file) continue;

    callbacks.onFileStart?.(file.name, index + 1, files.length);

    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw createFileSizeLimitError(file.name, file.size, MAX_FILE_SIZE_BYTES);
    }

    if (isZipFile(file)) {
      layerSources.push(...(await collectZipLayerSources(file, callbacks)));
      assertLayerCount(layerSources.length);
      continue;
    }

    layerSources.push({
      name: file.name,
      kind: getLayerSourceKind(file.name, await readLayerKindPreview(file)),
      sizeBytes: file.size,
      readText: (onProgress) => readFileText(file, onProgress),
    });
    assertLayerCount(layerSources.length);
  }

  return layerSources;
}

export function repeatLayerSources(layerSources, repeat, { offset = {} } = {}) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > MAX_SOURCE_REPEAT) {
    throw new RangeError(`Source repeat must be an integer from 1 to ${MAX_SOURCE_REPEAT}`);
  }
  const repeatedLayerCount = layerSources.length * repeat;
  if (!Number.isSafeInteger(repeatedLayerCount) || repeatedLayerCount > MAX_LAYER_COUNT) {
    throw new RangeError(`Repeated sources cannot exceed ${MAX_LAYER_COUNT} layers`);
  }
  if (repeat <= 1) {
    return layerSources;
  }

  const repeatOffset = normalizeLayerOffset(offset);

  return layerSources.flatMap((source) => {
    const readText = createSharedTextReader(source.readText);
    return Array.from({ length: repeat }, (_, index) => ({
      name: `${source.name} #${index + 1}`,
      kind: source.kind,
      sizeBytes: source.sizeBytes,
      readText,
      offset: addLayerOffsets(source.offset, {
        x: repeatOffset.x * index,
        y: repeatOffset.y * index,
      }),
    }));
  });
}

function createSharedTextReader(readText) {
  let textPromise = null;

  return (onProgress = () => {}) => {
    if (!textPromise) {
      textPromise = readText(onProgress);
    } else {
      textPromise.then(
        () => onProgress(1),
        () => onProgress(1),
      );
    }

    return textPromise;
  };
}

function readFileText(file, onProgress = () => {}) {
  if (typeof FileReader === "undefined") {
    return file.text().then((text) => {
      onProgress(1);
      return text;
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(event.loaded / event.total, 1));
      }
    };
    reader.onload = () => {
      onProgress(1);
      resolve(String(reader.result ?? ""));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    };
    reader.readAsText(file);
  });
}

function getNumberParam(params, key, fallback) {
  const rawValue = params.get(key);
  if (rawValue === null || rawValue.trim() === "") {
    return fallback;
  }

  const value = Number.parseFloat(rawValue);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeLayerOffset(offset = {}) {
  const x = Number(offset.x ?? 0);
  const y = Number(offset.y ?? 0);

  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

function addLayerOffsets(first, second) {
  const normalizedFirst = normalizeLayerOffset(first);
  const normalizedSecond = normalizeLayerOffset(second);

  return {
    x: normalizedFirst.x + normalizedSecond.x,
    y: normalizedFirst.y + normalizedSecond.y,
  };
}

async function collectZipLayerSources(
  file,
  {
    jsZip = globalThis.JSZip,
    onArchiveWarning = () => {},
    onArchiveInfo = () => {},
    onArchiveError = () => {},
    onArchiveStart = () => {},
  } = {},
) {
  if (!jsZip) {
    onArchiveError(file.name, new Error("ZIP support failed to load"));
    return [];
  }

  try {
    onArchiveStart(file.name);
    const zip = await jsZip.loadAsync(file);
    const archiveEntries = Object.values(zip.files);
    validateZipEntries(archiveEntries, file.name);
    const entries = archiveEntries
      .filter(
        (entry) =>
          !entry.dir &&
          !isArchiveMetadataPath(entry.name),
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );

    const sources = [];
    for (const entry of entries) {
      const source = isSupportedLayerPath(entry.name)
        ? await createKnownZipLayerSource(entry, file.name, onArchiveWarning)
        : await createUnknownZipLayerSource(entry, file.name, onArchiveWarning);
      if (source) {
        sources.push(source);
        assertLayerCount(sources.length);
      }
    }

    if (sources.length === 0) {
      onArchiveWarning(
        file.name,
        "No supported layer files found in archive",
      );
      return [];
    }

    onArchiveInfo(file.name, `${sources.length} layer files found in archive`);

    return sources;
  } catch (error) {
    onArchiveError(file.name, error);
    return [];
  }
}

async function createKnownZipLayerSource(entry, archiveName, onArchiveWarning) {
  const readText = createSharedTextReader((onProgress = () => {}) =>
    readZipEntryText(entry, onProgress),
  );
  let preview = "";
  if (isAmbiguousDrdPath(entry.name)) {
    try {
      preview = await readZipEntryText(entry);
    } catch (_error) {
      onArchiveWarning(
        archiveName,
        `Could not inspect ${getBaseFileName(entry.name)}; loading as Gerber`,
      );
    }
  }

  return {
    name: getBaseFileName(entry.name),
    kind: getLayerSourceKind(entry.name, preview),
    sizeBytes: getZipEntrySizeBytes(entry),
    readText,
  };
}

async function createUnknownZipLayerSource(entry, archiveName, onArchiveWarning) {
  let bytes;
  try {
    bytes = await readZipEntryBytes(entry);
  } catch (_error) {
    onArchiveWarning(
      archiveName,
      `Could not inspect ${getBaseFileName(entry.name)}; skipping unknown file`,
    );
    return null;
  }

  const headBytes = getHeadLineBytes(bytes, UNKNOWN_ZIP_LAYER_SNIFF_LINES);
  if (!isLikelyTextBytes(headBytes)) {
    return null;
  }

  const headText = decodeZipEntryText(headBytes);
  const looksLikeDrill = looksLikeDrillContent(headText);
  if (!looksLikeDrill && !looksLikeGerberContent(headText)) {
    return null;
  }
  const sizeBytes = getZipEntrySizeBytes(entry) ?? bytes.byteLength;

  return {
    name: getBaseFileName(entry.name),
    kind: looksLikeDrill ? "drill" : "gerber",
    sizeBytes,
    readText: createSharedTextReader((onProgress = () => {}) =>
      readZipEntryText(entry, onProgress),
    ),
  };
}

function readZipEntryText(entry, onProgress = () => {}) {
  return entry.async("string", (metadata) => {
    onProgress(Math.min(metadata.percent / 100, 1));
  });
}

function readZipEntryBytes(entry, onProgress = () => {}) {
  return entry.async("uint8array", (metadata) => {
    onProgress(Math.min(metadata.percent / 100, 1));
  });
}

function decodeZipEntryText(bytes) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }

  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

function getHeadLineBytes(bytes, maxLines) {
  if (!bytes || bytes.byteLength === 0) {
    return bytes;
  }

  let lines = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] === 10) {
      lines += 1;
      if (lines >= maxLines) {
        return bytes.subarray(0, index + 1);
      }
    }
  }

  return bytes;
}

async function readLayerKindPreview(file) {
  if (!isAmbiguousDrdPath(file.name)) {
    return "";
  }
  if (typeof file.slice === "function") {
    return file.slice(0, 8192).text();
  }
  return file.text();
}

function getZipEntrySizeBytes(entry) {
  const size = Number(
    entry._data?.uncompressedSize ?? entry._data?.compressedSize,
  );
  return Number.isFinite(size) && size > 0 ? size : null;
}

function getZipEntryCompressedSizeBytes(entry) {
  const size = Number(entry._data?.compressedSize);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function validateZipEntries(entries, archiveName) {
  if (entries.length > MAX_ARCHIVE_ENTRY_COUNT) {
    throw new RangeError(
      `${archiveName} contains ${entries.length} entries; the limit is ${MAX_ARCHIVE_ENTRY_COUNT}`,
    );
  }

  let totalSize = 0;
  for (const entry of entries) {
    const size = getZipEntrySizeBytes(entry);
    if (size == null) continue;
    if (size > MAX_FILE_SIZE_BYTES) {
      throw createFileSizeLimitError(
        `${archiveName}:${entry.name}`,
        size,
        MAX_FILE_SIZE_BYTES,
      );
    }
    totalSize += size;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_ARCHIVE_TOTAL_SIZE_BYTES) {
      throw createFileSizeLimitError(
        `${archiveName} uncompressed contents`,
        totalSize,
        MAX_ARCHIVE_TOTAL_SIZE_BYTES,
      );
    }

    const compressedSize = getZipEntryCompressedSizeBytes(entry);
    if (
      compressedSize != null &&
      size / compressedSize > MAX_ARCHIVE_COMPRESSION_RATIO
    ) {
      throw new RangeError(
        `${archiveName}:${entry.name} exceeds the supported ZIP compression ratio`,
      );
    }
  }
}

function assertLayerCount(count) {
  if (count > MAX_LAYER_COUNT) {
    throw new RangeError(`Cannot load more than ${MAX_LAYER_COUNT} layers at once`);
  }
}

function createFileSizeLimitError(name, size, limit) {
  return new RangeError(`${name} is ${size} bytes; the limit is ${limit} bytes`);
}
