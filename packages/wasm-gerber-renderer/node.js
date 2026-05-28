import { once } from "node:events";
import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { freemem } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDeflate, deflateSync } from "node:zlib";
import {
  DEFAULT_ARC_TESSELLATION_QUALITY,
  FrameState,
  addLayerToProcessor,
  applyProcessorOptions,
  boundaryToPlainObject,
  clamp01,
  createBaseFrameOptions,
  getSourceName,
  loadLayersBestEffort,
  loadWasmJsModule,
  mergeBounds,
  normalizeColor,
  normalizeLayer,
  normalizeLayerList,
  normalizeParseOptions,
  numberOrDefault,
  optionalAlpha,
  parseColor,
  positiveIntegerOrDefault,
  positiveNumberOrDefault,
  renderLayersBestEffort,
  resolveFrameView,
  resolveLayerAlpha,
  sourceToText,
  toByte,
} from "./shared.js";

const require = createRequire(import.meta.url);

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
const RGBA_BYTES_PER_PIXEL = 4;
const DEFAULT_MAX_STREAM_BAND_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FULL_FRAME_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_RENDER_TARGET_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_FRAMEBUFFER_MEMORY_SAFETY_FACTOR = 2;
const MIN_RENDER_TARGET_BYTES = 64 * 1024 * 1024;
const MEMORY_PROBE_TIMEOUT_MS = 750;
const PROBE_RENDER_TARGET_SIZE = 1;
const GL_RGBA8 = 0x8058;
const REQUIRED_WEBGL2_METHODS = [
  "createVertexArray",
  "bindVertexArray",
  "deleteVertexArray",
  "drawArraysInstanced",
  "vertexAttribDivisor",
  "readPixels",
];
const NODE_PREPARED_LAYER = Symbol("wasm-gerber-renderer.nodePreparedLayer");

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
    return await renderer.exportPng(exportOptions);
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
    this.staleGlContexts = [];
    this.frame = null;
    this.lastFrame = null;
    this.lastRenderPlan = null;
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
    try {
      this.frame = new NodeFrameState(normalizedFrameOptions);
      this.lastFrame = null;
      this.lastRenderPlan = null;
      await callback();
      this.prepareFrameExport();
    } finally {
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

  async loadLayer(layer, layerOptions = {}) {
    this.assertUsable();
    return this.createPreparedLayer(layer, layerOptions);
  }

  async loadLayers(layers, options = {}) {
    this.assertUsable();
    return loadLayersBestEffort(this, normalizeLayerList(layers), options);
  }

  async exportPng(exportOptions = {}) {
    this.assertUsable();
    if (!this.lastFrame || !this.lastRenderPlan) {
      throw new Error("No rendered frame is available for export.");
    }

    const background =
      "background" in exportOptions
        ? exportOptions.background
        : this.lastFrame.background;

    return renderPlanToPngBuffer(this, this.lastRenderPlan, {
      ...exportOptions,
      background,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.frame = null;
    this.lastFrame = null;
    this.lastRenderPlan = null;

    if (this.rendererOptions.releaseContext !== false && this.gl) {
      this.releaseContext();
    }
    this.releaseStaleContexts();
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

  createExportContext(width, height) {
    if (this.rendererOptions.gl) {
      return this.getContext(width, height);
    }

    if (this.gl) {
      this.releaseContext();
    }
    this.gl = createNodeGlesContext(
      width,
      height,
      this.rendererOptions,
      this.rendererOptions.contextAttributes || {},
    );
    return this.gl;
  }

  releaseContext() {
    if (!this.gl) return;
    try {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch (_error) {
      // Best-effort cleanup.
    }
    this.gl = null;
  }

  releaseStaleContexts() {
    for (const gl of this.staleGlContexts.splice(0)) {
      try {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch (_error) {
        // Best-effort cleanup.
      }
    }
  }

  releaseInternalContexts() {
    if (this.rendererOptions.gl) return;
    this.releaseContext();
    this.releaseStaleContexts();
  }

  async createLayerRecord(layer, layerOptions) {
    const prepared = isPreparedNodeLayer(layer)
      ? mergePreparedLayerOptions(layer, layerOptions)
      : await this.createPreparedLayer(layer, {
          ...this.frame.options,
          ...layerOptions,
        });
    const layerId = this.frame.layers.length;
    const color =
      prepared.color == null
        ? this.frame.nextColor()
        : normalizeColor(prepared.color, this.frame.options.colors[0], {
            allowString: true,
          });

    return {
      layerId,
      name: prepared.name || `Layer ${layerId}`,
      content: prepared.content,
      parsedLayer: prepared.parsedLayer,
      offsetX: prepared.offsetX,
      offsetY: prepared.offsetY,
      bounds: prepared.bounds,
      color,
      alpha: prepared.alpha,
    };
  }

  async createPreparedLayer(layer, layerOptions = {}) {
    if (isPreparedNodeLayer(layer)) {
      return mergePreparedLayerOptions(layer, layerOptions);
    }

    const { source, options } = normalizeLayer(layer, layerOptions, {
      allowPathConfig: true,
    });
    const content = await sourceToText(source, {
      fileUrlToPath: fileURLToPath,
      readPathText: (path) => readFile(path, "utf8"),
      sourceDescription:
        "a string, File, Blob, ArrayBuffer, Uint8Array, URL, or path config",
    });
    const offsetX = numberOrDefault(options.offsetX, 0);
    const offsetY = numberOrDefault(options.offsetY, 0);
    const parseOptions = normalizeParseOptions(options);
    const parsed = parseLayerPayload(
      this.wasmModule,
      content,
      offsetX,
      offsetY,
      parseOptions,
    );
    const sourceName = getSourceName(source);

    return {
      [NODE_PREPARED_LAYER]: true,
      name: options.name || sourceName || "Layer",
      sourceName,
      content: supportsParsedLayerReuse(this.wasmModule) ? null : content,
      parsedLayer: parsed.payload,
      bounds: parsed.bounds,
      offsetX,
      offsetY,
      color: options.color,
      alpha: optionalAlpha(options.alpha),
      parseOptions,
    };
  }

  prepareFrameExport() {
    const frame = this.frame;
    if (!frame) {
      throw new Error("No active frame to render.");
    }

    if (frame.layers.length === 0) {
      this.lastFrame = frame.toResult(null);
      this.lastRenderPlan = frame.toRenderPlan(null);
      return;
    }

    const view = resolveFrameView(
      frame.options,
      frame.bounds,
      frame.options.width,
      frame.options.height,
    );
    this.lastFrame = frame.toResult(view);
    this.lastRenderPlan = frame.toRenderPlan(view);
  }

  assertUsable() {
    if (this.disposed) {
      throw new Error("NodeGerberRenderer has been disposed.");
    }
  }
}

class NodeFrameState extends FrameState {
  toRenderPlan(view) {
    const globalAlpha = clamp01(numberOrDefault(this.options.globalAlpha, 1));
    return {
      width: this.options.width,
      height: this.options.height,
      background: this.options.background,
      bounds: this.bounds,
      view,
      globalAlpha,
      maxBandBytes: this.options.maxBandBytes,
      preserveArcRegions: this.options.preserveArcRegions,
      arcTessellationQuality: this.options.arcTessellationQuality,
      minimumFeaturePixels: this.options.minimumFeaturePixels,
      maxFullFrameBytes: this.options.maxFullFrameBytes,
      maxRenderTargetBytes: this.options.maxRenderTargetBytes,
      framebufferMemorySafetyFactor: this.options.framebufferMemorySafetyFactor,
      strategy: this.options.strategy,
      layers: this.layers.map((layer) => ({
        content: layer.content,
        parsedLayer: layer.parsedLayer,
        offsetX: layer.offsetX,
        offsetY: layer.offsetY,
        color: layer.color,
        alpha: layer.alpha,
      })),
    };
  }
}

async function loadWasmModule(rendererOptions) {
  return loadWasmJsModule(rendererOptions, {
    normalizeUrl: toUrl,
    hint: "Run npm run build:wasm before using the Node renderer.",
  });
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

function parseLayerPayload(wasmModule, content, offsetX, offsetY, frameOptions) {
  const parseWithOptions = wasmModule.parse_gerber_layer_with_options;
  const parseDefault = wasmModule.parse_gerber_layer;
  const preserveArcRegions = frameOptions.preserveArcRegions !== false;
  const arcTessellationQuality = Number(frameOptions.arcTessellationQuality ?? 1);
  let payload;

  if (typeof parseWithOptions === "function") {
    payload = parseWithOptions(
      content,
      offsetX,
      offsetY,
      preserveArcRegions,
      arcTessellationQuality,
    );
  } else {
    if (
      !preserveArcRegions ||
      arcTessellationQuality !== DEFAULT_ARC_TESSELLATION_QUALITY
    ) {
      throw new Error("Gerber parse options require an updated WASM module.");
    }
    payload = parseDefault(content, offsetX, offsetY);
  }

  const sublayers = Array.from(payload?.sublayers ?? []);
  let bounds = null;
  for (const sublayer of sublayers) {
    bounds = mergeBounds(bounds, boundaryToPlainObject(sublayer.boundary));
  }
  if (!bounds) {
    throw new Error("File does not contain valid Gerber data (no geometry found)");
  }
  return { payload, bounds };
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
    ...createBaseFrameOptions(frameOptions),
    maxBandBytes: positiveIntegerOrDefault(
      frameOptions.maxBandBytes,
      DEFAULT_MAX_STREAM_BAND_BYTES,
    ),
    maxFullFrameBytes: positiveIntegerOrDefault(
      frameOptions.maxFullFrameBytes,
      DEFAULT_MAX_FULL_FRAME_BYTES,
    ),
    maxRenderTargetBytes:
      frameOptions.maxRenderTargetBytes == null
        ? null
        : positiveIntegerOrDefault(
            frameOptions.maxRenderTargetBytes,
            DEFAULT_MAX_RENDER_TARGET_BYTES,
          ),
    framebufferMemorySafetyFactor: positiveNumberOrDefault(
      frameOptions.framebufferMemorySafetyFactor,
      DEFAULT_FRAMEBUFFER_MEMORY_SAFETY_FACTOR,
    ),
    strategy: normalizeExportStrategy(frameOptions.strategy),
  };
}

function isPreparedNodeLayer(value) {
  return Boolean(value?.[NODE_PREPARED_LAYER]);
}

function mergePreparedLayerOptions(preparedLayer, layerOptions = {}) {
  const offsetX = numberOrDefault(preparedLayer.offsetX, 0);
  const offsetY = numberOrDefault(preparedLayer.offsetY, 0);
  if (
    ("offsetX" in layerOptions && numberOrDefault(layerOptions.offsetX, 0) !== offsetX) ||
    ("offsetY" in layerOptions && numberOrDefault(layerOptions.offsetY, 0) !== offsetY)
  ) {
    throw new Error("Prepared layer offsets are fixed. Load the layer again to change offsets.");
  }

  return {
    ...preparedLayer,
    name:
      "name" in layerOptions && layerOptions.name != null
        ? String(layerOptions.name)
        : preparedLayer.name,
    color:
      "color" in layerOptions
        ? layerOptions.color
        : preparedLayer.color,
    alpha:
      "alpha" in layerOptions
        ? optionalAlpha(layerOptions.alpha)
        : preparedLayer.alpha,
  };
}

async function renderPlanToPngBuffer(renderer, plan, exportOptions) {
  const width = positiveIntegerOrDefault(plan.width, DEFAULT_WIDTH);
  const height = positiveIntegerOrDefault(plan.height, DEFAULT_HEIGHT);
  const strategy = normalizeExportStrategy(exportOptions.strategy || plan.strategy);
  const background =
    exportOptions.background == null
      ? null
      : parseColor(exportOptions.background, true);
  const pngColorType = getPngColorType(background);
  const pngChannels = getPngChannelCount(pngColorType);
  const maxBandBytes = positiveIntegerOrDefault(
    exportOptions.maxBandBytes,
    plan.maxBandBytes || DEFAULT_MAX_STREAM_BAND_BYTES,
  );
  const maxFullFrameBytes = positiveIntegerOrDefault(
    exportOptions.maxFullFrameBytes,
    plan.maxFullFrameBytes || DEFAULT_MAX_FULL_FRAME_BYTES,
  );
  const maxRenderTargetBytes = await resolveMaxRenderTargetBytes(
    exportOptions,
    plan,
  );
  const framebufferMemorySafetyFactor = positiveNumberOrDefault(
    exportOptions.framebufferMemorySafetyFactor,
    plan.framebufferMemorySafetyFactor || DEFAULT_FRAMEBUFFER_MEMORY_SAFETY_FACTOR,
  );
  const layerCount = Math.max(1, plan.layers.length);
  const fullFrameEstimate = estimateFullFrameBytes(
    width,
    height,
    framebufferMemorySafetyFactor,
  );
  const fullFrameRenderTargetEstimate = estimateRenderTargetBytes(
    width,
    height,
    getFullFrameRenderTargetCount(layerCount),
  );
  const rowStride = getPngRowStride(width, pngChannels);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = pngColorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  if (plan.layers.length === 0 || !plan.view) {
    const blankTileHeight = getBlankStreamTileHeight(
      width,
      height,
      maxBandBytes,
      pngChannels,
    );
    const deflatedChunks = await deflatePngRows(async (writeRow) => {
      await writeBlankPngRows(
        writeRow,
        width,
        height,
        blankTileHeight,
        background,
        pngChannels,
      );
    });
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      ...deflatedChunks.map((chunk) => pngChunk("IDAT", chunk)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }

  const shouldTryFullFrame =
    strategy === "full-frame" ||
    (strategy === "auto" &&
      fullFrameEstimate <= maxFullFrameBytes &&
      fullFrameRenderTargetEstimate <= maxRenderTargetBytes);
  if (shouldTryFullFrame) {
    assertRenderTargetBudget(
      fullFrameRenderTargetEstimate,
      maxRenderTargetBytes,
      width,
      height,
    );
    try {
      return renderPlanToFullFramePngBuffer(
        renderer,
        plan,
        width,
        height,
        background,
      );
    } catch (error) {
      if (strategy === "full-frame") {
        throw error;
      }
      renderer.releaseInternalContexts();
    }
  }

  const gl = renderer.createExportContext(
    PROBE_RENDER_TARGET_SIZE,
    PROBE_RENDER_TARGET_SIZE,
  );
  const maxDimension = getMaxRenderDimension(gl);
  if (width > maxDimension) {
    throw new Error(
      `PNG export width ${width}px exceeds this renderer's ${maxDimension}px render limit.`,
    );
  }

  const tileHeight = getStreamTileHeight(
    width,
    height,
    maxBandBytes,
    maxRenderTargetBytes,
    maxDimension,
    layerCount,
    pngChannels,
  );
  if (!renderer.rendererOptions.gl) {
    renderer.releaseContext();
  }
  const renderGl = renderer.rendererOptions.gl
    ? gl
    : renderer.createExportContext(width, tileHeight);

  const deflatedChunks = await deflatePngRows(async (writeRow) => {
    const renderContext = createProcessorForPlan(
      renderer,
      plan,
      renderGl,
      width,
      tileHeight,
    );
    const tilePixels = new Uint8Array(width * tileHeight * 4);
    try {
      for (let tileY = 0; tileY < height; tileY += tileHeight) {
        const currentTileHeight = Math.min(tileHeight, height - tileY);
        const renderTileY =
          currentTileHeight === tileHeight ? tileY : Math.max(0, height - tileHeight);
        const sourceRowOffset = tileY - renderTileY;
        const readY = tileHeight - sourceRowOffset - currentTileHeight;
        renderContext.processor.render_tile(
          renderContext.activeLayerIds,
          renderContext.colorData,
          width,
          height,
          0,
          renderTileY,
          width,
          tileHeight,
          plan.view.zoomX,
          plan.view.zoomY,
          plan.view.offsetX,
          plan.view.offsetY,
          1,
        );
        renderGl.finish?.();
        renderGl.readPixels(
          0,
          readY,
          width,
          currentTileHeight,
          renderGl.RGBA,
          renderGl.UNSIGNED_BYTE,
          tilePixels,
        );
        await writeTileRows(
          writeRow,
          tilePixels,
          width,
          currentTileHeight,
          rowStride,
          background,
          pngChannels,
        );
      }
    } finally {
      disposeProcessor(renderContext.processor);
    }
  });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    ...deflatedChunks.map((chunk) => pngChunk("IDAT", chunk)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderPlanToFullFramePngBuffer(
  renderer,
  plan,
  width,
  height,
  background,
) {
  const gl = renderer.createExportContext(width, height);
  const maxDimension = getMaxRenderDimension(gl);
  if (width > maxDimension || height > maxDimension) {
    throw new Error(
      `PNG export size ${width}x${height}px exceeds this renderer's ${maxDimension}px render limit.`,
    );
  }

  const renderContext = createProcessorForPlan(renderer, plan, gl, width, height);
  try {
    const pixels = plan.layers.length === 0 || !plan.view
      ? new Uint8Array(width * height * 4)
      : renderContext.processor.render_pixels_with_clear(
          renderContext.activeLayerIds,
          renderContext.colorData,
          plan.view.zoomX,
          plan.view.zoomY,
          plan.view.offsetX,
          plan.view.offsetY,
          1,
          true,
        );
    return bottomUpRgbaToPngBuffer(Buffer.from(pixels), width, height, background);
  } finally {
    disposeProcessor(renderContext.processor);
  }
}

function createProcessorForPlan(renderer, plan, gl, width, height) {
  resizeDrawingBuffer(gl, width, height);
  const processor = new renderer.wasmModule.GerberProcessor();
  try {
    if (typeof processor.init_with_size !== "function") {
      throw new Error("Streaming PNG export requires an updated WASM module.");
    }
    processor.init_with_size(gl, width, height);
    applyProcessorOptions(processor, plan);

    const activeLayerIds = new Uint32Array(plan.layers.length);
    const colorData = new Float32Array(plan.layers.length * 4);
    for (const [index, layer] of plan.layers.entries()) {
      activeLayerIds[index] = addPlanLayerToProcessor(processor, layer);
      const offset = index * 4;
      colorData[offset] = layer.color[0];
      colorData[offset + 1] = layer.color[1];
      colorData[offset + 2] = layer.color[2];
      colorData[offset + 3] = resolveLayerAlpha(layer.alpha, plan.globalAlpha);
    }

    return { processor, activeLayerIds, colorData };
  } catch (error) {
    disposeProcessor(processor);
    throw error;
  }
}

function addPlanLayerToProcessor(processor, layer) {
  if (layer.parsedLayer) {
    if (typeof processor.add_parsed_layer === "function") {
      return processor.add_parsed_layer(layer.parsedLayer);
    }
    if (typeof layer.content !== "string") {
      throw new Error("Parsed layer reuse requires an updated WASM renderer.");
    }
  }
  if (typeof layer.content !== "string") {
    throw new Error("Layer content is unavailable for rendering.");
  }
  return addLayerToProcessor(processor, layer.content, layer.offsetX, layer.offsetY);
}

function supportsParsedLayerReuse(wasmModule) {
  return typeof wasmModule.GerberProcessor?.prototype?.add_parsed_layer === "function";
}

function resizeRenderTarget(processor, gl, width, height) {
  const didResize = resizeDrawingBuffer(gl, width, height);
  if (!didResize) return;
  if (typeof processor.resize_to !== "function") {
    throw new Error("Streaming PNG export requires renderer resize support.");
  }
  processor.resize_to(width, height);
}

function resizeDrawingBuffer(gl, width, height) {
  if (gl.drawingBufferWidth === width && gl.drawingBufferHeight === height) {
    return false;
  }
  if (typeof gl.drawingBufferStorage === "function") {
    gl.drawingBufferStorage(gl.RGBA8 || GL_RGBA8, width, height);
    return true;
  }
  const canvas = gl.canvas;
  if (canvas && "width" in canvas && "height" in canvas) {
    if (canvas.width === width && canvas.height === height) {
      return false;
    }
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
    throw new Error("The WebGL context cannot be resized for streaming PNG export.");
  }
  return false;
}

function disposeProcessor(processor) {
  try {
    processor.clear();
  } catch (_error) {
    // Best-effort cleanup.
  }
  try {
    processor.free?.();
  } catch (_error) {
    // Best-effort cleanup.
  }
}

async function deflatePngRows(writeRows) {
  const deflate = createDeflate();
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    deflate.once("end", resolve);
    deflate.once("error", reject);
  });
  deflate.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  try {
    await writeRows(async (row) => {
      if (!deflate.write(Buffer.from(row))) {
        await Promise.race([once(deflate, "drain"), done]);
      }
    });
    deflate.end();
    await done;
  } catch (error) {
    deflate.destroy();
    throw error;
  }
  return chunks;
}

async function writeBlankPngRows(
  writeRow,
  width,
  height,
  tileHeight,
  background,
  channels,
) {
  const rowStride = getPngRowStride(width, channels);
  const band = Buffer.alloc(rowStride * tileHeight);
  if (background) {
    fillBandBackground(band, width, tileHeight, rowStride, background, channels);
  }
  for (let y = 0; y < height; y += tileHeight) {
    const currentTileHeight = Math.min(tileHeight, height - y);
    await writeRow(band.subarray(0, currentTileHeight * rowStride));
  }
}

async function writeTileRows(
  writeRow,
  tilePixels,
  width,
  rowCount,
  rowStride,
  background,
  channels,
) {
  const band = Buffer.allocUnsafe(rowStride * rowCount);
  const sourceRowBytes = width * 4;
  for (let y = 0; y < rowCount; y += 1) {
    const rowStart = y * rowStride;
    band[rowStart] = 0;
    const sourceStart = (rowCount - 1 - y) * sourceRowBytes;
    if (background) {
      if (channels === 3) {
        writeOpaqueBackgroundRgbRow(
          band,
          rowStart + 1,
          tilePixels,
          sourceStart,
          sourceRowBytes,
          background,
        );
      } else {
        writeOpaqueBackgroundRgbaRow(
          band,
          rowStart + 1,
          tilePixels,
          sourceStart,
          sourceRowBytes,
          background,
        );
      }
    } else {
      copyPremultipliedRowToPng(band, rowStart + 1, tilePixels, sourceStart, sourceRowBytes);
    }
  }
  await writeRow(band);
}

function writeOpaqueBackgroundRgbaRow(
  output,
  outputOffset,
  source,
  sourceOffset,
  byteLength,
  background,
) {
  if (background[3] !== 255) {
    compositePremultipliedRowBackground(
      output,
      outputOffset,
      source,
      sourceOffset,
      byteLength,
      background,
    );
    return;
  }

  const bgR = background[0];
  const bgG = background[1];
  const bgB = background[2];
  if (bgR === 0 && bgG === 0 && bgB === 0) {
    for (let offset = 0; offset < byteLength; offset += 4) {
      const target = outputOffset + offset;
      output[target] = source[sourceOffset + offset];
      output[target + 1] = source[sourceOffset + offset + 1];
      output[target + 2] = source[sourceOffset + offset + 2];
      output[target + 3] = 255;
    }
    return;
  }

  for (let offset = 0; offset < byteLength; offset += 4) {
    const srcA = source[sourceOffset + offset + 3];
    const inverseA = 255 - srcA;
    const target = outputOffset + offset;
    output[target] = source[sourceOffset + offset] + Math.round((bgR * inverseA) / 255);
    output[target + 1] = source[sourceOffset + offset + 1] + Math.round((bgG * inverseA) / 255);
    output[target + 2] = source[sourceOffset + offset + 2] + Math.round((bgB * inverseA) / 255);
    output[target + 3] = 255;
  }
}

function writeOpaqueBackgroundRgbRow(
  output,
  outputOffset,
  source,
  sourceOffset,
  byteLength,
  background,
) {
  const bgR = background[0];
  const bgG = background[1];
  const bgB = background[2];
  if (bgR === 0 && bgG === 0 && bgB === 0) {
    for (let offset = 0, target = outputOffset; offset < byteLength; offset += 4, target += 3) {
      output[target] = source[sourceOffset + offset];
      output[target + 1] = source[sourceOffset + offset + 1];
      output[target + 2] = source[sourceOffset + offset + 2];
    }
    return;
  }

  for (let offset = 0, target = outputOffset; offset < byteLength; offset += 4, target += 3) {
    const srcA = source[sourceOffset + offset + 3];
    const inverseA = 255 - srcA;
    output[target] = source[sourceOffset + offset] + Math.round((bgR * inverseA) / 255);
    output[target + 1] = source[sourceOffset + offset + 1] + Math.round((bgG * inverseA) / 255);
    output[target + 2] = source[sourceOffset + offset + 2] + Math.round((bgB * inverseA) / 255);
  }
}

function fillBandBackground(band, width, height, rowStride, background, channels) {
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    band[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * channels;
      band[offset] = background[0];
      band[offset + 1] = background[1];
      band[offset + 2] = background[2];
      if (channels === 4) {
        band[offset + 3] = background[3];
      }
    }
  }
}

function copyPremultipliedRowToPng(
  output,
  outputOffset,
  source,
  sourceOffset,
  byteLength,
) {
  for (let offset = 0; offset < byteLength; offset += 4) {
    const srcA = source[sourceOffset + offset + 3];
    const target = outputOffset + offset;
    output[target + 3] = srcA;
    if (srcA === 0) {
      output[target] = 0;
      output[target + 1] = 0;
      output[target + 2] = 0;
    } else if (srcA === 255) {
      output[target] = source[sourceOffset + offset];
      output[target + 1] = source[sourceOffset + offset + 1];
      output[target + 2] = source[sourceOffset + offset + 2];
    } else {
      const scale = 255 / srcA;
      output[target] = toByte(source[sourceOffset + offset] * scale);
      output[target + 1] = toByte(source[sourceOffset + offset + 1] * scale);
      output[target + 2] = toByte(source[sourceOffset + offset + 2] * scale);
    }
  }
}

function compositePremultipliedRowBackground(
  output,
  outputOffset,
  source,
  sourceOffset,
  byteLength,
  background,
) {
  const bgA = background[3] / 255;
  for (let offset = 0; offset < byteLength; offset += 4) {
    const srcR = source[sourceOffset + offset] / 255;
    const srcG = source[sourceOffset + offset + 1] / 255;
    const srcB = source[sourceOffset + offset + 2] / 255;
    const srcAByte = source[sourceOffset + offset + 3];
    const srcA = srcAByte / 255;
    const outA = srcA + bgA * (1 - srcA);
    const target = outputOffset + offset;
    if (outA <= 0) {
      output[target] = 0;
      output[target + 1] = 0;
      output[target + 2] = 0;
      output[target + 3] = 0;
      continue;
    }
    output[target] = toByte(
      ((srcR + (background[0] / 255) * bgA * (1 - srcA)) / outA) * 255,
    );
    output[target + 1] = toByte(
      ((srcG + (background[1] / 255) * bgA * (1 - srcA)) / outA) * 255,
    );
    output[target + 2] = toByte(
      ((srcB + (background[2] / 255) * bgA * (1 - srcA)) / outA) * 255,
    );
    output[target + 3] = toByte(outA * 255);
  }
}

function bottomUpRgbaToPngBuffer(rgba, width, height, background) {
  const pngColorType = getPngColorType(background);
  const pngChannels = getPngChannelCount(pngColorType);
  const rowBytes = width * 4;
  const rowStride = getPngRowStride(width, pngChannels);
  const raw = Buffer.allocUnsafe(rowStride * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * rowStride;
    const sourceStart = (height - 1 - y) * rowBytes;
    raw[rawOffset] = 0;
    if (background) {
      if (pngChannels === 3) {
        writeOpaqueBackgroundRgbRow(
          raw,
          rawOffset + 1,
          rgba,
          sourceStart,
          rowBytes,
          background,
        );
      } else {
        writeOpaqueBackgroundRgbaRow(
          raw,
          rawOffset + 1,
          rgba,
          sourceStart,
          rowBytes,
          background,
        );
      }
    } else {
      copyPremultipliedRowToPng(raw, rawOffset + 1, rgba, sourceStart, rowBytes);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = pngColorType;
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

function getPngColorType(background) {
  return background && background[3] === 255 ? 2 : 6;
}

function getPngChannelCount(colorType) {
  return colorType === 2 ? 3 : RGBA_BYTES_PER_PIXEL;
}

function getPngRowStride(width, channels = RGBA_BYTES_PER_PIXEL) {
  return 1 + width * channels;
}

function estimateFullFrameBytes(width, height, safetyFactor) {
  const pixelBytes = width * height * RGBA_BYTES_PER_PIXEL;
  return pixelBytes * safetyFactor;
}

async function resolveMaxRenderTargetBytes(exportOptions, plan) {
  if (exportOptions.maxRenderTargetBytes != null) {
    return positiveIntegerOrDefault(
      exportOptions.maxRenderTargetBytes,
      DEFAULT_MAX_RENDER_TARGET_BYTES,
    );
  }

  if (plan.maxRenderTargetBytes != null) {
    return positiveIntegerOrDefault(
      plan.maxRenderTargetBytes,
      DEFAULT_MAX_RENDER_TARGET_BYTES,
    );
  }

  return probeRenderTargetBudgetBytes();
}

async function probeRenderTargetBudgetBytes() {
  const limits = [DEFAULT_MAX_RENDER_TARGET_BYTES];
  const freeRamBytes = Number(freemem());
  if (Number.isFinite(freeRamBytes) && freeRamBytes > 0) {
    limits.push(Math.floor(freeRamBytes * 0.5));
  }

  const freeVramBytes = await probeFreeVramBytes();
  if (Number.isFinite(freeVramBytes) && freeVramBytes > 0) {
    limits.push(Math.floor(freeVramBytes * 0.75));
  }

  return Math.max(MIN_RENDER_TARGET_BYTES, Math.min(...limits));
}

async function probeFreeVramBytes() {
  const probes = [
    probeNvidiaFreeVramBytes(),
    probeLinuxDrmFreeVramBytes(),
    probeRocmFreeVramBytes(),
  ];
  const results = await Promise.allSettled(probes);
  const values = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? Math.max(...values) : null;
}

async function probeNvidiaFreeVramBytes() {
  const stdout = await execFileText("nvidia-smi", [
    "--query-gpu=memory.free",
    "--format=csv,noheader,nounits",
  ]);
  const values = stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((mib) => mib * 1024 * 1024);
  return values.length > 0 ? Math.max(...values) : null;
}

async function probeLinuxDrmFreeVramBytes() {
  const entries = await readdir("/sys/class/drm", { withFileTypes: true });
  const values = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^card\d+$/.test(entry.name))
      .map(async (entry) => {
        const base = `/sys/class/drm/${entry.name}/device`;
        const [total, used] = await Promise.all([
          readIntegerFile(`${base}/mem_info_vram_total`),
          readIntegerFile(`${base}/mem_info_vram_used`),
        ]);
        if (total == null || used == null || total <= used) return null;
        return total - used;
      }),
  );
  const finiteValues = values.filter((value) => Number.isFinite(value) && value > 0);
  return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
}

async function probeRocmFreeVramBytes() {
  const stdout = await execFileText("rocm-smi", ["--showmeminfo", "vram"]);
  const freeValues = [];
  const usedValues = [];
  const totalValues = [];

  for (const line of stdout.split(/\r?\n/)) {
    const value = Number(line.match(/(-?\d+)\s*$/)?.[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (/free/i.test(line)) {
      freeValues.push(value);
    } else if (/used/i.test(line)) {
      usedValues.push(value);
    } else if (/total/i.test(line)) {
      totalValues.push(value);
    }
  }

  if (freeValues.length > 0) {
    return Math.max(...freeValues);
  }
  const computed = totalValues
    .map((total, index) => {
      const used = usedValues[index];
      return Number.isFinite(used) && total > used ? total - used : null;
    })
    .filter((value) => Number.isFinite(value) && value > 0);
  return computed.length > 0 ? Math.max(...computed) : null;
}

async function readIntegerFile(path) {
  try {
    const content = await readFile(path, "utf8");
    const value = Number(content.trim());
    return Number.isFinite(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFileCallback(
      command,
      args,
      {
        encoding: "utf8",
        timeout: MEMORY_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function estimateRenderTargetBytes(width, height, targetCount) {
  return width * height * RGBA_BYTES_PER_PIXEL * Math.max(1, targetCount);
}

function getFullFrameRenderTargetCount(layerCount) {
  return Math.max(1, Math.floor(numberOrDefault(layerCount, 1))) + 2;
}

function getStreamRenderTargetCount(layerCount) {
  return Math.max(1, Math.floor(numberOrDefault(layerCount, 1))) + 1;
}

function assertRenderTargetBudget(estimatedBytes, maxRenderTargetBytes, width, height) {
  if (estimatedBytes <= maxRenderTargetBytes) return;
  throw new Error(
    `PNG export render targets exceed the ${formatByteCount(maxRenderTargetBytes)} per-render limit at ${width} x ${height}px.`,
  );
}

function getStreamTileHeight(
  width,
  height,
  maxBandBytes,
  maxRenderTargetBytes,
  maxDimension = Number.POSITIVE_INFINITY,
  layerCount = 1,
  pngChannels = RGBA_BYTES_PER_PIXEL,
) {
  const rowStride = getPngRowStride(width, pngChannels);
  const byBandBytes = Math.floor(maxBandBytes / rowStride);
  const targetCount = getStreamRenderTargetCount(layerCount);
  const byRenderTargetBytes = Math.floor(
    maxRenderTargetBytes / (width * RGBA_BYTES_PER_PIXEL * targetCount),
  );
  const tileHeight = Math.min(height, maxDimension, byBandBytes, byRenderTargetBytes);
  if (!Number.isFinite(tileHeight) || tileHeight < 1) {
    throw new Error(
      `PNG export tile is too large for ${width}px rows under the ${formatByteCount(maxRenderTargetBytes)} per-render limit.`,
    );
  }
  return Math.max(1, Math.floor(tileHeight));
}

function getBlankStreamTileHeight(width, height, maxBandBytes, pngChannels) {
  const rowStride = getPngRowStride(width, pngChannels);
  const tileHeight = Math.min(height, Math.floor(maxBandBytes / rowStride));
  if (!Number.isFinite(tileHeight) || tileHeight < 1) {
    throw new Error(
      `PNG export rows exceed the ${formatByteCount(maxBandBytes)} stream band limit at ${width}px wide.`,
    );
  }
  return Math.max(1, Math.floor(tileHeight));
}

function getMaxRenderDimension(gl) {
  return Math.min(
    getGlNumericParameter(gl, gl.MAX_RENDERBUFFER_SIZE),
    getGlNumericParameter(gl, gl.MAX_TEXTURE_SIZE),
  );
}

function getGlNumericParameter(gl, parameter) {
  if (parameter == null || typeof gl.getParameter !== "function") {
    return Number.POSITIVE_INFINITY;
  }
  const value = Number(gl.getParameter(parameter));
  return Number.isFinite(value) && value > 0
    ? value
    : Number.POSITIVE_INFINITY;
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

function formatByteCount(bytes) {
  const units = ["bytes", "KiB", "MiB", "GiB"];
  let value = Number(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function normalizeExportStrategy(value) {
  if (value == null) return "auto";
  const strategy = String(value);
  if (strategy === "auto" || strategy === "full-frame" || strategy === "stream") {
    return strategy;
  }
  throw new TypeError("strategy must be 'auto', 'full-frame', or 'stream'.");
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
