import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);

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

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
const DEFAULT_BACKGROUND = null;
const DEFAULT_GLOBAL_ALPHA = 0.7;
const DEFAULT_MINIMUM_FEATURE_PIXELS = 1;
const DEFAULT_ARC_TESSELLATION_QUALITY = 1;
const REQUIRED_WEBGL2_METHODS = [
  "createVertexArray",
  "bindVertexArray",
  "deleteVertexArray",
  "drawArraysInstanced",
  "vertexAttribDivisor",
  "readPixels",
];

export async function createNodeGerberRenderer(rendererOptions = {}) {
  return NodeGerberRenderer.create(rendererOptions);
}

export async function renderGerberToPngBuffer(
  layers,
  frameOptions = {},
  exportOptions = {},
  rendererOptions = {},
) {
  const renderer = await createNodeGerberRenderer(rendererOptions);
  try {
    await renderer.withFrame(frameOptions, async () => {
      await renderer.renderLayers(layers, frameOptions);
    });
    return renderer.exportPng(exportOptions);
  } finally {
    renderer.dispose();
  }
}

export async function renderGerberToPngFile(
  outputPath,
  layers,
  frameOptions = {},
  exportOptions = {},
  rendererOptions = {},
) {
  const png = await renderGerberToPngBuffer(
    layers,
    frameOptions,
    exportOptions,
    rendererOptions,
  );
  await writeFile(outputPath, png);
}

export class NodeGerberRenderer {
  static async create(rendererOptions = {}) {
    const { wasmModule, wasmModuleUrl } = await loadWasmModule(rendererOptions);
    await initializeWasmModule(wasmModule, wasmModuleUrl, rendererOptions);
    return new NodeGerberRenderer(rendererOptions, wasmModule);
  }

  constructor(rendererOptions, wasmModule) {
    this.rendererOptions = { ...rendererOptions };
    this.wasmModule = wasmModule;
    this.gl = rendererOptions.gl || null;
    this.frame = null;
    this.lastFrame = null;
    this.lastPixels = null;
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
    const gl = this.getContext(
      normalizedFrameOptions.width,
      normalizedFrameOptions.height,
    );
    const processor = new this.wasmModule.GerberProcessor();
    if (typeof processor.init_with_size !== "function") {
      throw new Error("Headless rendering requires an updated WASM module.");
    }
    processor.init_with_size(
      gl,
      normalizedFrameOptions.width,
      normalizedFrameOptions.height,
    );
    applyProcessorOptions(processor, normalizedFrameOptions);

    this.frame = new FrameState(processor, normalizedFrameOptions);
    this.lastFrame = null;
    this.lastPixels = null;

    try {
      await callback();
      this.renderFrameToPixels();
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
    if (!this.lastFrame || !this.lastPixels) {
      throw new Error("No rendered frame is available for export.");
    }

    const background =
      "background" in exportOptions
        ? exportOptions.background
        : this.lastFrame.background;
    const pixels =
      background == null
        ? this.lastPixels
        : compositeBackground(this.lastPixels, parseColor(background, true));

    return rgbaToPngBuffer(pixels, this.lastFrame.width, this.lastFrame.height);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.frame = null;
    this.lastFrame = null;
    this.lastPixels = null;

    if (this.rendererOptions.releaseContext !== false && this.gl) {
      try {
        this.gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch (_error) {
        // Best-effort cleanup.
      }
    }
  }

  getContext(width, height) {
    if (this.gl) {
      validateWebGl2Context(this.gl);
      return this.gl;
    }

    this.gl = createNodeGlesContext(
      width,
      height,
      this.rendererOptions,
      this.rendererOptions.contextAttributes || {},
    );
    return this.gl;
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
    const alpha = clamp01(numberOrDefault(options.alpha, 1));

    return {
      layerId,
      name: options.name || getSourceName(source) || `Layer ${layerId}`,
      bounds,
      color,
      alpha,
    };
  }

  renderFrameToPixels() {
    const frame = this.frame;
    if (!frame) {
      throw new Error("No active frame to render.");
    }

    if (frame.layers.length === 0) {
      const pixelCount = frame.options.width * frame.options.height * 4;
      this.lastPixels = Buffer.alloc(pixelCount);
      this.lastFrame = frame.toResult(null);
      return;
    }

    const view = resolveFrameView(
      frame,
      frame.options.width,
      frame.options.height,
    );
    const activeLayerIds = new Uint32Array(
      frame.layers.map((layer) => layer.layerId),
    );
    const colorData = new Float32Array(frame.layers.length * 4);
    for (const [index, layer] of frame.layers.entries()) {
      const offset = index * 4;
      colorData[offset] = layer.color[0];
      colorData[offset + 1] = layer.color[1];
      colorData[offset + 2] = layer.color[2];
      colorData[offset + 3] = layer.alpha;
    }

    const globalAlpha = clamp01(numberOrDefault(frame.options.globalAlpha, 1));
    const pixels = frame.processor.render_pixels_with_clear(
      activeLayerIds,
      colorData,
      view.zoomX,
      view.zoomY,
      view.offsetX,
      view.offsetY,
      globalAlpha,
      frame.options.clear !== false,
    );

    this.lastPixels = flipRgbaRows(
      Buffer.from(pixels),
      frame.options.width,
      frame.options.height,
    );
    this.lastFrame = frame.toResult(view);
  }

  disposeFrameProcessor(processor) {
    try {
      processor.clear();
    } catch (_error) {
      // The pixel result is already copied; cleanup failures should not hide it.
    }
  }

  assertUsable() {
    if (this.disposed) {
      throw new Error("NodeGerberRenderer has been disposed.");
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
        alpha: layer.alpha,
      })),
    };
  }
}

