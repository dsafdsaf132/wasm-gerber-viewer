import {
  DEFAULT_BACKGROUND,
  COMPOSITE_MODE_STACK,
  LAYER_KIND_COMPOSITE,
  FrameState,
  PNG_SIGNATURE,
  addDrillLayerToProcessor,
  addLayerToProcessor,
  applyProcessorOptions,
  boundaryToPlainObject,
  clamp01,
  createBaseFrameOptions,
  createCompositeVisibleBitset,
  createPngHeader,
  expandBounds,
  getPngChannelCount,
  getPngColorType,
  getPngRowStride,
  getSourceName,
  hasDrillOutlineStyle,
  isDrillLayerKind,
  loadWasmJsModule,
  normalizeDrillOutlineColor,
  normalizeColor,
  normalizeLayerKind,
  normalizeLayer,
  normalizeLayerList,
  mergeBounds,
  numberOrDefault,
  optionalAlpha,
  resolveDrillRenderColors,
  resolveFrameFitPadding,
  parseColor,
  positiveIntegerOrDefault,
  renderLayersBestEffort,
  resolveFrameView,
  resolveLayerAlpha,
  setDefaultDrillInnerOutline,
  sourceToText,
  pngChunk,
  validatePngDimensions,
  validateCompositeSourceCount,
  writePixelRowsToPngRows,
} from "./shared.js";

const DEFAULT_STREAM_EXPORT_BAND_BYTES = 128 * 1024 * 1024;

export async function createGerberRenderer(canvas, rendererOptions = {}) {
  return GerberRenderer.create(canvas, rendererOptions);
}

export async function renderGerberToCanvas(
  canvas,
  layers,
  frameOptions = {},
) {
  const renderer = await createGerberRenderer(canvas, {
    releaseContext: false,
    ...(frameOptions.rendererOptions || {}),
  });

  try {
    await renderer.withFrame(frameOptions, async () => {
      await renderer.renderLayers(layers, frameOptions);
    });
  } finally {
    renderer.dispose();
  }
}

export async function renderGerberToPng(
  canvas,
  layers,
  frameOptions = {},
  exportOptions = {},
) {
  const renderFrameOptions = {
    ...frameOptions,
    ...("background" in exportOptions
      ? { background: exportOptions.background }
      : {}),
  };
  const renderer = await createGerberRenderer(
    canvas,
    {
      releaseContext: false,
      ...(renderFrameOptions.rendererOptions || {}),
    },
  );

  try {
    await renderer.withFrame(renderFrameOptions, async () => {
      await renderer.renderLayers(layers, renderFrameOptions);
    });
    return await renderer.exportPng({
      background: renderFrameOptions.background,
      ...exportOptions,
    });
  } finally {
    renderer.dispose();
  }
}

export async function renderGerberToPngStream(
  canvas,
  writable,
  layers,
  frameOptions = {},
  exportOptions = {},
) {
  const renderFrameOptions = {
    ...frameOptions,
    ...("background" in exportOptions
      ? { background: exportOptions.background }
      : {}),
  };
  const renderer = await createGerberRenderer(
    canvas,
    {
      releaseContext: false,
      ...(renderFrameOptions.rendererOptions || {}),
    },
  );

  try {
    await renderer.withFrame(renderFrameOptions, async () => {
      await renderer.renderLayers(layers, renderFrameOptions);
    });
    await renderer.exportPngStream(writable, {
      background: renderFrameOptions.background,
      ...exportOptions,
    });
  } finally {
    renderer.dispose();
  }
}

export class GerberRenderer {
  static async create(canvas, rendererOptions = {}) {
    const wasmModule = await loadWasmModule(rendererOptions);
    if (typeof wasmModule.default === "function") {
      await wasmModule.default(rendererOptions.wasmInitInput);
    }
    return new GerberRenderer(canvas, rendererOptions, wasmModule);
  }

  constructor(canvas, rendererOptions, wasmModule) {
    if (!canvas || typeof canvas.getContext !== "function") {
      throw new TypeError("A canvas with getContext() is required.");
    }

    this.canvas = canvas;
    this.rendererOptions = { ...rendererOptions };
    this.wasmModule = wasmModule;
    this.gl = null;
    this.frame = null;
    this.lastFrame = null;
    this.activeExport = false;
    this.disposed = false;
    this.nextPublicLayerId = 0;
  }

