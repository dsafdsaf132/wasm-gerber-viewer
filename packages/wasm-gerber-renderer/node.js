import { once } from "node:events";
import { execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { freemem } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDeflate } from "node:zlib";
import {
  DEFAULT_ARC_TESSELLATION_QUALITY,
  FrameState,
  PNG_SIGNATURE,
  addLayerToProcessor,
  applyProcessorOptions,
  clamp01,
  createBaseFrameOptions,
  createPngHeader,
  getPngChannelCount,
  getPngColorType,
  getPngRowStride,
  getSourceName,
  isDrillLayerKind,
  loadLayersBestEffort,
  loadWasmJsModule,
  normalizeColor,
  normalizeLayer,
  normalizeLayerKind,
  normalizeLayerList,
  normalizeParseOptions,
  numberOrDefault,
  optionalAlpha,
  parseDrillLayerPayload,
  parseColor,
  payloadBounds,
  positiveIntegerOrDefault,
  positiveNumberOrDefault,
  renderLayersBestEffort,
  resolveDrillRenderColors,
  resolveFrameView,
  resolveLayerAlpha,
  sourceToText,
  pngChunk,
  writeBlankPngRows,
  writePixelRowsToPngRows,
} from "./shared.js";

const require = createRequire(import.meta.url);

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
const RGBA_BYTES_PER_PIXEL = 4;
const DEFAULT_MAX_STREAM_BAND_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FULL_FRAME_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_RENDER_TARGET_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_STREAM_TILE_WIDTH = 1;
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
  const renderer = await createNodeGerberRenderer(rendererOptions);
  try {
    await renderer.withFrame(frameOptions, async () => {
      await renderer.renderLayers(layers, frameOptions);
    });
    await renderer.exportPngFile(outputPath, exportOptions);
  } finally {
    renderer.dispose();
  }
}

