import {
  DEFAULT_BACKGROUND,
  FrameState,
  PNG_SIGNATURE,
  addDrillLayerToProcessor,
  addLayerToProcessor,
  applyProcessorOptions,
  boundaryToPlainObject,
  clamp01,
  createBaseFrameOptions,
  createPngHeader,
  getPngChannelCount,
  getPngColorType,
  getPngRowStride,
  getSourceName,
  isDrillLayerKind,
  loadWasmJsModule,
  normalizeColor,
  normalizeLayerKind,
  normalizeLayer,
  normalizeLayerList,
  numberOrDefault,
  optionalAlpha,
  resolveDrillRenderColors,
  parseColor,
  positiveIntegerOrDefault,
  renderLayersBestEffort,
  resolveFrameView,
  resolveLayerAlpha,
  sourceToText,
  pngChunk,
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
    this.disposed = false;
  }

  async withFrame(frameOptions = {}, callback) {
    this.assertUsable();
    if (this.frame) {
      throw new Error("A render frame is already active.");
    }
    if (typeof callback !== "function") {
      throw new TypeError("withFrame requires a callback.");
    }

    const normalizedFrameOptions = normalizeFrameOptions(frameOptions);
    this.prepareCanvas(normalizedFrameOptions);

    const processor = new this.wasmModule.GerberProcessor();
    try {
      processor.init(this.getContext());
      applyProcessorOptions(processor, normalizedFrameOptions);

      this.frame = new FrameState(normalizedFrameOptions, { processor });
      await callback();
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
    this.frame.addLayer(layerRecord);
    return layerRecord.layerId;
  }

  async renderLayers(layers, options = {}) {
    this.assertUsable();
    if (!this.frame) {
      throw new Error("renderLayers must be called inside withFrame().");
    }

    return renderLayersBestEffort(this, normalizeLayerList(layers), options);
  }

  async exportPng(exportOptions = {}) {
    this.assertUsable();
    const type = exportOptions.type || "image/png";
    const quality = exportOptions.quality;
    const background =
      "background" in exportOptions
        ? exportOptions.background
        : (this.lastFrame?.background ?? DEFAULT_BACKGROUND);

    if (background == null) {
      return canvasToBlob(this.canvas, type, quality);
    }

    const output = createOutputCanvas(this.canvas.width, this.canvas.height);
    if (!output) {
      return canvasToBlob(this.canvas, type, quality);
    }

    const context = output.getContext("2d");
    if (!context) {
      return canvasToBlob(this.canvas, type, quality);
    }

    context.fillStyle = normalizeCssColor(background);
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(this.canvas, 0, 0);
    return canvasToBlob(output, type, quality);
  }

  async exportPngStream(writable, exportOptions = {}) {
    this.assertUsable();
    const type = exportOptions.type || "image/png";
    if (type !== "image/png") {
      throw new TypeError("Streaming export only supports image/png.");
    }

    const background =
      "background" in exportOptions
        ? exportOptions.background
        : (this.lastFrame?.background ?? DEFAULT_BACKGROUND);

    await streamCanvasToPng(
      this.canvas,
      this.getContext(),
      writable,
      background,
      exportOptions,
    );
  }

  dispose() {
    if (this.disposed) return;
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
      const bounds = boundaryToPlainObject(
        this.frame.processor.get_layer_boundary(outlineLayerId),
      );
      const alpha = optionalAlpha(options.alpha);
      return {
        kind,
        layerId: outlineLayerId,
        outlineLayerId,
        fillLayerId,
        name: options.name || getSourceName(source) || `Layer ${outlineLayerId}`,
        bounds,
        color: null,
        alpha,
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
      frame.options,
      frame.bounds,
      this.canvas.width,
      this.canvas.height,
    );
    const globalAlpha = clamp01(numberOrDefault(frame.options.globalAlpha, 1));
    const renderEntries = createRenderEntries(
      frame.layers,
      globalAlpha,
      frame.options.background,
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
          throw new Error("Drill rendering requires an updated WASM renderer.");
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
        frame.layers.some((layer) => isDrillLayerKind(layer.kind))
      ) {
        throw new Error("Layer alpha requires an updated WASM renderer.");
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
}

function createRenderEntries(layers, globalAlpha, background) {
  const entries = [];
  const drillColors = resolveDrillRenderColors(background);

  for (const layer of layers) {
    if (!isDrillLayerKind(layer.kind)) {
      entries.push({
        layerId: layer.layerId,
        color: layer.color,
        alpha: resolveLayerAlpha(layer.alpha, globalAlpha),
        blendMode: 0,
      });
    }
  }

  for (const layer of layers) {
    if (isDrillLayerKind(layer.kind)) {
      entries.push({
        layerId: layer.outlineLayerId,
        color: drillColors.outline,
        alpha: resolveLayerAlpha(layer.alpha, 1),
        blendMode: 0,
      });
    }
  }

  for (const layer of layers) {
    if (isDrillLayerKind(layer.kind)) {
      entries.push({
        layerId: layer.fillLayerId,
        color: drillColors.fill,
        alpha: resolveLayerAlpha(layer.alpha, 1),
        blendMode: drillColors.hasBackground ? 1 : 2,
      });
    }
  }

  return entries;
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
  const normalizedBackground = parseExportBackground(background);
  const pngColorType = getPngColorType(normalizedBackground);
  const pngChannels = getPngChannelCount(pngColorType);
  const rowStride = getPngRowStride(width, pngChannels);
  const sink = createWebWritablePngSink(writable);

  try {
    await sink.write(PNG_SIGNATURE);
    await sink.write(pngChunk("IHDR", createPngHeader(width, height, pngColorType)));
    await deflatePngRowsToWebSink(sink, async (writeRow) => {
      await writeCanvasPixelRows(
        writeRow,
        gl,
        width,
        height,
        rowStride,
        normalizedBackground,
        pngChannels,
        exportOptions.maxBandBytes,
      );
    });
    await sink.write(pngChunk("IEND", new Uint8Array(0)));
    await sink.close();
  } finally {
    sink.release();
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
    return parseColor(resolved, true);
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

function createWebWritablePngSink(writable) {
  if (writable && typeof writable.getWriter === "function") {
    const writer = writable.getWriter();
    return {
      write: (chunk) => writer.write(chunk),
      close: () => writer.close(),
      release: () => writer.releaseLock(),
    };
  }
  if (writable && typeof writable.write === "function") {
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close?.(),
      release: () => {},
    };
  }
  throw new TypeError("A WritableStream or FileSystemWritableFileStream is required.");
}

async function deflatePngRowsToWebSink(sink, writeRows) {
  const compression = new CompressionStream("deflate");
  const reader = compression.readable.getReader();
  const writer = compression.writable.getWriter();
  let pumpError = null;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await sink.write(pngChunk("IDAT", value));
    }
  })().catch((error) => {
    pumpError = error;
    throw error;
  });
  pump.catch(() => {});

  try {
    await writeRows(async (row) => {
      if (pumpError) throw pumpError;
      await writer.write(row.slice());
      if (pumpError) throw pumpError;
    });
    await writer.close();
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
    writer.releaseLock();
    reader.releaseLock();
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
  maxBandBytes,
) {
  const rowBytes = width * 4;
  const rowsPerBand = getCanvasStreamBandRows(
    width,
    height,
    rowStride,
    maxBandBytes,
  );
  const pixels = new Uint8Array(rowBytes * rowsPerBand);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.finish?.();
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
}

function getCanvasStreamBandRows(width, height, rowStride, maxBandBytes) {
  const budget = positiveIntegerOrDefault(
    maxBandBytes,
    DEFAULT_STREAM_EXPORT_BAND_BYTES,
  );
  const perRowBytes = width * 4 + rowStride;
  return Math.max(1, Math.min(height, Math.floor(budget / perRowBytes)));
}

function normalizeCssColor(color) {
  if (typeof color === "string") {
    return color;
  }
  if (Array.isArray(color) && color.length >= 3) {
    const r = Math.round(clamp01(color[0]) * 255);
    const g = Math.round(clamp01(color[1]) * 255);
    const b = Math.round(clamp01(color[2]) * 255);
    const a = color.length >= 4 ? clamp01(color[3]) : 1;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return "transparent";
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
