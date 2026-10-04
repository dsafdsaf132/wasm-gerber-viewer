// Minimal UNIX `compress`-compatible LZW encoder for tests and fixtures.
// Mirrors ncompress: block mode, 9..maxBits code widths, LSB-first packing,
// and output padded to whole groups of `width * 8` bits whenever the width
// changes or a CLEAR code is written.

const INIT_BITS = 9;
const CLEAR_CODE = 256;
const FIRST_FREE = 257;

/**
 * @param {Uint8Array} input
 * @param {{ maxBits?: number, clearAfterCodes?: number }} options
 *   `clearAfterCodes` forces a CLEAR code after that many emitted codes so a
 *   test can exercise the decoder's reset path.
 */
export function compressLzw(input, { maxBits = 16, clearAfterCodes = 0 } = {}) {
  if (maxBits < INIT_BITS || maxBits > 16) {
    throw new RangeError("maxBits must be between 9 and 16");
  }
  const maxMaxCode = 1 << maxBits;
  const out = [0x1f, 0x9d, maxBits | 0x80];
  let bitBuffer = 0;
  let bitCount = 0;
  let bitPos = 0;
  let groupStart = 0; // like ncompress `boff`: groups align to the last boundary
  let width = INIT_BITS;
  let maxCode = (1 << width) - 1;
  let freeEntry = FIRST_FREE;
  let emitted = 0;
  let dictionary = new Map();

  const writeBits = (value, count) => {
    bitBuffer |= value << bitCount;
    bitCount += count;
    bitPos += count;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  const padToGroup = () => {
    const group = width * 8;
    const target = groupStart + Math.ceil((bitPos - groupStart) / group) * group;
    while (bitPos < target) writeBits(0, 1);
    groupStart = bitPos;
  };
  const output = (code) => {
    writeBits(code, width);
    emitted += 1;
    if (freeEntry > maxCode) {
      padToGroup();
      width += 1;
      maxCode = width === maxBits ? maxMaxCode : (1 << width) - 1;
    }
  };
  const clear = () => {
    writeBits(CLEAR_CODE, width);
    emitted += 1;
    padToGroup();
    width = INIT_BITS;
    maxCode = (1 << width) - 1;
    freeEntry = FIRST_FREE;
    dictionary = new Map();
  };

  let index = 0;
  if (input.length === 0) return Uint8Array.from(out);
  let current = input[index++];

  while (index < input.length) {
    const byte = input[index++];
    const key = current * 256 + byte;
    const existing = dictionary.get(key);
    if (existing !== undefined) {
      current = existing;
      continue;
    }
    output(current);
    if (clearAfterCodes && emitted >= clearAfterCodes) {
      clear();
      clearAfterCodes = 0;
    } else if (freeEntry < maxMaxCode) {
      dictionary.set(key, freeEntry);
      freeEntry += 1;
    }
    current = byte;
  }
  output(current);
  if (bitCount > 0) {
    out.push(bitBuffer & 0xff);
  }
  return Uint8Array.from(out);
}