async function loadWasmModule(rendererOptions) {
  if (rendererOptions.wasmModule) {
    return {
      wasmModule: rendererOptions.wasmModule,
      wasmModuleUrl: rendererOptions.wasmModuleUrl
        ? toUrl(rendererOptions.wasmModuleUrl)
        : null,
    };
  }

  const wasmModuleUrls = rendererOptions.wasmModuleUrl
    ? [toUrl(rendererOptions.wasmModuleUrl)]
    : DEFAULT_WASM_MODULE_URLS;
  const errors = [];

  for (const wasmModuleUrl of wasmModuleUrls) {
    try {
      return {
        wasmModule: await import(String(wasmModuleUrl)),
        wasmModuleUrl,
      };
    } catch (error) {
      errors.push({ wasmModuleUrl, error });
    }
  }

  const attemptedUrls = wasmModuleUrls.map(String).join(", ");
  throw new Error(
    `Failed to load wasm-gerber renderer module from ${attemptedUrls}. ` +
      "Run npm run build:wasm before using the Node renderer.",
    { cause: errors[0]?.error },
  );
}

async function initializeWasmModule(wasmModule, wasmModuleUrl, rendererOptions) {
  if (typeof wasmModule.default !== "function") return;

  if (rendererOptions.wasmInitInput !== undefined) {
    await wasmModule.default(rendererOptions.wasmInitInput);
    return;
  }

  const wasmBinaryUrl = rendererOptions.wasmBinaryUrl
    ? toUrl(rendererOptions.wasmBinaryUrl)
    : wasmModuleUrl
      ? new URL("wasm_gerber_processor_bg.wasm", wasmModuleUrl)
      : null;

  if (!wasmBinaryUrl) {
    await wasmModule.default();
    return;
  }

  const bytes = await readBinaryUrl(wasmBinaryUrl);
  await wasmModule.default({ module_or_path: bytes });
}

