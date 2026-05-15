import {
  getBaseFileName,
  isArchiveMetadataPath,
  isSupportedGerberPath,
  isZipFile,
} from "./file-utils.js";

export function getInitialSourceUrl(search = globalThis.location?.search ?? "") {
  const params = new URLSearchParams(search);
  return params.get("url") || params.get("source") || params.get("file");
}

export function getInitialSourceRepeat(search = globalThis.location?.search ?? "") {
  const params = new URLSearchParams(search);
  const rawRepeat = params.get("repeat");
  if (!rawRepeat) return 1;

  const repeat = Number.parseInt(rawRepeat, 10);
  if (!Number.isFinite(repeat)) return 1;

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

export async function fetchRemoteFile(url, { onProgress = () => {} } = {}) {
  const response = await fetch(url.href);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${url.href}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  let blob;
  if (!response.body || !Number.isFinite(contentLength) || contentLength <= 0) {
    blob = await response.blob();
    onProgress(1);
  } else {
    const reader = response.body.getReader();
    const chunks = [];
    let receivedLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedLength += value.length;
      onProgress(Math.min(receivedLength / contentLength, 1));
    }

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

  for (let index = 0; index < files.length; index++) {
    const file = typeof files.item === "function" ? files.item(index) : files[index];
    if (!file) continue;

    callbacks.onFileStart?.(file.name, index + 1, files.length);

    if (isZipFile(file)) {
      layerSources.push(...(await collectZipLayerSources(file, callbacks)));
      continue;
    }

    layerSources.push({
      name: file.name,
      sizeBytes: file.size,
      readText: (onProgress) => readFileText(file, onProgress),
    });
  }

  return layerSources;
}

export function repeatLayerSources(layerSources, repeat, { offset = {} } = {}) {
  if (repeat <= 1) {
    return layerSources;
  }

  const repeatOffset = normalizeLayerOffset(offset);

  return layerSources.flatMap((source) => {
    const readText = createSharedTextReader(source.readText);
    return Array.from({ length: repeat }, (_, index) => ({
      name: `${source.name} #${index + 1}`,
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
    const entries = Object.values(zip.files)
      .filter(
        (entry) =>
          !entry.dir &&
          !isArchiveMetadataPath(entry.name) &&
          isSupportedGerberPath(entry.name),
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );

    if (entries.length === 0) {
      onArchiveWarning(
        file.name,
        "No supported Gerber files found in archive",
      );
      return [];
    }

    onArchiveInfo(file.name, `${entries.length} Gerber files found in archive`);

    return entries.map((entry) => ({
      name: getBaseFileName(entry.name),
      sizeBytes: getZipEntrySizeBytes(entry),
      readText: (onProgress = () => {}) =>
        entry.async("string", (metadata) => {
          onProgress(Math.min(metadata.percent / 100, 1));
        }),
    }));
  } catch (error) {
    onArchiveError(file.name, error);
    return [];
  }
}

function getZipEntrySizeBytes(entry) {
  const size = Number(
    entry._data?.uncompressedSize ?? entry._data?.compressedSize,
  );
  return Number.isFinite(size) && size > 0 ? size : null;
}
