const DEFAULT_WASM_MODULE_URLS = [
  new URL("./wasm/wasm_gerber_processor.js", import.meta.url),
  new URL("../../wasm/pkg/wasm_gerber_processor.js", import.meta.url),
];

const DEFAULT_COLORS = [
  [1.0, 0.0, 0.0],
  [0.0, 1.0, 0.0],
  [0.0, 0.0, 1.0],
  [1.0, 0.0, 1.0],
  [1.0, 1.0, 0.0],
  [0.0, 1.0, 1.0],
];
const DEFAULT_BACKGROUND = null;
const DEFAULT_GLOBAL_ALPHA = 0.7;
const DEFAULT_MINIMUM_FEATURE_PIXELS = 1;
const DEFAULT_ARC_TESSELLATION_QUALITY = 1;

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
  const renderer = await createGerberRenderer(
    canvas,
    {
      releaseContext: false,
      ...(frameOptions.rendererOptions || {}),
    },
  );

  try {
    await renderer.withFrame(frameOptions, async () => {
      await renderer.renderLayers(layers, frameOptions);
    });
    return await renderer.exportPng({
      background: frameOptions.background,
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

      this.frame = new FrameState(processor, normalizedFrameOptions);
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
    const content = await sourceToText(source);
    const offsetX = numberOrDefault(options.offsetX, 0);
    const offsetY = numberOrDefault(options.offsetY, 0);
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

    const view = resolveFrameView(frame, this.canvas);
    const activeLayerIds = new Uint32Array(frame.layers.map((layer) => layer.layerId));
    const globalAlpha = clamp01(numberOrDefault(frame.options.globalAlpha, 1));

    if (typeof frame.processor.render_with_clear === "function") {
      const colorData = new Float32Array(
        frame.layers.flatMap((layer) => [
          layer.color[0],
          layer.color[1],
          layer.color[2],
          resolveLayerAlpha(layer.alpha, globalAlpha),
        ]),
      );
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
    } else {
      if (!clear) {
        throw new Error("clear:false requires an updated WASM renderer.");
      }
      if (frame.layers.some((layer) => layer.alpha != null)) {
        throw new Error("Layer alpha requires an updated WASM renderer.");
      }
      const colorData = new Float32Array(
        frame.layers.flatMap((layer) => layer.color),
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

class FrameState {
  constructor(processor, options) {
    this.processor = processor;
    this.options = options;
    this.layers = [];
    this.bounds = null;
    this.nextColorIndex = 0;
  }

  addLayer(layer) {
    this.layers.push(layer);
    this.bounds = mergeBounds(this.bounds, layer.bounds);
  }

  nextColor() {
    const color = this.options.colors[
      this.nextColorIndex % this.options.colors.length
    ];
    this.nextColorIndex += 1;
    return [...color];
  }

  toResult(view) {
    const globalAlpha = clamp01(numberOrDefault(this.options.globalAlpha, 1));
    return {
      width: this.options.width,
      height: this.options.height,
      background: this.options.background,
      bounds: this.bounds,
      view,
      layers: this.layers.map((layer) => ({
        id: layer.layerId,
        name: layer.name,
        bounds: layer.bounds,
        color: layer.color,
        alpha: resolveLayerAlpha(layer.alpha, globalAlpha),
      })),
    };
  }
}

async function loadWasmModule(rendererOptions) {
  if (rendererOptions.wasmModule) {
    return rendererOptions.wasmModule;
  }

  const wasmModuleUrls = rendererOptions.wasmModuleUrl
    ? [rendererOptions.wasmModuleUrl]
    : DEFAULT_WASM_MODULE_URLS;
  const errors = [];

  for (const wasmModuleUrl of wasmModuleUrls) {
    try {
      return await import(String(wasmModuleUrl));
    } catch (error) {
      errors.push({ wasmModuleUrl, error });
    }
  }

  const attemptedUrls = wasmModuleUrls.map(String).join(", ");
  throw new Error(
    `Failed to load wasm-gerber renderer module from ${attemptedUrls}. ` +
      "Run npm run build:wasm before using the package.",
    { cause: errors[0]?.error },
  );
}

function applyProcessorOptions(processor, frameOptions) {
  if (typeof processor.set_preserve_arc_regions === "function") {
    processor.set_preserve_arc_regions(frameOptions.preserveArcRegions !== false);
  }
  if (
    typeof processor.set_arc_tessellation_quality === "function" &&
    frameOptions.arcTessellationQuality != null
  ) {
    processor.set_arc_tessellation_quality(frameOptions.arcTessellationQuality);
  }
  if (
    typeof processor.set_minimum_feature_pixels === "function" &&
    frameOptions.minimumFeaturePixels != null
  ) {
    processor.set_minimum_feature_pixels(frameOptions.minimumFeaturePixels);
  }
}

function addLayerToProcessor(processor, content, offsetX, offsetY) {
  if (offsetX !== 0 || offsetY !== 0) {
    if (typeof processor.add_layer_with_offset !== "function") {
      throw new Error("Layer offsets require an updated WASM renderer.");
    }
    return processor.add_layer_with_offset(content, offsetX, offsetY);
  }
  return processor.add_layer(content);
}

function normalizeFrameOptions(frameOptions) {
  return {
    width: frameOptions.width,
    height: frameOptions.height,
    clear: frameOptions.clear !== false,
    background:
      "background" in frameOptions ? frameOptions.background : DEFAULT_BACKGROUND,
    fit: frameOptions.fit !== false,
    padding: numberOrDefault(frameOptions.padding, 0),
    view: frameOptions.view || null,
    preserveArcRegions: frameOptions.preserveArcRegions !== false,
    arcTessellationQuality: numberOrDefault(
      frameOptions.arcTessellationQuality,
      DEFAULT_ARC_TESSELLATION_QUALITY,
    ),
    minimumFeaturePixels: numberOrDefault(
      frameOptions.minimumFeaturePixels,
      DEFAULT_MINIMUM_FEATURE_PIXELS,
    ),
    globalAlpha: numberOrDefault(frameOptions.globalAlpha, DEFAULT_GLOBAL_ALPHA),
    colors: DEFAULT_COLORS.map((color) => [...color]),
  };
}

function normalizeLayerList(layers) {
  if (layers == null) {
    return [];
  }
  if (typeof FileList !== "undefined" && layers instanceof FileList) {
    return Array.from(layers);
  }
  return Array.isArray(layers) ? layers : [layers];
}

async function renderLayersBestEffort(renderer, layers, options = {}) {
  const layerErrorMode = options.layerErrorMode || "skip";
  if (layerErrorMode !== "skip" && layerErrorMode !== "throw") {
    throw new TypeError("layerErrorMode must be 'skip' or 'throw'.");
  }

  const failures = [];
  let renderedCount = 0;

  for (const layer of layers) {
    try {
      await renderer.renderLayer(layer);
      renderedCount += 1;
    } catch (error) {
      const failure = {
        layer,
        name: getLayerFailureName(layer),
        error,
      };
      failures.push(failure);
      if (typeof options.onLayerError === "function") {
        options.onLayerError(failure);
      }
      if (layerErrorMode === "throw") {
        throw error;
      }
    }
  }

  if (renderedCount === 0 && failures.length > 0) {
    throw failures[0].error;
  }

  return { renderedCount, failures };
}

function normalizeLayer(layer, layerOptions = {}) {
  if (isLayerConfig(layer)) {
    const { source, ...inlineOptions } = layer;
    if (source == null) {
      throw new TypeError("Layer config requires a source.");
    }
    return {
      source,
      options: { ...inlineOptions, ...layerOptions },
    };
  }

  return {
    source: layer,
    options: { ...layerOptions },
  };
}

function isLayerConfig(value) {
  return (
    value &&
    typeof value === "object" &&
    "source" in value &&
    !isBlob(value) &&
    !isArrayBufferLike(value)
  );
}

async function sourceToText(source) {
  if (typeof source === "string") {
    return source;
  }
  if (isBlob(source)) {
    return source.text();
  }
  if (source instanceof ArrayBuffer) {
    return new TextDecoder().decode(source);
  }
  if (ArrayBuffer.isView(source)) {
    return new TextDecoder().decode(
      source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
    );
  }

  throw new TypeError(
    "Layer source must be a string, File, Blob, ArrayBuffer, or Uint8Array.",
  );
}

function getSourceName(source) {
  if (source && typeof source === "object" && "name" in source) {
    return String(source.name);
  }
  return "";
}

function getLayerFailureName(layer) {
  if (layer && typeof layer === "object") {
    if ("name" in layer && layer.name) {
      return String(layer.name);
    }
    if ("source" in layer) {
      return getSourceName(layer.source);
    }
  }
  return getSourceName(layer) || "Layer";
}

function isBlob(value) {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isArrayBufferLike(value) {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function resolveFrameView(frame, canvas) {
  if (frame.options.view) {
    return {
      zoomX: finiteOrThrow(frame.options.view.zoomX, "view.zoomX"),
      zoomY: finiteOrThrow(frame.options.view.zoomY, "view.zoomY"),
      offsetX: finiteOrThrow(frame.options.view.offsetX, "view.offsetX"),
      offsetY: finiteOrThrow(frame.options.view.offsetY, "view.offsetY"),
    };
  }

  if (frame.options.fit === false) {
    return { zoomX: 1, zoomY: 1, offsetX: 0, offsetY: 0 };
  }

  if (!frame.bounds) {
    throw new Error("Cannot fit an empty Gerber frame.");
  }

  return calculateFitView(
    frame.bounds,
    canvas.width,
    canvas.height,
    frame.options.padding,
  );
}

function calculateFitView(bounds, width, height, padding) {
  const minX = Number(bounds.minX);
  const maxX = Number(bounds.maxX);
  const minY = Number(bounds.minY);
  const maxY = Number(bounds.maxY);
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    throw new Error("Cannot fit Gerber layer because bounds are invalid.");
  }

  const boundsWidth = Math.max(0, maxX - minX);
  const boundsHeight = Math.max(0, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const aspect = width / height;
  const viewWidth = aspect > 1 ? 2 * aspect : 2;
  const viewHeight = aspect > 1 ? 2 : 2 / aspect;
  const usableWidth = viewWidth * Math.max(1, width - padding * 2) / width;
  const usableHeight = viewHeight * Math.max(1, height - padding * 2) / height;

  let zoom = 2;
  if (boundsWidth > 0 && boundsHeight > 0) {
    zoom = Math.min(usableWidth / boundsWidth, usableHeight / boundsHeight);
  } else if (boundsWidth > 0) {
    zoom = usableWidth / boundsWidth;
  } else if (boundsHeight > 0) {
    zoom = usableHeight / boundsHeight;
  }

  return {
    zoomX: zoom,
    zoomY: zoom,
    offsetX: -centerX * zoom,
    offsetY: -centerY * zoom,
  };
}

function boundaryToPlainObject(boundary) {
  return {
    minX: readBoundaryNumber(boundary, "min_x", "minX"),
    maxX: readBoundaryNumber(boundary, "max_x", "maxX"),
    minY: readBoundaryNumber(boundary, "min_y", "minY"),
    maxY: readBoundaryNumber(boundary, "max_y", "maxY"),
  };
}

function mergeBounds(first, second) {
  if (!second) return first;
  if (!first) return { ...second };
  return {
    minX: Math.min(first.minX, second.minX),
    maxX: Math.max(first.maxX, second.maxX),
    minY: Math.min(first.minY, second.minY),
    maxY: Math.max(first.maxY, second.maxY),
  };
}

function normalizeColor(color, fallback = DEFAULT_COLORS[0]) {
  const input = color == null ? fallback : color;
  if (!input || (!Array.isArray(input) && !ArrayBuffer.isView(input))) {
    return fallback == null ? null : [...fallback];
  }
  if (input.length < 3) {
    return fallback == null ? null : [...fallback];
  }
  const fallbackColor = fallback || DEFAULT_COLORS[0];
  return [
    clamp01(numberOrDefault(input[0], fallbackColor[0])),
    clamp01(numberOrDefault(input[1], fallbackColor[1])),
    clamp01(numberOrDefault(input[2], fallbackColor[2])),
  ];
}

function readBoundaryNumber(boundary, snakeName, camelName) {
  const value = boundary[snakeName] ?? boundary[camelName];
  return Number(typeof value === "function" ? value.call(boundary) : value);
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

function positiveIntegerOrDefault(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return Math.max(1, Math.round(number));
  }
  return Math.max(1, Math.round(Number(fallback) || 1));
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalAlpha(value) {
  return value == null ? null : clamp01(value);
}

function resolveLayerAlpha(layerAlpha, globalAlpha) {
  return layerAlpha == null ? globalAlpha : layerAlpha;
}

function finiteOrThrow(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name} must be finite.`);
  }
  return number;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, numberOrDefault(value, 0)));
}
