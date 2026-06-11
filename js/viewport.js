export function getViewScaleX(camera) {
  return camera.zoom * (camera.flipX ? -1 : 1);
}

export function getViewScaleY(camera) {
  return camera.zoom * (camera.flipY ? -1 : 1);
}

export function clampZoom(zoom, currentZoom, minZoom, maxZoom) {
  if (!Number.isFinite(zoom)) {
    return currentZoom;
  }

  return Math.min(maxZoom, Math.max(minZoom, zoom));
}

export function calculateFitView({
  layers,
  selectedLayerIds,
  canvas,
  drawer,
  isMobileLayout,
}) {
  if (selectedLayerIds.size === 0) return null;

  const selectedLayers = layers.filter((layer) => selectedLayerIds.has(layer.id));
  if (selectedLayers.length === 0) return null;

  const bounds = getLayerBounds(selectedLayers);
  if (
    !bounds ||
    canvas.width === 0 ||
    canvas.height === 0
  ) {
    return null;
  }

  const viewport = getVisibleCanvasViewport({ canvas, drawer, isMobileLayout });
  if (!viewport) return null;

  const boundsWidth = bounds.maxX - bounds.minX;
  const boundsHeight = bounds.maxY - bounds.minY;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const targetX = (viewport.left + viewport.right) / 2;
  const targetY = (viewport.top + viewport.bottom) / 2;

  if (boundsWidth === 0 && boundsHeight === 0) {
    return { centerX, centerY, targetX, targetY, zoom: 2.0 };
  }

  const zoom = getFitZoom(boundsWidth, boundsHeight, viewport);
  return { centerX, centerY, targetX, targetY, zoom };
}

export function getVisibleCanvasViewport({ canvas, drawer, isMobileLayout }) {
  const rect = canvas.getBoundingClientRect();
  if (
    rect.width === 0 ||
    rect.height === 0 ||
    canvas.width === 0 ||
    canvas.height === 0
  ) {
    return null;
  }

  const visibleRect = getVisibleRect(rect, drawer, isMobileLayout);
  const topLeft = canvasLocalPointToCorrected({
    x: visibleRect.left,
    y: visibleRect.top,
    rect,
    canvas,
  });
  const bottomRight = canvasLocalPointToCorrected({
    x: visibleRect.right,
    y: visibleRect.bottom,
    rect,
    canvas,
  });

  return {
    left: topLeft.x,
    right: bottomRight.x,
    top: topLeft.y,
    bottom: bottomRight.y,
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(topLeft.y - bottomRight.y),
  };
}

export function canvasPointToWorld({
  clientX,
  clientY,
  canvas,
  camera,
  rect = null,
}) {
  const viewportRect = rect ?? canvas.getBoundingClientRect();
  if (viewportRect.width === 0 || viewportRect.height === 0) {
    return null;
  }

  const corrected = clientPointToCorrected({
    clientX,
    clientY,
    rect: viewportRect,
    canvas,
  });
  const worldX = (corrected.x - camera.offsetX) / getViewScaleX(camera);
  const worldY = (corrected.y - camera.offsetY) / getViewScaleY(camera);
  return { x: worldX, y: worldY };
}

export function worldToCanvasPoint({
  point,
  canvas,
  camera,
  renderState = null,
  rect = null,
}) {
  const viewportRect = renderState
    ? { width: renderState.rectWidth, height: renderState.rectHeight }
    : rect ?? canvas.getBoundingClientRect();
  if (viewportRect.width === 0 || viewportRect.height === 0) {
    return null;
  }

  const canvasWidth = renderState?.canvasWidth ?? canvas.width;
  const canvasHeight = renderState?.canvasHeight ?? canvas.height;
  const viewScaleX = renderState?.viewScaleX ?? getViewScaleX(camera);
  const viewScaleY = renderState?.viewScaleY ?? getViewScaleY(camera);
  const offsetX = renderState?.offsetX ?? camera.offsetX;
  const offsetY = renderState?.offsetY ?? camera.offsetY;
  const aspect = canvasWidth / canvasHeight;
  const correctedX = point.x * viewScaleX + offsetX;
  const correctedY = point.y * viewScaleY + offsetY;
  const ndcX = aspect > 1.0 ? correctedX / aspect : correctedX;
  const ndcY = aspect > 1.0 ? correctedY : correctedY * aspect;
  return {
    x: ((ndcX + 1) / 2) * viewportRect.width,
    y: ((1 - ndcY) / 2) * viewportRect.height,
  };
}

