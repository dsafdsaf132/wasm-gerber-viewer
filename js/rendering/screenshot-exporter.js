import {
  MAX_SCREENSHOT_RENDER_TARGET_BYTES,
  MAX_SCREENSHOT_STREAM_BAND_BYTES,
} from "../core/config.js";
import { formatFileSize, getErrorMessage } from "../loading/file-utils.js";

function normalizeLayerOffset(offset = {}) {
  const x = Number(offset.x ?? 0);
  const y = Number(offset.y ?? 0);

  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

function hasLayerOffset(offset) {
  return offset.x !== 0 || offset.y !== 0;
}

function clampAlpha(alpha) {
  const value = Number(alpha);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function normalizeOptionalLayerAlpha(alpha) {
  if (alpha === null || alpha === undefined) return null;
  const value = Number(alpha);
  if (!Number.isFinite(value)) return null;
  return clampAlpha(value);
}

function resolveLayerAlpha(layer, defaultAlpha) {
  const layerAlpha = normalizeOptionalLayerAlpha(layer?.alpha);
  return layerAlpha === null ? clampAlpha(defaultAlpha) : layerAlpha;
}

function isDrillLayer(layer) {
  return layer?.kind === "drill";
}

function isCompositeLayer(layer) {
  return layer?.kind === "composite";
}

function isFatalWasmRuntimeError(error) {
  const message = getErrorMessage(error);
  return (
    (typeof WebAssembly !== "undefined" &&
      error instanceof WebAssembly.RuntimeError) ||
    message.includes("recursive use of an object detected")
  );
}

function isBoardOutlineLayer(layer) {
  if (!layer || isDrillLayer(layer) || isCompositeLayer(layer)) return false;
  return isBoardOutlineName(layer.name);
}

function isBoardOutlineName(name) {
  const normalized = String(name ?? "").toLowerCase();
  const extensionMatch = normalized.match(/\.([a-z0-9]+)(?:\s*#\d+)?$/i);
  const extension = extensionMatch?.[1] ?? "";
  if (
    [
      "gko",
      "gml",
      "gm1",
      "gmb",
      "gbrd",
      "outline",
      "edge",
      "cuts",
    ].includes(extension)
  ) {
    return true;
  }
  if (normalized.includes("outline")) {
    return true;
  }

  return /(^|[^a-z0-9])(edge[-_. ]?cuts?|profile|contour|mechanical|mech|dimension)([^a-z0-9]|$)/i.test(
    normalized,
  );
}

function getDrillOutlineStyle(layer, renderOptions = {}) {
  if (layer?.drillType === "npth") {
    return {
      pixels: Number(renderOptions.drillOutlinePixels ?? 0),
      worldMm: 0,
    };
  }

  return {
    pixels: 0,
    worldMm: Number(renderOptions.pthPlatingMicrometers ?? 20) / 1000,
  };
}

function expandBounds(bounds, amount) {
  const value = Number(amount);
  if (!bounds || !Number.isFinite(value) || value <= 0) {
    return bounds;
  }
  return {
    minX: bounds.minX - value,
    maxX: bounds.maxX + value,
    minY: bounds.minY - value,
    maxY: bounds.maxY + value,
  };
}

function getVisibleGerberBounds(
  layers,
  { excludeLayer = null, includeLayerIds = null } = {},
) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (const layer of layers) {
    const bounds = layer.bounds;
    const includedDependency = includeLayerIds?.has(layer.id) ?? false;
    if (
      isDrillLayer(layer) ||
      isCompositeLayer(layer) ||
      (!layer.visible && !includedDependency) ||
      layer === excludeLayer ||
      !bounds
    ) {
      continue;
    }

    if (
      !Number.isFinite(bounds.minX) ||
      !Number.isFinite(bounds.maxX) ||
      !Number.isFinite(bounds.minY) ||
      !Number.isFinite(bounds.maxY)
    ) {
      continue;
    }

    minX = Math.min(minX, bounds.minX);
    maxX = Math.max(maxX, bounds.maxX);
    minY = Math.min(minY, bounds.minY);
    maxY = Math.max(maxY, bounds.maxY);
    count++;
  }

  if (count === 0 || minX >= maxX || minY >= maxY) {
    return null;
  }

  return { minX, maxX, minY, maxY };
}

function resolveInvertedFillSource(
  layers,
  layer,
  boardOutlineSelection,
  boundsMarginMm,
  includeLayerIds = null,
) {
  const selection = String(boardOutlineSelection ?? "auto");
  const selectedOutlineLayer =
    selection !== "auto" && selection !== "bounds"
      ? layers.find((candidate) => candidate.id === selection)
      : null;
  const outlineLayer =
    selectedOutlineLayer && selectedOutlineLayer !== layer
      ? selectedOutlineLayer
      : selection === "auto"
        ? layers.find(
            (candidate) =>
              candidate !== layer &&
              typeof candidate.sourceContent === "string" &&
              isBoardOutlineLayer(candidate),
          )
        : null;

  if (outlineLayer && typeof outlineLayer.sourceContent === "string") {
    return {
      type: "outline",
      outlineLayer,
      outlineOffset: normalizeLayerOffset(outlineLayer.offset),
      // The outline is rebuilt from its ordinary Gerber source content, so its
      // dependency bounds must describe that raw geometry even when the same
      // layer is displayed inverted.
      bounds: outlineLayer.bounds ?? null,
    };
  }

  return resolveInvertedBoundsFillSource(
    layers,
    layer,
    boundsMarginMm,
    includeLayerIds,
  );
}

function resolveInvertedBoundsFillSource(
  layers,
  layer,
  boundsMarginMm = 0,
  includeLayerIds = null,
) {
  const bounds = expandBounds(
    getVisibleGerberBounds(layers, { includeLayerIds }),
    boundsMarginMm,
  );
  return bounds ? { type: "bounds", bounds } : null;
}

function addInvertedLayerToProcessor(processor, layer, fillSource, offset) {
  if (fillSource.type === "outline") {
    if (typeof processor.add_inverted_layer_with_outline !== "function") {
      throw new Error("Inverted outline screenshot export requires an updated WASM module.");
    }
    return processor.add_inverted_layer_with_outline(
      layer.sourceContent,
      fillSource.outlineLayer.sourceContent,
      offset.x,
      offset.y,
      fillSource.outlineOffset.x,
      fillSource.outlineOffset.y,
    );
  }

  if (typeof processor.add_inverted_layer_with_bounds !== "function") {
    throw new Error("Inverted bounds screenshot export requires an updated WASM module.");
  }
  return processor.add_inverted_layer_with_bounds(
    layer.sourceContent,
    offset.x,
    offset.y,
    fillSource.bounds.minX,
    fillSource.bounds.maxX,
    fillSource.bounds.minY,
    fillSource.bounds.maxY,
  );
}

function hexColorToRgb(color) {
  const match = String(color ?? "").match(/^#([0-9a-f]{6})$/i);
  if (!match) {
    return [0, 0, 0];
  }

  const value = match[1];
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}

export class ScreenshotExporter {
  constructor({
    canvas,
    screenshotButton,
    dialog,
    form,
    backgroundToggle,
    scaleSelect,
    resolution,
    progressLabel,
    progressValue,
    progressBar,
    cancelButton,
    dismissButton,
    exportButton,
    getGl,
    getWasmModule,
    getWasmProcessor,
    getLayers,
    getBoardOutlineSelection,
    getParseOptions,
    getRenderOptions,
    getRenderState,
    isWebGlUnavailable,
    drawMeasurements,
    showError,
    onCompositeError,
  }) {
    this.canvas = canvas;
    this.screenshotButton = screenshotButton;
    this.dialog = dialog;
    this.form = form;
    this.backgroundToggle = backgroundToggle;
    this.scaleSelect = scaleSelect;
    this.resolution = resolution;
    this.progressLabel = progressLabel;
    this.progressValue = progressValue;
    this.progressBar = progressBar;
    this.cancelButton = cancelButton;
    this.dismissButton = dismissButton;
    this.exportButton = exportButton;
    this.getGl = getGl;
    this.getWasmModule = getWasmModule;
    this.getWasmProcessor = getWasmProcessor;
    this.getLayers = getLayers;
    this.getBoardOutlineSelection = getBoardOutlineSelection;
    this.getParseOptions = getParseOptions;
    this.getRenderOptions = getRenderOptions;
    this.getRenderState = getRenderState;
    this.isWebGlUnavailable = isWebGlUnavailable;
    this.drawMeasurements = drawMeasurements;
    this.showError = showError;
    this.onCompositeError = onCompositeError;

    this.isExporting = false;
    this.rendererUnavailable = false;
    this.pngCrcTable = null;
  }

  openDialog() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.showError("Cannot export screenshot because the canvas has no size.");
      return;
    }

    this.updateResolutionPreview();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  closeDialog() {
    if (this.isExporting) return;
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  setExportBusy(isBusy) {
    this.form.classList.toggle("is-exporting", isBusy);
    this.backgroundToggle.disabled = isBusy || this.rendererUnavailable;
    this.scaleSelect.disabled = isBusy || this.rendererUnavailable;
    this.cancelButton.disabled = isBusy;
    this.dismissButton.disabled = isBusy;
    this.exportButton.disabled = isBusy || this.rendererUnavailable;
    this.exportButton.textContent = isBusy ? "Exporting" : "Export";

    if (isBusy) {
      this.setProgress(0, "Rendering");
    } else {
      this.setProgress(0, "Exporting");
    }
  }

  setRendererUnavailable(isUnavailable) {
    this.rendererUnavailable = Boolean(isUnavailable);
    this.screenshotButton.disabled = this.isExporting || this.rendererUnavailable;
    if (this.isExporting) return;
    this.backgroundToggle.disabled = this.rendererUnavailable;
    this.scaleSelect.disabled = this.rendererUnavailable;
    this.updateResolutionPreview();
  }

  setProgress(progress, label = null) {
    const clampedProgress = Math.min(1, Math.max(0, progress));
    const percent = Math.trunc(clampedProgress * 100);

    if (label !== null) {
      this.progressLabel.textContent = label;
    }
    this.progressValue.textContent = `${percent}%`;
    this.progressBar.value = percent;
  }

  getSelectedScale() {
    const scale = Number.parseFloat(this.scaleSelect.value);
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  getDimensions(scale = this.getSelectedScale()) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
    };
  }

  getMaxDimension() {
    const gl = this.getGl();
    if (!gl) return Number.POSITIVE_INFINITY;

    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    return Math.min(maxTextureSize, maxRenderbufferSize);
  }

  updateResolutionPreview() {
    const scale = this.getSelectedScale();
    const { width, height } = this.getDimensions(scale);
    const maxDimension = this.getMaxDimension();
    const limitMessage = this.getExportLimitMessage(
      width,
      height,
      maxDimension,
      scale,
    );

    this.resolution.textContent = limitMessage
      ? `Estimated ${width} x ${height} px · ${limitMessage}`
      : `Estimated ${width} x ${height} px`;
    this.exportButton.disabled =
      this.isExporting || this.rendererUnavailable || Boolean(limitMessage);
  }

  shouldTile(scale) {
    return scale >= 2;
  }

  shouldStream(scale) {
    return scale >= 2 && this.supportsStreaming();
  }

  supportsStreaming() {
    return typeof CompressionStream === "function";
  }

  getExportLimitMessage(width, height, maxDimension, scale) {
    const exceedsGpuLimit = width > maxDimension || height > maxDimension;
    if (!exceedsGpuLimit || this.shouldStream(scale)) {
      return "";
    }

    if (this.shouldTile(scale) && !this.supportsStreaming()) {
      return "streamed PNG export is unavailable in this browser; try a lower resolution";
    }

    return `exceeds ${maxDimension}px GPU limit`;
  }

  async export({ includeBackground = false, scale = 1 } = {}) {
    if (this.isExporting) return false;

    if (
      this.rendererUnavailable ||
      !this.getWasmProcessor() ||
      this.isWebGlUnavailable()
    ) {
      this.showError("Cannot export screenshot while WebGL is unavailable.");
      return false;
    }

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.showError("Cannot export screenshot because the canvas has no size.");
      return false;
    }

    const exportScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const exportWidth = Math.max(1, Math.round(rect.width * exportScale));
    const exportHeight = Math.max(1, Math.round(rect.height * exportScale));
    const maxDimension = this.getMaxDimension();
    const shouldStream = this.shouldStream(exportScale);
    const renderState = this.getRenderState(rect);
    const limitMessage = this.getExportLimitMessage(
      exportWidth,
      exportHeight,
      maxDimension,
      exportScale,
    );
    if (limitMessage) {
      const detail =
        this.shouldTile(exportScale) && !this.supportsStreaming()
          ? "This browser does not support streamed PNG export. Try a lower resolution or a browser with CompressionStream support."
          : `The requested image exceeds this GPU's ${maxDimension}px render limit.`;
      this.showError(
        `Screenshot is too large to export at ${exportWidth} x ${exportHeight}px. ${detail}`,
      );
      return false;
    }

    this.isExporting = true;
    this.screenshotButton.disabled = true;
    this.setExportBusy(true);
    let screenshotRenderer = null;

    try {
      screenshotRenderer = this.createRenderer(renderState, includeBackground);
      let blob = null;

      if (shouldStream) {
        blob = await this.renderStreaming(
          screenshotRenderer,
          exportWidth,
          exportHeight,
          exportScale,
          includeBackground,
          renderState,
        );
      } else {
        blob = await this.renderSingleImage(
          screenshotRenderer,
          exportWidth,
          exportHeight,
          exportScale,
          includeBackground,
          renderState,
        );
      }

      if (!blob) {
        throw new Error(
          `Failed to encode ${exportWidth} x ${exportHeight}px PNG. The requested image may exceed this browser's canvas limit.`,
        );
      }

      this.downloadBlob(blob);
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Export] Failed to export screenshot:", error);
      this.showError(`Failed to export screenshot: ${message}`);
      return false;
    } finally {
      this.disposeRenderer(screenshotRenderer);
      this.isExporting = false;
      this.screenshotButton.disabled = this.rendererUnavailable;
      this.setExportBusy(false);
      this.updateResolutionPreview();
    }
  }

  async renderSingleImage(
    screenshotRenderer,
    exportWidth,
    exportHeight,
    exportScale,
    includeBackground,
    renderState,
  ) {
    const output = document.createElement("canvas");
    output.width = exportWidth;
    output.height = exportHeight;

    const context = output.getContext("2d");
    if (!context) {
      throw new Error(
        `Cannot create ${exportWidth} x ${exportHeight}px screenshot canvas. Try a lower resolution.`,
      );
    }

    if (includeBackground) {
      context.fillStyle = renderState.backgroundColor;
      context.fillRect(0, 0, exportWidth, exportHeight);
    } else {
      context.clearRect(0, 0, exportWidth, exportHeight);
    }

    this.renderSingleTile(
      screenshotRenderer,
      exportWidth,
      exportHeight,
      0,
      0,
      exportWidth,
      exportHeight,
      renderState,
    );
    context.drawImage(screenshotRenderer.canvas, 0, 0, exportWidth, exportHeight);

    context.save();
    context.scale(exportScale, exportScale);
    this.drawMeasurements(context, renderState);
    context.restore();

    return new Promise((resolve) => {
      output.toBlob(resolve, "image/png");
    });
  }

  createRenderer(renderState, includeBackground) {
    const wasmModule = this.getWasmModule();
    if (!wasmModule) {
      throw new Error("WASM module is unavailable for screenshot export.");
    }

    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) {
      throw new Error("WebGL2 is unavailable for screenshot export.");
    }

    let processor = null;
    try {
      processor = new wasmModule.GerberProcessor();
      return this.initializeRenderer(
        canvas,
        gl,
        processor,
        renderState,
        includeBackground,
      );
    } catch (error) {
      this.disposeRenderer({ canvas, gl, processor });
      throw error;
    }
  }

  initializeRenderer(canvas, gl, processor, renderState, includeBackground) {
    processor.init(gl);
    const parseOptions = this.getParseOptions?.() ?? {};
    if (typeof processor.set_interactions_enabled === "function") {
      processor.set_interactions_enabled(false);
    }
    if (typeof processor.set_preserve_arc_regions === "function") {
      processor.set_preserve_arc_regions(
        parseOptions.preserveArcRegions !== false,
      );
    } else if (parseOptions.preserveArcRegions === false) {
      throw new Error("Region arc options require an updated WASM module.");
    }
    if (typeof processor.set_arc_tessellation_quality === "function") {
      processor.set_arc_tessellation_quality(
        Number(parseOptions.arcTessellationQuality ?? 1),
      );
    } else if (
      parseOptions.preserveArcRegions === false &&
      Number(parseOptions.arcTessellationQuality ?? 1) !== 1
    ) {
      throw new Error("Arc tessellation quality requires an updated WASM module.");
    }
    const renderOptions = this.getRenderOptions?.() ?? {};
    const isStackCompositeMode = renderOptions.compositeMode === "stack";
    if (typeof processor.set_minimum_feature_pixels === "function") {
      processor.set_minimum_feature_pixels(
        Number(renderOptions.minimumFeaturePixels ?? 1),
      );
    }

    const activeLayerIds = [];
    const colorData = [];
    const blendModes = [];
    const gerberRenderLayers = [];
    const rendererIdByClientId = new Map();
    const outlineRendererIdByClientId = new Map();
    const effectiveBoundsByClientId = new Map();
    const hiddenDependencyBuildErrors = new Map();
    const drillLayers = [];
    const compositeEntries = [];
    let wasmLayerCount = 0;
    const drillFillColor = includeBackground
      ? hexColorToRgb(renderState.backgroundColor)
      : [0, 0, 0];
    const drillFillBlendMode = includeBackground ? 1 : 2;
    const defaultLayerAlpha = clampAlpha(renderState.globalAlpha);
    const layers = this.getLayers();
    const visibleCompositeLayers = layers.filter(
      (layer) => isCompositeLayer(layer) && layer.visible,
    );
    const compositeSourceLayerIds = new Set(
      visibleCompositeLayers.flatMap((layer) => layer.slotSourceIds),
    );
    const boardOutlineSelection = this.getBoardOutlineSelection?.() ?? "auto";
    const selectedCompositeOutline =
      boardOutlineSelection !== "auto" && boardOutlineSelection !== "bounds"
        ? layers.find(
            (candidate) =>
              candidate.id === boardOutlineSelection &&
              !isDrillLayer(candidate) &&
              !isCompositeLayer(candidate),
          )
        : null;
    const compositeOutline = selectedCompositeOutline ??
      (boardOutlineSelection === "auto"
        ? layers.find(
            (candidate) =>
              !isCompositeLayer(candidate) &&
              typeof candidate.sourceContent === "string" &&
              isBoardOutlineLayer(candidate),
          )
        : null);
    const requiredGerberLayerIds = new Set(compositeSourceLayerIds);
    if (visibleCompositeLayers.length > 0 && compositeOutline) {
      requiredGerberLayerIds.add(compositeOutline.id);
    }
    const rawBoardOutlineBoundsMarginMm = Number(
      renderOptions.boardOutlineBoundsMarginMm,
    );
    const boardOutlineBoundsMarginMm = Number.isFinite(
      rawBoardOutlineBoundsMarginMm,
    )
      ? Math.max(0, rawBoardOutlineBoundsMarginMm)
      : 10;
    for (const layer of layers) {
      if (isCompositeLayer(layer)) {
        continue;
      }
      if (!layer.visible && !requiredGerberLayerIds.has(layer.id)) {
        continue;
      }
      const isolateHiddenDependencyFailure =
        !layer.visible && requiredGerberLayerIds.has(layer.id);
      try {
        if (typeof layer.sourceContent !== "string") {
          throw new Error("Reload files before using high-resolution screenshot export.");
        }

      if (isDrillLayer(layer)) {
        if (typeof processor.add_drill_layer !== "function") {
          throw new Error("Drill screenshot export requires an updated WASM module.");
        }
        const offsetX = Number(layer.offset?.x) || 0;
        const offsetY = Number(layer.offset?.y) || 0;
        let result;
        if (offsetX !== 0 || offsetY !== 0) {
          if (typeof processor.add_drill_layer_with_offset !== "function") {
            throw new Error("Drill screenshot offsets require an updated WASM module.");
          }
          result = processor.add_drill_layer_with_offset(
            layer.sourceContent,
            offsetX,
            offsetY,
          );
        } else {
          result = processor.add_drill_layer(layer.sourceContent);
        }
        wasmLayerCount += 2;
        if (layer.visible) {
          const outlineLayerId = Number(result?.outlineLayerId);
          const outlineStyle = getDrillOutlineStyle(layer, renderOptions);
          if (typeof processor.set_layer_inner_outline === "function") {
            processor.set_layer_inner_outline(
              outlineLayerId,
              outlineStyle.pixels,
              outlineStyle.worldMm,
            );
          } else if (outlineStyle.pixels > 0 || outlineStyle.worldMm > 0) {
            throw new Error("Drill outline export requires an updated WASM module.");
          }
          drillLayers.push({
            outlineLayerId,
            fillLayerId: Number(result?.fillLayerId),
            color: layer.color,
            outlineStyle,
          });
        }
        continue;
      }

      const offset = normalizeLayerOffset(layer.offset);
      if (layer.inverted && (layer.visible || compositeSourceLayerIds.has(layer.id))) {
        if (compositeOutline?.id === layer.id) {
          if (
            hasLayerOffset(offset) &&
            typeof processor.add_layer_with_offset !== "function"
          ) {
            throw new Error("Layer offset requires an updated WASM module.");
          }
          const rawOutlineLayerId = hasLayerOffset(offset)
            ? processor.add_layer_with_offset(layer.sourceContent, offset.x, offset.y)
            : processor.add_layer(layer.sourceContent);
          wasmLayerCount += 1;
          outlineRendererIdByClientId.set(layer.id, Number(rawOutlineLayerId));
        }
        const fillSource = resolveInvertedFillSource(
          layers,
          layer,
          boardOutlineSelection,
          boardOutlineBoundsMarginMm,
          compositeSourceLayerIds,
        );
        if (!fillSource) {
          throw new Error("Inverted screenshot export needs a board outline or visible layer bounds.");
        }
        let layerId;
        let effectiveFillSource = fillSource;
        try {
          layerId = addInvertedLayerToProcessor(processor, layer, fillSource, offset);
        } catch (error) {
          if (
            isFatalWasmRuntimeError(error) ||
            fillSource.type !== "outline" ||
            String(boardOutlineSelection ?? "auto") !== "auto"
          ) {
            throw error;
          }
          const fallbackSource = resolveInvertedBoundsFillSource(
            layers,
            layer,
            boardOutlineBoundsMarginMm,
            compositeSourceLayerIds,
          );
          if (!fallbackSource) {
            throw error;
          }
          effectiveFillSource = fallbackSource;
          layerId = addInvertedLayerToProcessor(
            processor,
            layer,
            fallbackSource,
            offset,
          );
        }
        wasmLayerCount += 1;
        rendererIdByClientId.set(layer.id, Number(layerId));
        effectiveBoundsByClientId.set(
          layer.id,
          effectiveFillSource.bounds ?? layer.renderBounds ?? layer.bounds,
        );
        if (layer.visible) {
          gerberRenderLayers.push({
            clientId: layer.id,
            layerId,
            color: layer.color,
            alpha: resolveLayerAlpha(layer, defaultLayerAlpha),
          });
        }
        continue;
      }

      if (
        hasLayerOffset(offset) &&
        typeof processor.add_layer_with_offset !== "function"
      ) {
        throw new Error("Layer offset requires an updated WASM module.");
      }
      const layerId = hasLayerOffset(offset)
        ? processor.add_layer_with_offset(layer.sourceContent, offset.x, offset.y)
        : processor.add_layer(layer.sourceContent);
      wasmLayerCount += 1;
      rendererIdByClientId.set(layer.id, Number(layerId));
      outlineRendererIdByClientId.set(layer.id, Number(layerId));
      effectiveBoundsByClientId.set(
        layer.id,
        layer.renderBounds ?? layer.bounds,
      );
      if (layer.visible) {
        gerberRenderLayers.push({
          clientId: layer.id,
          layerId,
          color: layer.color,
          alpha: resolveLayerAlpha(layer, defaultLayerAlpha),
        });
      }
      } catch (error) {
        if (!isolateHiddenDependencyFailure || isFatalWasmRuntimeError(error)) {
          throw error;
        }
        hiddenDependencyBuildErrors.set(layer.id, getErrorMessage(error));
      }
    }

    for (const layer of layers) {
      if (!isCompositeLayer(layer) || !layer.visible) continue;
      try {
      const sourceIds = layer.slotSourceIds.map((sourceId) => {
        const dependencyError = hiddenDependencyBuildErrors.get(sourceId);
        if (dependencyError) {
          const sourceName = layers.find(
            (candidate) => candidate.id === sourceId,
          )?.name ?? sourceId;
          throw new Error(
            `Composite source failed to rebuild: ${sourceName}: ${dependencyError}`,
          );
        }
        const rendererId = rendererIdByClientId.get(sourceId);
        if (!Number.isFinite(rendererId)) {
          throw new Error(`Composite source is unavailable: ${sourceId}`);
        }
        return rendererId;
      });
      const outline = compositeOutline;
      const fallbackLayerIds = new Set([
        ...layers
          .filter(
            (candidate) =>
              !isDrillLayer(candidate) &&
              !isCompositeLayer(candidate) &&
              candidate.visible,
          )
          .map((candidate) => candidate.id),
        ...layer.slotSourceIds,
      ]);
      const fallbackLayers = [...fallbackLayerIds]
        .map((clientId) => ({
          id: clientId,
          kind: "gerber",
          visible: true,
          bounds: effectiveBoundsByClientId.get(clientId),
        }))
        .filter((candidate) => candidate.bounds);
      const fallbackBounds = expandBounds(
        getVisibleGerberBounds(fallbackLayers),
        boardOutlineBoundsMarginMm,
      );
      let compositeId;
      if (outline) {
        const outlineRendererId = outlineRendererIdByClientId.get(outline.id);
        if (!Number.isFinite(outlineRendererId)) {
          throw new Error(`Composite outline is unavailable: ${outline.id}`);
        }
        const offset = normalizeLayerOffset(outline.offset);
        try {
          compositeId = processor.add_composite_layer_with_outline_content(
            new Uint32Array(sourceIds),
            layer.visibleBitset,
            Boolean(layer.inverted),
            outlineRendererId,
            outline.sourceContent,
            offset.x,
            offset.y,
          );
        } catch (outlineError) {
          if (
            isFatalWasmRuntimeError(outlineError) ||
            boardOutlineSelection !== "auto" ||
            !fallbackBounds
          ) {
            throw outlineError;
          }
          compositeId = processor.add_composite_layer_with_bounds(
            new Uint32Array(sourceIds),
            layer.visibleBitset,
            Boolean(layer.inverted),
            fallbackBounds.minX,
            fallbackBounds.maxX,
            fallbackBounds.minY,
            fallbackBounds.maxY,
          );
        }
      } else {
        if (!fallbackBounds) {
          throw new Error("Composite screenshot bounds are unavailable.");
        }
        compositeId = processor.add_composite_layer_with_bounds(
          new Uint32Array(sourceIds),
          layer.visibleBitset,
          Boolean(layer.inverted),
          fallbackBounds.minX,
          fallbackBounds.maxX,
          fallbackBounds.minY,
          fallbackBounds.maxY,
        );
      }
      // A visible composite owns an output mask and an internal outline mask.
      // Count the renderer-shared membership scratch conservatively per
      // composite so tile sizing cannot under-estimate the first composite.
      wasmLayerCount += 3;
      compositeEntries.push({ layerId: Number(compositeId), name: layer.name });
      gerberRenderLayers.push({
        clientId: layer.id,
        layerId: Number(compositeId),
        color: layer.color,
        alpha: resolveLayerAlpha(layer, defaultLayerAlpha),
      });
      } catch (error) {
        if (isFatalWasmRuntimeError(error)) throw error;
        this.reportCompositeError(layer.name, getErrorMessage(error));
      }
    }

    gerberRenderLayers.sort(
      (a, b) =>
        layers.findIndex((layer) => layer.id === a.clientId) -
        layers.findIndex((layer) => layer.id === b.clientId),
    );
    const orderedGerberRenderLayers = isStackCompositeMode
      ? [...gerberRenderLayers].reverse()
      : gerberRenderLayers;
    const drillLayerAlpha = 1;
    for (const layer of orderedGerberRenderLayers) {
      activeLayerIds.push(layer.layerId);
      colorData.push(layer.color[0], layer.color[1], layer.color[2], layer.alpha);
      blendModes.push(isStackCompositeMode ? 1 : 0);
    }

    for (const layer of drillLayers) {
      if (
        Number.isFinite(layer.outlineLayerId) &&
        (layer.outlineStyle.pixels > 0 || layer.outlineStyle.worldMm > 0)
      ) {
        activeLayerIds.push(layer.outlineLayerId);
        colorData.push(
          layer.color[0],
          layer.color[1],
          layer.color[2],
          drillLayerAlpha,
        );
        blendModes.push(1);
      }
    }

    for (const layer of drillLayers) {
      if (Number.isFinite(layer.fillLayerId)) {
        activeLayerIds.push(layer.fillLayerId);
        colorData.push(
          drillFillColor[0],
          drillFillColor[1],
          drillFillColor[2],
          drillLayerAlpha,
        );
        blendModes.push(drillFillBlendMode);
      }
    }

    return {
      canvas,
      gl,
      processor,
      layerCount: wasmLayerCount,
      activeLayerIds: new Uint32Array(activeLayerIds),
      colorData: new Float32Array(colorData),
      blendModes: new Uint8Array(blendModes),
      compositeEntries,
      reportedCompositeErrors: new Set(),
      alpha: 1,
    };
  }

  disposeRenderer(screenshotRenderer) {
    if (!screenshotRenderer) return;

    try {
      screenshotRenderer.processor?.clear();
    } catch (error) {
      console.warn("[Export] Failed to dispose screenshot renderer:", error);
    }
    try {
      screenshotRenderer.processor?.free?.();
    } catch (error) {
      console.warn("[Export] Failed to free screenshot processor:", error);
    }

    screenshotRenderer.canvas.width = 0;
    screenshotRenderer.canvas.height = 0;
    if (screenshotRenderer.tileCanvas) {
      screenshotRenderer.tileCanvas.width = 0;
      screenshotRenderer.tileCanvas.height = 0;
    }
    screenshotRenderer.tileContext = null;

    try {
      screenshotRenderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch (error) {
      console.warn("[Export] Failed to release screenshot WebGL context:", error);
    }
  }

  async renderStreaming(
    screenshotRenderer,
    exportWidth,
    exportHeight,
    exportScale,
    includeBackground,
    renderState,
  ) {
    if (typeof CompressionStream !== "function") {
      throw new Error(
        "This browser does not support streamed PNG export. Try a lower resolution.",
      );
    }

    const tileSize = this.getStreamTileDimensions(
      exportWidth,
      exportHeight,
      screenshotRenderer.layerCount,
    );
    this.validateStreamMemory(exportWidth, exportHeight, tileSize);
    const totalTiles =
      Math.ceil(exportWidth / tileSize.width) *
      Math.ceil(exportHeight / tileSize.height);
    await this.preflightStreamingTiles(
      screenshotRenderer,
      exportWidth,
      exportHeight,
      tileSize,
      renderState,
    );
    const expectedCompositeFailureCount =
      screenshotRenderer.reportedCompositeErrors.size;
    const rowStride = this.getPngRowStride(exportWidth);
    const pngParts = [
      this.createPngSignature(),
      this.createPngHeaderChunk(exportWidth, exportHeight),
    ];
    const compressionStream = new CompressionStream("deflate");
    const reader = compressionStream.readable.getReader();
    const writer = compressionStream.writable.getWriter();
    const readCompressed = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pngParts.push(this.createPngChunk("IDAT", value));
      }
    })();
    let tileCount = 0;
    let writeError = null;

    try {
      for (let tileY = 0; tileY < exportHeight; tileY += tileSize.height) {
        const tileHeight = Math.min(tileSize.height, exportHeight - tileY);
        const bandBuffer = this.createBandBuffer(
          exportWidth,
          exportHeight,
          tileHeight,
        );

        for (let tileX = 0; tileX < exportWidth; tileX += tileSize.width) {
          const tileWidth = Math.min(tileSize.width, exportWidth - tileX);
          this.setProgress(tileCount / totalTiles);
          const tileData = this.renderTileToImageData(
            screenshotRenderer,
            exportWidth,
            exportHeight,
            exportScale,
            tileX,
            tileY,
            tileWidth,
            tileHeight,
            includeBackground,
            renderState,
            false,
          );
          if (
            screenshotRenderer.reportedCompositeErrors.size !==
            expectedCompositeFailureCount
          ) {
            throw new Error(
              "A composite failed after screenshot preflight; no mixed PNG was produced.",
            );
          }

          for (let row = 0; row < tileHeight; row += 1) {
            const sourceStart = row * tileWidth * 4;
            const sourceEnd = sourceStart + tileWidth * 4;
            const destStart = row * rowStride + 1 + tileX * 4;
            bandBuffer.set(tileData.subarray(sourceStart, sourceEnd), destStart);
          }

          tileCount += 1;
          this.setProgress(tileCount / totalTiles);
        }

        for (let row = 0; row < tileHeight; row += 1) {
          const rowStart = row * rowStride;
          await writer.write(bandBuffer.subarray(rowStart, rowStart + rowStride));
        }
        await this.yieldToBrowser();
      }

      this.setProgress(1);
      await writer.close();
    } catch (error) {
      writeError = error;
      try {
        await writer.abort(error);
      } catch {
        // The stream may already be closed or errored.
      }
    }

    try {
      await readCompressed;
    } catch (error) {
      if (!writeError) {
        writeError = error;
      }
    }

    if (writeError) {
      throw writeError;
    }

    pngParts.push(this.createPngChunk("IEND", new Uint8Array()));
    return new Blob(pngParts, { type: "image/png" });
  }

  async preflightStreamingTiles(
    screenshotRenderer,
    exportWidth,
    exportHeight,
    tileSize,
    renderState,
  ) {
    if (screenshotRenderer.compositeEntries.length === 0) return;

    for (let tileY = 0; tileY < exportHeight; tileY += tileSize.height) {
      const tileHeight = Math.min(tileSize.height, exportHeight - tileY);
      for (let tileX = 0; tileX < exportWidth; tileX += tileSize.width) {
        const tileWidth = Math.min(tileSize.width, exportWidth - tileX);
        this.renderSingleTile(
          screenshotRenderer,
          exportWidth,
          exportHeight,
          tileX,
          tileY,
          tileWidth,
          tileHeight,
          renderState,
          true,
        );
      }
      await this.yieldToBrowser();
    }
  }

  validateStreamMemory(exportWidth, exportHeight, tileSize) {
    const bandHeight = Math.min(tileSize.height, exportHeight);
    const bandBytes = this.getBandByteLength(exportWidth, bandHeight);

    if (
      !Number.isSafeInteger(bandBytes) ||
      bandBytes > MAX_SCREENSHOT_STREAM_BAND_BYTES
    ) {
      throw new Error(
        this.getMemoryLimitMessage(exportWidth, exportHeight, bandBytes),
      );
    }
  }

  createBandBuffer(exportWidth, exportHeight, bandHeight) {
    const bandBytes = this.getBandByteLength(exportWidth, bandHeight);

    try {
      return new Uint8Array(bandBytes);
    } catch (error) {
      throw new Error(
        this.getMemoryLimitMessage(exportWidth, exportHeight, bandBytes),
        { cause: error },
      );
    }
  }

  getBandByteLength(exportWidth, bandHeight) {
    return this.getPngRowStride(exportWidth) * bandHeight;
  }

  getPngRowStride(width) {
    return 1 + width * 4;
  }

  getMemoryLimitMessage(exportWidth, exportHeight, bandBytes) {
    const memoryText = Number.isFinite(bandBytes)
      ? formatFileSize(bandBytes)
      : "more than this browser can address";

    return [
      `Screenshot is too large to export at ${exportWidth} x ${exportHeight}px.`,
      `It needs about ${memoryText} of temporary browser memory.`,
      "Try a lower resolution.",
    ].join(" ");
  }

  getStreamTileDimensions(exportWidth, exportHeight, layerCount = 1) {
    const rect = this.canvas.getBoundingClientRect();
    const maxDimension = this.getMaxDimension();
    const preferredTileWidth = Math.max(1, Math.round(rect.width * 2));
    const preferredTileHeight = Math.max(1, Math.round(rect.height));
    const tileWidth = Math.max(
      1,
      Math.min(exportWidth, maxDimension, preferredTileWidth),
    );

    const layerTargetCount = Math.max(1, Math.floor(Number(layerCount) || 1)) + 1;
    const rowStride = this.getPngRowStride(exportWidth);
    const heightByBandMemory = Math.floor(
      MAX_SCREENSHOT_STREAM_BAND_BYTES / rowStride,
    );
    const heightByRenderTargets = Math.floor(
      MAX_SCREENSHOT_RENDER_TARGET_BYTES / (tileWidth * 4 * layerTargetCount),
    );
    const tileHeight = Math.min(
      exportHeight,
      maxDimension,
      preferredTileHeight,
      heightByBandMemory,
      heightByRenderTargets,
    );
    if (!Number.isFinite(tileHeight) || tileHeight < 1) {
      throw new Error(
        this.getMemoryLimitMessage(exportWidth, exportHeight, rowStride),
      );
    }

    return {
      width: tileWidth,
      height: Math.max(1, Math.floor(tileHeight)),
    };
  }

  renderTileToImageData(
    screenshotRenderer,
    exportWidth,
    exportHeight,
    exportScale,
    tileX,
    tileY,
    tileWidth,
    tileHeight,
    includeBackground,
    renderState,
    allowCompositeDiscovery = true,
  ) {
    this.renderSingleTile(
      screenshotRenderer,
      exportWidth,
      exportHeight,
      tileX,
      tileY,
      tileWidth,
      tileHeight,
      renderState,
      allowCompositeDiscovery,
    );

    const context = this.getTileContext(screenshotRenderer, tileWidth, tileHeight);

    if (includeBackground) {
      context.fillStyle = renderState.backgroundColor;
      context.fillRect(0, 0, tileWidth, tileHeight);
    } else {
      context.clearRect(0, 0, tileWidth, tileHeight);
    }

    context.drawImage(screenshotRenderer.canvas, 0, 0, tileWidth, tileHeight);
    context.save();
    context.scale(exportScale, exportScale);
    context.translate(-tileX / exportScale, -tileY / exportScale);
    this.drawMeasurements(context, renderState);
    context.restore();

    return context.getImageData(0, 0, tileWidth, tileHeight).data;
  }

  getTileContext(screenshotRenderer, tileWidth, tileHeight) {
    if (!screenshotRenderer.tileCanvas) {
      screenshotRenderer.tileCanvas = document.createElement("canvas");
    }

    const tileCanvas = screenshotRenderer.tileCanvas;
    if (tileCanvas.width !== tileWidth) {
      tileCanvas.width = tileWidth;
    }
    if (tileCanvas.height !== tileHeight) {
      tileCanvas.height = tileHeight;
    }

    if (!screenshotRenderer.tileContext) {
      screenshotRenderer.tileContext = tileCanvas.getContext("2d", {
        willReadFrequently: true,
      });
    }
    if (!screenshotRenderer.tileContext) {
      throw new Error("Cannot create screenshot tile canvas.");
    }

    return screenshotRenderer.tileContext;
  }

  downloadBlob(blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gerber-viewer-${this.getTimestampForFileName()}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  getTimestampForFileName() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  createPngSignature() {
    return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  }

  createPngHeaderChunk(width, height) {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);
    view.setUint32(0, width, false);
    view.setUint32(4, height, false);
    data[8] = 8;
    data[9] = 6;
    data[10] = 0;
    data[11] = 0;
    data[12] = 0;
    return this.createPngChunk("IHDR", data);
  }

  createPngChunk(type, data) {
    const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
    const chunk = new Uint8Array(12 + payload.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, payload.length, false);

    for (let index = 0; index < 4; index += 1) {
      chunk[4 + index] = type.charCodeAt(index);
    }

    chunk.set(payload, 8);
    view.setUint32(
      8 + payload.length,
      this.pngCrc32(chunk.subarray(4, 8 + payload.length)),
      false,
    );
    return chunk;
  }

  pngCrc32(bytes) {
    const table = this.getPngCrcTable();
    let crc = 0xffffffff;

    for (const byte of bytes) {
      crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  getPngCrcTable() {
    if (this.pngCrcTable) {
      return this.pngCrcTable;
    }

    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }

    this.pngCrcTable = table;
    return table;
  }

  renderSingleTile(
    screenshotRenderer,
    exportWidth,
    exportHeight,
    tileX,
    tileY,
    tileWidth,
    tileHeight,
    renderState,
    allowCompositeDiscovery = true,
  ) {
    const didResize =
      screenshotRenderer.canvas.width !== tileWidth ||
      screenshotRenderer.canvas.height !== tileHeight;
    if (didResize) {
      screenshotRenderer.canvas.width = tileWidth;
      screenshotRenderer.canvas.height = tileHeight;
      screenshotRenderer.processor.resize();
    }
    for (;;) {
      if (screenshotRenderer.blendModes.some((mode) => mode !== 0)) {
        if (typeof screenshotRenderer.processor.render_tile_with_blend_modes !== "function") {
          throw new Error("Stack compositing and drill screenshot rendering require an updated WASM module.");
        }
        screenshotRenderer.processor.render_tile_with_blend_modes(
          screenshotRenderer.activeLayerIds,
          screenshotRenderer.colorData,
          screenshotRenderer.blendModes,
          exportWidth,
          exportHeight,
          tileX,
          tileY,
          tileWidth,
          tileHeight,
          renderState.viewScaleX,
          renderState.viewScaleY,
          renderState.offsetX,
          renderState.offsetY,
          screenshotRenderer.alpha,
        );
      } else {
        screenshotRenderer.processor.render_tile(
          screenshotRenderer.activeLayerIds,
          screenshotRenderer.colorData,
          exportWidth,
          exportHeight,
          tileX,
          tileY,
          tileWidth,
          tileHeight,
          renderState.viewScaleX,
          renderState.viewScaleY,
          renderState.offsetX,
          renderState.offsetY,
          screenshotRenderer.alpha,
        );
      }
      const removedCount = this.handleCompositeRenderErrors(screenshotRenderer);
      if (removedCount === 0) break;
      if (!allowCompositeDiscovery) {
        throw new Error(
          "A composite failed after screenshot preflight; no mixed PNG was produced.",
        );
      }
    }
    screenshotRenderer.gl.finish();
  }

  handleCompositeRenderErrors(screenshotRenderer) {
    if (screenshotRenderer.compositeEntries.length === 0) return 0;
    const { processor } = screenshotRenderer;
    if (typeof processor.get_composite_error !== "function") {
      throw new Error("Composite screenshot diagnostics require an updated WASM module.");
    }
    const failedLayerIds = new Set();
    for (const entry of screenshotRenderer.compositeEntries) {
      const error = processor.get_composite_error(entry.layerId);
      if (!error) continue;
      failedLayerIds.add(entry.layerId);
      const key = `${entry.layerId}:${error}`;
      if (screenshotRenderer.reportedCompositeErrors.has(key)) continue;
      screenshotRenderer.reportedCompositeErrors.add(key);
      this.reportCompositeError(entry.name, error);
    }
    if (failedLayerIds.size === 0) return 0;

    const activeLayerIds = [];
    const colorData = [];
    const blendModes = [];
    for (let index = 0; index < screenshotRenderer.activeLayerIds.length; index += 1) {
      if (failedLayerIds.has(screenshotRenderer.activeLayerIds[index])) continue;
      activeLayerIds.push(screenshotRenderer.activeLayerIds[index]);
      blendModes.push(screenshotRenderer.blendModes[index]);
      const colorOffset = index * 4;
      colorData.push(
        screenshotRenderer.colorData[colorOffset],
        screenshotRenderer.colorData[colorOffset + 1],
        screenshotRenderer.colorData[colorOffset + 2],
        screenshotRenderer.colorData[colorOffset + 3],
      );
    }
    screenshotRenderer.activeLayerIds = new Uint32Array(activeLayerIds);
    screenshotRenderer.colorData = new Float32Array(colorData);
    screenshotRenderer.blendModes = new Uint8Array(blendModes);
    screenshotRenderer.compositeEntries = screenshotRenderer.compositeEntries.filter(
      (entry) => !failedLayerIds.has(entry.layerId),
    );
    return failedLayerIds.size;
  }

  reportCompositeError(name, error) {
    try {
      this.onCompositeError?.({ name, error });
    } catch (_error) {
      // Diagnostics cannot turn an isolated composite failure into a failed
      // screenshot export.
    }
  }

  yieldToBrowser() {
    if (globalThis.scheduler?.yield) {
      return globalThis.scheduler.yield();
    }

    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