  async withFrame(frameOptions = {}, callback) {
    this.assertUsable();
    if (this.frame) {
      throw new Error("A render frame is already active.");
    }
    if (this.activeExport) {
      throw new Error("Cannot start a render frame while an export is active.");
    }
    if (typeof callback !== "function") {
      throw new TypeError("withFrame requires a callback.");
    }

    const normalizedFrameOptions = normalizeFrameOptions(frameOptions);
    // Canvas sizing and rendering are not transactional. Invalidate the prior
    // result before prepareCanvas mutates it, and publish a new result only
    // after renderFrame completes successfully.
    this.lastFrame = null;
    this.prepareCanvas(normalizedFrameOptions);

    const processor = new this.wasmModule.GerberProcessor();
    try {
      const gl = this.getContext();
      if (gl.canvas != null || typeof processor.init_with_size !== "function") {
        processor.init(gl);
      } else {
        processor.init_with_size(gl, this.canvas.width, this.canvas.height);
      }
      applyProcessorOptions(processor, normalizedFrameOptions);

      this.frame = new FrameState(normalizedFrameOptions, { processor });
      await callback();
      this.refreshFrameCompositeFallbackBounds();
      this.renderFrame();
    } finally {
      this.disposeFrameProcessor(processor);
      this.frame = null;
    }
  }

  async renderLayer(layer, layerOptions = {}) {
    this.assertUsable();
    if (!this.frame) {
      throw new Error("renderLayer must be called inside withFrame().");
    }

    const layerRecord = await this.createLayerRecord(layer, layerOptions);
    if (!layerRecord) {
      return null;
    }
    layerRecord.id = this.reservePublicLayerId();
    this.frame.addLayer(layerRecord);
    return layerRecord.id;
  }

  async renderLayers(layers, options = {}) {
    this.assertUsable();
    if (!this.frame) {
      throw new Error("renderLayers must be called inside withFrame().");
    }

    return renderLayersBestEffort(this, normalizeLayerList(layers), options);
  }

  async renderCompositeLayer(sourceLayerIds, options = {}) {
    this.assertUsable();
    if (!this.frame) {
      throw new Error("renderCompositeLayer must be called inside withFrame().");
    }
    if (!Array.isArray(sourceLayerIds)) {
      throw new TypeError("sourceLayerIds must be an ordered array of layer IDs.");
    }
    const sourceCount = validateCompositeSourceCount(sourceLayerIds.length);
    const sourceIds = new Array(sourceCount);
    for (let index = 0; index < sourceCount; index += 1) {
      sourceIds[index] = sourceLayerIds[index];
    }
    if (new Set(sourceIds).size !== sourceCount) {
      throw new TypeError("Composite source layer IDs must be unique.");
    }
    const sourceLayers = sourceIds.map((sourceLayerId) => {
      if (!Number.isInteger(sourceLayerId)) {
        throw new TypeError("Composite source layer IDs must be integers.");
      }
      const layer = this.frame.layers.find(
        (candidate) => getPublicLayerId(candidate) === sourceLayerId,
      );
      if (!layer) {
        throw new Error(`Invalid or stale composite source layer ID: ${sourceLayerId}`);
      }
      if (isDrillLayerKind(layer.kind) || layer.kind === LAYER_KIND_COMPOSITE) {
        throw new TypeError("Composite sources must be ordinary Gerber layers.");
      }
      return layer;
    });
    const visibleBits = createCompositeVisibleBitset(sourceLayers.length, options);
    const inverted = options.inverted === true;
    const outlineLayer = resolveCompositeOutlineLayer(this.frame, options.outlineLayerId);
    const color =
      options.color == null
        ? null
        : normalizeBrowserCompositeColor(
            options.color,
            this.frame.options.colors[0],
          );
    const alpha = optionalAlpha(options.alpha);
    const visible = options.visible !== false;
    const compositeNumber =
      this.frame.layers.filter((layer) => layer.kind === LAYER_KIND_COMPOSITE).length + 1;
    const name = options.name || `Composite ${compositeNumber}`;
    let layerId;
    if (outlineLayer) {
      if (typeof outlineLayer.content !== "string") {
        throw new Error("Composite outline source content is unavailable.");
      }
      layerId = this.frame.processor.add_composite_layer_with_outline_content(
        new Uint32Array(sourceLayers.map((layer) => layer.layerId)),
        visibleBits,
        inverted,
        outlineLayer.layerId,
        outlineLayer.content,
        outlineLayer.offsetX,
        outlineLayer.offsetY,
      );
    } else {
      const bounds = resolveCompositeFallbackBounds(this.frame, sourceLayers);
      if (!bounds) {
        throw new Error("Composite layer needs a board outline or finite bounds.");
      }
      layerId = this.frame.processor.add_composite_layer_with_bounds(
        new Uint32Array(sourceLayers.map((layer) => layer.layerId)),
        visibleBits,
        inverted,
        bounds.minX,
        bounds.maxX,
        bounds.minY,
        bounds.maxY,
      );
    }
    const bounds = boundaryToPlainObject(
      this.frame.processor.get_layer_boundary(layerId),
    );
    const id = this.reservePublicLayerId();
    this.frame.addLayer({
      id,
      kind: LAYER_KIND_COMPOSITE,
      layerId,
      name,
      bounds,
      color: color ?? this.frame.nextColor(),
      alpha,
      visible,
      sourceLayerIds: sourceIds,
      visibleBits,
      inverted,
      outlineLayerId: outlineLayer ? getPublicLayerId(outlineLayer) : null,
      fallbackBounds: outlineLayer ? null : bounds,
    });
    return id;
  }