export function zoomCameraAtCanvasPoint({
  clientX,
  clientY,
  zoomChange,
  canvas,
  camera,
  minZoom,
  maxZoom,
  rect = null,
}) {
  if (!Number.isFinite(zoomChange) || zoomChange <= 0) {
    return false;
  }

  const viewportRect = rect ?? canvas.getBoundingClientRect();
  if (viewportRect.width === 0 || viewportRect.height === 0) {
    return false;
  }

  const corrected = clientPointToCorrected({
    clientX,
    clientY,
    rect: viewportRect,
    canvas,
  });
  const prevZoom = camera.zoom;
  const newZoom = clampZoom(prevZoom * zoomChange, prevZoom, minZoom, maxZoom);
  const zoomRatio = newZoom / prevZoom;

  camera.offsetX = (camera.offsetX - corrected.x) * zoomRatio + corrected.x;
  camera.offsetY = (camera.offsetY - corrected.y) * zoomRatio + corrected.y;
  camera.zoom = newZoom;
  return true;
}

export function panCameraByScreenDelta({ deltaX, deltaY, canvas, camera, rect = null }) {
  const viewportRect = rect ?? canvas.getBoundingClientRect();
  if (viewportRect.width === 0 || viewportRect.height === 0) {
    return false;
  }

  const deltaXNDC = (deltaX / viewportRect.width) * 2;
  const deltaYNDC = (-deltaY / viewportRect.height) * 2;
  const aspect = canvas.width / canvas.height;

  if (aspect > 1.0) {
    camera.offsetX += deltaXNDC * aspect;
    camera.offsetY += deltaYNDC;
  } else {
    camera.offsetX += deltaXNDC;
    camera.offsetY += deltaYNDC / aspect;
  }

  return true;
}

function getLayerBounds(layers) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const layer of layers) {
    if (!layer.bounds) continue;
    minX = Math.min(minX, layer.bounds.minX);
    maxX = Math.max(maxX, layer.bounds.maxX);
    minY = Math.min(minY, layer.bounds.minY);
    maxY = Math.max(maxY, layer.bounds.maxY);
  }

  if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY)) {
    return null;
  }

  return { minX, maxX, minY, maxY };
}

function getFitZoom(boundsWidth, boundsHeight, viewport) {
  if (boundsWidth === 0) {
    return (viewport.height / boundsHeight) * 0.9;
  }
  if (boundsHeight === 0) {
    return (viewport.width / boundsWidth) * 0.9;
  }

  return Math.min(viewport.width / boundsWidth, viewport.height / boundsHeight) *
    0.9;
}

function getVisibleRect(rect, drawer, isMobileLayout) {
  const visibleRect = {
    left: 0,
    top: 0,
    right: rect.width,
    bottom: rect.height,
  };
  const drawerRect = drawer.getBoundingClientRect();
  const intersectsCanvas =
    drawerRect.right > rect.left &&
    drawerRect.left < rect.right &&
    drawerRect.bottom > rect.top &&
    drawerRect.top < rect.bottom;

  if (!intersectsCanvas) {
    return visibleRect;
  }

  if (isMobileLayout()) {
    visibleRect.bottom = Math.max(
      visibleRect.top + 1,
      Math.min(visibleRect.bottom, drawerRect.top - rect.top),
    );
  } else {
    visibleRect.right = Math.max(
      visibleRect.left + 1,
      Math.min(visibleRect.right, drawerRect.left - rect.left),
    );
  }

  return visibleRect;
}

function clientPointToCorrected({ clientX, clientY, rect, canvas }) {
  return canvasLocalPointToCorrected({
    x: clientX - rect.left,
    y: clientY - rect.top,
    rect,
    canvas,
  });
}

function canvasLocalPointToCorrected({ x, y, rect, canvas }) {
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const ndcX = ((x - centerX) / rect.width) * 2;
  const ndcY = -((y - centerY) / rect.height) * 2;
  const aspect = canvas.width / canvas.height;

  return {
    x: aspect > 1.0 ? ndcX * aspect : ndcX,
    y: aspect > 1.0 ? ndcY : ndcY / aspect,
  };
}