async function readBinaryUrl(url) {
  if (url.protocol === "file:") {
    return readFile(fileURLToPath(url));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch WASM binary: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function createNodeGlesContext(width, height, rendererOptions, contextAttributes) {
  const { moduleName, module: nodeGles } = loadNodeGlesModule(rendererOptions);

  const createContext =
    nodeGles.binding?.createWebGLRenderingContext ||
    nodeGles.createWebGLRenderingContext;
  if (typeof createContext !== "function") {
    throw new Error(`${moduleName} does not expose createWebGLRenderingContext().`);
  }

  const attempts = [
    [{ width, height, ...contextAttributes }],
  ];
  const errors = [];

  for (const args of attempts) {
    try {
      const gl = createContext(...args);
      if (gl) {
        validateWebGl2Context(gl);
        return gl;
      }
    } catch (error) {
      errors.push(error);
    }
  }

  throw new Error(
    `${moduleName} failed to create a compatible WebGL2 context. ` +
      `The installed GLES module must expose ${REQUIRED_WEBGL2_METHODS.join(", ")}.`,
    { cause: errors[0] },
  );
}

function loadNodeGlesModule(rendererOptions) {
  if (rendererOptions.glesModule) {
    return { moduleName: "custom GLES module", module: rendererOptions.glesModule };
  }

  const moduleNames = [
    rendererOptions.glesModuleName,
    process.env.GERBER_RENDERER_GLES_MODULE,
    "node-gles-webgl2",
    "node-gles",
  ].filter(Boolean);
  const errors = [];

  for (const moduleName of moduleNames) {
    try {
      return { moduleName, module: require(moduleName) };
    } catch (error) {
      errors.push({ moduleName, error });
    }
  }

  throw new Error(
    "A WebGL2-capable GLES module is required for Node CLI rendering. " +
      "Install node-gles-webgl2 or pass rendererOptions.glesModule.",
    { cause: errors[0]?.error },
  );
}

function validateWebGl2Context(gl) {
  const missing = REQUIRED_WEBGL2_METHODS.filter(
    (name) => typeof gl[name] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `GLES context is missing required WebGL2 methods: ${missing.join(", ")}`,
    );
  }
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
  if (frameOptions.clear === false) {
    throw new Error(
      "clear:false is not supported by Node rendering because each frame renders to a fresh output buffer.",
    );
  }

  return {
    width: positiveIntegerOrDefault(frameOptions.width, DEFAULT_WIDTH),
    height: positiveIntegerOrDefault(frameOptions.height, DEFAULT_HEIGHT),
    clear: true,
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
  if (isPathLayerConfig(layer)) {
    const { path, ...inlineOptions } = layer;
    return {
      source: { path },
      options: { ...inlineOptions, ...layerOptions },
    };
  }
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

function isPathLayerConfig(value) {
  return (
    value &&
    typeof value === "object" &&
    "path" in value &&
    !("source" in value)
  );
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
  if (source instanceof URL) {
    return readFile(fileURLToPath(source), "utf8");
  }
  if (source && typeof source === "object" && "path" in source) {
    return readFile(String(source.path), "utf8");
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
    "Layer source must be a string, File, Blob, ArrayBuffer, Uint8Array, URL, or path config.",
  );
}

function getSourceName(source) {
  if (source && typeof source === "object" && "name" in source) {
    return String(source.name);
  }
  if (source && typeof source === "object" && "path" in source) {
    return basename(String(source.path));
  }
  if (source instanceof URL && source.protocol === "file:") {
    return basename(fileURLToPath(source));
  }
  return "";
}

function getLayerFailureName(layer) {
  if (layer && typeof layer === "object") {
    if ("name" in layer && layer.name) {
      return String(layer.name);
    }
    if ("path" in layer) {
      return basename(String(layer.path));
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

function resolveFrameView(frame, width, height) {
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

  return calculateFitView(frame.bounds, width, height, frame.options.padding);
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

function readBoundaryNumber(boundary, snakeName, camelName) {
  const value = boundary[snakeName] ?? boundary[camelName];
  return Number(typeof value === "function" ? value.call(boundary) : value);
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
  if (typeof input === "string") {
    return parseColor(input).slice(0, 3).map((value) => value / 255);
  }
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

function parseColor(color, allowAlpha = false) {
  if (Array.isArray(color) || ArrayBuffer.isView(color)) {
    if (color.length < 3) {
      throw new TypeError("Color arrays must have at least three channels.");
    }
    return [
      Math.round(clamp01(color[0]) * 255),
      Math.round(clamp01(color[1]) * 255),
      Math.round(clamp01(color[2]) * 255),
      Math.round(clamp01(color.length >= 4 ? color[3] : 1) * 255),
    ];
  }

  if (typeof color !== "string") {
    throw new TypeError("Color must be a CSS hex/rgb string or RGBA array.");
  }

  const hex = color.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const value = hex[1];
    if (value.length === 3 || value.length === 4) {
      return [
        parseInt(value[0] + value[0], 16),
        parseInt(value[1] + value[1], 16),
        parseInt(value[2] + value[2], 16),
        value.length === 4 && allowAlpha ? parseInt(value[3] + value[3], 16) : 255,
      ];
    }
    if (value.length === 6 || value.length === 8) {
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
        value.length === 8 && allowAlpha ? parseInt(value.slice(6, 8), 16) : 255,
      ];
    }
  }

  const rgb = color
    .trim()
    .match(/^rgba?\(([^,]+),([^,]+),([^,]+)(?:,([^,]+))?\)$/i);
  if (rgb) {
    return [
      parseCssChannel(rgb[1]),
      parseCssChannel(rgb[2]),
      parseCssChannel(rgb[3]),
      rgb[4] && allowAlpha ? Math.round(clamp01(Number(rgb[4])) * 255) : 255,
    ];
  }

  throw new TypeError(`Unsupported color format: ${color}`);
}

function parseCssChannel(value) {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    return Math.round(clamp01(Number(trimmed.slice(0, -1)) / 100) * 255);
  }
  return Math.min(255, Math.max(0, Math.round(Number(trimmed))));
}

function compositeBackground(pixels, background) {
  const output = Buffer.from(pixels);
  const bgA = background[3] / 255;
  for (let index = 0; index < output.length; index += 4) {
    const srcA = output[index + 3] / 255;
    const outA = srcA + bgA * (1 - srcA);
    if (outA <= 0) {
      output[index] = 0;
      output[index + 1] = 0;
      output[index + 2] = 0;
      output[index + 3] = 0;
      continue;
    }

    output[index] = Math.round(
      (output[index] * srcA + background[0] * bgA * (1 - srcA)) / outA,
    );
    output[index + 1] = Math.round(
      (output[index + 1] * srcA + background[1] * bgA * (1 - srcA)) / outA,
    );
    output[index + 2] = Math.round(
      (output[index + 2] * srcA + background[2] * bgA * (1 - srcA)) / outA,
    );
    output[index + 3] = Math.round(outA * 255);
  }
  return output;
}

function flipRgbaRows(pixels, width, height) {
  const rowSize = width * 4;
  const output = Buffer.allocUnsafe(pixels.length);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = (height - 1 - y) * rowSize;
    const targetStart = y * rowSize;
    pixels.copy(output, targetStart, sourceStart, sourceStart + rowSize);
  }
  return output;
}

function rgbaToPngBuffer(rgba, width, height) {
  const rowSize = width * 4;
  const raw = Buffer.allocUnsafe((rowSize + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (rowSize + 1);
    raw[rawOffset] = 0;
    rgba.copy(raw, rawOffset + 1, y * rowSize, (y + 1) * rowSize);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }

  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
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

function toUrl(value) {
  if (value instanceof URL) return value;
  if (typeof value === "string") {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      return new URL(value);
    }
    return pathToFileURL(resolve(value));
  }
  throw new TypeError("Expected a URL or path string.");
}

export function fileLayer(path, options = {}) {
  return {
    source: { path },
    name: options.name || basename(path),
    ...options,
  };
}

export function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)));
}
