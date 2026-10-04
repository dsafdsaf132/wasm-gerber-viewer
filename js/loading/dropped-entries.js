import { MAX_DIRECTORY_DEPTH, MAX_DIRECTORY_ENTRY_COUNT } from "../core/config.js";

/**
 * Expand dropped FileSystemEntry objects (from `DataTransferItem.webkitGetAsEntry`)
 * into `{ file, relativePath, name, size }` wrappers. Paths start with the
 * dropped folder name, mirroring `File.webkitRelativePath`.
 */
export async function collectDroppedEntries(
  entries,
  { maxEntries = MAX_DIRECTORY_ENTRY_COUNT, maxDepth = MAX_DIRECTORY_DEPTH } = {},
) {
  const items = [];

  const visit = async (entry, path, depth) => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      items.push({ file, relativePath: path, name: file.name, size: file.size });
      if (items.length > maxEntries) {
        throw new RangeError(`Dropped folder contains more than ${maxEntries} files`);
      }
      return;
    }
    if (!entry.isDirectory) return;
    if (depth >= maxDepth) {
      throw new RangeError(`Dropped folder is nested deeper than ${maxDepth} levels`);
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch || batch.length === 0) break;
      for (const child of batch) {
        await visit(child, `${path}/${child.name}`, depth + 1);
      }
    }
  };

  for (const entry of entries) {
    await visit(entry, entry?.name ?? "", 0);
  }
  return items;
}

/** Entries must be resolved synchronously inside the drop event. */
export function getDroppedEntries(dataTransfer) {
  const items = Array.from(dataTransfer?.items ?? []);
  return items.map((item) =>
    typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null,
  );
}