  refreshFrameCompositeFallbackBounds() {
    const frame = this.frame;
    if (!frame) return;
    for (const layer of frame.layers) {
      if (layer.kind !== LAYER_KIND_COMPOSITE || layer.outlineLayerId != null) {
        continue;
      }
      const sourceLayers = layer.sourceLayerIds.map((sourceLayerId) =>
        frame.layers.find(
          (candidate) => getPublicLayerId(candidate) === sourceLayerId,
        ),
      );
      if (sourceLayers.some((sourceLayer) => !sourceLayer)) {
        throw new Error(`Composite ${layer.name} has an unavailable source layer.`);
      }
      const bounds = resolveCompositeFallbackBounds(frame, sourceLayers);
      if (!bounds) {
        throw new Error(`Composite ${layer.name} needs finite fallback bounds.`);
      }
      if (typeof frame.processor.set_composite_bounds !== "function") {
        throw new Error("Composite fallback updates require an updated WASM renderer.");
      }
      frame.processor.set_composite_bounds(
        layer.layerId,
        bounds.minX,
        bounds.maxX,
        bounds.minY,
        bounds.maxY,
      );
      layer.fallbackBounds = bounds;
      layer.bounds = boundaryToPlainObject(
        frame.processor.get_layer_boundary(layer.layerId),
      );
    }
    frame.bounds = null;
    for (const layer of frame.layers) {
      if (layer.visible !== false) {
        frame.bounds = mergeBounds(frame.bounds, layer.bounds);
      }
    }
  }

  async exportPng(exportOptions = {}) {
    this.assertUsable();
    const completedFrame = this.beginExport();
    try {
      const type = exportOptions.type || "image/png";
      const quality = exportOptions.quality;
      const background =
        "background" in exportOptions
          ? exportOptions.background
          : (completedFrame.background ?? DEFAULT_BACKGROUND);

      if (background == null) {
        return await canvasToBlob(this.canvas, type, quality);
      }
      const cssBackground = normalizeCssColor(background);

      const output = createOutputCanvas(this.canvas.width, this.canvas.height);
      if (!output) {
        return await canvasToBlob(this.canvas, type, quality);
      }

      const context = output.getContext("2d");
      if (!context) {
        return await canvasToBlob(this.canvas, type, quality);
      }

      context.fillStyle = cssBackground;
      context.fillRect(0, 0, output.width, output.height);
      context.drawImage(this.canvas, 0, 0);
      return await canvasToBlob(output, type, quality);
    } finally {
      this.activeExport = false;
    }
  }