export async function renderGerberToPngStream(
  writable,
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
    await renderer.exportPngStream(writable, exportOptions);
  } finally {
    renderer.dispose();
  }
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

  async loadLayer(layer, layerOptions = {}) {
    this.assertUsable();
    return this.createPreparedLayer(layer, layerOptions);
  }

  async loadLayers(layers, options = {}) {
    this.assertUsable();
    return loadLayersBestEffort(this, normalizeLayerList(layers), options);
  }

  async exportPng(exportOptions = {}) {
    this.assertRenderedFrameAvailable();

    const background =
      "background" in exportOptions
        ? exportOptions.background
        : this.lastFrame.background;

    return renderPlanToPngBuffer(this, this.lastRenderPlan, {
      ...exportOptions,
      background,
    });
  }

  async exportPngStream(writable, exportOptions = {}) {
    this.assertRenderedFrameAvailable();

    const background =
      "background" in exportOptions
        ? exportOptions.background
        : this.lastFrame.background;

    await renderPlanToPngWritable(this, this.lastRenderPlan, {
      ...exportOptions,
      background,
    }, writable);
  }

  async exportPngFile(outputPath, exportOptions = {}) {
    this.assertRenderedFrameAvailable();
    const tempPath = createTempOutputPath(outputPath);
    const stream = createWriteStream(tempPath, { flags: "wx" });
    const done = finished(stream);
    try {
      await this.exportPngStream(stream, exportOptions);
      stream.end();
      await done;
      await rename(tempPath, outputPath);
    } catch (error) {
      stream.destroy(error);
      try {
        await done;
      } catch (_streamError) {
        // Preserve the original rendering error.
      }
      await rm(tempPath, { force: true });
      throw error;
    }
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
    if (!prepared) {
      return null;
    }
    if (isDrillLayerKind(prepared.kind) && !this.frame.options.renderDrills) {
      return null;
    }
    const isDrill = isDrillLayerKind(prepared.kind);
    const layerId = this.frame.layers.length;
    const color = isDrill
      ? null
      : prepared.color == null
        ? this.frame.nextColor()
        : normalizeColor(prepared.color, this.frame.options.colors[0], {
            allowString: true,
          });

    return {
      kind: prepared.kind,
      layerId,
      name: prepared.name || `Layer ${layerId}`,
      content: prepared.content,
      parsedLayer: prepared.parsedLayer,
      parsedDrillLayer: prepared.parsedDrillLayer,
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
    const offsetX = numberOrDefault(options.offsetX, 0);
    const offsetY = numberOrDefault(options.offsetY, 0);
    const initialKind = normalizeLayerKind(options.kind, source, options.name);
    if (isDrillLayerKind(initialKind) && options.renderDrills === false) {
      return null;
    }
    const content = await sourceToText(source, {
      fileUrlToPath: fileURLToPath,
      readPathText: (path) => readFile(path, "utf8"),
      sourceDescription:
        "a string, File, Blob, ArrayBuffer, Uint8Array, URL, or path config",
    });
    const kind = isDrillLayerKind(initialKind)
      ? initialKind
      : normalizeLayerKind(options.kind, source, options.name, content);
    if (isDrillLayerKind(kind) && options.renderDrills === false) {
      return null;
    }
    const parseOptions = normalizeParseOptions(options);
    const parsed = isDrillLayerKind(kind)
      ? parseDrillLayerPayload(this.wasmModule, content, offsetX, offsetY)
      : parseLayerPayload(
          this.wasmModule,
          content,
          offsetX,
          offsetY,
          parseOptions,
        );
    const sourceName = getSourceName(source);

    return {
      [NODE_PREPARED_LAYER]: true,
      kind,
      name: options.name || sourceName || "Layer",
      sourceName,
      content: supportsParsedLayerReuse(this.wasmModule) ? null : content,
      parsedLayer: isDrillLayerKind(kind) ? null : parsed.payload,
      parsedDrillLayer: isDrillLayerKind(kind)
        ? {
            outlineLayer: parsed.outlineLayer,
            fillLayer: parsed.fillLayer,
          }
        : null,
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

  assertRenderedFrameAvailable() {
    this.assertUsable();
    if (!this.lastFrame || !this.lastRenderPlan) {
      throw new Error("No rendered frame is available for export.");
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
        kind: layer.kind,
        content: layer.content,
        parsedLayer: layer.parsedLayer,
        parsedDrillLayer: layer.parsedDrillLayer,
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

  const bounds = payloadBounds(payload);
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
  const kind = normalizeLayerKind(preparedLayer.kind, { name: preparedLayer.sourceName });
  if (
    ("offsetX" in layerOptions && numberOrDefault(layerOptions.offsetX, 0) !== offsetX) ||
    ("offsetY" in layerOptions && numberOrDefault(layerOptions.offsetY, 0) !== offsetY)
  ) {
    throw new Error("Prepared layer offsets are fixed. Load the layer again to change offsets.");
  }
  if (
    "kind" in layerOptions &&
      layerOptions.kind != null &&
    normalizeLayerKind(layerOptions.kind, { name: preparedLayer.sourceName }) !== kind
  ) {
    throw new Error("Prepared layer kind is fixed. Load the layer again to change kind.");
  }

  return {
    ...preparedLayer,
    name:
      "name" in layerOptions && layerOptions.name != null
        ? String(layerOptions.name)
        : preparedLayer.name,
    kind,
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
  const sink = new BufferPngSink();
  await renderPlanToPngSink(renderer, plan, exportOptions, sink);
  return sink.toBuffer();
}

async function renderPlanToPngWritable(renderer, plan, exportOptions, writable) {
  if (!writable || typeof writable.write !== "function") {
    throw new TypeError("A Node writable stream is required.");
  }
  await renderPlanToPngSink(
    renderer,
    plan,
    exportOptions,
    new NodeWritablePngSink(writable),
  );
}

async function renderPlanToPngSink(renderer, plan, exportOptions, sink) {
  const width = positiveIntegerOrDefault(plan.width, DEFAULT_WIDTH);
  const height = positiveIntegerOrDefault(plan.height, DEFAULT_HEIGHT);
  const strategy = normalizeExportStrategy(exportOptions.strategy || plan.strategy);
  const renderPlan = { ...plan, background: exportOptions.background };
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
  const layerCount = Math.max(1, getRenderLayerCount(renderPlan.layers));
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
  if (renderPlan.layers.length === 0 || !renderPlan.view) {
    const blankTileHeight = getBlankStreamTileHeight(
      width,
      height,
      maxBandBytes,
      pngChannels,
    );
    await writePngDocument(sink, width, height, pngColorType, async (writeRow) => {
      await writeBlankPngRows(
        writeRow,
        width,
        height,
        blankTileHeight,
        background,
        pngChannels,
      );
    });
    return;
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
      await renderPlanToFullFramePngSink(
        renderer,
        renderPlan,
        sink,
        width,
        height,
        background,
        pngColorType,
        pngChannels,
        maxBandBytes,
      );
      return;
    } catch (error) {
      if (error instanceof PngSinkWriteError) {
        throw error.cause || error;
      }
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
  const tileWidth = getStreamTileWidth(width, maxDimension);
  if (!renderer.rendererOptions.gl) {
    renderer.releaseContext();
  }
  const rowStride = getPngRowStride(width, pngChannels);

  await writePngDocument(sink, width, height, pngColorType, async (writeRow) => {
    let streamState = createStreamRenderStateWithFallback(
      renderer,
      renderPlan,
      tileWidth,
      width,
      height,
      maxBandBytes,
      maxRenderTargetBytes,
      maxDimension,
      layerCount,
      pngChannels,
    );
    const bandRowBytes = width * 4;
    try {
      let tileY = 0;
      while (tileY < height) {
        let currentTileHeight = 0;
        for (;;) {
          try {
            currentTileHeight = renderStreamBand(
              streamState,
              width,
              height,
              tileY,
              plan.view,
              bandRowBytes,
            );
            break;
          } catch (error) {
            if (!canReduceStreamTileWidth(streamState.tileWidth)) {
              throw error;
            }
            const nextTileWidth = reduceStreamTileWidth(streamState.tileWidth);
            disposeStreamRenderState(renderer, streamState, true);
            streamState = null;
            streamState = createStreamRenderStateWithFallback(
              renderer,
              plan,
              nextTileWidth,
              width,
              height,
              maxBandBytes,
              maxRenderTargetBytes,
              maxDimension,
              layerCount,
              pngChannels,
            );
          }
        }

        await writePixelRowsToPngRows(
          writeRow,
          streamState.bandPixels.subarray(0, bandRowBytes * currentTileHeight),
          width,
          currentTileHeight,
          rowStride,
          background,
          pngChannels,
        );
        tileY += currentTileHeight;
      }
    } finally {
      disposeStreamRenderState(renderer, streamState, false);
    }
  });
}

function createStreamRenderStateWithFallback(
  renderer,
  plan,
  tileWidth,
  width,
  height,
  maxBandBytes,
  maxRenderTargetBytes,
  maxDimension,
  layerCount,
  pngChannels,
) {
  let nextTileWidth = tileWidth;
  for (;;) {
    try {
      return createStreamRenderState(
        renderer,
        plan,
        nextTileWidth,
        width,
        height,
        maxBandBytes,
        maxRenderTargetBytes,
        maxDimension,
        layerCount,
        pngChannels,
      );
    } catch (error) {
      if (!canReduceStreamTileWidth(nextTileWidth)) {
        throw error;
      }
      nextTileWidth = reduceStreamTileWidth(nextTileWidth);
    }
  }
}

function createStreamRenderState(
  renderer,
  plan,
  tileWidth,
  width,
  height,
  maxBandBytes,
  maxRenderTargetBytes,
  maxDimension,
  layerCount,
  pngChannels,
) {
  const tileHeight = getStreamTileHeight(
    width,
    height,
    tileWidth,
    maxBandBytes,
    maxRenderTargetBytes,
    maxDimension,
    layerCount,
    pngChannels,
  );
  const renderGl = renderer.createExportContext(tileWidth, tileHeight);
  let renderContext = null;
  try {
    renderContext = createProcessorForPlan(
      renderer,
      plan,
      renderGl,
      tileWidth,
      tileHeight,
    );
    return {
      tileWidth,
      tileHeight,
      renderGl,
      renderContext,
      tilePixels: new Uint8Array(tileWidth * tileHeight * 4),
      bandPixels: new Uint8Array(width * tileHeight * 4),
    };
  } catch (error) {
    if (renderContext) {
      disposeProcessor(renderContext.processor);
    }
    if (!renderer.rendererOptions.gl) {
      renderer.releaseContext();
    }
    throw error;
  }
}

function renderStreamBand(state, width, height, tileY, view, bandRowBytes) {
  const currentTileHeight = Math.min(state.tileHeight, height - tileY);
  const renderTileY =
    currentTileHeight === state.tileHeight ? tileY : Math.max(0, height - state.tileHeight);
  const sourceRowOffset = tileY - renderTileY;
  const readY = state.tileHeight - sourceRowOffset - currentTileHeight;
  state.bandPixels.fill(0, 0, bandRowBytes * currentTileHeight);

  for (let tileX = 0; tileX < width; tileX += state.tileWidth) {
    const currentTileWidth = Math.min(state.tileWidth, width - tileX);
    const renderTileX =
      currentTileWidth === state.tileWidth ? tileX : Math.max(0, width - state.tileWidth);
    const readX = tileX - renderTileX;
    if (hasBlendModes(state.renderContext.blendModes)) {
      if (typeof state.renderContext.processor.render_tile_with_blend_modes !== "function") {
        throw new Error("Drill rendering requires an updated WASM renderer.");
      }
      state.renderContext.processor.render_tile_with_blend_modes(
        state.renderContext.activeLayerIds,
        state.renderContext.colorData,
        state.renderContext.blendModes,
        width,
        height,
        renderTileX,
        renderTileY,
        state.tileWidth,
        state.tileHeight,
        view.zoomX,
        view.zoomY,
        view.offsetX,
        view.offsetY,
        1,
      );
    } else {
      state.renderContext.processor.render_tile(
        state.renderContext.activeLayerIds,
        state.renderContext.colorData,
        width,
        height,
        renderTileX,
        renderTileY,
        state.tileWidth,
        state.tileHeight,
        view.zoomX,
        view.zoomY,
        view.offsetX,
        view.offsetY,
        1,
      );
    }
    state.renderGl.finish?.();
    state.renderGl.readPixels(
      readX,
      readY,
      currentTileWidth,
      currentTileHeight,
      state.renderGl.RGBA,
      state.renderGl.UNSIGNED_BYTE,
      state.tilePixels,
    );

    const tileRowBytes = currentTileWidth * 4;
    for (let row = 0; row < currentTileHeight; row += 1) {
      const sourceStart = row * tileRowBytes;
      const sourceEnd = sourceStart + tileRowBytes;
      const destStart = row * bandRowBytes + tileX * 4;
      state.bandPixels.set(
        state.tilePixels.subarray(sourceStart, sourceEnd),
        destStart,
      );
    }
  }

  return currentTileHeight;
}

function disposeStreamRenderState(renderer, state, releaseContext) {
  if (!state) return;
  disposeProcessor(state.renderContext.processor);
  if (releaseContext && !renderer.rendererOptions.gl) {
    renderer.releaseContext();
  }
}

async function renderPlanToFullFramePngSink(
  renderer,
  plan,
  sink,
  width,
  height,
  background,
  pngColorType,
  pngChannels,
  maxBandBytes,
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
      : renderPlanPixels(renderContext, plan);
    await writePngDocument(sink, width, height, pngColorType, async (writeRow) => {
      await writeFullFramePixelRows(
        writeRow,
        pixels,
        width,
        height,
        background,
        pngChannels,
        maxBandBytes,
      );
    });
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

    const renderEntries = createPlanRenderEntries(processor, plan);
    const activeLayerIds = new Uint32Array(
      renderEntries.map((entry) => entry.layerId),
    );
    const blendModes = new Uint8Array(renderEntries.map((entry) => entry.blendMode));
    const colorData = new Float32Array(renderEntries.length * 4);
    for (const [index, entry] of renderEntries.entries()) {
      const offset = index * 4;
      colorData[offset] = entry.color[0];
      colorData[offset + 1] = entry.color[1];
      colorData[offset + 2] = entry.color[2];
      colorData[offset + 3] = entry.alpha;
    }

    return { processor, activeLayerIds, colorData, blendModes };
  } catch (error) {
    disposeProcessor(processor);
    throw error;
  }
}

function renderPlanPixels(renderContext, plan) {
  if (hasBlendModes(renderContext.blendModes)) {
    if (
      typeof renderContext.processor.render_pixels_with_clear_and_blend_modes !==
      "function"
    ) {
      throw new Error("Drill rendering requires an updated WASM renderer.");
    }
    return renderContext.processor.render_pixels_with_clear_and_blend_modes(
      renderContext.activeLayerIds,
      renderContext.colorData,
      renderContext.blendModes,
      plan.view.zoomX,
      plan.view.zoomY,
      plan.view.offsetX,
      plan.view.offsetY,
      1,
      true,
    );
  }

  return renderContext.processor.render_pixels_with_clear(
    renderContext.activeLayerIds,
    renderContext.colorData,
    plan.view.zoomX,
    plan.view.zoomY,
    plan.view.offsetX,
    plan.view.offsetY,
    1,
    true,
  );
}

function hasBlendModes(blendModes) {
  return Boolean(blendModes?.some((mode) => mode !== 0));
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

function createPlanRenderEntries(processor, plan) {
  const gerberEntries = [];
  const drillOutlineEntries = [];
  const drillFillEntries = [];
  const drillColors = resolveDrillRenderColors(plan.background);

  for (const layer of plan.layers) {
    if (isDrillLayerKind(layer.kind)) {
      const { outlineLayerId, fillLayerId } = addPlanDrillLayerToProcessor(processor, layer);
      const alpha = resolveLayerAlpha(layer.alpha, 1);
      drillOutlineEntries.push({
        layerId: outlineLayerId,
        color: drillColors.outline,
        alpha,
        blendMode: 0,
      });
      drillFillEntries.push({
        layerId: fillLayerId,
        color: drillColors.fill,
        alpha,
        blendMode: drillColors.hasBackground ? 1 : 2,
      });
      continue;
    }

    gerberEntries.push({
      layerId: addPlanLayerToProcessor(processor, layer),
      color: layer.color,
      alpha: resolveLayerAlpha(layer.alpha, plan.globalAlpha),
      blendMode: 0,
    });
  }

  return [...gerberEntries, ...drillOutlineEntries, ...drillFillEntries];
}

function addPlanDrillLayerToProcessor(processor, layer) {
  if (layer.parsedDrillLayer && typeof processor.add_parsed_layer === "function") {
    return {
      outlineLayerId: processor.add_parsed_layer(layer.parsedDrillLayer.outlineLayer),
      fillLayerId: processor.add_parsed_layer(layer.parsedDrillLayer.fillLayer),
    };
  }
  if (typeof layer.content !== "string") {
    throw new Error("Drill layer content is unavailable for rendering.");
  }
  if (layer.offsetX !== 0 || layer.offsetY !== 0) {
    if (typeof processor.add_drill_layer_with_offset !== "function") {
      throw new Error("Drill layer offsets require an updated WASM renderer.");
    }
    const result = processor.add_drill_layer_with_offset(
      layer.content,
      layer.offsetX,
      layer.offsetY,
    );
    return normalizeDrillLayerIds(result);
  }
  if (typeof processor.add_drill_layer !== "function") {
    throw new Error("Drill rendering requires an updated WASM renderer.");
  }
  return normalizeDrillLayerIds(processor.add_drill_layer(layer.content));
}

function normalizeDrillLayerIds(result) {
  const outlineLayerId = Number(result?.outlineLayerId);
  const fillLayerId = Number(result?.fillLayerId);
  if (!Number.isInteger(outlineLayerId) || !Number.isInteger(fillLayerId)) {
    throw new Error("Drill rendering did not return layer IDs.");
  }
  return { outlineLayerId, fillLayerId };
}

function getRenderLayerCount(layers) {
  return layers.reduce(
    (count, layer) => count + (isDrillLayerKind(layer.kind) ? 2 : 1),
    0,
  );
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

class BufferPngSink {
  constructor() {
    this.chunks = [];
  }

  async write(chunk) {
    this.chunks.push(Buffer.from(chunk));
  }

  toBuffer() {
    return Buffer.concat(this.chunks);
  }
}

class NodeWritablePngSink {
  constructor(writable) {
    this.writable = writable;
  }

  async write(chunk) {
    try {
      await writeNodeWritable(this.writable, chunk);
    } catch (error) {
      throw new PngSinkWriteError(error);
    }
  }
}

class PngSinkWriteError extends Error {
  constructor(cause) {
    super(`PNG stream write failed: ${cause?.message || cause}`);
    this.name = "PngSinkWriteError";
    this.cause = cause;
  }
}

async function writePngDocument(sink, width, height, colorType, writeRows) {
  await sink.write(PNG_SIGNATURE);
  await sink.write(pngChunk("IHDR", createPngHeader(width, height, colorType)));
  await deflatePngRowsToSink(sink, writeRows);
  await sink.write(pngChunk("IEND", new Uint8Array(0)));
}

async function deflatePngRowsToSink(sink, writeRows) {
  const deflate = createDeflate();
  let writeError = null;
  let pendingWrites = 0;
  let resolvePendingWrites = null;
  let rejectWriteError = null;
  const writeErrorSignal = new Promise((_, reject) => {
    rejectWriteError = reject;
  });
  writeErrorSignal.catch(() => {});
  const done = new Promise((resolve, reject) => {
    deflate.once("end", resolve);
    deflate.once("error", reject);
  });
  deflate.on("data", (chunk) => {
    const idat = pngChunk("IDAT", Buffer.from(chunk));
    deflate.pause();
    pendingWrites += 1;
    Promise.resolve(sink.write(idat))
      .catch((error) => {
        writeError = error;
        rejectWriteError(error);
        deflate.destroy(error);
      })
      .finally(() => {
        pendingWrites -= 1;
        if (pendingWrites === 0 && resolvePendingWrites) {
          resolvePendingWrites();
          resolvePendingWrites = null;
        }
        if (!writeError) {
          deflate.resume();
        }
      });
  });

  try {
    await writeRows(async (row) => {
      if (writeError) throw writeError;
      if (!deflate.write(Buffer.from(row))) {
        await Promise.race([once(deflate, "drain"), done, writeErrorSignal]);
      }
      if (writeError) throw writeError;
    });
    deflate.end();
    await Promise.race([done, writeErrorSignal]);
    await waitForPendingPngWrites(() => pendingWrites, (resolve) => {
      resolvePendingWrites = resolve;
    });
    if (writeError) throw writeError;
  } catch (error) {
    deflate.destroy();
    throw writeError || error;
  }
}

function waitForPendingPngWrites(getPendingWrites, setResolvePendingWrites) {
  if (getPendingWrites() === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setResolvePendingWrites(resolve);
  });
}

async function writeFullFramePixelRows(
  writeRow,
  pixels,
  width,
  height,
  background,
  channels,
  maxBandBytes,
) {
  const rowStride = getPngRowStride(width, channels);
  const rowsPerBand = getBlankStreamTileHeight(width, height, maxBandBytes, channels);
  const sourceRowBytes = width * RGBA_BYTES_PER_PIXEL;
  for (let topY = 0; topY < height; topY += rowsPerBand) {
    const rowCount = Math.min(rowsPerBand, height - topY);
    const sourceStart = (height - topY - rowCount) * sourceRowBytes;
    await writePixelRowsToPngRows(
      writeRow,
      pixels.subarray(sourceStart, sourceStart + rowCount * sourceRowBytes),
      width,
      rowCount,
      rowStride,
      background,
      channels,
    );
  }
}

function writeNodeWritable(writable, chunk) {
  const buffer = Buffer.from(chunk);
  if (!isNodeWritableStream(writable)) {
    return Promise.resolve(writable.write(buffer));
  }

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      if (typeof writable.off === "function") {
        writable.off("error", onError);
      }
    };
    if (typeof writable.once === "function") {
      writable.once("error", onError);
    }
    try {
      writable.write(buffer, (error) => {
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function isNodeWritableStream(writable) {
  return typeof writable.once === "function";
}

function createTempOutputPath(outputPath) {
  const resolvedPath = resolve(outputPath);
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return resolve(dirname(resolvedPath), `.${basename(resolvedPath)}.${suffix}.tmp`);
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

function getStreamTileWidth(width, maxDimension = Number.POSITIVE_INFINITY) {
  const tileWidth = Math.min(width, maxDimension);
  if (!Number.isFinite(tileWidth) || tileWidth < 1) {
    throw new Error("PNG export tile width is outside this renderer's limits.");
  }
  return Math.max(1, Math.floor(tileWidth));
}

function canReduceStreamTileWidth(tileWidth) {
  return Number.isFinite(tileWidth) && tileWidth > MIN_STREAM_TILE_WIDTH;
}

function reduceStreamTileWidth(tileWidth) {
  if (!canReduceStreamTileWidth(tileWidth)) {
    return tileWidth;
  }
  return Math.max(MIN_STREAM_TILE_WIDTH, Math.floor(tileWidth / 2));
}

function getStreamTileHeight(
  width,
  height,
  tileWidth,
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
    maxRenderTargetBytes / (tileWidth * RGBA_BYTES_PER_PIXEL * targetCount),
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
