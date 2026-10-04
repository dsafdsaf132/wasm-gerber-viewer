export const NOTIFICATION_DURATION_MS = 2000;
export const MAX_FILE_SIZE_BYTES = 300 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRY_COUNT = 1_000;
export const MAX_ARCHIVE_TOTAL_SIZE_BYTES = MAX_FILE_SIZE_BYTES;
export const MAX_ARCHIVE_COMPRESSION_RATIO = 1_000;
export const MAX_SOURCE_REPEAT = 100;
export const MAX_LAYER_COUNT = 500;
export const MAX_SCREENSHOT_STREAM_BAND_BYTES = 1024 * 1024 * 1024;
export const MAX_SCREENSHOT_RENDER_TARGET_BYTES = 2 * 1024 * 1024 * 1024;

export const ZIP_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
]);

// ODB++ jobs arrive as TAR archives (usually gzip-compressed), as ZIPs that
// contain a job tree, or as dropped folders.
export const ODB_ARCHIVE_EXTENSIONS = [".tgz", ".tar.gz", ".tar"];
export const ODB_ARCHIVE_MIME_TYPES = new Set(["application/x-tar"]);
// A production job ships every symbol, font and wheel as its own file, so a
// real ODB++ tree easily holds several thousand entries. The byte limits above
// still bound how much of it is inflated.
export const MAX_ODB_ARCHIVE_ENTRY_COUNT = 20_000;
export const MAX_ARCHIVE_METADATA_SIZE_BYTES = 1024 * 1024;
export const MAX_ARCHIVE_PATH_SIZE_BYTES = 4 * 1024;
export const MAX_TAR_EXPANDED_SIZE_BYTES =
  MAX_ARCHIVE_TOTAL_SIZE_BYTES + (MAX_ODB_ARCHIVE_ENTRY_COUNT + 2) * 1024;
export const MAX_DIRECTORY_ENTRY_COUNT = MAX_ODB_ARCHIVE_ENTRY_COUNT;
export const MAX_DIRECTORY_DEPTH = 16;

export const GERBER_FILE_EXTENSIONS = new Set([
  ".art",
  ".bot",
  ".bsk",
  ".bsm",
  ".cmp",
  ".crc",
  ".crs",
  ".drd",
  ".gbl",
  ".gbo",
  ".gbr",
  ".gbs",
  ".gbp",
  ".gbx",
  ".gdo",
  ".ger",
  ".gko",
  ".gpb",
  ".gpt",
  ".gtl",
  ".gto",
  ".gtp",
  ".gts",
  ".outline",
  ".pastebot",
  ".pastetop",
  ".phd",
  ".pho",
  ".plb",
  ".plc",
  ".pls",
  ".plt",
  ".smb",
  ".smt",
  ".sol",
  ".spb",
  ".spt",
  ".ssb",
  ".sst",
  ".stc",
  ".sts",
  ".top",
  ".tsk",
  ".tsm",
]);

export const DRILL_FILE_EXTENSIONS = new Set([
  ".drl",
  ".nc",
  ".xnc",
  ".xln",
]);
