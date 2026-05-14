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
