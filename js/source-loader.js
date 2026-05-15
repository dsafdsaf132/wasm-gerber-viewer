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

export async function fetchRemoteFile(url) {
  const response = await fetch(url.href);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${url.href}`);
  }

  const fileName = getBaseFileName(decodeURIComponent(url.pathname));
  return new File([await response.blob()], fileName, {
    type: response.headers.get("content-type") || "",
  });
}

export async function collectLayerSources(files, callbacks = {}) {
  const layerSources = [];

  for (const file of files) {
    if (isZipFile(file)) {
      layerSources.push(...(await collectZipLayerSources(file, callbacks)));
      continue;
    }

    layerSources.push({
      name: file.name,
      readText: () => file.text(),
    });
  }

  return layerSources;
}

export function repeatLayerSources(layerSources, repeat, { offset = {} } = {}) {
  if (repeat <= 1) {
    return layerSources;
  }

  const repeatOffset = normalizeLayerOffset(offset);

  return layerSources.flatMap((source) =>
    Array.from({ length: repeat }, (_, index) => ({
      name: `${source.name} #${index + 1}`,
      readText: source.readText,
      offset: addLayerOffsets(source.offset, {
        x: repeatOffset.x * index,
        y: repeatOffset.y * index,
      }),
    })),
  );
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
  } = {},
) {
  if (!jsZip) {
    onArchiveError(file.name, new Error("ZIP support failed to load"));
    return [];
  }

  try {
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
      readText: () => entry.async("string"),
    }));
  } catch (error) {
    onArchiveError(file.name, error);
    return [];
  }
}
