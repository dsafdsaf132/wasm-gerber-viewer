export const COMPOSITE_LAYER_KIND = "composite";
export const MIN_COMPOSITE_SOURCES = 2;
export const MAX_COMPOSITE_SOURCES = 24;
export const COMPOSITE_PRESETS = new Set([
  "union",
  "intersection",
  "difference",
]);

const LOW_SLOT_REMOVE_LOOKUPS = Array.from({ length: 3 }, (_unused, removedSlot) => {
  const lookup = new Uint8Array(256);
  const lowMask = 2 ** removedSlot - 1;
  for (let byte = 0; byte < lookup.length; byte += 1) {
    let compacted = 0;
    for (let code = 0; code < 4; code += 1) {
      const withoutRemoved = (code & lowMask) | ((code & ~lowMask) << 1);
      const withRemoved = withoutRemoved | (1 << removedSlot);
      if (byte & ((1 << withoutRemoved) | (1 << withRemoved))) {
        compacted |= 1 << code;
      }
    }
    lookup[byte] = compacted;
  }
  return lookup;
});

export function getCompositeBitsetByteLength(sourceCount) {
  validateCompositeSourceCount(sourceCount);
  return Math.ceil(2 ** sourceCount / 8);
}

export function validateCompositeSourceCount(sourceCount) {
  if (
    !Number.isInteger(sourceCount) ||
    sourceCount < MIN_COMPOSITE_SOURCES ||
    sourceCount > MAX_COMPOSITE_SOURCES
  ) {
    throw new TypeError("Composite layers require between 2 and 24 Gerber sources.");
  }
}

export function getCompositeAreaVisible(bitset, code) {
  return Boolean(bitset[code >>> 3] & (1 << (code & 7)));
}

export function setCompositeAreaVisible(bitset, code, visible) {
  const byteIndex = code >>> 3;
  const mask = 1 << (code & 7);
  bitset[byteIndex] = visible
    ? bitset[byteIndex] | mask
    : bitset[byteIndex] & ~mask;
  return byteIndex;
}

export function createCompositePresetBitset(sourceCount, preset = "union") {
  validateCompositeSourceCount(sourceCount);
  if (!COMPOSITE_PRESETS.has(preset)) {
    throw new TypeError("Composite preset must be union, intersection, or difference.");
  }
  const bitset = new Uint8Array(getCompositeBitsetByteLength(sourceCount));
  if (preset === "union") {
    bitset.fill(0xff);
    bitset[0] &= 0xfe;
  } else if (preset === "intersection") {
    setCompositeAreaVisible(bitset, 2 ** sourceCount - 1, true);
  } else {
    // Slot zero is the first ordered source. Difference is first - union(rest).
    setCompositeAreaVisible(bitset, 1, true);
  }
  return bitset;
}

export function createCompositeLayerPresetBitset(layer, preset = "union") {
  if (!layer || layer.kind !== COMPOSITE_LAYER_KIND) {
    throw new TypeError("A composite layer is required.");
  }
  const sourceCount = layer.slotSourceIds?.length;
  validateCompositeSourceCount(sourceCount);
  if (
    !Array.isArray(layer.sourceIds) ||
    layer.sourceIds.length !== sourceCount ||
    new Set(layer.sourceIds).size !== sourceCount ||
    new Set(layer.slotSourceIds).size !== sourceCount ||
    layer.sourceIds.some((sourceId) => !layer.slotSourceIds.includes(sourceId))
  ) {
    throw new TypeError("Composite source order and bit slots must match.");
  }
  const bitset = createCompositePresetBitset(sourceCount, preset);
  if (preset === "difference") {
    const firstSlot = layer.slotSourceIds.indexOf(layer.sourceIds[0]);
    bitset.fill(0);
    setCompositeAreaVisible(bitset, 2 ** firstSlot, true);
  }
  return bitset;
}

export function normalizeVisibleAreaPatterns(patterns, sourceCount, { allowEmpty = false } = {}) {
  validateCompositeSourceCount(sourceCount);
  if (!Array.isArray(patterns)) {
    throw new TypeError("visibleAreas must be an array of binary strings.");
  }
  if (!allowEmpty && patterns.length === 0) {
    throw new TypeError("visibleAreas cannot be empty.");
  }
  const unique = [];
  const seen = new Set();
  for (const pattern of patterns) {
    const value = String(pattern);
    if (value.length !== sourceCount || !/^[01]+$/.test(value)) {
      throw new TypeError(
        `Each visibleAreas pattern must contain exactly ${sourceCount} binary digits.`,
      );
    }
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

export function visibleAreaPatternsToBitset(patterns, sourceCount, options = {}) {
  const normalized = normalizeVisibleAreaPatterns(patterns, sourceCount, options);
  const bitset = new Uint8Array(getCompositeBitsetByteLength(sourceCount));
  for (const pattern of normalized) {
    setCompositeAreaVisible(bitset, compositePatternToCode(pattern), true);
  }
  return bitset;
}

export function compositePatternToCode(pattern) {
  let code = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "1") code += 2 ** index;
  }
  return code;
}

export function compositeCodeToPattern(code, sourceSlots) {
  return sourceSlots
    .map((slot) => (code & 2 ** slot ? "1" : "0"))
    .join("");
}

