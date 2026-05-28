import {
  DEFAULT_BACKGROUND,
  FrameState,
  addLayerToProcessor,
  applyProcessorOptions,
  boundaryToPlainObject,
  clamp01,
  createBaseFrameOptions,
  getSourceName,
  loadWasmJsModule,
  normalizeColor,
  normalizeLayer,
  normalizeLayerList,
  numberOrDefault,
  optionalAlpha,
  positiveIntegerOrDefault,
  renderLayersBestEffort,
  resolveFrameView,
  resolveLayerAlpha,
  sourceToText,
} from "./shared.js";

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

    const view = resolveFrameView(
      frame.options,
      frame.bounds,
      this.canvas.width,
      this.canvas.height,
    );
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
