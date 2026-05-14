import { GERBER_FILE_EXTENSIONS, ZIP_MIME_TYPES } from "./config.js";

export function isZipFile(file) {
  return getFileExtension(file.name) === ".zip" || ZIP_MIME_TYPES.has(file.type);
}

export function isSupportedGerberPath(path) {
  return GERBER_FILE_EXTENSIONS.has(getFileExtension(path));
}

export function isArchiveMetadataPath(path) {
  const normalizedPath = path.replaceAll("\\", "/");
  const fileName = normalizedPath.split("/").pop() ?? normalizedPath;
  return normalizedPath.startsWith("__MACOSX/") || fileName.startsWith("._");
}

export function getFileExtension(path) {
  const fileName = getBaseFileName(path);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return "";
  }

  return fileName.slice(dotIndex).toLowerCase();
}

export function getBaseFileName(path) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const index = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / Math.pow(k, index)) * 100) / 100} ${sizes[index]}`;
}

export function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isNoGeometryError(message) {
  return message.toLowerCase().includes("no geometry found");
}
