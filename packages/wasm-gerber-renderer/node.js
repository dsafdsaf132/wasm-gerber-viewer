import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { open, readdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { freemem } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDeflate } from "node:zlib";
import {
  COMPOSITE_MODE_STACK,
  LAYER_KIND_COMPOSITE,
  DEFAULT_ARC_TESSELLATION_QUALITY,
  FrameState,
  INVERTED_OUTLINE_AUTO,
  INVERTED_OUTLINE_BOUNDS,
  MAX_SOURCE_FILE_SIZE_BYTES,
  PNG_SIGNATURE,
  addLayerToProcessor,
  applyProcessorOptions,
  clamp01,
  createBaseFrameOptions,
  createCompositeVisibleBitset,
  createPngHeader,
  expandBounds,
  getPngChannelCount,
  getPngColorType,
  getPngRowStride,
  getSourceName,
  getDefaultDrillOutlineStyle,
  hasDrillOutlineStyle,
  isBoardOutlineLayerName,
  isDrillLayerKind,
  loadLayersBestEffort,
  loadWasmJsModule,
  mergeBounds,
  normalizeDrillOutlineColor,
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
  resolveFrameFitPadding,
  resolveFrameView,
  resolveLayerAlpha,
  setDefaultDrillInnerOutline,
  sourceToText,
  pngChunk,
  validatePngDimensions,
  validateCompositeSourceCount,
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
const INTERNAL_LAYER_SELECTOR_PREFIX = "__wasmGerberRendererCliLayer:";

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
    this.__lastCompositeErrors = [];
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
    this.frame.options.invertedOutline = resolveNodeFrameOutlineSelector(
      this.frame.options.invertedOutline,
    );
    const selectorKey = this.reserveFrameLayerSelectorKey();
    if (layerRequestsInversion(layer, layerOptions)) {
      this.frame.options.retainSourceContentForInversion = true;
    }

    const layerRecord = await this.createLayerRecord(layer, {
      ...layerOptions,
      __selectorKey:
        typeof layerOptions.__selectorKey === "string"
          ? layerOptions.__selectorKey
          : selectorKey,
    });
    if (!layerRecord) {
      return null;
    }
    layerRecord.id = this.reservePublicLayerId();
    this.frame.addLayer(layerRecord);
    return layerRecord.id;
  }

  reserveFrameLayerSelectorKey() {
    const index = this.frame.nextInputLayerSelectorIndex ?? 0;
    this.frame.nextInputLayerSelectorIndex = index + 1;
    return getInternalLayerSelectorKey(index);
  }

  async renderLayers(layers, options = {}) {
    this.assertUsable();
    if (!this.frame) {
      throw new Error("renderLayers must be called inside withFrame().");
    }

    const normalizedLayers = normalizeLayerList(layers);
    if (normalizedLayers.some(layerRequestsInversion)) {
      this.frame.options.retainSourceContentForInversion = true;
    }
    return renderLayersBestEffort(this, normalizedLayers, options);
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
    const visible = options.visible !== false;
    const outlineBoundsFallbackAllowed =
      options.__allowOutlineBoundsFallback === true;
    const outlineLayer = resolveNodeCompositeOutlineLayer(
      this.frame,
      options.outlineLayerId,
    );
    const compositeSourceIds = new Set([
      ...this.frame.layers
        .filter(
          (layer) =>
            layer.kind === LAYER_KIND_COMPOSITE && layer.visible !== false,
        )
        .flatMap((layer) => layer.sourceLayerIds),
      ...sourceIds,
    ]);
    const fallbackBounds = resolveNodeCompositeFallbackBounds(
      this.frame,
      sourceLayers,
      compositeSourceIds,
    );
    const outlineBounds = outlineLayer?.bounds ?? fallbackBounds;
    if (!outlineBounds) {
      throw new Error("Composite layer needs a board outline or finite bounds.");
    }
    let bounds = sourceLayers.reduce(
      (combined, layer) =>
        mergeBounds(
          combined,
          resolveLayerRenderBounds(
            this.frame.layers,
            this.frame.options,
            layer,
            compositeSourceIds,
          ),
        ),
      null,
    );
    if (inverted || (visibleBits[0] & 1) !== 0) {
      bounds = mergeBounds(bounds, outlineBounds);
    }
    const layerId = this.frame.layers.length;
    const compositeNumber =
      this.frame.layers.filter((layer) => layer.kind === LAYER_KIND_COMPOSITE).length + 1;
    const name = options.name || `Composite ${compositeNumber}`;
    const normalizedColor =
      options.color == null
        ? null
        : normalizeColor(options.color, this.frame.options.colors[0], {
            allowString: true,
          });
    const alpha = optionalAlpha(options.alpha);
    const id = this.reservePublicLayerId();
    const color = normalizedColor ?? this.frame.nextColor();
    this.frame.addLayer({
      kind: LAYER_KIND_COMPOSITE,
      id,
      layerId,
      selectorKey: null,
      name,
      sourceName: null,
      bounds,
      fallbackBounds,
      color,
      alpha,
      visible,
      inverted,
      sourceLayerIds: sourceIds,
      visibleBits,
      outlineLayerId: outlineLayer ? getPublicLayerId(outlineLayer) : null,
      outlineBoundsFallbackAllowed,
    });
    return id;
  }

  async loadLayer(layer, layerOptions = {}) {
    this.assertUsable();
    return this.createPreparedLayer(layer, layerOptions);
  }

  async loadLayers(layers, options = {}) {
    this.assertUsable();
    const normalizedLayers = normalizeLayerList(layers);
    const layerOptions = normalizedLayers.some(layerRequestsInversion)
      ? { ...options, retainSourceContentForInversion: true }
      : options;
    return loadLayersBestEffort(this, normalizedLayers, layerOptions);
  }

  async exportPng(exportOptions = {}) {
    const { completedFrame, renderPlan } = this.beginExport();
    try {
      const background =
        "background" in exportOptions
          ? exportOptions.background
          : completedFrame.background;

      return await renderPlanToPngBuffer(this, renderPlan, {
        ...exportOptions,
        background,
      });
    } finally {
      this.activeExport = false;
    }
  }

  async exportPngStream(writable, exportOptions = {}) {
    const { completedFrame, renderPlan } = this.beginExport();
    try {
      const background =
        "background" in exportOptions
          ? exportOptions.background
          : completedFrame.background;

      await renderPlanToPngWritable(this, renderPlan, {
        ...exportOptions,
        background,
      }, writable);
    } finally {
      this.activeExport = false;
    }
  }

  async exportPngFile(outputPath, exportOptions = {}) {
    const destinationPath = resolveOutputFilePath(outputPath);
    const { completedFrame, renderPlan } = this.beginExport();
    let tempPath = null;
    let ownsTempPath = false;
    let stream = null;
    let done = null;
    try {
      tempPath = createTempOutputPath(destinationPath);
      stream = createWriteStream(tempPath, { flags: "wx" });
      done = finished(stream);
      // An asynchronous open error can arrive while export setup is doing
      // other work. Observe it immediately, then await the original promise at
      // the normal completion/error boundary below.
      done.catch(() => {});
      await waitForWriteStreamOpen(stream);
      ownsTempPath = true;
      const background =
        "background" in exportOptions
          ? exportOptions.background
          : completedFrame.background;
      await renderPlanToPngWritable(this, renderPlan, {
        ...exportOptions,
        background,
      }, stream);
      stream.end();
      await done;
      await rename(tempPath, destinationPath);
    } catch (error) {
      stream?.destroy(error);
      if (done) {
        try {
          await done;
        } catch (_streamError) {
          // Preserve the original rendering error.
        }
      }
      if (ownsTempPath) {
        try {
          await this.__removeTempOutputFile(tempPath);
        } catch (_cleanupError) {
          // Preserve the primary render/write/rename failure.
        }
      }
      throw error;
    } finally {
      this.activeExport = false;
    }
  }

  async __removeTempOutputFile(tempPath) {
    await rm(tempPath, { force: true });
  }

  dispose() {
    if (this.disposed) return;
    if (this.frame) {
      throw new Error("Cannot dispose NodeGerberRenderer while a render frame is active.");
    }
    if (this.activeExport) {
      throw new Error("Cannot dispose NodeGerberRenderer while an export is active.");
    }
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
    if (isDrill && prepared.inverted) {
      throw new Error("Drill layers cannot be inverted.");
    }
    const layerId = this.frame.layers.length;
    const color = isDrill
      ? normalizeDrillOutlineColor(prepared.color, {
          allowString: true,
          name: prepared.name,
        })
      : prepared.color == null
        ? this.frame.nextColor()
        : normalizeColor(prepared.color, this.frame.options.colors[0], {
            allowString: true,
          });
    const outlineStyle = isDrill
      ? getDefaultDrillOutlineStyle(prepared.name)
      : null;

    return {
      kind: prepared.kind,
      layerId,
      selectorKey: prepared.selectorKey,
      name: prepared.name || `Layer ${layerId}`,
      sourceName: prepared.sourceName,
      content: prepared.content,
      outlineContent: prepared.outlineContent,
      parsedLayer: prepared.parsedLayer,
      parsedDrillLayer: prepared.parsedDrillLayer,
      offsetX: prepared.offsetX,
      offsetY: prepared.offsetY,
      bounds: isDrill
        ? expandBounds(prepared.bounds, outlineStyle.worldMm)
        : prepared.bounds,
      color,
      alpha: prepared.alpha,
      inverted: Boolean(prepared.inverted),
      parseOptions: normalizeParseOptions(prepared.parseOptions),
      outlineStyle,
      visible: prepared.visible !== false,
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
      readPathText: (path) => readSourcePathText(path),
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
    const sourceName = getSourceName(source);
    const name = options.name || sourceName || "Layer";
    const inverted = options.inverted === true;
    const retainSourceContent =
      inverted ||
      options.retainSourceContentForInversion === true ||
      isBoardOutlineLayerName(name) ||
      isBoardOutlineLayerName(sourceName);
    const parsed = isDrillLayerKind(kind)
      ? parseDrillLayerPayload(this.wasmModule, content, offsetX, offsetY)
      : parseLayerPayload(
          this.wasmModule,
          content,
          offsetX,
          offsetY,
          parseOptions,
        );

    return {
      [NODE_PREPARED_LAYER]: true,
      kind,
      name,
      sourceName,
      selectorKey:
        typeof options.__selectorKey === "string" ? options.__selectorKey : null,
      content:
        supportsParsedLayerReuse(this.wasmModule) && !retainSourceContent
          ? null
          : content,
      // Parsed-layer payloads intentionally omit the source contours used to
      // reconstruct an exact G36 region as an outline. Keep the same immutable
      // string reference only for region-bearing Gerbers so a later composite
      // outline can be reparsed without retaining every prepared source.
      outlineContent:
        !isDrillLayerKind(kind) && containsGerberRegion(content)
          ? content
          : null,
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
      visible: options.visible !== false,
      inverted,
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

    refreshNodeCompositeBounds(frame);
    validateFrameInversionSources(frame.layers, frame.options);
    frame.bounds = resolveFrameRenderBounds(frame.layers, frame.options);
    const view = resolveFrameView(
      {
        ...frame.options,
        padding: resolveFrameFitPadding(frame.options, frame.layers),
      },
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

  beginExport() {
    this.assertRenderedFrameAvailable();
    if (this.activeExport) {
      throw new Error("A Node export is already active.");
    }
    this.activeExport = true;
    return {
      completedFrame: this.lastFrame,
      renderPlan: this.lastRenderPlan,
    };
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
      compositeMode: this.options.compositeMode,
      invertedOutline: this.options.invertedOutline,
      maxFullFrameBytes: this.options.maxFullFrameBytes,
      maxRenderTargetBytes: this.options.maxRenderTargetBytes,
      framebufferMemorySafetyFactor: this.options.framebufferMemorySafetyFactor,
      strategy: this.options.strategy,
      autoFit: !this.options.view && this.options.fit !== false,
      fitOptions: {
        fit: this.options.fit,
        padding: this.options.padding,
        view: this.options.view,
        flipX: this.options.flipX,
        flipY: this.options.flipY,
      },
      layers: this.layers.map((layer) => ({
        kind: layer.kind,
        id: getPublicLayerId(layer),
        layerId: layer.layerId,
        selectorKey: layer.selectorKey,
        name: layer.name,
        sourceName: layer.sourceName,
        content: layer.content,
        outlineContent: layer.outlineContent,
        parsedLayer: layer.parsedLayer,
        parsedDrillLayer: layer.parsedDrillLayer,
        offsetX: layer.offsetX,
        offsetY: layer.offsetY,
        bounds: layer.bounds,
        color: layer.color,
        alpha: layer.alpha,
        visible: layer.visible !== false,
        inverted: layer.inverted,
        parseOptions: normalizeParseOptions(layer.parseOptions ?? this.options),
        outlineStyle: layer.outlineStyle,
        sourceLayerIds: layer.sourceLayerIds,
        visibleBits: layer.visibleBits,
        outlineLayerId: layer.outlineLayerId,
        fallbackBounds: layer.fallbackBounds,
        outlineBoundsFallbackAllowed: layer.outlineBoundsFallbackAllowed,
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

  const baseFrameOptions = createBaseFrameOptions(frameOptions);
  const needsOutlineSourceRetention =
    frameOptions.invertedOutline != null &&
    baseFrameOptions.invertedOutline !== INVERTED_OUTLINE_BOUNDS;

  return {
    width: positiveIntegerOrDefault(frameOptions.width, DEFAULT_WIDTH),
    height: positiveIntegerOrDefault(frameOptions.height, DEFAULT_HEIGHT),
    clear: true,
    ...baseFrameOptions,
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
    retainSourceContentForInversion:
      frameOptions.retainSourceContentForInversion === true ||
      needsOutlineSourceRetention,
    strategy: normalizeExportStrategy(frameOptions.strategy),
  };
}

function isPreparedNodeLayer(value) {
  return Boolean(value?.[NODE_PREPARED_LAYER]);
}

function layerRequestsInversion(layer, layerOptions = {}) {
  return Boolean(
    layerOptions.inverted === true ||
      (layer &&
        typeof layer === "object" &&
        "inverted" in layer &&
        layer.inverted === true),
  );
}

function containsGerberRegion(content) {
  return /(?:^|[^A-Z0-9])G0*36\s*\*/i.test(content);
}

function getPublicLayerId(layer) {
  return layer?.id ?? layer?.layerId;
}

function mergePreparedLayerOptions(preparedLayer, layerOptions = {}) {
  const offsetX = numberOrDefault(preparedLayer.offsetX, 0);
  const offsetY = numberOrDefault(preparedLayer.offsetY, 0);
  const kind = normalizeLayerKind(preparedLayer.kind, { name: preparedLayer.sourceName });
  const parseOptions = normalizeParseOptions(preparedLayer.parseOptions);
  const requestedParseOptions = normalizeParseOptions(layerOptions);
  const inverted =
    "inverted" in layerOptions
      ? layerOptions.inverted === true
      : Boolean(preparedLayer.inverted);
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
  if (
    "preserveArcRegions" in layerOptions &&
    requestedParseOptions.preserveArcRegions !== parseOptions.preserveArcRegions
  ) {
    throw new Error(
      "Prepared layer preserveArcRegions is fixed. Load the source again to change parse options.",
    );
  }
  if (
    "arcTessellationQuality" in layerOptions &&
    requestedParseOptions.arcTessellationQuality !==
      parseOptions.arcTessellationQuality
  ) {
    throw new Error(
      "Prepared layer arcTessellationQuality is fixed. Load the source again to change parse options.",
    );
  }
  if (
    layerOptions.retainSourceContentForInversion === true &&
    typeof preparedLayer.content !== "string"
  ) {
    throw new Error(
      `Prepared layer cannot retain source content after parsing: ${preparedLayer.name}. Load the source again with retainSourceContentForInversion:true.`,
    );
  }
  if (inverted && typeof preparedLayer.content !== "string") {
    throw new Error(
      `Prepared layer cannot be inverted because its source content was not retained: ${preparedLayer.name}. ` +
        "Load the layer with inverted:true or retainSourceContentForInversion:true.",
    );
  }

  return {
    ...preparedLayer,
    name:
      "name" in layerOptions && layerOptions.name != null
        ? String(layerOptions.name)
        : preparedLayer.name,
    kind,
    selectorKey:
      typeof layerOptions.__selectorKey === "string"
        ? layerOptions.__selectorKey
        : preparedLayer.selectorKey ?? null,
    color:
      "color" in layerOptions
        ? layerOptions.color
        : preparedLayer.color,
    alpha:
      "alpha" in layerOptions
        ? optionalAlpha(layerOptions.alpha)
        : preparedLayer.alpha,
    visible:
      "visible" in layerOptions
        ? layerOptions.visible !== false
        : preparedLayer.visible !== false,
    inverted,
  };
}

function resolveNodeCompositeOutlineLayer(frame, outlineLayerId) {
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

function resolveNodeCompositeFallbackBounds(
  frame,
  sourceLayers,
  includeLayerIds = new Set(sourceLayers.map(getPublicLayerId)),
) {
  let bounds = null;
  for (const layer of frame.layers) {
    if (
      layer.visible !== false &&
      !isDrillLayerKind(layer.kind) &&
      layer.kind !== LAYER_KIND_COMPOSITE
    ) {
      bounds = mergeBounds(
        bounds,
        resolveLayerRenderBounds(
          frame.layers,
          frame.options,
          layer,
          includeLayerIds,
        ),
      );
    }
  }
  for (const layer of sourceLayers) {
    bounds = mergeBounds(
      bounds,
      resolveLayerRenderBounds(
        frame.layers,
        frame.options,
        layer,
        includeLayerIds,
      ),
    );
  }
  return bounds;
}

function refreshNodeCompositeBounds(frame) {
  const effectiveDependencyIds = new Set(
    frame.layers
      .filter(
        (layer) =>
          layer.kind === LAYER_KIND_COMPOSITE && layer.visible !== false,
      )
      .flatMap((layer) => layer.sourceLayerIds),
  );
  for (const composite of frame.layers) {
    if (composite.kind !== LAYER_KIND_COMPOSITE) continue;
    const dependencyIds = new Set([
      ...effectiveDependencyIds,
      ...composite.sourceLayerIds,
    ]);
    const sourceLayers = composite.sourceLayerIds.map((sourceLayerId) =>
      frame.layers.find(
        (candidate) => getPublicLayerId(candidate) === sourceLayerId,
      ),
    );
    if (sourceLayers.some((sourceLayer) => !sourceLayer)) {
      throw new Error(`Composite ${composite.name} has an unavailable source layer.`);
    }
    const outlineLayer = composite.outlineLayerId == null
      ? null
      : frame.layers.find(
          (candidate) =>
            getPublicLayerId(candidate) === composite.outlineLayerId,
        );
    const fallbackBounds = outlineLayer && !composite.outlineBoundsFallbackAllowed
      ? composite.fallbackBounds
      : resolveNodeCompositeFallbackBounds(
          frame,
          sourceLayers,
          dependencyIds,
        );
    const clippingBounds = outlineLayer?.bounds ?? fallbackBounds;
    if (!clippingBounds) {
      throw new Error(`Composite ${composite.name} needs finite fallback bounds.`);
    }
    let bounds = sourceLayers.reduce(
      (combined, sourceLayer) =>
        mergeBounds(
          combined,
          resolveLayerRenderBounds(
            frame.layers,
            frame.options,
            sourceLayer,
            dependencyIds,
          ),
        ),
      null,
    );
    if (composite.inverted === true || (composite.visibleBits[0] & 1) !== 0) {
      bounds = mergeBounds(bounds, clippingBounds);
    }
    composite.fallbackBounds = fallbackBounds;
    composite.bounds = bounds;
  }
}

function getInternalLayerSelectorKey(index) {
  return `${INTERNAL_LAYER_SELECTOR_PREFIX}${index + 1}`;
}

function resolveNodeFrameOutlineSelector(invertedOutline) {
  const normalized = String(invertedOutline ?? "");
  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 1) {
    return getInternalLayerSelectorKey(index - 1);
  }
  return invertedOutline;
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
  renderer.__lastCompositeErrors = [];
  const width = positiveIntegerOrDefault(plan.width, DEFAULT_WIDTH);
  const height = positiveIntegerOrDefault(plan.height, DEFAULT_HEIGHT);
  validatePngDimensions(width, height);
  const strategy = normalizeExportStrategy(exportOptions.strategy || plan.strategy);
  const renderPlan = {
    ...plan,
    background: exportOptions.background,
    compositeErrorState: createExportCompositeErrorState(renderer),
  };
  const background =
    exportOptions.background == null
      ? null
      : parseColor(exportOptions.background, true);
  const pngColorType = getPngColorType(background);
  const pngChannels = getPngChannelCount(pngColorType);
  let successfulSinkWrites = 0;
  const outputSink = {
    async write(chunk) {
      await sink.write(chunk);
      successfulSinkWrites += 1;
    },
  };
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
    await writePngDocument(outputSink, width, height, pngColorType, async (writeRow) => {
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
        outputSink,
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
      if (successfulSinkWrites > 0) {
        throw error;
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
  const hasCompositeLayers = renderPlan.layers.some(
    (layer) => layer.kind === LAYER_KIND_COMPOSITE && layer.visible !== false,
  );
  let preflightStreamState = null;
  let effectiveTileWidth = tileWidth;
  if (hasCompositeLayers) {
    preflightStreamState = preflightStreamCompositeFailures(
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
    effectiveTileWidth = preflightStreamState.tileWidth;
  } else {
    preflightStreamState = createStreamRenderStateWithFallback(
      renderer,
      renderPlan,
      effectiveTileWidth,
      width,
      height,
      maxBandBytes,
      maxRenderTargetBytes,
      maxDimension,
      layerCount,
      pngChannels,
    );
    effectiveTileWidth = preflightStreamState.tileWidth;
  }
  const expectedCompositeFailureCount =
    renderPlan.compositeErrorState.excludedCompositePublicIds.size;

  try {
    await writePngDocument(outputSink, width, height, pngColorType, async (writeRow) => {
      let streamState = preflightStreamState;
      preflightStreamState = null;
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
                renderPlan,
                bandRowBytes,
              );
              if (
                renderPlan.compositeErrorState.excludedCompositePublicIds.size !==
                expectedCompositeFailureCount
              ) {
                throw new Error(
                  "A composite failed after stream preflight; no mixed PNG was produced.",
                );
              }
              break;
            } catch (error) {
              if (
                renderPlan.compositeErrorState.excludedCompositePublicIds.size !==
                expectedCompositeFailureCount
              ) {
                throw error;
              }
              if (!canReduceStreamTileWidth(streamState.tileWidth)) {
                throw error;
              }
              const nextTileWidth = reduceStreamTileWidth(streamState.tileWidth);
              disposeStreamRenderState(renderer, streamState, true);
              streamState = null;
              streamState = createStreamRenderStateWithFallback(
                renderer,
                renderPlan,
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
  } finally {
    disposeStreamRenderState(renderer, preflightStreamState, false);
  }
}

function preflightStreamCompositeFailures(
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
  let streamState = createStreamRenderStateWithFallback(
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
            plan,
            bandRowBytes,
          );
          break;
        } catch (error) {
          if (!canReduceStreamTileWidth(streamState.tileWidth)) throw error;
          const nextTileWidth = reduceStreamTileWidth(streamState.tileWidth);
          disposeStreamRenderState(renderer, streamState, true);
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
      tileY += currentTileHeight;
    }
    return streamState;
  } catch (error) {
    disposeStreamRenderState(renderer, streamState, false);
    throw error;
  }
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

function renderStreamBand(state, width, height, tileY, plan, bandRowBytes) {
  const currentTileHeight = Math.min(state.tileHeight, height - tileY);
  const renderTileY =
    currentTileHeight === state.tileHeight ? tileY : Math.max(0, height - state.tileHeight);
  const sourceRowOffset = tileY - renderTileY;
  const readY = state.tileHeight - sourceRowOffset - currentTileHeight;
  for (;;) {
    const failureCountBefore =
      state.renderContext.excludedCompositePublicIds.size;
    const view = resolveBestEffortPlanView(plan, state.renderContext);
    state.bandPixels.fill(0, 0, bandRowBytes * currentTileHeight);
    if (!view) return currentTileHeight;

    let retryBand = false;
    for (let tileX = 0; tileX < width; tileX += state.tileWidth) {
      const currentTileWidth = Math.min(state.tileWidth, width - tileX);
      const renderTileX =
        currentTileWidth === state.tileWidth
          ? tileX
          : Math.max(0, width - state.tileWidth);
      const readX = tileX - renderTileX;
      if (hasBlendModes(state.renderContext.blendModes)) {
        if (
          typeof state.renderContext.processor.render_tile_with_blend_modes !==
          "function"
        ) {
          throw new Error(
            "Stack compositing and drill rendering require an updated WASM renderer.",
          );
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
      handlePlanCompositeRenderErrors(state.renderContext);
      if (
        state.renderContext.excludedCompositePublicIds.size > failureCountBefore
      ) {
        rebuildPlanRenderContext(state.renderContext, plan);
        retryBand = true;
        break;
      }
      state.renderGl.finish?.();
      const managesPackAlignment =
        typeof state.renderGl.getParameter === "function" &&
        typeof state.renderGl.pixelStorei === "function" &&
        state.renderGl.PACK_ALIGNMENT != null;
      const previousPackAlignment = managesPackAlignment
        ? state.renderGl.getParameter(state.renderGl.PACK_ALIGNMENT)
        : null;
      if (managesPackAlignment) {
        state.renderGl.pixelStorei(state.renderGl.PACK_ALIGNMENT, 1);
      }
      try {
        state.renderGl.readPixels(
          readX,
          readY,
          currentTileWidth,
          currentTileHeight,
          state.renderGl.RGBA,
          state.renderGl.UNSIGNED_BYTE,
          state.tilePixels,
        );
      } finally {
        if (managesPackAlignment) {
          state.renderGl.pixelStorei(
            state.renderGl.PACK_ALIGNMENT,
            previousPackAlignment,
          );
        }
      }

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
    if (!retryBand) return currentTileHeight;
  }
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
  // This deterministic budget check must happen before the PNG signature or
  // IHDR is emitted, including the full-frame branch of auto strategy.
  getBlankStreamTileHeight(width, height, maxBandBytes, pngChannels);
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

    const compositeErrorState = createPlanCompositeErrorState(renderer, plan);
    const renderEntries = createPlanRenderEntries(
      processor,
      plan,
      compositeErrorState,
    );
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

    return {
      processor,
      activeLayerIds,
      colorData,
      blendModes,
      compositeEntries: renderEntries.filter((entry) => entry.isComposite),
      ...compositeErrorState,
    };
  } catch (error) {
    disposeProcessor(processor);
    throw error;
  }
}

function createExportCompositeErrorState(renderer) {
  return {
    continueOnCompositeError:
      renderer.rendererOptions.__continueOnCompositeError === true,
    onCompositeError:
      typeof renderer.rendererOptions.__onCompositeError === "function"
        ? renderer.rendererOptions.__onCompositeError
        : null,
    excludedCompositePublicIds: new Set(),
    adjustedViews: new Map(),
    recordCompositeError(failure) {
      const isNew = !renderer.__lastCompositeErrors.some(
        (existing) =>
          existing.publicLayerId === failure.publicLayerId &&
          existing.error === failure.error,
      );
      if (isNew) renderer.__lastCompositeErrors.push(failure);
      return isNew;
    },
  };
}

function createPlanCompositeErrorState(renderer, plan) {
  return plan.compositeErrorState ?? createExportCompositeErrorState(renderer);
}

function reportPlanCompositeFailure(errorState, failure) {
  errorState.excludedCompositePublicIds.add(failure.publicLayerId);
  if (!errorState.recordCompositeError(failure)) return;
  try {
    const callbackResult = errorState.onCompositeError?.(failure);
    Promise.resolve(callbackResult).catch(() => {});
  } catch (_error) {
    // Diagnostic callbacks cannot turn an isolated layer failure into an
    // export failure.
  }
}

function resolveBestEffortPlanView(plan, errorState) {
  if (errorState.excludedCompositePublicIds.size === 0 || !plan.autoFit) {
    return plan.view;
  }
  const exclusionKey = [...errorState.excludedCompositePublicIds]
    .sort((first, second) => first - second)
    .join(",");
  if (errorState.adjustedViews.has(exclusionKey)) {
    return errorState.adjustedViews.get(exclusionKey);
  }

  const survivorLayers = plan.layers
    .filter(
      (layer) =>
        layer.kind !== LAYER_KIND_COMPOSITE ||
        !errorState.excludedCompositePublicIds.has(getPublicLayerId(layer)),
    )
    .map((layer) => ({
      ...layer,
      bounds: layer.bounds ? { ...layer.bounds } : null,
      fallbackBounds: layer.fallbackBounds ? { ...layer.fallbackBounds } : null,
    }));
  refreshNodeCompositeBounds({ layers: survivorLayers, options: plan });
  const bounds = resolveFrameRenderBounds(survivorLayers, plan);
  const view = bounds
    ? resolveFrameView(
        {
          ...plan.fitOptions,
          padding: resolveFrameFitPadding(plan.fitOptions, survivorLayers),
        },
        bounds,
        plan.width,
        plan.height,
      )
    : null;
  errorState.adjustedViews.set(exclusionKey, view);
  return view;
}

function renderPlanPixels(renderContext, plan) {
  for (;;) {
    const failureCountBefore = renderContext.excludedCompositePublicIds.size;
    const view = resolveBestEffortPlanView(plan, renderContext);
    if (!view) return new Uint8Array(plan.width * plan.height * 4);
    let pixels;
    if (hasBlendModes(renderContext.blendModes)) {
    if (
      typeof renderContext.processor.render_pixels_with_clear_and_blend_modes !==
      "function"
    ) {
      throw new Error("Stack compositing and drill rendering require an updated WASM renderer.");
    }
    pixels = renderContext.processor.render_pixels_with_clear_and_blend_modes(
      renderContext.activeLayerIds,
      renderContext.colorData,
      renderContext.blendModes,
      view.zoomX,
      view.zoomY,
      view.offsetX,
      view.offsetY,
      1,
      true,
    );
    } else {
      pixels = renderContext.processor.render_pixels_with_clear(
      renderContext.activeLayerIds,
      renderContext.colorData,
      view.zoomX,
      view.zoomY,
      view.offsetX,
      view.offsetY,
      1,
      true,
    );
    }
    handlePlanCompositeRenderErrors(renderContext);
    if (renderContext.excludedCompositePublicIds.size === failureCountBefore) {
      return pixels;
    }
    rebuildPlanRenderContext(renderContext, plan);
  }
}

function applyPlanRenderEntries(renderContext, renderEntries) {
  renderContext.activeLayerIds = new Uint32Array(
    renderEntries.map((entry) => entry.layerId),
  );
  renderContext.blendModes = new Uint8Array(
    renderEntries.map((entry) => entry.blendMode),
  );
  const colorData = new Float32Array(renderEntries.length * 4);
  for (const [index, entry] of renderEntries.entries()) {
    const offset = index * 4;
    colorData[offset] = entry.color[0];
    colorData[offset + 1] = entry.color[1];
    colorData[offset + 2] = entry.color[2];
    colorData[offset + 3] = entry.alpha;
  }
  renderContext.colorData = colorData;
  renderContext.compositeEntries = renderEntries.filter(
    (entry) => entry.isComposite,
  );
}

function rebuildPlanRenderContext(renderContext, plan) {
  renderContext.processor.clear();
  applyProcessorOptions(renderContext.processor, plan);
  applyPlanRenderEntries(
    renderContext,
    createPlanRenderEntries(renderContext.processor, plan, renderContext),
  );
}

function handlePlanCompositeRenderErrors(renderContext) {
  if (renderContext.compositeEntries.length === 0) return;
  const { processor } = renderContext;
  if (typeof processor.get_composite_error !== "function") {
    throw new Error("Composite error reporting requires an updated WASM renderer.");
  }
  const failures = [];
  for (const entry of renderContext.compositeEntries) {
    const error = processor.get_composite_error(entry.layerId);
    if (error) {
      failures.push({
        layerId: entry.layerId,
        publicLayerId: entry.publicLayerId,
        name: entry.name,
        error,
      });
    }
  }
  if (failures.length === 0) return;
  if (!renderContext.continueOnCompositeError) {
    const failure = failures[0];
    throw new Error(`Composite ${failure.name} failed: ${failure.error}`);
  }

  const failedLayerIds = new Set(failures.map((failure) => failure.layerId));
  for (const failure of failures) {
    reportPlanCompositeFailure(renderContext, failure);
  }
  removeRenderEntries(renderContext, failedLayerIds);
}

function removeRenderEntries(renderContext, removedLayerIds) {
  const activeLayerIds = [];
  const colorData = [];
  const blendModes = [];
  for (let index = 0; index < renderContext.activeLayerIds.length; index += 1) {
    if (removedLayerIds.has(renderContext.activeLayerIds[index])) continue;
    activeLayerIds.push(renderContext.activeLayerIds[index]);
    blendModes.push(renderContext.blendModes[index]);
    const colorOffset = index * 4;
    colorData.push(
      renderContext.colorData[colorOffset],
      renderContext.colorData[colorOffset + 1],
      renderContext.colorData[colorOffset + 2],
      renderContext.colorData[colorOffset + 3],
    );
  }
  renderContext.activeLayerIds = new Uint32Array(activeLayerIds);
  renderContext.colorData = new Float32Array(colorData);
  renderContext.blendModes = new Uint8Array(blendModes);
  renderContext.compositeEntries = renderContext.compositeEntries.filter(
    (entry) => !removedLayerIds.has(entry.layerId),
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

function createPlanRenderEntries(processor, plan, compositeErrorState) {
  const exclusionCountBefore =
    compositeErrorState.excludedCompositePublicIds.size;
  const gerberEntries = [];
  const compositeEntries = [];
  const drillOutlineEntries = [];
  const drillFillEntries = [];
  const rendererLayerIds = new Map();
  const outlineRendererLayerIds = new Map();
  const activeCompositeLayers = plan.layers.filter(
    (layer) =>
      layer.kind === LAYER_KIND_COMPOSITE &&
      layer.visible !== false &&
      !compositeErrorState.excludedCompositePublicIds.has(
        getPublicLayerId(layer),
      ),
  );
  const compositeSourceLayerIds = new Set(
    activeCompositeLayers.flatMap((layer) => layer.sourceLayerIds),
  );
  const compositeOutlineLayerIds = new Set(
    activeCompositeLayers
      .filter((layer) => layer.outlineLayerId != null)
      .map((layer) => layer.outlineLayerId),
  );
  const drillColors = resolveDrillRenderColors(plan.background);
  const gerberBlendMode = plan.compositeMode === COMPOSITE_MODE_STACK ? 1 : 0;
  const gerberDefaultAlpha =
    plan.compositeMode === COMPOSITE_MODE_STACK ? 1 : plan.globalAlpha;

  for (const layer of plan.layers) {
    if (layer.kind === LAYER_KIND_COMPOSITE) {
      continue;
    }
    if (isDrillLayerKind(layer.kind)) {
      if (layer.visible === false) {
        continue;
      }
      const { outlineLayerId, fillLayerId } = addPlanDrillLayerToProcessor(
        processor,
        layer,
      );
      rendererLayerIds.set(getPublicLayerId(layer), outlineLayerId);
      const alpha = resolveLayerAlpha(layer.alpha, 1);
      drillFillEntries.push({
        layerId: fillLayerId,
        color: drillColors.fill,
        alpha,
        blendMode: drillColors.hasBackground ? 1 : 2,
      });
      if (hasDrillOutlineStyle(layer.outlineStyle)) {
        drillOutlineEntries.push({
          layerId: outlineLayerId,
          color: layer.color,
          alpha,
          blendMode: 1,
        });
      }
      continue;
    }

    const publicLayerId = getPublicLayerId(layer);
    const needsEffectiveLayer =
      layer.visible !== false || compositeSourceLayerIds.has(publicLayerId);
    const needsOutlineLayer = compositeOutlineLayerIds.has(publicLayerId);
    if (!needsEffectiveLayer && !needsOutlineLayer) {
      continue;
    }
    const baseLayerId =
      layer.inverted && needsOutlineLayer
        ? addPlanLayerToProcessor(processor, layer)
        : null;
    const layerId = layer.inverted && needsEffectiveLayer
      ? addPlanInvertedLayerToProcessor(
          processor,
          layer,
          plan,
          compositeSourceLayerIds,
        )
      : baseLayerId ?? addPlanLayerToProcessor(processor, layer);
    rendererLayerIds.set(publicLayerId, layerId);
    outlineRendererLayerIds.set(publicLayerId, baseLayerId ?? layerId);
    if (layer.visible !== false) {
      gerberEntries.push({
        layerId,
        publicLayerId,
        color: layer.color,
        alpha: resolveLayerAlpha(layer.alpha, gerberDefaultAlpha),
        blendMode: gerberBlendMode,
      });
    }
  }

  for (const layer of plan.layers) {
    if (layer.kind !== LAYER_KIND_COMPOSITE || layer.visible === false) {
      continue;
    }
    if (
      compositeErrorState.excludedCompositePublicIds.has(getPublicLayerId(layer))
    ) {
      continue;
    }
    try {
    const sourceIds = layer.sourceLayerIds.map((sourceLayerId) => {
      const rendererLayerId = rendererLayerIds.get(sourceLayerId);
      if (rendererLayerId == null) {
        throw new Error(
          `Composite ${layer.name} has an invalid or unavailable source layer ID: ${sourceLayerId}`,
        );
      }
      return rendererLayerId;
    });
    let layerId;
    if (layer.outlineLayerId != null) {
      const outlineLayerId = outlineRendererLayerIds.get(layer.outlineLayerId);
      if (outlineLayerId == null) {
        throw new Error(`Composite ${layer.name} has an unavailable outline layer.`);
      }
      const outlineLayer = plan.layers.find(
        (candidate) => getPublicLayerId(candidate) === layer.outlineLayerId,
      );
      const outlineContent =
        outlineLayer?.outlineContent ?? outlineLayer?.content ?? null;
      try {
        if (typeof outlineContent === "string") {
          const outlineParseOptions = resolvePlanLayerParseOptions(
            outlineLayer,
            plan,
          );
          if (
            typeof processor.add_composite_layer_with_outline_content_options ===
            "function"
          ) {
            layerId = processor.add_composite_layer_with_outline_content_options(
              new Uint32Array(sourceIds),
              layer.visibleBits,
              layer.inverted === true,
              outlineLayerId,
              outlineContent,
              outlineLayer.offsetX,
              outlineLayer.offsetY,
              outlineParseOptions.preserveArcRegions,
              outlineParseOptions.arcTessellationQuality,
            );
          } else {
            assertLegacyReparseOptionsMatchFrame(
              outlineParseOptions,
              plan,
              "Prepared composite region outline parse options",
            );
            if (
              typeof processor.add_composite_layer_with_outline_content !==
              "function"
            ) {
              throw new Error(
                "Exact composite region outlines require an updated WASM renderer.",
              );
            }
            layerId = processor.add_composite_layer_with_outline_content(
              new Uint32Array(sourceIds),
              layer.visibleBits,
              layer.inverted === true,
              outlineLayerId,
              outlineContent,
              outlineLayer.offsetX,
              outlineLayer.offsetY,
            );
          }
        } else {
          layerId = processor.add_composite_layer_with_outline(
            new Uint32Array(sourceIds),
            layer.visibleBits,
            layer.inverted === true,
            outlineLayerId,
          );
        }
      } catch (outlineError) {
        if (!layer.outlineBoundsFallbackAllowed || !layer.fallbackBounds) {
          throw outlineError;
        }
        layer.outlineFallbackUsed = true;
        layer.outlineFallbackError =
          outlineError instanceof Error
            ? outlineError.message
            : String(outlineError);
        const bounds = layer.fallbackBounds;
        layerId = processor.add_composite_layer_with_bounds(
          new Uint32Array(sourceIds),
          layer.visibleBits,
          layer.inverted === true,
          bounds.minX,
          bounds.maxX,
          bounds.minY,
          bounds.maxY,
        );
      }
    } else {
      const bounds = layer.fallbackBounds;
      if (!bounds) {
        throw new Error(`Composite ${layer.name} needs finite fallback bounds.`);
      }
      layerId = processor.add_composite_layer_with_bounds(
        new Uint32Array(sourceIds),
        layer.visibleBits,
        layer.inverted === true,
        bounds.minX,
        bounds.maxX,
        bounds.minY,
        bounds.maxY,
      );
    }
    compositeEntries.push({
      layerId,
      publicLayerId: getPublicLayerId(layer),
      name: layer.name,
      isComposite: true,
      color: layer.color,
      alpha: resolveLayerAlpha(layer.alpha, gerberDefaultAlpha),
      blendMode: gerberBlendMode,
    });
    } catch (error) {
      const failure = {
        layerId: null,
        publicLayerId: getPublicLayerId(layer),
        name: layer.name,
        error: error instanceof Error ? error.message : String(error),
      };
      if (!compositeErrorState.continueOnCompositeError) {
        throw new Error(`Composite ${failure.name} failed: ${failure.error}`, {
          cause: error,
        });
      }
      reportPlanCompositeFailure(compositeErrorState, failure);
    }
  }

  if (
    compositeErrorState.excludedCompositePublicIds.size > exclusionCountBefore
  ) {
    // Ordinary inverted dependencies and bounds were resolved before the
    // failed composite was known. Rebuild from the survivor set so a skipped
    // definition cannot affect another composite's mask or manual-view pixels.
    processor.clear();
    applyProcessorOptions(processor, plan);
    return createPlanRenderEntries(processor, plan, compositeErrorState);
  }

  const gerberEntryByPublicId = new Map(
    [...gerberEntries, ...compositeEntries].map((entry) => [
      entry.publicLayerId,
      entry,
    ]),
  );
  const orderedGerberEntries = plan.layers
    .filter(
      (layer) =>
        layer.visible !== false &&
        !isDrillLayerKind(layer.kind),
    )
    .map((layer) => gerberEntryByPublicId.get(getPublicLayerId(layer)))
    .filter(Boolean);
  return [
    ...orderedGerberEntries,
    ...drillOutlineEntries,
    ...drillFillEntries,
  ];
}

function addPlanInvertedLayerToProcessor(
  processor,
  layer,
  plan,
  includeLayerIds = null,
) {
  if (isDrillLayerKind(layer.kind) || layer.kind === LAYER_KIND_COMPOSITE) {
    throw new Error(`Drill layer cannot be inverted: ${layer.name}`);
  }
  if (typeof layer.content !== "string") {
    throw new Error(
      `Inverted layer requires source content. Load ${layer.name} with inverted:true or render the batch with source retention enabled.`,
    );
  }

  const fillSource = resolveInvertedFillSource(plan, layer, includeLayerIds);
  if (!fillSource) {
    throw new Error(`Inverted layer needs a board outline or bounds: ${layer.name}`);
  }

  try {
    return addPlanInvertedLayerWithFillSource(processor, layer, fillSource, plan);
  } catch (error) {
    const outlineSelection = plan.invertedOutline ?? INVERTED_OUTLINE_AUTO;
    if (fillSource.type !== "outline" || outlineSelection !== INVERTED_OUTLINE_AUTO) {
      throw error;
    }
    const bounds = getPlanGerberBounds(plan.layers, null, includeLayerIds);
    if (!bounds) {
      throw error;
    }
    return addPlanInvertedLayerWithFillSource(
      processor,
      layer,
      {
        type: "bounds",
        bounds,
      },
      plan,
    );
  }
}

function resolvePlanLayerParseOptions(layer, plan) {
  return normalizeParseOptions(layer?.parseOptions ?? plan);
}

function assertLegacyReparseOptionsMatchFrame(parseOptions, plan, label) {
  const frameParseOptions = normalizeParseOptions(plan);
  if (
    parseOptions.preserveArcRegions !== frameParseOptions.preserveArcRegions ||
    parseOptions.arcTessellationQuality !==
      frameParseOptions.arcTessellationQuality
  ) {
    throw new Error(
      `${label} require an updated WASM renderer to preserve load-time geometry.`,
    );
  }
}

function addPlanInvertedLayerWithFillSource(processor, layer, fillSource, plan) {
  const targetParseOptions = resolvePlanLayerParseOptions(layer, plan);
  if (fillSource.type === "outline") {
    if (typeof fillSource.layer.content !== "string") {
      throw new Error(
        `Inverted outline layer requires source content: ${fillSource.layer.name}`,
      );
    }
    const outlineParseOptions = resolvePlanLayerParseOptions(fillSource.layer, plan);
    if (typeof processor.add_inverted_layer_with_outline_options === "function") {
      return processor.add_inverted_layer_with_outline_options(
        layer.content,
        fillSource.layer.content,
        layer.offsetX,
        layer.offsetY,
        targetParseOptions.preserveArcRegions,
        targetParseOptions.arcTessellationQuality,
        fillSource.layer.offsetX,
        fillSource.layer.offsetY,
        outlineParseOptions.preserveArcRegions,
        outlineParseOptions.arcTessellationQuality,
      );
    }
    assertLegacyReparseOptionsMatchFrame(
      targetParseOptions,
      plan,
      "Prepared inverted target parse options",
    );
    assertLegacyReparseOptionsMatchFrame(
      outlineParseOptions,
      plan,
      "Prepared inverted outline parse options",
    );
    if (typeof processor.add_inverted_layer_with_outline !== "function") {
      throw new Error("Inverted outline rendering requires an updated WASM renderer.");
    }
    return processor.add_inverted_layer_with_outline(
      layer.content,
      fillSource.layer.content,
      layer.offsetX,
      layer.offsetY,
      fillSource.layer.offsetX,
      fillSource.layer.offsetY,
    );
  }

  if (typeof processor.add_inverted_layer_with_bounds_options === "function") {
    return processor.add_inverted_layer_with_bounds_options(
      layer.content,
      layer.offsetX,
      layer.offsetY,
      targetParseOptions.preserveArcRegions,
      targetParseOptions.arcTessellationQuality,
      fillSource.bounds.minX,
      fillSource.bounds.maxX,
      fillSource.bounds.minY,
      fillSource.bounds.maxY,
    );
  }
  assertLegacyReparseOptionsMatchFrame(
    targetParseOptions,
    plan,
    "Prepared inverted target parse options",
  );
  if (typeof processor.add_inverted_layer_with_bounds !== "function") {
    throw new Error("Inverted bounds rendering requires an updated WASM renderer.");
  }
  return processor.add_inverted_layer_with_bounds(
    layer.content,
    layer.offsetX,
    layer.offsetY,
    fillSource.bounds.minX,
    fillSource.bounds.maxX,
    fillSource.bounds.minY,
    fillSource.bounds.maxY,
  );
}

function validateFrameInversionSources(layers, options) {
  const activeCompositeSourceLayerIds = new Set(
    layers
      .filter(
        (layer) =>
          layer.kind === LAYER_KIND_COMPOSITE && layer.visible !== false,
      )
      .flatMap((layer) => layer.sourceLayerIds),
  );
  const invertedLayers = layers.filter(
    (layer) =>
      layer.inverted &&
      (layer.visible !== false ||
        activeCompositeSourceLayerIds.has(getPublicLayerId(layer))) &&
      !isDrillLayerKind(layer.kind) &&
      layer.kind !== LAYER_KIND_COMPOSITE,
  );
  if (invertedLayers.length === 0) {
    return;
  }

  for (const layer of invertedLayers) {
    if (typeof layer.content !== "string") {
      throw new Error(
        `Inverted layer requires source content: ${layer.name}. ` +
          "Load the layer with inverted:true or retainSourceContentForInversion:true.",
      );
    }
  }

  const outlineSelection = options.invertedOutline ?? INVERTED_OUTLINE_AUTO;
  if (
    outlineSelection === INVERTED_OUTLINE_AUTO ||
    outlineSelection === INVERTED_OUTLINE_BOUNDS
  ) {
    return;
  }

  for (const targetLayer of invertedLayers) {
    const outlineLayer = findLayerBySelector(
      layers,
      outlineSelection,
      targetLayer,
    );
    if (!outlineLayer) {
      throw new Error(`Inverted outline layer was not found: ${outlineSelection}`);
    }
    if (isDrillLayerKind(outlineLayer.kind)) {
      throw new Error(`Inverted outline layer must be a Gerber layer: ${outlineLayer.name}`);
    }
    if (typeof outlineLayer.content !== "string") {
      throw new Error(
        `Inverted outline layer requires source content: ${outlineLayer.name}. ` +
          "Load the outline with retainSourceContentForInversion:true.",
      );
    }
  }
}

function resolveInvertedFillSource(plan, targetLayer, includeLayerIds = null) {
  return resolveInvertedFillSourceForLayers(
    plan.layers,
    plan.invertedOutline,
    targetLayer,
    includeLayerIds,
  );
}

function resolveInvertedFillSourceForLayers(
  layers,
  invertedOutline,
  targetLayer,
  includeLayerIds = null,
) {
  const outlineSelection = invertedOutline ?? INVERTED_OUTLINE_AUTO;
  if (outlineSelection === INVERTED_OUTLINE_AUTO) {
    const outlineLayer = findAutomaticInvertedOutlineLayer(layers, targetLayer);
    if (outlineLayer) {
      return { type: "outline", layer: outlineLayer };
    }
  } else if (outlineSelection !== INVERTED_OUTLINE_BOUNDS) {
    const outlineLayer = findLayerBySelector(layers, outlineSelection, targetLayer);
    if (!outlineLayer) {
      throw new Error(`Inverted outline layer was not found: ${outlineSelection}`);
    }
    if (isDrillLayerKind(outlineLayer.kind)) {
      throw new Error(`Inverted outline layer must be a Gerber layer: ${outlineLayer.name}`);
    }
    return { type: "outline", layer: outlineLayer };
  }

  const bounds = getPlanGerberBounds(layers, null, includeLayerIds);
  return bounds ? { type: "bounds", bounds } : null;
}

function resolveFrameRenderBounds(layers, options) {
  let bounds = null;
  for (const layer of layers) {
    if (layer.visible === false) {
      continue;
    }
    bounds = mergePlanBounds(
      bounds,
      resolveLayerRenderBounds(layers, options, layer),
    );
  }
  return bounds;
}

function resolveLayerRenderBounds(
  layers,
  options,
  layer,
  includeLayerIds = null,
) {
  if (
    layer.kind === LAYER_KIND_COMPOSITE ||
    !layer.inverted ||
    isDrillLayerKind(layer.kind)
  ) {
    return layer.bounds;
  }

  const fillSource = resolveInvertedFillSourceForLayers(
    layers,
    options.invertedOutline,
    layer,
    includeLayerIds,
  );
  if (!fillSource) {
    return layer.bounds;
  }
  const outlineSelection = options.invertedOutline ?? INVERTED_OUTLINE_AUTO;
  if (fillSource.type === "outline" && outlineSelection === INVERTED_OUTLINE_AUTO) {
    // Auto outline rendering can fall back to bounds if the outline cannot be
    // converted to a fill. Keep a conservative union that covers either path,
    // including hidden layers required by a visible composite.
    return mergePlanBounds(
      getPlanGerberBounds(layers, null, includeLayerIds),
      fillSource.layer.bounds,
    );
  }
  return fillSource.type === "outline" ? fillSource.layer.bounds : fillSource.bounds;
}

function findAutomaticInvertedOutlineLayer(layers, targetLayer) {
  return layers.find(
    (layer) =>
      layer !== targetLayer &&
      !isDrillLayerKind(layer.kind) &&
      layer.kind !== LAYER_KIND_COMPOSITE &&
      (isBoardOutlineLayerName(layer.name) ||
        isBoardOutlineLayerName(layer.sourceName)),
  ) ?? null;
}

function findLayerBySelector(layers, selector, targetLayer = null) {
  const normalizedSelector = String(selector);
  if (normalizedSelector.startsWith(INTERNAL_LAYER_SELECTOR_PREFIX)) {
    const matches = layers.filter(
      (layer) =>
        layer !== targetLayer &&
        layer.kind !== LAYER_KIND_COMPOSITE &&
        layer.selectorKey === normalizedSelector,
    );
    if (matches.length > 1) {
      throw new Error(`Layer selector is ambiguous: ${normalizedSelector}`);
    }
    return matches[0] ?? null;
  }

  const index = Number(normalizedSelector);
  if (Number.isInteger(index) && index >= 1 && index <= layers.length) {
    const layer = layers[index - 1];
    return layer === targetLayer || layer.kind === LAYER_KIND_COMPOSITE
      ? null
      : layer;
  }

  const matches = layers.filter((layer) => {
    if (layer === targetLayer) return false;
    if (layer.kind === LAYER_KIND_COMPOSITE) return false;
    return (
      layer.name === normalizedSelector ||
      layer.sourceName === normalizedSelector ||
      basename(layer.name || "") === normalizedSelector ||
      basename(layer.sourceName || "") === normalizedSelector
    );
  });
  if (matches.length > 1) {
    throw new Error(`Layer selector is ambiguous: ${normalizedSelector}`);
  }
  return matches[0] ?? null;
}

function getPlanGerberBounds(layers, excludeLayer, includeLayerIds = null) {
  let bounds = null;
  for (const layer of layers) {
    if (
      layer === excludeLayer ||
      (layer.visible === false && !includeLayerIds?.has(getPublicLayerId(layer))) ||
      isDrillLayerKind(layer.kind) ||
      layer.kind === LAYER_KIND_COMPOSITE
    ) {
      continue;
    }
    bounds = mergePlanBounds(bounds, layer.bounds);
  }
  return bounds;
}

function mergePlanBounds(first, second) {
  if (!second) return first;
  if (!first) return { ...second };
  return {
    minX: Math.min(first.minX, second.minX),
    maxX: Math.max(first.maxX, second.maxX),
    minY: Math.min(first.minY, second.minY),
    maxY: Math.max(first.maxY, second.maxY),
  };
}

function addPlanDrillLayerToProcessor(processor, layer) {
  if (layer.parsedDrillLayer && typeof processor.add_parsed_layer === "function") {
    const outlineLayerId = processor.add_parsed_layer(
      layer.parsedDrillLayer.outlineLayer,
    );
    setDefaultDrillInnerOutline(processor, outlineLayerId, layer.name);
    return {
      outlineLayerId,
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
    const ids = normalizeDrillLayerIds(result);
    setDefaultDrillInnerOutline(processor, ids.outlineLayerId, layer.name);
    return ids;
  }
  if (typeof processor.add_drill_layer !== "function") {
    throw new Error("Drill rendering requires an updated WASM renderer.");
  }
  const ids = normalizeDrillLayerIds(processor.add_drill_layer(layer.content));
  setDefaultDrillInnerOutline(processor, ids.outlineLayerId, layer.name);
  return ids;
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
  const activeComposites = layers.filter(
    (layer) =>
      layer.kind === LAYER_KIND_COMPOSITE && layer.visible !== false,
  );
  const sourceLayerIds = new Set(
    activeComposites.flatMap((layer) => layer.sourceLayerIds),
  );
  const outlineLayerIds = new Set(
    activeComposites
      .filter((layer) => layer.outlineLayerId != null)
      .map((layer) => layer.outlineLayerId),
  );

  let count = activeComposites.length * 2;
  for (const layer of layers) {
    if (layer.kind === LAYER_KIND_COMPOSITE) continue;
    if (isDrillLayerKind(layer.kind)) {
      if (layer.visible !== false) count += 2;
      continue;
    }
    const publicLayerId = getPublicLayerId(layer);
    const needsEffectiveLayer =
      layer.visible !== false || sourceLayerIds.has(publicLayerId);
    const needsOutlineLayer = outlineLayerIds.has(publicLayerId);
    if (!needsEffectiveLayer && !needsOutlineLayer) continue;
    count += layer.inverted && needsEffectiveLayer && needsOutlineLayer ? 2 : 1;
  }
  return count;
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
      // Keep a zero-copy Buffer view over the immutable converted PNG band.
      // Buffer.from(Uint8Array) would duplicate the entire band outside the
      // maxBandBytes budget while zlib is applying backpressure.
      const rowBuffer = Buffer.from(
        row.buffer,
        row.byteOffset,
        row.byteLength,
      );
      // Wait for zlib's input callback even when write() stays below its high
      // water mark. Until then zlib may retain this view, and advancing to the
      // next band would let multiple application-sized bands coexist outside
      // the maxBandBytes contract.
      const inputConsumed = new Promise((resolve, reject) => {
        deflate.write(rowBuffer, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await Promise.race([inputConsumed, done, writeErrorSignal]);
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
    const result = writable.write(buffer);
    if (result === false) {
      return Promise.reject(
        new TypeError(
          "A duck-typed Node PNG writable must return a Promise for backpressure; boolean false requires a real Node Writable stream.",
        ),
      );
    }
    return Promise.resolve(result);
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
  return writable instanceof Writable;
}

function createTempOutputPath(outputPath) {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return resolve(dirname(outputPath), `.${basename(outputPath)}.${suffix}.tmp`);
}

function waitForWriteStreamOpen(stream) {
  if (stream.pending === false) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("open", onOpen);
      stream.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
  });
}

function resolveOutputFilePath(outputPath) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath must be a non-empty string.");
  }
  return resolve(outputPath);
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

async function readSourcePathText(path) {
  const bytes = await readStableRegularFile(path, MAX_SOURCE_FILE_SIZE_BYTES, "Layer source");
  return bytes.toString("utf8");
}

async function readStableRegularFile(path, maxBytes, label) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new TypeError(`${label} must be a regular file: ${path}`);
    }
    if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new RangeError(`${label} has an unsupported size: ${path}`);
    }
    if (stats.size > maxBytes) {
      throw new RangeError(
        `${label} ${path} is ${stats.size} bytes; the limit is ${maxBytes} bytes.`,
      );
    }

    const bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    if (offset !== bytes.length) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }

    const sentinel = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytesRead } = await handle.read(sentinel, 0, 1, offset);
    if (extraBytesRead !== 0) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    const finalStats = await handle.stat();
    if (
      finalStats.size !== stats.size ||
      finalStats.mtimeMs !== stats.mtimeMs ||
      finalStats.ctimeMs !== stats.ctimeMs ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino
    ) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
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
  // These three CPU buffers coexist while an encoded band is awaiting the
  // output sink: full-width RGBA assembly, tile-local RGBA readback, and the
  // encoded PNG rows. Treat maxBandBytes as their combined budget.
  const combinedRowBytes =
    width * RGBA_BYTES_PER_PIXEL +
    tileWidth * RGBA_BYTES_PER_PIXEL +
    rowStride;
  const byBandBytes = Math.floor(maxBandBytes / combinedRowBytes);
  if (!Number.isFinite(byBandBytes) || byBandBytes < 1) {
    throw new Error(
      `PNG export rows exceed the ${formatByteCount(maxBandBytes)} stream band limit at ${width}px wide.`,
    );
  }
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