  async exportPngStream(writable, exportOptions = {}) {
    this.assertUsable();
    const completedFrame = this.beginExport();
    try {
      const type = exportOptions.type || "image/png";
      if (type !== "image/png") {
        throw new TypeError("Streaming export only supports image/png.");
      }

      const background =
        "background" in exportOptions
          ? exportOptions.background
          : (completedFrame.background ?? DEFAULT_BACKGROUND);

      await streamCanvasToPng(
        this.canvas,
        this.getContext(),
        writable,
        background,
        exportOptions,
      );
    } finally {
      this.activeExport = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    if (this.frame) {
      throw new Error("Cannot dispose GerberRenderer while a render frame is active.");
    }
    if (this.activeExport) {
      throw new Error("Cannot dispose GerberRenderer while an export is active.");
    }
    this.disposed = true;
    this.frame = null;
    this.lastFrame = null;

    if (this.rendererOptions.releaseContext !== false && this.gl) {
      try {
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch (_error) {
        // Best-effort cleanup.
      }
    }
  }

  async createLayerRecord(layer, layerOptions) {
    const { source, options } = normalizeLayer(layer, layerOptions);
    const offsetX = numberOrDefault(options.offsetX, 0);
    const offsetY = numberOrDefault(options.offsetY, 0);
    const initialKind = normalizeLayerKind(options.kind, source, options.name);
    if (isDrillLayerKind(initialKind) && !this.frame.options.renderDrills) {
      return null;
    }
    const content = await sourceToText(source);
    const kind = isDrillLayerKind(initialKind)
      ? initialKind
      : normalizeLayerKind(options.kind, source, options.name, content);
    if (isDrillLayerKind(kind)) {
      if (!this.frame.options.renderDrills) {
        return null;
      }
      const result = addDrillLayerToProcessor(
        this.frame.processor,
        content,
        offsetX,
        offsetY,
      );
      const outlineLayerId = Number(result?.outlineLayerId);
      const fillLayerId = Number(result?.fillLayerId);
      if (!Number.isInteger(outlineLayerId) || !Number.isInteger(fillLayerId)) {
        throw new Error("Drill rendering did not return layer IDs.");
      }
      const name = options.name || getSourceName(source) || `Layer ${outlineLayerId}`;
      const outlineStyle = setDefaultDrillInnerOutline(
        this.frame.processor,
        outlineLayerId,
        name,
      );
      const bounds = boundaryToPlainObject(
        this.frame.processor.get_layer_boundary(outlineLayerId),
      );
      const expandedBounds = expandBounds(bounds, outlineStyle.worldMm);
      const color = normalizeDrillOutlineColor(options.color, {
        allowString: true,
        name,
      });
      const alpha = optionalAlpha(options.alpha);
      return {
        kind,
        layerId: outlineLayerId,
        outlineLayerId,
        fillLayerId,
        name,
        bounds: expandedBounds,
        color,
        alpha,
        outlineStyle,
        visible: options.visible !== false,
      };
    }

    const layerId = addLayerToProcessor(
      this.frame.processor,
      content,
      offsetX,
      offsetY,
    );
    const bounds = boundaryToPlainObject(
      this.frame.processor.get_layer_boundary(layerId),
    );
    const color =
      options.color == null
        ? this.frame.nextColor()
        : normalizeColor(options.color, this.frame.options.colors[0]);
    const alpha = optionalAlpha(options.alpha);

    return {
      kind,
      layerId,
      name: options.name || getSourceName(source) || `Layer ${layerId}`,
      bounds,
      color,
      alpha,
      visible: options.visible !== false,
      content,
      offsetX,
      offsetY,
    };
  }

  renderFrame() {
    const frame = this.frame;
    if (!frame) {
      throw new Error("No active frame to render.");
    }

    const gl = this.getContext();
    const clear = frame.options.clear !== false;
    if (frame.layers.length === 0) {
      if (clear) {
        clearCanvas(gl, this.canvas);
      }
      this.lastFrame = frame.toResult(null);
      return;
    }

    const view = resolveFrameView(
      {
        ...frame.options,
        padding: resolveFrameFitPadding(frame.options, frame.layers),
      },
      frame.bounds,
      this.canvas.width,
      this.canvas.height,
    );
    const globalAlpha = clamp01(numberOrDefault(frame.options.globalAlpha, 1));
    const renderEntries = createRenderEntries(
      frame.layers,
      globalAlpha,
      frame.options.background,
      frame.options.compositeMode,
    );
    const activeLayerIds = new Uint32Array(renderEntries.map((entry) => entry.layerId));
    const blendModes = new Uint8Array(renderEntries.map((entry) => entry.blendMode));

    if (typeof frame.processor.render_with_clear === "function") {
      const colorData = new Float32Array(
        renderEntries.flatMap((entry) => [
          entry.color[0],
          entry.color[1],
          entry.color[2],
          entry.alpha,
        ]),
      );
      if (blendModes.some((mode) => mode !== 0)) {
        if (typeof frame.processor.render_with_clear_and_blend_modes !== "function") {
          throw new Error("Stack compositing and drill rendering require an updated WASM renderer.");
        }
        frame.processor.render_with_clear_and_blend_modes(
          activeLayerIds,
          colorData,
          blendModes,
          view.zoomX,
          view.zoomY,
          view.offsetX,
          view.offsetY,
          1,
          clear,
        );
      } else {
        frame.processor.render_with_clear(
          activeLayerIds,
          colorData,
          view.zoomX,
          view.zoomY,
          view.offsetX,
          view.offsetY,
          1,
          clear,
        );
      }
    } else {
      if (!clear) {
        throw new Error("clear:false requires an updated WASM renderer.");
      }
      if (
        frame.layers.some((layer) => layer.alpha != null) ||
        frame.layers.some((layer) => isDrillLayerKind(layer.kind)) ||
        frame.options.compositeMode === COMPOSITE_MODE_STACK
      ) {
        throw new Error("Layer alpha, stack compositing, and drill rendering require an updated WASM renderer.");
      }
      const colorData = new Float32Array(
        renderEntries.flatMap((entry) => entry.color),
      );
      frame.processor.render(
        activeLayerIds,
        colorData,
        view.zoomX,
        view.zoomY,
        view.offsetX,
        view.offsetY,
        globalAlpha,
      );
    }

    assertNoCompositeRenderErrors(frame.processor, frame.layers);

    this.lastFrame = frame.toResult(view);
  }

  getContext() {
    if (this.gl) return this.gl;

    const contextAttributes = {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
      ...(this.rendererOptions.contextAttributes || {}),
    };
    const gl = this.canvas.getContext("webgl2", contextAttributes);
    if (!gl) {
      throw new Error("WebGL2 is unavailable.");
    }

    this.gl = gl;
    return gl;
  }

  prepareCanvas(frameOptions) {
    const width = positiveIntegerOrDefault(
      frameOptions.width,
      this.canvas.width || this.canvas.clientWidth || 1,
    );
    const height = positiveIntegerOrDefault(
      frameOptions.height,
      this.canvas.height || this.canvas.clientHeight || 1,
    );

    if (this.canvas.width !== width) {
      this.canvas.width = width;
    }
    if (this.canvas.height !== height) {
      this.canvas.height = height;
    }

    frameOptions.width = width;
    frameOptions.height = height;
  }

  disposeFrameProcessor(processor) {
    try {
      processor.clear();
    } catch (_error) {
      // The canvas result is already rendered; cleanup failures should not hide it.
    }
    try {
      processor.free?.();
    } catch (_error) {
      // The context may already be unrecoverable; cleanup is best-effort.
    }
  }

  assertUsable() {
    if (this.disposed) {
      throw new Error("GerberRenderer has been disposed.");
    }
  }

  assertRenderedFrameAvailable() {
    if (this.frame) {
      throw new Error("Cannot export while a render frame is active.");
    }
    if (!this.lastFrame) {
      throw new Error("No successfully completed browser frame is available to export.");
    }
  }

  beginExport() {
    this.assertRenderedFrameAvailable();
    if (this.activeExport) {
      throw new Error("A browser export is already active.");
    }
    this.activeExport = true;
    return this.lastFrame;
  }

  reservePublicLayerId() {
    while (
      this.frame?.layers.some(
        (layer) => getPublicLayerId(layer) === this.nextPublicLayerId,
      )
    ) {
      this.nextPublicLayerId += 1;
    }
    if (!Number.isSafeInteger(this.nextPublicLayerId)) {
      throw new Error("Layer ID space is exhausted.");
    }
    const id = this.nextPublicLayerId;
    this.nextPublicLayerId += 1;
    return id;
  }
}

function assertNoCompositeRenderErrors(processor, layers) {
  const composites = layers.filter(
    (layer) => layer.kind === LAYER_KIND_COMPOSITE && layer.visible !== false,
  );
  if (composites.length === 0) return;
  if (typeof processor.get_composite_error !== "function") {
    throw new Error("Composite error reporting requires an updated WASM renderer.");
  }
  for (const layer of composites) {
    const error = processor.get_composite_error(layer.layerId);
    if (error) {
      throw new Error(`Composite ${layer.name} failed: ${error}`);
    }
  }
}

function createRenderEntries(layers, globalAlpha, background, compositeMode) {
  const entries = [];
  const drillColors = resolveDrillRenderColors(background);
  const gerberBlendMode = compositeMode === COMPOSITE_MODE_STACK ? 1 : 0;
  const gerberDefaultAlpha =
    compositeMode === COMPOSITE_MODE_STACK ? 1 : globalAlpha;

  for (const layer of layers) {
    if (layer.visible !== false && !isDrillLayerKind(layer.kind)) {
      entries.push({
        layerId: layer.layerId,
        color: layer.color,
        alpha: resolveLayerAlpha(layer.alpha, gerberDefaultAlpha),
        blendMode: gerberBlendMode,
      });
    }
  }

  for (const layer of layers) {
    if (
      layer.visible !== false &&
      isDrillLayerKind(layer.kind) &&
      hasDrillOutlineStyle(layer.outlineStyle)
    ) {
      entries.push({
        layerId: layer.outlineLayerId,
        color: layer.color,
        alpha: resolveLayerAlpha(layer.alpha, 1),
        blendMode: 1,
      });
    }
  }

  for (const layer of layers) {
    if (layer.visible !== false && isDrillLayerKind(layer.kind)) {
      const alpha = resolveLayerAlpha(layer.alpha, 1);
      entries.push({
        layerId: layer.fillLayerId,
        color: drillColors.fill,
        alpha,
        blendMode: drillColors.hasBackground ? 1 : 2,
      });
    }
  }

  return entries;
}

function resolveCompositeOutlineLayer(frame, outlineLayerId) {
  if (outlineLayerId == null) return null;
  if (!Number.isInteger(outlineLayerId)) {
    throw new TypeError("outlineLayerId must be an integer Gerber layer ID.");
  }
  const layer = frame.layers.find(
    (candidate) => getPublicLayerId(candidate) === outlineLayerId,
  );
  if (!layer || isDrillLayerKind(layer.kind) || layer.kind === LAYER_KIND_COMPOSITE) {
    throw new TypeError("outlineLayerId must reference an ordinary Gerber layer.");
  }
  return layer;
}

function getPublicLayerId(layer) {
  return layer?.id ?? layer?.layerId;
}

function resolveCompositeFallbackBounds(frame, sourceLayers) {
  let bounds = null;
  for (const layer of frame.layers) {
    if (
      layer.visible !== false &&
      !isDrillLayerKind(layer.kind) &&
      layer.kind !== LAYER_KIND_COMPOSITE
    ) {
      bounds = mergeBounds(bounds, layer.bounds);
    }
  }
  for (const layer of sourceLayers) {
    bounds = mergeBounds(bounds, layer.bounds);
  }
  return bounds;
}

async function loadWasmModule(rendererOptions) {
  const { wasmModule } = await loadWasmJsModule(rendererOptions);
  return wasmModule;
}

function normalizeFrameOptions(frameOptions) {
  return {
    width: frameOptions.width,
    height: frameOptions.height,
    clear: frameOptions.clear !== false,
    ...createBaseFrameOptions(frameOptions),
  };
}

async function streamCanvasToPng(canvas, gl, writable, background, exportOptions) {
  if (typeof CompressionStream !== "function") {
    throw new Error("Streaming PNG export requires CompressionStream support.");
  }

  const width = positiveIntegerOrDefault(canvas.width, 1);
  const height = positiveIntegerOrDefault(canvas.height, 1);
  const sink = createWebWritablePngSink(writable);

  try {
    const normalizedBackground = parseExportBackground(background);
    const pngColorType = getPngColorType(normalizedBackground);
    const pngChannels = getPngChannelCount(pngColorType);
    const rowStride = getPngRowStride(width, pngChannels);
    validatePngDimensions(width, height);
    const rowsPerBand = getCanvasStreamBandRows(
      width,
      height,
      rowStride,
      exportOptions.maxBandBytes,
    );
    await deflatePngRowsToWebSink(sink, async (writeRow) => {
      // Compression construction and stream-lock acquisition happen before
      // these first bytes, so deterministic capability failures cannot leave a
      // partial PNG in the destination.
      await sink.write(PNG_SIGNATURE);
      await sink.write(pngChunk("IHDR", createPngHeader(width, height, pngColorType)));
      await writeCanvasPixelRows(
        writeRow,
        gl,
        width,
        height,
        rowStride,
        normalizedBackground,
        pngChannels,
        rowsPerBand,
      );
    });
    await sink.write(pngChunk("IEND", new Uint8Array(0)));
    await sink.close();
  } catch (error) {
    try {
      await sink.abort(error);
    } catch (_abortError) {
      // Preserve the rendering or write error.
    }
    throw error;
  } finally {
    try {
      sink.release();
    } catch (_releaseError) {
      // Cleanup must not replace the rendering or write result.
    }
  }
}

function parseExportBackground(background) {
  if (background == null) return null;
  try {
    return parseColor(background, true);
  } catch (error) {
    if (typeof background !== "string") {
      throw error;
    }
    const resolved = resolveCssColor(background);
    if (!resolved) {
      throw error;
    }
    try {
      return parseColor(resolved, true);
    } catch (_serializationError) {
      const pixels = resolveCssColorRgbaPixels(background);
      if (!pixels) throw error;
      return pixels;
    }
  }
}

function normalizeBrowserCompositeColor(color, fallback) {
  try {
    return normalizeColor(color, fallback, { allowString: true });
  } catch (error) {
    if (typeof color !== "string") {
      throw error;
    }
    const resolved = resolveCssColor(color);
    if (!resolved) {
      throw error;
    }
    try {
      // Composite alpha remains an independent option. CSS alpha is parsed only
      // to validate the color and is deliberately excluded from the RGB result.
      return normalizeColor(resolved, fallback, { allowString: true });
    } catch (_serializationError) {
      const resolvedPixels = resolveCssColorPixels(color);
      if (!resolvedPixels) {
        throw error;
      }
      return resolvedPixels;
    }
  }
}

function resolveCssColor(color) {
  const canvas = createOutputCanvas(1, 1);
  const context = canvas?.getContext("2d");
  if (!context) return null;

  context.fillStyle = "#010203";
  context.fillStyle = color;
  const first = context.fillStyle;
  context.fillStyle = "#040506";
  context.fillStyle = color;
  const second = context.fillStyle;
  return first === "#010203" && second === "#040506" ? null : first;
}

function resolveCssColorPixels(color) {
  const data = resolveCssColorRgbaPixels(color);
  if (!data) return null;
  return [data[0] / 255, data[1] / 255, data[2] / 255];
}

function resolveCssColorRgbaPixels(color) {
  const canvas = createOutputCanvas(1, 1);
  const context = canvas?.getContext("2d", { willReadFrequently: true });
  if (
    !context ||
    typeof context.clearRect !== "function" ||
    typeof context.fillRect !== "function" ||
    typeof context.getImageData !== "function"
  ) {
    return null;
  }
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1)?.data;
  if (!data || data.length < 4) {
    return null;
  }
  return [data[0], data[1], data[2], data[3]];
}

function createWebWritablePngSink(writable) {
  if (writable && typeof writable.getWriter === "function") {
    const writer = writable.getWriter();
    return {
      write: (chunk) => writer.write(chunk),
      close: () => writer.close(),
      abort: (error) => writer.abort(error),
      release: () => writer.releaseLock(),
    };
  }
  if (writable && typeof writable.write === "function") {
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close?.(),
      abort: (error) => writable.abort?.(error),
      release: () => {},
    };
  }
  throw new TypeError("A WritableStream or FileSystemWritableFileStream is required.");
}

