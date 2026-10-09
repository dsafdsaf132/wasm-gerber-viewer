export function createLayerLoadProgress(total) {
  return {
    total,
    completedLayers: 0,
    completedIndices: new Set(),
    partialLayers: new Map(),
    activeLayers: new Map(),
  };
}

export function markLayerLoadComplete(progress, index) {
  if (!progress) return 0;
  if (!progress.completedIndices.has(index)) {
    progress.completedIndices.add(index);
    progress.partialLayers.delete(index);
    progress.activeLayers.delete(index);
    progress.completedLayers = Math.min(progress.total, progress.completedLayers + 1);
  }
  return progress.completedLayers;
}

export function getLayerLoadModalFields(progress, { index, ...fields }) {
  if (Number.isInteger(index) && !progress.completedIndices.has(index)) {
    const previous = progress.activeLayers.get(index);
    progress.activeLayers.set(index, {
      fileName: fields.fileName ?? previous?.fileName,
      stage: fields.stage ?? previous?.stage,
    });
  }
  let firstIndex = Infinity;
  let active = null;
  for (const [candidate, state] of progress.activeLayers) {
    if (candidate < firstIndex) {
      firstIndex = candidate;
      active = state;
    }
  }
  let partial = 0;
  for (const fraction of progress.partialLayers.values()) partial += fraction;
  return {
    ...fields,
    ...(active ?? {}),
    current: progress.completedLayers,
    total: progress.total,
    partial,
    showPercent: true,
  };
}