export function addCompositeSource(bitset, sourceCount) {
  validateCompositeBitset(bitset, sourceCount);
  if (sourceCount >= MAX_COMPOSITE_SOURCES) {
    throw new TypeError("Composite source limit is 24.");
  }
  const next = new Uint8Array(getCompositeBitsetByteLength(sourceCount + 1));
  if (sourceCount >= 3) {
    next.set(bitset, 0);
    next.set(bitset, bitset.byteLength);
  } else {
    const branchOffset = 2 ** sourceCount;
    for (let code = 0; code < branchOffset; code += 1) {
      const visible = getCompositeAreaVisible(bitset, code);
      setCompositeAreaVisible(next, code, visible);
      setCompositeAreaVisible(next, code + branchOffset, visible);
    }
  }
  return next;
}

export function removeCompositeSource(bitset, sourceCount, removedSlot) {
  validateCompositeBitset(bitset, sourceCount);
  if (sourceCount <= MIN_COMPOSITE_SOURCES) {
    throw new TypeError("A composite layer must keep at least two sources.");
  }
  if (!Number.isInteger(removedSlot) || removedSlot < 0 || removedSlot >= sourceCount) {
    throw new TypeError("Composite source slot is out of range.");
  }
  const nextCount = sourceCount - 1;
  const next = new Uint8Array(getCompositeBitsetByteLength(nextCount));

  if (removedSlot < 3) {
    // The removed bit is inside each byte. Compact every old byte to a nibble,
    // then pack two adjacent nibbles into one output byte.
    const lookup = LOW_SLOT_REMOVE_LOOKUPS[removedSlot];
    for (let outputIndex = 0; outputIndex < next.byteLength; outputIndex += 1) {
      const inputIndex = outputIndex * 2;
      next[outputIndex] =
        lookup[bitset[inputIndex]] |
        ((inputIndex + 1 < bitset.byteLength
          ? lookup[bitset[inputIndex + 1]]
          : 0) << 4);
    }
    return next;
  }

  // Higher slots divide the packed bitset into byte-aligned 0/1 branches.
  // OR each pair directly so work scales with output bytes, not coverage codes.
  const branchByteLength = 2 ** (removedSlot - 3);
  let outputIndex = 0;
  for (
    let blockStart = 0;
    blockStart < bitset.byteLength;
    blockStart += branchByteLength * 2
  ) {
    const withRemovedStart = blockStart + branchByteLength;
    for (let offset = 0; offset < branchByteLength; offset += 1) {
      next[outputIndex] =
        bitset[blockStart + offset] | bitset[withRemovedStart + offset];
      outputIndex += 1;
    }
  }
  return next;
}

export function reconcileCompositeSources(
  layer,
  nextSourceIds,
  { takeBitsetOwnership = false } = {},
) {
  if (!layer || layer.kind !== COMPOSITE_LAYER_KIND) {
    throw new TypeError("A composite layer is required.");
  }
  if (!Array.isArray(nextSourceIds)) {
    throw new TypeError("Composite source IDs must be an array.");
  }
  if (new Set(nextSourceIds).size !== nextSourceIds.length) {
    throw new TypeError("Composite source IDs must be unique.");
  }
  validateCompositeSourceCount(nextSourceIds.length);

  let slotIds = [...layer.slotSourceIds];
  // The default remains pure for model callers. An edit dialog already owns
  // its draft buffer, so it can transfer that ownership into an add/remove
  // transformation instead of copying as much as 2 MiB first.
  let bitset = takeBitsetOwnership
    ? layer.visibleBitset
    : layer.visibleBitset.slice();
  const pendingAdditions = nextSourceIds.filter((sourceId) => !slotIds.includes(sourceId));
  for (let slot = slotIds.length - 1; slot >= 0; slot -= 1) {
    if (!nextSourceIds.includes(slotIds[slot])) {
      if (slotIds.length <= MIN_COMPOSITE_SOURCES) {
        const sourceId = pendingAdditions.shift();
        if (sourceId === undefined) {
          throw new TypeError("A composite layer must keep at least two sources.");
        }
        bitset = addCompositeSource(bitset, slotIds.length);
        slotIds.push(sourceId);
      }
      bitset = removeCompositeSource(bitset, slotIds.length, slot);
      slotIds.splice(slot, 1);
    }
  }
  for (const sourceId of pendingAdditions) {
    bitset = addCompositeSource(bitset, slotIds.length);
    slotIds.push(sourceId);
  }
  return {
    sourceIds: [...nextSourceIds],
    slotSourceIds: slotIds,
    visibleBitset: bitset,
  };
}

export function validateCompositeBitset(bitset, sourceCount) {
  if (!(bitset instanceof Uint8Array)) {
    throw new TypeError("Composite visible bitset must be a Uint8Array.");
  }
  const expected = getCompositeBitsetByteLength(sourceCount);
  if (bitset.byteLength !== expected) {
    throw new TypeError(
      `Composite visible bitset requires ${expected} bytes for ${sourceCount} sources.`,
    );
  }
}

export function getCompositeSourceSlots(layer) {
  return layer.sourceIds.map((sourceId) => layer.slotSourceIds.indexOf(sourceId));
}