async function deflatePngRowsToWebSink(sink, writeRows) {
  const compression = new CompressionStream("deflate");
  let reader = null;
  let writer = null;
  try {
    reader = compression.readable.getReader();
    writer = compression.writable.getWriter();
  } catch (error) {
    try {
      await reader?.cancel(error);
    } catch (_cancelError) {
      // Preserve the capability/setup error.
    }
    try {
      reader?.releaseLock();
    } catch (_releaseError) {
      // Preserve the capability/setup error.
    }
    throw error;
  }
  let pumpError = null;
  let rejectPumpError;
  const pumpErrorSignal = new Promise((_, reject) => {
    rejectPumpError = reject;
  });
  // The signal is also consumed by Promise.race() below. Keep this handler so
  // a destination failure between compression writes cannot surface as an
  // unhandled rejection.
  pumpErrorSignal.catch(() => {});
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await sink.write(pngChunk("IDAT", value));
    }
  })().catch((error) => {
    pumpError = error;
    rejectPumpError(error);
    throw error;
  });
  pump.catch(() => {});

  try {
    await writeRows(async (row) => {
      if (pumpError) throw pumpError;
      // The converted PNG band is immutable until this write settles, so the
      // CompressionStream can consume it directly without a second full-band
      // allocation outside maxBandBytes accounting.
      await Promise.race([writer.write(row), pumpErrorSignal]);
      if (pumpError) throw pumpError;
    });
    await Promise.race([writer.close(), pumpErrorSignal]);
    await pump;
  } catch (error) {
    try {
      await writer.abort(error);
    } catch (_abortError) {
      // Preserve the original error.
    }
    try {
      await reader.cancel(error);
    } catch (_cancelError) {
      // Preserve the original error.
    }
    try {
      await pump;
    } catch (_pumpError) {
      // Preserve the original error.
    }
    throw error;
  } finally {
    try {
      writer.releaseLock();
    } catch (_releaseError) {
      // Cleanup must not replace the compression result.
    }
    try {
      reader.releaseLock();
    } catch (_releaseError) {
      // Cleanup must not replace the compression result.
    }
  }
}

