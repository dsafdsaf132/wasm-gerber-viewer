export function isGzipBytes(bytes) {
  return Boolean(bytes) && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Inflate gzip data with the platform DecompressionStream, aborting once the
 * output grows past `maxOutputBytes`.
 */
export async function gunzip(
  bytes,
  { maxOutputBytes = Number.POSITIVE_INFINITY, label = "gzip data" } = {},
) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      `${label} is gzip-compressed, but this environment does not support gzip decompression`,
    );
  }

  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxOutputBytes) {
      await reader.cancel().catch(() => {});
      throw new RangeError(
        `${label} expands beyond the ${maxOutputBytes}-byte limit`,
      );
    }
    chunks.push(value);
  }

  if (chunks.length === 1) {
    return chunks[0];
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

