import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_TAR_EXPANDED_SIZE_BYTES,
} from "./config.js";
import { gunzip, isGzipBytes } from "./archive/gzip.js";
import {
  createFileListJobTree,
  createTarJobTree,
  createZipJobTree,
} from "./archive/job-tree.js";
import { parseTar } from "./archive/tar.js";
import { createOdbLayerSources, loadOdbJob, selectDefaultStep } from "./job-loader.js";

export { isOdbArchiveFile, isOdbFileList, isOdbZip } from "./archive/detect.js";
export const ODB_STEP_QUERY_PARAM = "odbStep";

/**
 * Read a `.tgz`/`.tar.gz`/`.tar` file into TAR entries plus a job tree. The
 * tree reports `isOdbJob === false` when the archive is a plain collection of
 * files (for example zipped Gerbers), which callers handle themselves.
 */
export async function readTarArchive(file, treeOptions = {}) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (isGzipBytes(bytes)) {
    bytes = await gunzip(bytes, {
      maxOutputBytes: Math.min(
        MAX_TAR_EXPANDED_SIZE_BYTES,
        bytes.byteLength * MAX_ARCHIVE_COMPRESSION_RATIO,
      ),
      label: file.name,
    });
  }
  const entries = parseTar(bytes, { archiveName: file.name });
  return { entries, tree: createTarJobTree(entries, treeOptions) };
}

export function createOdbTreeFromZip(zip, treeOptions = {}) {
  return createZipJobTree(zip, treeOptions);
}

export function createOdbTreeFromFiles(items, treeOptions = {}) {
  return createFileListJobTree(items, treeOptions);
}

/** Job-tree options taken from the loader callbacks (the `.Z` decoder). */
export function odbTreeOptions(callbacks = {}) {
  return { decompressUnixZ: callbacks.decompressUnixZ ?? null };
}

/**
 * Import the default (or requested) step of an ODB++ job as viewer layer
 * sources. Errors propagate to the caller, which reports them per archive.
 */
export async function collectOdbLayerSourcesFromTree(
  tree,
  jobLabel,
  {
    onArchiveStage = () => {},
    onArchiveWarning = () => {},
    onArchiveInfo = () => {},
    odbStepName = null,
  } = {},
) {
  const jobName = jobLabel.replace(/\.(tgz|tar\.gz|tar|zip)$/i, "");
  const job = await loadOdbJob(tree, {
    jobName,
    onStage: (stage) => onArchiveStage(jobLabel, stage),
  });
  const stepName = await selectDefaultStep(job, odbStepName);
  const sources = await createOdbLayerSources(job, {
    stepName,
    onWarning: onArchiveWarning,
    onInfo: onArchiveInfo,
    onStage: (stage) => onArchiveStage(jobLabel, stage),
  });
  if (sources.length === 0) {
    throw new Error(`${jobLabel}: step ${stepName} has no importable board layers`);
  }
  onArchiveInfo(jobLabel, `${sources.length} ODB++ layers imported from step ${stepName}`);
  return sources;
}

export function getInitialOdbStepName(search = globalThis.location?.search ?? "") {
  const value = new URLSearchParams(search).get(ODB_STEP_QUERY_PARAM);
  return value && value.trim() !== "" ? value.trim() : null;
}

