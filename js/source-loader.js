import {
  getBaseFileName,
  isArchiveMetadataPath,
  isSupportedGerberPath,
  isZipFile,
} from "./file-utils.js";

export const MAX_INITIAL_SOURCE_REPEAT = 10;

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

  return Math.min(Math.max(repeat, 1), MAX_INITIAL_SOURCE_REPEAT);
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

export function repeatLayerSources(layerSources, repeat) {
  if (repeat <= 1) {
    return layerSources;
  }

  return layerSources.flatMap((source) =>
    Array.from({ length: repeat }, (_, index) => ({
      name: `${source.name} #${index + 1}`,
      readText: source.readText,
    })),
  );
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
