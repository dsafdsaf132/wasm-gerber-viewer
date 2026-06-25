import {
  MAX_SCREENSHOT_RENDER_TARGET_BYTES,
  MAX_SCREENSHOT_STREAM_BAND_BYTES,
} from "./config.js";
import { formatFileSize, getErrorMessage } from "./file-utils.js";

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

function isDrillLayer(layer) {
  return layer?.kind === "drill";
}

function isBoardOutlineLayer(layer) {
  if (!layer || isDrillLayer(layer)) return false;

  return [layer.name, layer.sourceName, layer.fileName].some(isBoardOutlineName);
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

function getVisibleGerberBounds(layers, { excludeLayer = null } = {}) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (const layer of layers) {
    const bounds = layer.bounds;
    if (
      isDrillLayer(layer) ||
      !layer.visible ||
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
      bounds: outlineLayer.renderBounds ?? outlineLayer.bounds ?? null,
    };
  }

  return resolveInvertedBoundsFillSource(layers, layer, boundsMarginMm);
}

function resolveInvertedBoundsFillSource(layers, layer, boundsMarginMm = 0) {
  const bounds = expandBounds(getVisibleGerberBounds(layers), boundsMarginMm);
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

    this.isExporting = false;
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
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  setExportBusy(isBusy) {
    this.form.classList.toggle("is-exporting", isBusy);
    this.backgroundToggle.disabled = isBusy;
    this.scaleSelect.disabled = isBusy;
    this.cancelButton.disabled = isBusy;
    this.dismissButton.disabled = isBusy;
    this.exportButton.disabled = isBusy;
    this.exportButton.textContent = isBusy ? "Exporting" : "Export";

    if (isBusy) {
      this.setProgress(0, "Rendering");
    } else {
      this.setProgress(0, "Exporting");
    }
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
    this.exportButton.disabled = this.isExporting || Boolean(limitMessage);
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

    if (!this.getWasmProcessor() || this.isWebGlUnavailable()) {
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
    const isTiled = this.shouldTile(exportScale);
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
    this.setExportBusy(isTiled);
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
      this.screenshotButton.disabled = false;
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
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) {
      throw new Error("WebGL2 is unavailable for screenshot export.");
    }

    const wasmModule = this.getWasmModule();
    if (!wasmModule) {
      throw new Error("WASM module is unavailable for screenshot export.");
    }

    const processor = new wasmModule.GerberProcessor();
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
    const drillLayers = [];
    let wasmLayerCount = 0;
    const drillFillColor = includeBackground
      ? hexColorToRgb(renderState.backgroundColor)
      : [0, 0, 0];
    const drillFillBlendMode = includeBackground ? 1 : 2;
    const drillAlpha = renderState.globalAlpha > 0 ? 1 / renderState.globalAlpha : 0;
    const layers = this.getLayers();
    const boardOutlineSelection = this.getBoardOutlineSelection?.() ?? "auto";
    const rawBoardOutlineBoundsMarginMm = Number(
      renderOptions.boardOutlineBoundsMarginMm,
    );
    const boardOutlineBoundsMarginMm = Number.isFinite(
      rawBoardOutlineBoundsMarginMm,
    )
      ? Math.max(0, rawBoardOutlineBoundsMarginMm)
      : 10;
    for (const layer of layers) {
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

      if (!layer.visible) {
        continue;
      }

      const offset = normalizeLayerOffset(layer.offset);
      if (layer.inverted) {
        const fillSource = resolveInvertedFillSource(
          layers,
          layer,
          boardOutlineSelection,
          boardOutlineBoundsMarginMm,
        );
        if (!fillSource) {
          throw new Error("Inverted screenshot export needs a board outline or visible layer bounds.");
        }
        let layerId;
        try {
          layerId = addInvertedLayerToProcessor(processor, layer, fillSource, offset);
        } catch (error) {
          if (fillSource.type !== "outline" || String(boardOutlineSelection ?? "auto") !== "auto") {
            throw error;
          }
          const fallbackSource = resolveInvertedBoundsFillSource(
            layers,
            layer,
            boardOutlineBoundsMarginMm,
          );
          if (!fallbackSource) {
            throw error;
          }
          layerId = addInvertedLayerToProcessor(
            processor,
            layer,
            fallbackSource,
            offset,
          );
        }
        wasmLayerCount += 1;
        gerberRenderLayers.push({
          layerId,
          color: layer.color,
        });
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
      gerberRenderLayers.push({
        layerId,
        color: layer.color,
      });
    }

    const orderedGerberRenderLayers = isStackCompositeMode
      ? [...gerberRenderLayers].reverse()
      : gerberRenderLayers;
    for (const layer of orderedGerberRenderLayers) {
      activeLayerIds.push(layer.layerId);
      colorData.push(layer.color[0], layer.color[1], layer.color[2], 1);
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
          drillAlpha,
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
          drillAlpha,
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
    };
  }

  disposeRenderer(screenshotRenderer) {
    if (!screenshotRenderer) return;

    try {
      screenshotRenderer.processor.clear();
    } catch (error) {
      console.warn("[Export] Failed to dispose screenshot renderer:", error);
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
          );

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
  ) {
    const didResize =
      screenshotRenderer.canvas.width !== tileWidth ||
      screenshotRenderer.canvas.height !== tileHeight;
    if (didResize) {
      screenshotRenderer.canvas.width = tileWidth;
      screenshotRenderer.canvas.height = tileHeight;
      screenshotRenderer.processor.resize();
    }
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
        renderState.globalAlpha,
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
        renderState.globalAlpha,
      );
    }
    screenshotRenderer.gl.finish();
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
