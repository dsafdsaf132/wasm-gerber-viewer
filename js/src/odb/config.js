import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_METADATA_SIZE_BYTES,
  MAX_ARCHIVE_PATH_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  MAX_ODB_ARCHIVE_ENTRY_COUNT,
  MAX_TAR_EXPANDED_SIZE_BYTES,
} from "../../core/config.js";

export {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_METADATA_SIZE_BYTES,
  MAX_ARCHIVE_PATH_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  MAX_ODB_ARCHIVE_ENTRY_COUNT,
  MAX_TAR_EXPANDED_SIZE_BYTES,
};

export const MAX_ARCHIVE_TOTAL_SIZE_BYTES = MAX_FILE_SIZE_BYTES;

export const ODB_ARCHIVE_EXTENSIONS = [".tgz", ".tar.gz", ".tar"];
export const ODB_ARCHIVE_MIME_TYPES = new Set(["application/x-tar"]);

export function isArchiveMetadataPath(path) {
  const normalized = String(path ?? "").replaceAll("\\", "/");
  const fileName = normalized.split("/").pop() ?? normalized;
  return normalized.startsWith("__MACOSX/") || fileName.startsWith("._");
}
