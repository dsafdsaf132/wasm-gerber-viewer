import {
  ODB_ARCHIVE_EXTENSIONS,
  ODB_ARCHIVE_MIME_TYPES,
} from "../config.js";
import { findOdbRoot } from "./job-tree.js";

/** TAR archives (plain or gzip-compressed) that may hold an ODB++ job. */
export function isOdbArchiveFile(file) {
  const name = String(file?.name ?? "").toLowerCase();
  if (ODB_ARCHIVE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return true;
  }
  return ODB_ARCHIVE_MIME_TYPES.has(String(file?.type ?? "").toLowerCase());
}

/** A JSZip archive whose entries contain a `matrix/matrix` file. */
export function isOdbZip(zip) {
  return findOdbRoot(Object.keys(zip?.files ?? {})) !== null;
}

/** A list of dropped/picked files whose relative paths form an ODB++ job. */
export function isOdbFileList(items) {
  const paths = [];
  for (const item of items ?? []) {
    const file = item?.file ?? item;
    const relativePath = item?.relativePath ?? file?.webkitRelativePath ?? "";
    if (relativePath) paths.push(relativePath);
  }
  return paths.length > 0 && findOdbRoot(paths) !== null;
}