async function writeCanvasPixelRows(
  writeRow,
  gl,
  width,
  height,
  rowStride,
  background,
  pngChannels,
  rowsPerBand,
) {
  const rowBytes = width * 4;
  const pixels = new Uint8Array(rowBytes * rowsPerBand);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.finish?.();
  const managesPackAlignment =
    typeof gl.getParameter === "function" &&
    typeof gl.pixelStorei === "function" &&
    gl.PACK_ALIGNMENT != null;
  const previousPackAlignment = managesPackAlignment
    ? gl.getParameter(gl.PACK_ALIGNMENT)
    : null;
  if (managesPackAlignment) gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  try {
    for (let topY = 0; topY < height; topY += rowsPerBand) {
      const rowCount = Math.min(rowsPerBand, height - topY);
      const readY = height - topY - rowCount;
      gl.readPixels(
        0,
        readY,
        width,
        rowCount,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      await writePixelRowsToPngRows(
        writeRow,
        pixels.subarray(0, rowBytes * rowCount),
        width,
        rowCount,
        rowStride,
        background,
        pngChannels,
      );
    }
  } finally {
    if (managesPackAlignment) {
      gl.pixelStorei(gl.PACK_ALIGNMENT, previousPackAlignment);
    }
  }
}

function getCanvasStreamBandRows(width, height, rowStride, maxBandBytes) {
  const budget = positiveIntegerOrDefault(
    maxBandBytes,
    DEFAULT_STREAM_EXPORT_BAND_BYTES,
  );
  const perRowBytes = width * 4 + rowStride;
  const rows = Math.floor(budget / perRowBytes);
  if (!Number.isFinite(rows) || rows < 1) {
    throw new Error(
      `PNG export rows exceed the ${budget}-byte stream band limit at ${width}px wide.`,
    );
  }
  return Math.min(height, rows);
}

function normalizeCssColor(color) {
  if (typeof color === "string") {
    const resolved = resolveCssColor(color);
    if (!resolved) {
      throw new TypeError(`Unsupported color format: ${color}`);
    }
    return resolved;
  }
  const [r, g, b, a] = parseColor(color, true);
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type, quality });
  }
  if (typeof canvas.toBlob !== "function") {
    return Promise.reject(new Error("Canvas PNG export is unavailable."));
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Canvas PNG export failed."));
      }
    }, type, quality);
  });
}

function createOutputCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function clearCanvas(gl, canvas) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
