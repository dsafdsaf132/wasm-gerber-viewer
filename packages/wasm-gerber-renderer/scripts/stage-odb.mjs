import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "../../js/src/odb");
const destinationRoot = resolve(packageRoot, "dst/odb");

const packageConfig = `import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_METADATA_SIZE_BYTES,
  MAX_ARCHIVE_PATH_SIZE_BYTES,
  MAX_SOURCE_FILE_SIZE_BYTES,
} from "../../shared.js";

export {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_METADATA_SIZE_BYTES,
  MAX_ARCHIVE_PATH_SIZE_BYTES,
};

export const MAX_FILE_SIZE_BYTES = MAX_SOURCE_FILE_SIZE_BYTES;
export const MAX_ARCHIVE_TOTAL_SIZE_BYTES = MAX_SOURCE_FILE_SIZE_BYTES;
export const MAX_ODB_ARCHIVE_ENTRY_COUNT = 20_000;
export const MAX_TAR_EXPANDED_SIZE_BYTES =
  MAX_ARCHIVE_TOTAL_SIZE_BYTES + (MAX_ODB_ARCHIVE_ENTRY_COUNT + 2) * 1024;

export const ODB_ARCHIVE_EXTENSIONS = [".tgz", ".tar.gz", ".tar"];
export const ODB_ARCHIVE_MIME_TYPES = new Set(["application/x-tar"]);

export function isArchiveMetadataPath(path) {
  const normalized = String(path ?? "").replaceAll("\\\\", "/");
  const fileName = normalized.split("/").pop() ?? normalized;
  return normalized.startsWith("__MACOSX/") || fileName.startsWith("._");
}
`;

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(dirname(destinationRoot), { recursive: true });
await cp(sourceRoot, destinationRoot, { recursive: true });
await writeFile(resolve(destinationRoot, "config.js"), packageConfig);

// Keep this check visible in logs when a source file accidentally imports a
// repository-only path that cannot exist inside the published package.
const stagedIndex = await readFile(resolve(destinationRoot, "index.js"), "utf8");
if (stagedIndex.includes("../../core/")) {
  throw new Error("ODB staging produced a viewer-only import in the package tree");
}
