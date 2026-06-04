import { MAX_FILE_SIZE_BYTES, NOTIFICATION_DURATION_MS } from "./config.js";
import { DiagnosticsLog } from "./diagnostics.js";
import { getViewerElements } from "./dom-elements.js";
import { DrawerController } from "./drawer-controller.js";
import {
  formatFileSize,
  getErrorMessage,
  isNoGeometryError,
} from "./file-utils.js";
import { LayerFilterStore } from "./layer-filters.js";
import { renderLayerList as renderLayerListView } from "./layer-list.js";
import {
  drawMeasurementsOnContext,
  formatDimensionPair,
  renderMeasurements as renderMeasurementOverlay,
} from "./measurements.js";
import { NotificationCenter } from "./notifications.js";
import {
  collectLayerSources,
  fetchRemoteFile,
  getInitialSourceRepeat,
  getInitialSourceRepeatOffset,
  getInitialSourceUrl,
  repeatLayerSources,
} from "./source-loader.js";
import { ScreenshotExporter } from "./screenshot-exporter.js";
import {
  calculateFitView as calculateViewportFit,
  canvasPointToWorld as canvasPointToWorldCoordinate,
  clampZoom as clampViewportZoom,
  getViewScaleX,
  getViewScaleY,
  getVisibleCanvasViewport,
  panCameraByScreenDelta,
  worldToCanvasPoint as worldToCanvasCoordinate,
  zoomCameraAtCanvasPoint,
} from "./viewport.js";
import { ViewerOptionsStore } from "./viewer-options.js";

const WASM_INPUT_RESERVE_MARGIN_BYTES = 1024 * 1024;
const MAX_PARSE_WORKERS = 4;
const BYTES_PER_MIB = 1024 * 1024;
const UNKNOWN_LAYER_SOURCE_SIZE_BYTES = 16 * BYTES_PER_MIB;
const MIN_PARSE_TASK_MEMORY_BYTES = 32 * BYTES_PER_MIB;
const DEFAULT_PARSE_MEMORY_BUDGET_BYTES = 512 * BYTES_PER_MIB;
const MIN_PARSE_MEMORY_BUDGET_BYTES = 128 * BYTES_PER_MIB;
const MAX_PARSE_MEMORY_BUDGET_BYTES = 1536 * BYTES_PER_MIB;
const PARSE_MEMORY_ESTIMATE_MULTIPLIER = 16;
const PARSE_MEMORY_HEADROOM_RATIO = 0.5;
const RECYCLE_PARSE_WORKER_MEMORY_BYTES = 256 * BYTES_PER_MIB;
const RECYCLE_PARSE_WORKER_GROWTH_BYTES = 128 * BYTES_PER_MIB;
const ARC_TESSELLATION_QUALITY_LEVELS = {
  low: 0,
  normal: 1,
  high: 2,
};
const MINIMUM_FEATURE_PIXEL_VALUES = new Set([0, 1, 2]);
const DRILL_LAYER_KIND = "drill";
const GERBER_LAYER_KIND = "gerber";

class ParseWorkerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseWorkerUnavailableError";
  }
}

function isParseWorkerUnavailableError(error) {
  return error instanceof ParseWorkerUnavailableError;
}

function isParseWorkerCapabilityErrorMessage(message) {
  const normalizedMessage = String(message ?? "").toLowerCase();
  return (
    normalizedMessage.includes("parse_gerber_layer") ||
    normalizedMessage.includes("parse worker api") ||
    normalizedMessage.includes("parse worker requires an updated wasm module") ||
    normalizedMessage.includes("failed to fetch dynamically imported module") ||
    normalizedMessage.includes("wasm_gerber_processor")
  );
}

function isDrillSource(source) {
  return source?.kind === DRILL_LAYER_KIND;
}

function isDrillLayer(layer) {
  return layer?.kind === DRILL_LAYER_KIND;
}

function normalizeDrillMetadata(metadata = {}) {
  const tools = Array.isArray(metadata.tools)
    ? metadata.tools
        .map((tool) => ({
          code: Number(tool.code),
          diameterMm: Number(tool.diameterMm),
          hitCount: Number(tool.hitCount ?? 0),
          slotCount: Number(tool.slotCount ?? 0),
        }))
        .filter(
          (tool) =>
            Number.isFinite(tool.code) &&
            Number.isFinite(tool.diameterMm) &&
            tool.diameterMm > 0,
        )
    : [];

  return {
    tools,
    hitCount: Number(metadata.hitCount ?? 0),
    slotCount: Number(metadata.slotCount ?? 0),
  };
}

function getWorkerErrorEventMessage(event) {
  const messages = [
    getErrorMessage(event?.error),
    event?.message,
  ].filter(
    (message) =>
      message &&
      message !== "undefined" &&
      message !== "null" &&
      message !== "Unknown error",
  );
  const message = messages[0] || "Gerber parse worker failed";
  const line = Number(event?.lineno);
  const column = Number(event?.colno);

  if (event?.filename && Number.isFinite(line) && line > 0) {
    const location = Number.isFinite(column) && column > 0
      ? `${event.filename}:${line}:${column}`
      : `${event.filename}:${line}`;
    return `${message} (${location})`;
  }

  return message;
}

function getUtf8ByteLength(value) {
  let bytes = 0;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

function clampProgress(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

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

function getParseWorkerCount(layerCount) {
  if (layerCount <= 1 || typeof Worker === "undefined") {
    return 0;
  }

  const hardwareConcurrency = Number(globalThis.navigator?.hardwareConcurrency);
  const availableWorkers = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, hardwareConcurrency - 1)
    : 2;

  return Math.min(layerCount, availableWorkers, MAX_PARSE_WORKERS);
}

function getLayerSourceSizeBytes(source) {
  const sizeBytes = Number(source?.sizeBytes);
  return Number.isFinite(sizeBytes) && sizeBytes > 0
    ? sizeBytes
    : UNKNOWN_LAYER_SOURCE_SIZE_BYTES;
}

function estimateLayerParseMemoryBytes(source) {
  return Math.max(
    getLayerSourceSizeBytes(source) * PARSE_MEMORY_ESTIMATE_MULTIPLIER,
    MIN_PARSE_TASK_MEMORY_BYTES,
  );
}

function getBrowserAvailableHeapBytes() {
  const memory = globalThis.performance?.memory;
  const heapLimit = Number(memory?.jsHeapSizeLimit);
  const usedHeap = Number(memory?.usedJSHeapSize);

  if (!Number.isFinite(heapLimit) || !Number.isFinite(usedHeap)) {
    return null;
  }

  return Math.max(0, heapLimit - usedHeap);
}

function getDeviceMemoryBudgetBytes() {
  const deviceMemory = Number(globalThis.navigator?.deviceMemory);
  if (!Number.isFinite(deviceMemory) || deviceMemory <= 0) {
    return DEFAULT_PARSE_MEMORY_BUDGET_BYTES;
  }

  return deviceMemory * 1024 * BYTES_PER_MIB * 0.25;
}

function getParseMemoryBudgetBytes() {
  const availableHeapBytes = getBrowserAvailableHeapBytes();
  const rawBudget =
    availableHeapBytes === null
      ? getDeviceMemoryBudgetBytes()
      : Math.min(
          getDeviceMemoryBudgetBytes(),
          availableHeapBytes * PARSE_MEMORY_HEADROOM_RATIO,
        );

  return Math.min(
    Math.max(rawBudget, MIN_PARSE_MEMORY_BUDGET_BYTES),
    MAX_PARSE_MEMORY_BUDGET_BYTES,
  );
}

class GerberParseWorkerPool {
  constructor(workerCount) {
    this.workers = [];
    this.idleWorkers = [];
    this.queue = [];
    this.activeTasks = new Map();
    this.nextTaskId = 0;
    this.isDisposed = false;
    this.unavailableError = null;
    this.workerUrl = new URL("./gerber-parse-worker.js", import.meta.url);

    try {
      for (let index = 0; index < workerCount; index++) {
        this.addIdleWorker();
      }
    } catch (error) {
      for (const worker of this.workers) {
        worker.terminate();
      }
      this.workers = [];
      this.idleWorkers = [];
      throw error;
    }
  }

  get size() {
    return this.workers.length;
  }

  createWorker() {
    const worker = new Worker(this.workerUrl, { type: "module" });
    worker.addEventListener("message", (event) =>
      this.handleWorkerMessage(worker, event),
    );
    worker.addEventListener("error", (event) =>
      this.handleWorkerError(worker, event),
    );
    return worker;
  }

  addIdleWorker() {
    const worker = this.createWorker();
    this.workers.push(worker);
    this.idleWorkers.push(worker);
    return worker;
  }

  rejectRemainingTasksAsUnavailable(error) {
    const unavailableError =
      error instanceof ParseWorkerUnavailableError
        ? error
        : new ParseWorkerUnavailableError(getErrorMessage(error));
    this.unavailableError = unavailableError;

    for (const queuedTask of this.queue) {
      queuedTask.reject(unavailableError);
    }
    this.queue = [];

    for (const activeTask of this.activeTasks.values()) {
      activeTask.reject(unavailableError);
    }
    this.activeTasks.clear();

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.idleWorkers = [];
  }

  parse(content, offset, options = {}) {
    if (this.isDisposed) {
      return Promise.reject(new Error("Parse worker pool has been disposed"));
    }
    if (this.workers.length === 0) {
      return Promise.reject(
        this.unavailableError ??
          new ParseWorkerUnavailableError("No parse workers are available"),
      );
    }

    const id = this.nextTaskId++;
    return new Promise((resolve, reject) => {
      this.queue.push({ id, content, offset, options, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const worker = this.idleWorkers.pop();
      const task = this.queue.shift();
      this.activeTasks.set(worker, task);
      try {
        worker.postMessage({
          id: task.id,
          content: task.content,
          offset: task.offset,
          preserveArcRegions: task.options.preserveArcRegions,
          arcTessellationQuality: task.options.arcTessellationQuality,
        });
      } catch (error) {
        this.activeTasks.delete(worker);
        const unavailableError = new ParseWorkerUnavailableError(
          `Failed to send parse task to worker: ${getErrorMessage(error)}`,
        );
        task.reject(unavailableError);
        this.rejectRemainingTasksAsUnavailable(unavailableError);
        return;
      }
    }
  }

  handleWorkerMessage(worker, event) {
    const task = this.activeTasks.get(worker);
    if (!task || event.data?.id !== task.id) {
      return;
    }

    this.activeTasks.delete(worker);
    const shouldRecycle = this.shouldRecycleWorker(event.data?.workerMemory);

    if (event.data.ok) {
      task.resolve(event.data.parsedLayer);
    } else {
      const errorMessage = event.data.error || "Failed to parse Gerber layer";
      if (
        event.data.workerUnavailable ||
        isParseWorkerCapabilityErrorMessage(errorMessage)
      ) {
        const error = new ParseWorkerUnavailableError(errorMessage);
        task.reject(error);
        this.rejectRemainingTasksAsUnavailable(error);
        return;
      }

      task.reject(new Error(errorMessage));
    }

    if (!this.isDisposed) {
      if (shouldRecycle) {
        this.recycleWorker(worker);
      } else {
        this.idleWorkers.push(worker);
      }
    }

    this.pump();
  }

  shouldRecycleWorker(memory) {
    const beforeBytes = Number(memory?.beforeBytes);
    const afterBytes = Number(memory?.afterBytes);
    if (!Number.isFinite(afterBytes)) {
      return false;
    }

    const growthBytes = Number.isFinite(beforeBytes)
      ? Math.max(0, afterBytes - beforeBytes)
      : 0;
    return (
      afterBytes >= RECYCLE_PARSE_WORKER_MEMORY_BYTES ||
      growthBytes >= RECYCLE_PARSE_WORKER_GROWTH_BYTES
    );
  }

  recycleWorker(worker) {
    worker.terminate();
    this.workers = this.workers.filter((item) => item !== worker);

    if (this.isDisposed) {
      return;
    }

    try {
      this.addIdleWorker();
    } catch (error) {
      if (this.workers.length === 0) {
        this.unavailableError = new ParseWorkerUnavailableError(
          `Failed to recreate parse worker: ${getErrorMessage(error)}`,
        );
        for (const queuedTask of this.queue) {
          queuedTask.reject(this.unavailableError);
        }
        this.queue = [];
      }
    }
  }

  handleWorkerError(worker, event) {
    event?.preventDefault?.();
    const error = new ParseWorkerUnavailableError(
      getWorkerErrorEventMessage(event),
    );
    this.rejectRemainingTasksAsUnavailable(error);
  }

  dispose() {
    this.isDisposed = true;
    for (const task of this.queue) {
      task.reject(new Error("Parse worker pool has been disposed"));
    }
    for (const task of this.activeTasks.values()) {
      task.reject(new Error("Parse worker pool has been disposed"));
    }
    this.queue = [];
    this.activeTasks.clear();

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.idleWorkers = [];
  }
}

function isFatalWasmRuntimeError(error) {
  const message = getErrorMessage(error);
  return (
    (typeof WebAssembly !== "undefined" &&
      error instanceof WebAssembly.RuntimeError &&
      message.includes("unreachable")) ||
    message.includes("recursive use of an object detected")
  );
}

export class GerberViewer {
  constructor() {
    Object.assign(this, getViewerElements());
    this.gl = null; // WebGL2 context

    // WASM module and single processor
    this.wasmModule = null;
    this.wasmExports = null;
    this.wasmProcessor = null;
    this.isWebGlContextLost = false;
    this.isRestoringWebGlContext = false;
    this.isRecoveringWasmProcessor = false;
    this.wasmRecoveryPromise = null;
    this.isInitialUrlLoading = Boolean(getInitialSourceUrl());
    this.isLoadingLayers = false;
    this.loadingWorkspaceStatus = "Loading files";
    this.pendingRenderFrame = null;

    // Layers
    this.layers = [];
    this.nextLayerDomId = 0;
    this.draggedLayerId = null;
    this.layerDropIndex = null;
    this.pendingLayerRecordsForRecovery = null;

    // Camera
    this.camera = {
      zoom: 1.0,
      offsetX: 0.0,
      offsetY: 0.0,
      flipX: false,
      flipY: false,
    };
    this.fitViewZoom = null;
    this.minZoom = 0.000001;
    this.maxZoom = 1000000.0;

    // Interaction
    this.isPanning = false;
    this.lastMousePos = { x: 0, y: 0 };

    // Touch interaction
    this.isTouching = false;
    this.touches = [];
    this.initialPinchDistance = null;
    this.lastPinchDistance = null;
    this.lastTouchCenter = { x: 0, y: 0 };
    this.activeRulerTouchIdentifier = null;
    this.rulerTouchStartPoint = null;
    this.rulerTouchPoint = null;

    // Colors
    this.colorPalette = [
      [0.0, 1.0, 0.0], // Green
      [0.0, 0.0, 1.0], // Blue
      [1.0, 1.0, 0.0], // Yellow
      [1.0, 0.0, 1.0], // Magenta
      [0.0, 1.0, 1.0], // Cyan
      [1.0, 0.0, 0.0], // Red
    ];
    this.nextColorIndex = 0;

    // Global alpha
    this.globalAlpha = 0.7;
    this.diagnostics = new DiagnosticsLog({ container: this.diagnosticList });
    this.activePanel = "layers";
    this.isCanvasLight = false;
    this.isRulerActive = false;
    this.rulerStartPoint = null;
    this.rulerHoverPoint = null;
    this.measurements = [];
    this.measurementUnit = "mm";
    this.layerFilterStore = new LayerFilterStore();
    this.viewerOptionsStore = new ViewerOptionsStore();
    this.preserveArcRegions = Boolean(
      this.viewerOptionsStore.get("preserveArcRegions"),
    );
    this.arcTessellationQuality =
      this.viewerOptionsStore.get("arcTessellationQuality") ?? "normal";
    this.minimumFeaturePixels = Number(
      this.viewerOptionsStore.get("minimumFeaturePixels") ?? 0,
    );
    this.drawerController = new DrawerController({
      drawer: this.drawer,
      resizeHandle: this.resizeHandle,
      toggleButton: this.drawerToggleBtn,
      dropZone: this.dropZone,
      refreshIcons: () => this.refreshIcons(),
      captureViewState: () => this.captureCanvasViewState(),
      onResizeEnd: (viewState) => {
        this.resizeCanvas({ preserveViewState: viewState });
      },
    });
    this.notifications = new NotificationCenter({
      notification: this.notification,
      titleElement: this.notificationTitle,
      messageElement: this.notificationMessage,
      durationMs: NOTIFICATION_DURATION_MS,
      onNotify: (level, title, detail) => this.addDiagnostic(level, title, detail),
    });
    this.screenshotExporter = new ScreenshotExporter({
      canvas: this.canvas,
      screenshotButton: this.screenshotBtn,
      dialog: this.screenshotDialog,
      form: this.screenshotForm,
      backgroundToggle: this.screenshotBackgroundToggle,
      scaleSelect: this.screenshotScaleSelect,
      resolution: this.screenshotResolution,
      progressLabel: this.screenshotProgressLabel,
      progressValue: this.screenshotProgressValue,
      progressBar: this.screenshotProgressBar,
      cancelButton: this.screenshotCancelBtn,
      dismissButton: this.screenshotDismissBtn,
      exportButton: this.screenshotExportBtn,
      getGl: () => this.gl,
      getWasmModule: () => this.wasmModule,
      getWasmProcessor: () => this.wasmProcessor,
      getLayers: () => this.layers,
      getParseOptions: () => this.getParseOptions(),
      getRenderOptions: () => this.getRenderOptions(),
      getRenderState: (rect) => ({
        viewScaleX: this.getViewScaleX(),
        viewScaleY: this.getViewScaleY(),
        offsetX: this.camera.offsetX,
        offsetY: this.camera.offsetY,
        canvasWidth: this.canvas.width,
        canvasHeight: this.canvas.height,
        rectWidth: rect.width,
        rectHeight: rect.height,
        globalAlpha: this.globalAlpha,
        backgroundColor: this.isCanvasLight ? "#f8fafc" : "#020617",
      }),
      isWebGlUnavailable: () =>
        this.isWebGlContextLost || this.isRestoringWebGlContext,
      drawMeasurements: (context, renderState) =>
        this.drawMeasurementsOnContext(context, renderState),
      showError: (message) => this.showError(message),
    });
  }

  async init() {
    // Load WASM module
    this.wasmModule = await import("../wasm/pkg/wasm_gerber_processor.js");
    this.wasmExports = await this.wasmModule.default();
    this.wasmModule.init_panic_hook();

    this.createWebGlProcessor();
    this.normalizePersistedParserOptions();

    // Resize Canvas
    this.resizeCanvas();
    window.addEventListener("resize", () => {
      this.resizeCanvas();
      this.drawerController.updateToggleState();
      if (this.screenshotDialog.open) {
        this.updateScreenshotResolutionPreview();
      }
    });

    this.setupEventListeners();

    // Initial render
    this.updateEmptyStateHint();
    this.refreshIcons();
    this.syncOptionControls();
    this.syncFilterInputs();
    this.updateUiState();
    this.updateRulerControls();
    this.updateMeasurementUnitControl();
    this.updateViewFlipControls();
    this.requestRender();
    this.loadInitialUrlSource();
  }

  createWebGlContext() {
    const gl = this.canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    return gl;
  }

  createWebGlProcessor() {
    this.gl = this.createWebGlContext();
    this.wasmProcessor = new this.wasmModule.GerberProcessor();
    this.wasmProcessor.init(this.gl);
    this.configureWasmProcessorOptions(this.wasmProcessor);
  }

  createStagedWasmProcessor() {
    if (!this.gl || this.isWebGlContextLost) {
      throw new Error("WebGL renderer is not available");
    }

    const processor = new this.wasmModule.GerberProcessor();
    try {
      processor.init(this.gl);
      this.configureWasmProcessorOptions(processor);
      processor.resize();
      return processor;
    } catch (error) {
      this.disposeWasmProcessorInstance(processor, "staged processor");
      throw error;
    }
  }

  configureWasmProcessorOptions(processor) {
    if (typeof processor?.set_preserve_arc_regions === "function") {
      processor.set_preserve_arc_regions(this.preserveArcRegions);
    }

    if (typeof processor?.set_arc_tessellation_quality === "function") {
      processor.set_arc_tessellation_quality(this.getArcTessellationQualityLevel());
    }

    if (typeof processor?.set_minimum_feature_pixels === "function") {
      processor.set_minimum_feature_pixels(this.minimumFeaturePixels);
    }
  }

  normalizePersistedParserOptions() {
    let nextPreserveArcRegions = this.preserveArcRegions;
    let nextArcTessellationQuality = this.arcTessellationQuality;

    if (
      !nextPreserveArcRegions &&
      typeof this.wasmProcessor?.set_preserve_arc_regions !== "function"
    ) {
      nextPreserveArcRegions = true;
    }

    if (
      nextArcTessellationQuality !== "normal" &&
      typeof this.wasmProcessor?.set_arc_tessellation_quality !== "function"
    ) {
      nextArcTessellationQuality = "normal";
    }

    if (
      nextPreserveArcRegions === this.preserveArcRegions &&
      nextArcTessellationQuality === this.arcTessellationQuality
    ) {
      return;
    }

    this.preserveArcRegions = nextPreserveArcRegions;
    this.arcTessellationQuality = nextArcTessellationQuality;
    this.viewerOptionsStore.set("preserveArcRegions", this.preserveArcRegions);
    this.viewerOptionsStore.set(
      "arcTessellationQuality",
      this.arcTessellationQuality,
    );
    this.configureWasmProcessorOptions(this.wasmProcessor);
  }

  ensureParserOptionsSupported({
    preserveArcRegions = this.preserveArcRegions,
    arcTessellationQuality = this.arcTessellationQuality,
  } = {}) {
    if (
      !preserveArcRegions &&
      typeof this.wasmProcessor?.set_preserve_arc_regions !== "function"
    ) {
      throw new Error("Region arc options require an updated WASM module");
    }

    if (
      !preserveArcRegions &&
      arcTessellationQuality !== "normal" &&
      typeof this.wasmProcessor?.set_arc_tessellation_quality !== "function"
    ) {
      throw new Error("Arc tessellation quality requires an updated WASM module");
    }
  }

  resizeCanvas({ allowProcessorResize = false, preserveViewState = null } = {}) {
    this.drawerController.syncLayout();

    const rect = this.canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
    this.canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
    this.restoreCanvasViewState(preserveViewState);

    const canResizeProcessor =
      this.wasmProcessor &&
      !this.isWebGlContextLost &&
      (!this.isRestoringWebGlContext || allowProcessorResize);
    if (canResizeProcessor) {
      try {
        this.wasmProcessor.resize();
      } catch (error) {
        const message = getErrorMessage(error);
        console.error("[Render] Failed to resize renderer:", error);
        this.addDiagnostic("error", "Resize failed", message);
      }
    }

    this.requestRender();
  }

  setupEventListeners() {
    this.canvas.addEventListener(
      "webglcontextlost",
      (e) => this.handleWebGlContextLost(e),
      { passive: false },
    );
    this.canvas.addEventListener("webglcontextrestored", () => {
      void this.handleWebGlContextRestored();
    });

    // File input
    this.selectFilesBtn.addEventListener("click", () => {
      this.fileInput.click();
    });

    this.emptyUploadBtn.addEventListener("click", () => {
      this.fileInput.click();
    });

    this.fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) {
        this.handleFileUpload(e.target.files);
      }
    });

    // Fit view button
    this.fitViewBtn.addEventListener("click", () => {
      this.fitView();
    });

    this.flipHorizontalBtn.addEventListener("click", () => {
      this.toggleViewFlip("x");
    });

    this.flipVerticalBtn.addEventListener("click", () => {
      this.toggleViewFlip("y");
    });

    this.canvasThemeToggle.addEventListener("click", () => {
      this.toggleCanvasTheme();
    });

    this.screenshotBtn.addEventListener("click", () => {
      this.openScreenshotDialog();
    });
    this.screenshotForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.isExportingScreenshot) return;

      const options = {
        includeBackground: this.screenshotBackgroundToggle.checked,
        scale: this.getSelectedScreenshotScale(),
      };
      const isTiled = this.shouldTileScreenshot(options.scale);
      if (!isTiled) {
        this.closeScreenshotDialog();
      }
      void this.exportScreenshot(options).finally(() => {
        if (isTiled) {
          this.closeScreenshotDialog();
        }
      });
    });
    this.screenshotScaleSelect.addEventListener("change", () => {
      this.updateScreenshotResolutionPreview();
    });
    this.screenshotCancelBtn.addEventListener("click", () => {
      if (this.isExportingScreenshot) return;
      this.closeScreenshotDialog();
    });
    this.screenshotDismissBtn.addEventListener("click", () => {
      if (this.isExportingScreenshot) return;
      this.closeScreenshotDialog();
    });
    this.screenshotDialog.addEventListener("click", (e) => {
      if (e.target === this.screenshotDialog && !this.isExportingScreenshot) {
        this.closeScreenshotDialog();
      }
    });

    this.rulerToggleBtn.addEventListener("click", () => {
      this.toggleRuler();
    });

    this.rulerClearBtn.addEventListener("click", () => {
      this.clearRulerMeasurements();
    });

    this.measurementUnitToggle.addEventListener("click", () => {
      this.toggleMeasurementUnit();
    });

    this.fullscreenBtn.addEventListener("click", () => {
      this.toggleFullscreen();
    });

    document.addEventListener("fullscreenchange", () => {
      this.updateFullscreenState();
      this.triggerCanvasResize();
    });

    // Layer control buttons
    this.selectAllBtn.addEventListener("click", () => {
      this.selectAllLayerCheckboxes();
    });

    this.selectTopBtn.addEventListener("click", () => {
      this.selectLayersByFilter("top");
    });

    this.selectBottomBtn.addEventListener("click", () => {
      this.selectLayersByFilter("bottom");
    });

    this.unselectAllBtn.addEventListener("click", () => {
      this.unselectAllLayerCheckboxes();
    });

    this.clearAllBtn.addEventListener("click", () => {
      this.clearAllLayers();
    });

    this.clearDiagnosticsBtn.addEventListener("click", () => {
      this.clearDiagnostics();
    });

    // Alpha slider
    this.alphaSlider.addEventListener("input", (e) => {
      const alpha = parseInt(e.target.value) / 100;
      this.alphaValue.textContent = `${e.target.value}%`;
      this.updateGlobalAlpha(alpha);
    });

    this.regionArcExactInput.addEventListener("change", () => {
      if (this.regionArcExactInput.checked) {
        void this.setRegionArcMode("exact");
      }
    });

    this.regionArcApproximateInput.addEventListener("change", () => {
      if (this.regionArcApproximateInput.checked) {
        void this.setRegionArcMode("approximate");
      }
    });

    for (const input of this.getArcQualityInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) {
          void this.setArcTessellationQuality(input.value);
        }
      });
    }

    for (const input of this.getMinimumVisibilityInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.setMinimumFeaturePixels(Number(input.value));
        }
      });
    }

    this.topFilterInput.addEventListener("input", () => {
      this.updateLayerFilter("top", this.topFilterInput.value);
    });

    this.bottomFilterInput.addEventListener("input", () => {
      this.updateLayerFilter("bottom", this.bottomFilterInput.value);
    });

    this.filterSaveBtn.addEventListener("click", () => {
      this.saveLayerFiltersFromInputs();
    });

    this.filterDefaultBtn.addEventListener("click", () => {
      this.setLayerFilters(this.layerFilterStore.getDefaults());
    });

    this.filterRestoreBtn.addEventListener("click", () => {
      this.setLayerFilters(this.layerFilterStore.reload());
    });

    this.notificationCloseBtn.addEventListener("click", () => {
      this.hideNotification();
    });

    // Canvas mouse events
    this.canvas.addEventListener("mousedown", (e) => this.handleMouseDown(e));
    this.canvas.addEventListener("mousemove", (e) => this.handleMouseMove(e));
    this.canvas.addEventListener("mouseup", (e) => this.handleMouseUp(e));
    this.canvas.addEventListener("mouseleave", (e) => this.handleMouseUp(e));
    this.canvas.addEventListener("wheel", (e) => this.handleWheel(e));

    // Canvas touch events
    this.canvas.addEventListener("touchstart", (e) => this.handleTouchStart(e), {
      passive: false,
    });
    this.canvas.addEventListener("touchmove", (e) => this.handleTouchMove(e), {
      passive: false,
    });
    this.canvas.addEventListener("touchend", (e) => this.handleTouchEnd(e), {
      passive: false,
    });
    this.canvas.addEventListener("touchcancel", (e) => this.handleTouchEnd(e), {
      passive: false,
    });

    this.drawerController.bindEvents();
    this.drawerController.initialize();
    this.resizeCanvas();
    this.panelTabs.forEach((button) => {
      button.addEventListener("click", () => {
        this.setActivePanel(button.dataset.panelTab);
      });
    });

    this.layerList.addEventListener("dragover", (e) =>
      this.handleLayerListDragOver(e),
    );
    this.layerList.addEventListener("drop", (e) => this.handleLayerDrop(e));
    this.layerList.addEventListener("dragleave", (e) => {
      e.stopPropagation();
      if (!this.layerList.contains(e.relatedTarget)) {
        this.clearLayerDropIndicator();
      }
    });

    // File drop events
    this.dropZone.addEventListener("dragover", (e) => this.handleDragOver(e));
    this.dropZone.addEventListener("dragleave", (e) => this.handleDragLeave(e));
    this.dropZone.addEventListener("drop", (e) => this.handleDrop(e));
  }

  handleWebGlContextLost(e) {
    e.preventDefault();
    this.isWebGlContextLost = true;
    this.isRestoringWebGlContext = false;
    this.gl = null;
    this.addDiagnostic(
      "warning",
      "WebGL context lost",
      "Waiting for the browser to restore the GPU context.",
    );
    this.updateUiState();
  }

  async handleWebGlContextRestored() {
    if (this.isRestoringWebGlContext) return;

    const layerSnapshot = this.layers.map((layer) =>
      this.createLayerRecoverySnapshot(layer),
    );
    const viewState = this.captureCanvasViewState();

    this.isRestoringWebGlContext = true;
    this.updateUiState();

    try {
      this.gl = this.createWebGlContext();
      if (!this.wasmProcessor) {
        throw new Error("No parsed layer data available for WebGL restore");
      }
      try {
        this.wasmProcessor.restore_context(this.gl);
        this.isWebGlContextLost = false;
        this.resizeCanvas({ allowProcessorResize: true, preserveViewState: viewState });
        this.layers = layerSnapshot;
      } catch (restoreError) {
        await this.rebuildWebGlProcessorFromSnapshot(
          layerSnapshot,
          viewState,
          restoreError,
        );
      }

      this.renderLayerList();
    } catch (error) {
      this.isWebGlContextLost = true;
      const message = getErrorMessage(error);
      console.error("[Render] Failed to restore WebGL context:", error);
      this.addDiagnostic("error", "WebGL restore failed", message);
      this.showError(`Failed to restore WebGL context: ${message}`);
    } finally {
      this.isRestoringWebGlContext = false;
      this.updateUiState();
      this.requestRender();
    }
  }

  async rebuildWebGlProcessorFromSnapshot(layerSnapshot, viewState, restoreError) {
    this.addDiagnostic(
      "warning",
      "WebGL renderer rebuilt",
      `Rebuilding layers after WebGL restore could not reuse cached geometry: ${getErrorMessage(restoreError)}`,
    );

    this.disposeWasmProcessor();
    this.layers = [];
    this.createWebGlProcessor();
    this.isWebGlContextLost = false;
    this.resizeCanvas({ allowProcessorResize: true, preserveViewState: viewState });

    for (const layer of layerSnapshot) {
      await this.restoreLayerFromSnapshot(layer);
    }
  }

  refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  setLayerFilters(filters) {
    this.layerFilterStore.set(filters);
    this.syncFilterInputs();
  }

  getParseOptions() {
    return {
      preserveArcRegions: this.preserveArcRegions,
      arcTessellationQuality: this.getArcTessellationQualityLevel(),
    };
  }

  getRenderOptions() {
    return {
      minimumFeaturePixels: this.minimumFeaturePixels,
    };
  }

  getArcTessellationQualityLevel() {
    return ARC_TESSELLATION_QUALITY_LEVELS[this.arcTessellationQuality] ?? 1;
  }

  getArcQualityInputs() {
    return [
      this.arcQualityLowInput,
      this.arcQualityNormalInput,
      this.arcQualityHighInput,
    ];
  }

  getMinimumVisibilityInputs() {
    return [
      this.minimumVisibilityOffInput,
      this.minimumVisibility1Input,
      this.minimumVisibility2Input,
    ];
  }

  syncOptionControls() {
    this.regionArcExactInput.checked = this.preserveArcRegions;
    this.regionArcApproximateInput.checked = !this.preserveArcRegions;

    for (const input of this.getArcQualityInputs()) {
      input.checked = input.value === this.arcTessellationQuality;
      input.disabled = this.preserveArcRegions || this.isRendererBusy();
    }

    for (const input of this.getMinimumVisibilityInputs()) {
      input.checked = Number(input.value) === this.minimumFeaturePixels;
      input.disabled = this.isRendererBusy();
    }
  }

  syncFilterInputs() {
    this.topFilterInput.value = this.layerFilterStore.get("top");
    this.bottomFilterInput.value = this.layerFilterStore.get("bottom");
  }

  async setRegionArcMode(mode) {
    const nextPreserveArcRegions = mode !== "approximate";
    if (nextPreserveArcRegions === this.preserveArcRegions) {
      return;
    }
    if (this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    const previousPreserveArcRegions = this.preserveArcRegions;
    try {
      this.ensureParserOptionsSupported({
        preserveArcRegions: nextPreserveArcRegions,
        arcTessellationQuality: this.arcTessellationQuality,
      });

      this.preserveArcRegions = nextPreserveArcRegions;
      this.syncOptionControls();

      if (this.layers.length > 0) {
        await this.rebuildLayersForParserOptions();
      } else {
        this.configureWasmProcessorOptions(this.wasmProcessor);
      }
      this.viewerOptionsStore.set(
        "preserveArcRegions",
        this.preserveArcRegions,
      );
      this.showNotification(
        "Options updated",
        "info",
        NOTIFICATION_DURATION_MS,
        (messageElement) => {
          messageElement.textContent = "Region arc rendering mode was applied.";
        },
      );
    } catch (error) {
      this.preserveArcRegions = previousPreserveArcRegions;
      this.syncOptionControls();
      this.viewerOptionsStore.set(
        "preserveArcRegions",
        this.preserveArcRegions,
      );
      this.configureWasmProcessorOptions(this.wasmProcessor);
      this.showError(`Failed to apply region arc option: ${getErrorMessage(error)}`);
    } finally {
      this.updateUiState();
    }
  }

  async setArcTessellationQuality(quality) {
    if (!(quality in ARC_TESSELLATION_QUALITY_LEVELS)) {
      this.syncOptionControls();
      return;
    }
    if (quality === this.arcTessellationQuality) {
      return;
    }
    if (this.preserveArcRegions || this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    const previousQuality = this.arcTessellationQuality;
    try {
      this.ensureParserOptionsSupported({
        preserveArcRegions: this.preserveArcRegions,
        arcTessellationQuality: quality,
      });

      this.arcTessellationQuality = quality;
      this.syncOptionControls();

      if (this.layers.length > 0) {
        await this.rebuildLayersForParserOptions();
      } else {
        this.configureWasmProcessorOptions(this.wasmProcessor);
      }
      this.viewerOptionsStore.set(
        "arcTessellationQuality",
        this.arcTessellationQuality,
      );
      this.showNotification(
        "Options updated",
        "info",
        NOTIFICATION_DURATION_MS,
        (messageElement) => {
          messageElement.textContent = "Arc tessellation quality was applied.";
        },
      );
    } catch (error) {
      this.arcTessellationQuality = previousQuality;
      this.syncOptionControls();
      this.viewerOptionsStore.set(
        "arcTessellationQuality",
        this.arcTessellationQuality,
      );
      this.configureWasmProcessorOptions(this.wasmProcessor);
      this.showError(`Failed to apply arc quality option: ${getErrorMessage(error)}`);
    } finally {
      this.updateUiState();
    }
  }

  setMinimumFeaturePixels(pixels) {
    if (!MINIMUM_FEATURE_PIXEL_VALUES.has(pixels)) {
      this.syncOptionControls();
      return;
    }
    if (pixels === this.minimumFeaturePixels) {
      return;
    }
    if (this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    const previousPixels = this.minimumFeaturePixels;
    this.minimumFeaturePixels = pixels;
    this.syncOptionControls();
    this.viewerOptionsStore.set(
      "minimumFeaturePixels",
      this.minimumFeaturePixels,
    );

    try {
      if (typeof this.wasmProcessor?.set_minimum_feature_pixels === "function") {
        this.wasmProcessor.set_minimum_feature_pixels(this.minimumFeaturePixels);
      }
      this.requestRender();
    } catch (error) {
      this.minimumFeaturePixels = previousPixels;
      this.syncOptionControls();
      this.viewerOptionsStore.set(
        "minimumFeaturePixels",
        this.minimumFeaturePixels,
      );
      this.configureWasmProcessorOptions(this.wasmProcessor);
      this.showError(`Failed to apply minimum line width: ${getErrorMessage(error)}`);
    } finally {
      this.updateUiState();
    }
  }

  async rebuildLayersForParserOptions() {
    const layerSnapshot = this.layers.map((layer) =>
      this.createLayerRecoverySnapshot(layer),
    );

    if (
      layerSnapshot.some((layer) => typeof layer.sourceContent !== "string")
    ) {
      throw new Error("Reload files before changing parser options.");
    }

    const viewState = this.captureCanvasViewState();
    this.showLoadingModal({
      title: "Applying options",
      stage: "Parsing",
      current: 0,
      total: layerSnapshot.length,
    });

    try {
      const parsedLayers = [];
      for (const [index, layer] of layerSnapshot.entries()) {
        this.updateLoadingModal({
          title: "Applying options",
          stage: "Parsing",
          fileName: layer.name,
          current: index,
          total: layerSnapshot.length,
        });

        if (layer.kind === DRILL_LAYER_KIND) {
          parsedLayers.push({ ...layer, parsedLayer: null });
        } else {
          try {
            const parsedLayer = await this.parseLayerContent(
              layer.sourceContent,
              layer.offset,
              null,
            );
            parsedLayers.push({ ...layer, parsedLayer });
          } catch (error) {
            this.handleLayerLoadError(layer.name, error);
            throw new Error(
              `Failed to apply options because ${layer.name} could not be parsed: ${getErrorMessage(error)}`,
            );
          }
        }
      }

      let stagedProcessor = null;
      const stagedLayers = [];
      const nextLayerDomId = this.nextLayerDomId;
      const nextColorIndex = this.nextColorIndex;
      try {
        stagedProcessor = this.createStagedWasmProcessor();

        for (const [index, layer] of parsedLayers.entries()) {
          this.updateLoadingModal({
            title: "Applying options",
            stage: "Loading",
            fileName: layer.name,
            current: index,
            total: parsedLayers.length,
          });

          const layerOptions = {
            id: layer.id,
            visible: layer.visible,
            color: layer.color,
            sourceContent: layer.sourceContent,
            offset: layer.offset,
            skipFatalRecovery: true,
          };
          const layerRecord =
            layer.kind === DRILL_LAYER_KIND
              ? await this.createDrillLayerRecord(
                  layer.name,
                  layer.sourceContent,
                  layerOptions,
                  stagedProcessor,
                )
              : await this.createParsedLayerRecord(
                  layer.name,
                  layer.parsedLayer,
                  layerOptions,
                  stagedProcessor,
                );
          this.prepareLayerMetadata(layerRecord);
          stagedLayers.push(layerRecord);

          this.updateLoadingModal({
            stage: "Loaded",
            fileName: layer.name,
            current: index + 1,
            total: parsedLayers.length,
          });
        }

        const previousProcessor = this.wasmProcessor;
        this.wasmProcessor = stagedProcessor;
        stagedProcessor = null;
        this.layers = stagedLayers;
        this.disposeWasmProcessorInstance(previousProcessor, "previous processor");
      } catch (error) {
        this.nextLayerDomId = nextLayerDomId;
        this.nextColorIndex = nextColorIndex;
        this.disposeWasmProcessorInstance(stagedProcessor, "staged processor");
        throw error;
      }

      this.restoreCanvasViewState(viewState);
      this.renderLayerList();
      this.requestRender();
    } finally {
      this.hideLoadingModal();
    }
  }

  updateLayerFilter(kind, value) {
    this.layerFilterStore.update(kind, value);
  }

  saveLayerFiltersFromInputs() {
    this.updateLayerFilter("top", this.topFilterInput.value);
    this.updateLayerFilter("bottom", this.bottomFilterInput.value);
    this.layerFilterStore.save();
    this.showNotification(
      "Filters saved",
      "info",
      NOTIFICATION_DURATION_MS,
      (messageElement) => {
        messageElement.textContent = "Layer filter settings were saved.";
      },
    );
  }

  isRendererBusy() {
    return (
      this.isLoadingLayers ||
      this.isWebGlContextLost ||
      this.isRestoringWebGlContext
    );
  }

  updateUiState() {
    const totalLayers = this.layers.length;
    const visibleLayers = this.layers.filter((layer) => layer.visible).length;

    if (this.isLoadingLayers) {
      this.workspaceStatus.textContent = this.loadingWorkspaceStatus;
    } else if (this.isRestoringWebGlContext) {
      this.workspaceStatus.textContent = "Restoring WebGL";
    } else if (this.isWebGlContextLost) {
      this.workspaceStatus.textContent = "WebGL context lost";
    } else {
      this.workspaceStatus.textContent =
        totalLayers === 0
          ? "Ready"
          : `${visibleLayers} visible / ${totalLayers} loaded`;
    }

    const rendererBusy = this.isRendererBusy();
    this.fileInput.disabled = rendererBusy;
    this.selectFilesBtn.disabled = rendererBusy;
    this.emptyUploadBtn.disabled = rendererBusy;
    this.regionArcExactInput.disabled = rendererBusy;
    this.regionArcApproximateInput.disabled = rendererBusy;
    for (const input of this.getArcQualityInputs()) {
      input.disabled = rendererBusy || this.preserveArcRegions;
    }
    for (const input of this.getMinimumVisibilityInputs()) {
      input.disabled = rendererBusy;
    }

    this.visibleLayerCount.textContent = `${visibleLayers} / ${totalLayers}`;
    this.diagnosticsCount.textContent = String(this.diagnostics.count);
    this.emptyState.classList.toggle(
      "is-hidden",
      totalLayers > 0 || this.isInitialUrlLoading || this.isLoadingLayers,
    );
    this.zoomReadout.textContent = this.formatZoom();
    this.boundsReadout.textContent = this.formatCombinedBounds();
    this.renderDiagnostics();
    this.refreshIcons();
  }

  formatZoom() {
    if (this.layers.length === 0) {
      return "100%";
    }

    const fitZoom = this.getZoomReadoutBaseZoom();
    if (!Number.isFinite(fitZoom) || fitZoom <= 0) {
      return "100%";
    }

    const zoomPercent = (this.camera.zoom / fitZoom) * 100;
    return `${Math.trunc(zoomPercent)}%`;
  }

  getZoomReadoutBaseZoom() {
    return Number.isFinite(this.fitViewZoom) && this.fitViewZoom > 0
      ? this.fitViewZoom
      : this.getFitViewZoom();
  }

  getZoomReadoutRatio() {
    const fitZoom = this.getZoomReadoutBaseZoom();
    if (!Number.isFinite(fitZoom) || fitZoom <= 0) {
      return null;
    }

    return this.camera.zoom / fitZoom;
  }

  formatCombinedBounds() {
    if (this.layers.length === 0) {
      return "No bounds";
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const layer of this.layers) {
      if (!layer.bounds) continue;
      minX = Math.min(minX, layer.bounds.minX);
      maxX = Math.max(maxX, layer.bounds.maxX);
      minY = Math.min(minY, layer.bounds.minY);
      maxY = Math.max(maxY, layer.bounds.maxY);
    }

    if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY)) {
      return "No bounds";
    }

    const width = maxX - minX;
    const height = maxY - minY;
    return formatDimensionPair(width, height, this.measurementUnit);
  }

  setWorkspaceStatus(status) {
    this.workspaceStatus.textContent = status;
  }

  showLoadingModal({
    title = "Loading files",
    stage = "Preparing",
    fileName = "-",
    current = 0,
    total = 0,
    progress = 0,
    indeterminate = false,
  } = {}) {
    this.isLoadingLayers = true;
    this.loadingWorkspaceStatus = title;
    this.loadingModal.hidden = false;
    this.updateLoadingModal({
      title,
      stage,
      fileName,
      current,
      total,
      progress,
      indeterminate,
    });
    this.updateUiState();
  }

  updateLoadingModal({
    title = null,
    stage = null,
    fileName = null,
    current = null,
    total = null,
    indeterminate = false,
  } = {}) {
    if (title !== null) {
      this.loadingTitle.textContent = title;
      this.loadingWorkspaceStatus = title;
    }
    if (stage !== null) {
      this.loadingStage.textContent = stage;
    }
    if (fileName !== null) {
      this.loadingFileName.textContent = fileName || "-";
    }
    const currentValue = Number.isFinite(current) ? current : null;
    const totalValue = Number.isFinite(total) ? total : null;
    if (currentValue !== null || totalValue !== null) {
      this.loadingProgressCount.textContent =
        `${currentValue ?? 0} / ${totalValue ?? 0}`;
    }

    if (indeterminate) {
      this.loadingProgressBar.removeAttribute("value");
      this.loadingProgressValue.textContent = "";
      this.loadingProgressValue.hidden = true;
      return;
    }

    this.loadingProgressValue.textContent = "";
    this.loadingProgressValue.hidden = true;
    const progressRatio =
      totalValue && totalValue > 0 ? (currentValue ?? 0) / totalValue : 0;
    this.loadingProgressBar.value = Math.round(
      clampProgress(progressRatio) * 100,
    );
  }

  hideLoadingModal() {
    this.loadingModal.hidden = true;
    this.isLoadingLayers = false;
    this.loadingWorkspaceStatus = "Loading files";
    this.updateUiState();
  }

  addDiagnostic(level, title, detail = "") {
    this.diagnostics.add(level, title, detail);
    this.updateUiState();
  }

  renderDiagnostics() {
    this.diagnostics.render();
  }

  clearDiagnostics() {
    this.diagnostics.clear();
    this.updateUiState();
  }

  setActivePanel(panelName) {
    if (!panelName) return;
    this.activePanel = panelName;

    this.panelTabs.forEach((button) => {
      button.classList.toggle("active", button.dataset.panelTab === panelName);
    });

    this.panelSections.forEach((section) => {
      section.classList.toggle("active", section.dataset.panel === panelName);
    });
  }

  getViewScaleX() {
    return getViewScaleX(this.camera);
  }

  getViewScaleY() {
    return getViewScaleY(this.camera);
  }

  toggleViewFlip(axis) {
    const viewportCenter = this.getVisibleCanvasViewportCenter();

    if (axis === "x") {
      this.camera.flipX = !this.camera.flipX;
      this.camera.offsetX = 2 * viewportCenter.x - this.camera.offsetX;
    } else if (axis === "y") {
      this.camera.flipY = !this.camera.flipY;
      this.camera.offsetY = 2 * viewportCenter.y - this.camera.offsetY;
    }

    this.requestRender();
    this.updateViewFlipControls();
  }

  getVisibleCanvasViewportCenter() {
    const viewport = this.getVisibleCanvasViewport();
    if (!viewport) {
      return { x: 0, y: 0 };
    }

    return {
      x: (viewport.left + viewport.right) / 2,
      y: (viewport.top + viewport.bottom) / 2,
    };
  }

  captureCanvasViewState() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || this.camera.zoom === 0) {
      return null;
    }

    const anchorWorld = this.canvasPointToWorld(rect.left, rect.top);
    if (!anchorWorld) return null;

    return {
      anchorWorld,
      pixelsPerWorld: (Math.min(rect.width, rect.height) * this.camera.zoom) / 2,
      zoomReadoutRatio: this.getZoomReadoutRatio(),
    };
  }

  restoreCanvasViewState(viewState) {
    if (!viewState || !Number.isFinite(viewState.pixelsPerWorld)) return;

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const nextZoom = this.clampZoom(
      (viewState.pixelsPerWorld * 2) / Math.min(rect.width, rect.height),
    );
    this.camera.zoom = nextZoom;

    const anchorCorrected = this.canvasLocalPointToCorrected(0, 0, rect);
    this.camera.offsetX =
      anchorCorrected.x - viewState.anchorWorld.x * this.getViewScaleX();
    this.camera.offsetY =
      anchorCorrected.y - viewState.anchorWorld.y * this.getViewScaleY();

    if (
      Number.isFinite(viewState.zoomReadoutRatio) &&
      viewState.zoomReadoutRatio > 0
    ) {
      this.fitViewZoom = this.camera.zoom / viewState.zoomReadoutRatio;
    }
  }

  updateViewFlipControls() {
    this.flipHorizontalBtn.setAttribute(
      "aria-pressed",
      String(this.camera.flipX),
    );
    this.flipVerticalBtn.setAttribute(
      "aria-pressed",
      String(this.camera.flipY),
    );
  }

  toggleCanvasTheme() {
    this.isCanvasLight = !this.isCanvasLight;
    this.updateCanvasTheme();
  }

  updateCanvasTheme() {
    this.viewerSurface.classList.toggle("canvas-light", this.isCanvasLight);

    const label = this.isCanvasLight
      ? "Switch to black canvas"
      : "Switch to white canvas";
    this.canvasThemeToggle.setAttribute("aria-label", label);
    this.canvasThemeToggle.setAttribute("aria-pressed", String(this.isCanvasLight));
    this.canvasThemeToggle.title = label;
    this.canvasThemeToggle.replaceChildren();

    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", this.isCanvasLight ? "moon" : "sun");
    this.canvasThemeToggle.appendChild(icon);
    this.refreshIcons();
  }

  openScreenshotDialog() {
    this.screenshotExporter.openDialog();
  }

  closeScreenshotDialog() {
    this.screenshotExporter.closeDialog();
  }

  getSelectedScreenshotScale() {
    return this.screenshotExporter.getSelectedScale();
  }

  updateScreenshotResolutionPreview() {
    this.screenshotExporter.updateResolutionPreview();
  }

  shouldTileScreenshot(scale) {
    return this.screenshotExporter.shouldTile(scale);
  }

  get isExportingScreenshot() {
    return this.screenshotExporter.isExporting;
  }

  async exportScreenshot({ includeBackground = false, scale = 1 } = {}) {
    return this.screenshotExporter.export({ includeBackground, scale });
  }

  drawMeasurementsOnContext(context, renderState = null) {
    drawMeasurementsOnContext(context, {
      measurements: this.measurements,
      rulerStartPoint: this.rulerStartPoint,
      rulerHoverPoint: this.rulerHoverPoint,
      worldToCanvasPoint: (point) => this.worldToCanvasPoint(point, renderState),
      unit: this.measurementUnit,
    });
  }

  toggleRuler() {
    this.isRulerActive = !this.isRulerActive;
    if (!this.isRulerActive) {
      this.resetRulerTouch();
      this.rulerStartPoint = null;
      this.rulerHoverPoint = null;
    }

    this.renderMeasurements();
    this.updateRulerControls();
  }

  clearRulerMeasurements() {
    this.measurements = [];
    this.resetRulerTouch();
    this.rulerStartPoint = null;
    this.rulerHoverPoint = null;
    this.renderMeasurements();
    this.updateRulerControls();
  }

  toggleMeasurementUnit() {
    this.measurementUnit = this.measurementUnit === "mm" ? "inch" : "mm";
    this.updateMeasurementUnitControl();
    this.renderMeasurements();
    this.renderLayerList();
    this.updateUiState();
  }

  updateMeasurementUnitControl() {
    const isInch = this.measurementUnit === "inch";
    const label = isInch
      ? "Show measurements in millimeters"
      : "Show measurements in inches";
    this.measurementUnitToggle.textContent = isInch ? "in" : "mm";
    this.measurementUnitToggle.setAttribute("aria-label", label);
    this.measurementUnitToggle.title = label;
  }

  updateRulerControls() {
    const label = this.isRulerActive ? "Disable ruler" : "Enable ruler";
    this.dropZone.classList.toggle("ruler-active", this.isRulerActive);
    this.rulerToggleBtn.setAttribute("aria-label", label);
    this.rulerToggleBtn.setAttribute("aria-pressed", String(this.isRulerActive));
    this.rulerToggleBtn.title = label;
    this.rulerClearBtn.disabled =
      this.measurements.length === 0 && this.rulerStartPoint === null;
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }

    this.dropZone.requestFullscreen?.();
  }

  updateFullscreenState() {
    const isFullscreen = Boolean(document.fullscreenElement);
    const label = isFullscreen ? "Exit fullscreen" : "Enter fullscreen";
    this.fullscreenBtn.setAttribute("aria-label", label);
    this.fullscreenBtn.title = label;
    this.fullscreenBtn.replaceChildren();
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", isFullscreen ? "minimize-2" : "maximize-2");
    this.fullscreenBtn.appendChild(icon);
    this.refreshIcons();
  }

  updateEmptyStateHint() {
    this.emptyFileSizeLimit.textContent =
      `Max ${formatFileSize(MAX_FILE_SIZE_BYTES)} per file`;
  }

  async loadInitialUrlSource() {
    const sourceUrl = getInitialSourceUrl();
    if (!sourceUrl) {
      this.isInitialUrlLoading = false;
      return;
    }
    const repeat = getInitialSourceRepeat();
    const repeatOffset = getInitialSourceRepeatOffset();

    try {
      this.isInitialUrlLoading = true;
      this.updateUiState();
      const url = new URL(sourceUrl);
      await this.loadRemoteSource(url, { repeat, repeatOffset });
    } catch (error) {
      this.handleLayerLoadError(sourceUrl, error);
    } finally {
      this.isInitialUrlLoading = false;
      this.updateUiState();
    }
  }

  async loadRemoteSource(url, { repeat = 1, repeatOffset = {} } = {}) {
    this.showLoadingModal({
      title: "Loading remote file",
      stage: "Downloading",
      fileName: url.href,
      indeterminate: true,
    });

    try {
      const file = await fetchRemoteFile(url, {
        onProgress: () => {
          this.updateLoadingModal({
            stage: "Downloading",
            fileName: url.href,
            current: 0,
            total: 0,
            indeterminate: true,
          });
        },
      });
      const layerSources = repeatLayerSources(
        await this.collectLayerSources([file]),
        repeat,
        { offset: repeatOffset },
      );
      if (layerSources.length === 0) {
        this.updateUiState();
        return;
      }

      const results = await this.loadLayerSources(layerSources, {
        title: "Loading remote file",
      });
      const loadedCount = results.filter(Boolean).length;

      if (loadedCount > 0) {
        this.renderLayerList();
        this.requestRender();
        this.fitView();
        this.addDiagnostic("info", "Remote file loaded", `${loadedCount} processed`);
      }
    } finally {
      this.hideLoadingModal();
    }
  }

  async handleFileUpload(files) {
    if (this.isRendererBusy()) {
      this.fileInput.value = "";
      return;
    }

    const oversizedFiles = [];
    const validFiles = [];

    this.setWorkspaceStatus("Loading files");

    // Validate file sizes
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        oversizedFiles.push({
          name: file.name,
          size: formatFileSize(file.size),
          limit: formatFileSize(MAX_FILE_SIZE_BYTES),
        });
      } else {
        validFiles.push(file);
      }
    }

    // Show warning for oversized files
    if (oversizedFiles.length > 0) {
      this.showFileSizeWarning(oversizedFiles);
    }

    if (validFiles.length > 0) {
      this.showLoadingModal({
        title: "Loading files",
        stage: "Preparing",
        current: 0,
        total: validFiles.length,
      });

      try {
        const layerSources = await this.collectLayerSources(validFiles);

        if (layerSources.length > 0) {
          const results = await this.loadLayerSources(layerSources, {
            title: "Loading files",
          });
          const loadedCount = results.filter(Boolean).length;

          if (loadedCount > 0) {
            this.renderLayerList();
            this.requestRender();
            this.fitView();
            this.addDiagnostic("info", "Files loaded", `${loadedCount} processed`);
          }
        }
      } finally {
        this.hideLoadingModal();
      }
    }

    this.updateUiState();

    // Clear file input
    this.fileInput.value = "";
  }

  async loadLayerSources(layerSources, { title = "Loading files" } = {}) {
    const total = layerSources.length;
    if (layerSources.some(isDrillSource)) {
      return this.loadLayerSourcesSerially(layerSources, { title, total });
    }

    const parseWorkerPool = this.createParseWorkerPool(total);

    if (!parseWorkerPool) {
      return this.loadLayerSourcesSerially(layerSources, { title, total });
    }

    const concurrency = parseWorkerPool.size;
    const progress = this.createLayerLoadProgress(total);
    const parseTasks = this.createLayerParseTasks(layerSources);
    this.showLoadingModal({
      title,
      stage: "Reading",
      current: 0,
      total,
    });

    try {
      return await this.runLayerParsePipeline(layerSources, {
        title,
        total,
        concurrency,
        progress,
        parseWorkerPool,
        parseTasks,
      });
    } catch (error) {
      if (!isParseWorkerUnavailableError(error)) {
        throw error;
      }

      parseWorkerPool.dispose();
      this.addDiagnostic(
        "warning",
        "Parallel parsing unavailable",
        `${getErrorMessage(error)} Falling back to serial parsing.`,
      );
      return this.loadLayerSourcesSerially(layerSources, { title, total });
    } finally {
      parseWorkerPool?.dispose();
    }
  }

  async loadLayerSourcesSerially(
    layerSources,
    { title = "Loading files", total = layerSources.length } = {},
  ) {
    const results = [];

    for (const [index, source] of layerSources.entries()) {
      results.push(
        await this.loadLayerSourceSerially(source, {
          index,
          total,
          title,
        }),
      );
    }

    return results;
  }

  async collectLayerSources(files) {
    return collectLayerSources(files, {
      onArchiveWarning: (name, message) =>
        this.addDiagnostic("warning", name, message),
      onArchiveInfo: (name, message) => this.addDiagnostic("info", name, message),
      onArchiveError: (name, error) => this.handleLayerLoadError(name, error),
      onArchiveStart: (name) => {
        this.updateLoadingModal({
          stage: "Reading archive",
          fileName: name,
          indeterminate: true,
        });
      },
      onFileStart: (name, current, total) => {
        this.updateLoadingModal({
          stage: "Preparing",
          fileName: name,
          current: Math.max(0, current - 1),
          total,
        });
      },
    });
  }

  runLayerParsePipeline(
    layerSources,
    {
      title,
      total,
      concurrency,
      progress,
      parseWorkerPool,
      parseTasks,
    },
  ) {
    const results = Array(total).fill(false);
    const layerRecords = Array(total).fill(null);
    const previousPendingLayerRecords = this.pendingLayerRecordsForRecovery;
    this.pendingLayerRecordsForRecovery = layerRecords;
    let activeTasks = 0;
    let scheduledTasks = 0;
    let completedTasks = 0;
    let activeMemoryBytes = 0;
    let isResolved = false;

    return new Promise((resolve, reject) => {
      const restorePendingLayerRecords = () => {
        if (this.pendingLayerRecordsForRecovery === layerRecords) {
          this.pendingLayerRecordsForRecovery = previousPendingLayerRecords;
        }
      };

      const discardLayerRecord = (layerRecord) => {
        if (!layerRecord || typeof this.wasmProcessor?.remove_layer !== "function") {
          return;
        }

        try {
          this.removeWasmLayerRecord(layerRecord);
        } catch (error) {
          console.warn(
            `[Layer] Failed to discard pending layer ${layerRecord.name}:`,
            error,
          );
        }
      };

      const discardPendingLayerRecords = () => {
        for (let index = 0; index < layerRecords.length; index++) {
          discardLayerRecord(layerRecords[index]);
          layerRecords[index] = null;
        }
      };

      const abortWithWorkerFallback = (error) => {
        if (isResolved) {
          return;
        }

        isResolved = true;
        discardPendingLayerRecords();
        restorePendingLayerRecords();
        reject(error);
      };

      const finishIfDone = () => {
        if (isResolved || completedTasks < total) {
          return;
        }

        isResolved = true;
        let didCommitLayer = false;
        for (let index = 0; index < layerRecords.length; index++) {
          const layerRecord = layerRecords[index];
          if (layerRecord) {
            this.prepareLayerMetadata(layerRecord);
            this.commitLayerMetadata(layerRecord, { updateUiState: false });
            layerRecords[index] = null;
            didCommitLayer = true;
          }
        }
        restorePendingLayerRecords();
        if (didCommitLayer) {
          this.updateUiState();
        }
        resolve(results);
      };

      const launchMore = () => {
        while (activeTasks < concurrency && scheduledTasks < total) {
          const task = this.pickNextLayerParseTask(parseTasks, {
            activeTasks,
            activeMemoryBytes,
          });
          if (!task) break;

          task.scheduled = true;
          scheduledTasks++;
          const { index, source, estimatedMemoryBytes } = task;
          activeTasks++;
          activeMemoryBytes += estimatedMemoryBytes;

          this.readAndParseLayerSource(source, {
            index,
            total,
            title,
            progress,
            parseWorkerPool,
          })
            .then(async (parseResult) => {
              const layerRecord = await this.addParsedLayerSource(parseResult, {
                title,
                total,
                progress,
              });
              if (isResolved) {
                discardLayerRecord(layerRecord);
                return;
              }
              if (layerRecord) {
                layerRecords[index] = layerRecord;
                results[index] = true;
              }
            })
            .catch((error) => {
              if (isParseWorkerUnavailableError(error)) {
                abortWithWorkerFallback(error);
                return;
              }
              if (isResolved) {
                return;
              }
              const completed = this.markLayerLoadComplete(progress);
              this.handleLayerLoadError(source.name, error);
              this.updateLoadingModal({
                title,
                stage: "Skipped",
                fileName: source.name,
                current: completed,
                total,
              });
            })
            .finally(() => {
              activeTasks--;
              completedTasks++;
              activeMemoryBytes = Math.max(
                0,
                activeMemoryBytes - estimatedMemoryBytes,
              );
              if (isResolved) {
                return;
              }
              launchMore();
              finishIfDone();
            });
        }

        finishIfDone();
      };

      launchMore();
    });
  }

  createLayerParseTasks(layerSources) {
    return layerSources.map((source, index) => ({
      source,
      index,
      estimatedMemoryBytes: estimateLayerParseMemoryBytes(source),
      scheduled: false,
    }));
  }

  pickNextLayerParseTask(
    parseTasks,
    { activeTasks, activeMemoryBytes },
  ) {
    const candidates = parseTasks.filter((task) => !task.scheduled);
    if (candidates.length === 0) {
      return null;
    }

    const budgetBytes = getParseMemoryBudgetBytes();
    const availableBytes = budgetBytes - activeMemoryBytes;
    const fittingCandidates = candidates.filter(
      (task) => task.estimatedMemoryBytes <= availableBytes,
    );

    if (fittingCandidates.length > 0) {
      return fittingCandidates.sort(
        (a, b) => b.estimatedMemoryBytes - a.estimatedMemoryBytes,
      )[0];
    }

    if (activeTasks > 0) {
      return null;
    }

    return candidates.sort(
      (a, b) => a.estimatedMemoryBytes - b.estimatedMemoryBytes,
    )[0];
  }

  createLayerLoadProgress(total) {
    return {
      total,
      completedLayers: 0,
    };
  }

  markLayerLoadComplete(progress) {
    if (!progress) {
      return 0;
    }

    progress.completedLayers = Math.min(
      progress.total,
      (progress.completedLayers ?? 0) + 1,
    );
    return progress.completedLayers;
  }

  createParseWorkerPool(layerCount) {
    const workerCount = getParseWorkerCount(layerCount);
    if (workerCount === 0) {
      return null;
    }

    try {
      return new GerberParseWorkerPool(workerCount);
    } catch (error) {
      console.warn("[Parse] Failed to create parse workers:", error);
      this.addDiagnostic(
        "warning",
        "Parallel parsing unavailable",
        getErrorMessage(error),
      );
      return null;
    }
  }

  async parseLayerContent(content, offset, parseWorkerPool) {
    const normalizedOffset = normalizeLayerOffset(offset);
    const parseOptions = this.getParseOptions();

    if (parseWorkerPool) {
      return parseWorkerPool.parse(content, normalizedOffset, parseOptions);
    }

    const parseWithOptions = this.wasmModule?.parse_gerber_layer_with_options;
    if (typeof parseWithOptions === "function") {
      if (
        parseWithOptions.length < 5 &&
        !parseOptions.preserveArcRegions &&
        parseOptions.arcTessellationQuality !== 1
      ) {
        throw new Error("Arc tessellation quality requires an updated WASM module");
      }
      this.reserveWasmInputCapacity(content);
      return parseWithOptions(
        content,
        normalizedOffset.x,
        normalizedOffset.y,
        parseOptions.preserveArcRegions,
        parseOptions.arcTessellationQuality,
      );
    }

    if (
      !parseOptions.preserveArcRegions ||
      typeof this.wasmModule?.parse_gerber_layer !== "function"
    ) {
      throw new Error("Parallel parsing requires an updated WASM module");
    }

    this.reserveWasmInputCapacity(content);
    return this.wasmModule.parse_gerber_layer(
      content,
      normalizedOffset.x,
      normalizedOffset.y,
    );
  }

  async readAndParseLayerSource(
    source,
    {
      index,
      total,
      title,
      progress,
      parseWorkerPool,
    },
  ) {
    const { name, readText } = source;

    try {
      this.updateLoadingModal({
        title,
        stage: "Reading",
        fileName: name,
        current: progress.completedLayers,
        total,
      });

      const content = await readText(() => {
        this.updateLoadingModal({
          stage: "Reading",
          fileName: name,
          current: progress.completedLayers,
          total,
        });
      });
      this.updateLoadingModal({
        stage: "Reading",
        fileName: name,
        current: progress.completedLayers,
        total,
      });

      this.updateLoadingModal({
        stage: "Parsing",
        fileName: name,
        current: progress.completedLayers,
        total,
      });
      const parsedLayer = await this.parseLayerContent(
        content,
        source.offset,
        parseWorkerPool,
      );
      this.updateLoadingModal({
        stage: "Parsing",
        fileName: name,
        current: progress.completedLayers,
        total,
      });

      return {
        ok: true,
        index,
        name,
        parsedLayer,
        sourceContent: content,
        offset: source.offset,
      };
    } catch (error) {
      if (isParseWorkerUnavailableError(error)) {
        throw error;
      }
      this.handleLayerLoadError(name, error);
      this.updateLoadingModal({
        stage: "Skipped",
        fileName: name,
        current: progress.completedLayers,
        total,
      });
      return {
        ok: false,
        index,
        name,
      };
    }
  }

  async loadLayerSourceSerially(
    source,
    { index = 0, total = 1, title = "Loading files" } = {},
  ) {
    const { name, readText } = source;

    try {
      this.updateLoadingModal({
        title,
        stage: "Reading",
        fileName: name,
        current: index,
        total,
      });

      const content = await readText(() => {
        this.updateLoadingModal({
          stage: "Reading",
          fileName: name,
          current: index,
          total,
        });
      });

      this.updateLoadingModal({
        stage: "Parsing",
        fileName: name,
        current: index,
        total,
      });

      if (isDrillSource(source)) {
        await this.addDrillLayer(name, content, { offset: source.offset });
      } else {
        await this.addLayer(name, content, { offset: source.offset });
      }
      this.updateLoadingModal({
        stage: "Loaded",
        fileName: name,
        current: index + 1,
        total,
      });
      return true;
    } catch (error) {
      this.handleLayerLoadError(name, error);
      this.updateLoadingModal({
        stage: "Skipped",
        fileName: name,
        current: index + 1,
        total,
      });
      return false;
    }
  }

  async addParsedLayerSource(
    parseResult,
    {
      title = "Loading files",
      total = 1,
      progress = null,
    } = {},
  ) {
    const index = parseResult.index ?? 0;
    const name = parseResult.name;

    if (!parseResult.ok) {
      const completed = this.markLayerLoadComplete(progress);
      this.updateLoadingModal({
        title,
        stage: "Skipped",
        fileName: name,
        current: completed,
        total,
      });
      return null;
    }

    try {
      this.updateLoadingModal({
        title,
        stage: "Rendering",
        fileName: name,
        current: progress?.completedLayers ?? index,
        total,
      });

      const layerRecord = await this.createParsedLayerRecord(
        name,
        parseResult.parsedLayer,
        {
          offset: parseResult.offset,
          sourceContent: parseResult.sourceContent,
        },
      );
      const completed = this.markLayerLoadComplete(progress);
      this.updateLoadingModal({
        stage: "Loaded",
        fileName: name,
        current: completed,
        total,
      });
      return layerRecord;
    } catch (error) {
      const completed = this.markLayerLoadComplete(progress);
      this.handleLayerLoadError(name, error);
      this.updateLoadingModal({
        stage: "Skipped",
        fileName: name,
        current: completed,
        total,
      });
      return null;
    } finally {
      parseResult.parsedLayer = null;
      parseResult.sourceContent = null;
    }
  }

  handleLayerLoadError(name, error) {
    const message = getErrorMessage(error);
    if (isNoGeometryError(message)) {
      console.warn(`Skipped file ${name}:`, error);
      this.addDiagnostic("warning", name, message);
      return;
    }

    console.error(`Failed to load file ${name}:`, error);
    this.addDiagnostic("error", name, message);
    this.showError(`Failed to load file ${name}: ${message}`);
  }

  reserveWasmInputCapacity(content) {
    if (typeof this.wasmModule?.reserve_input_capacity !== "function") {
      return;
    }

    const byteLength = getUtf8ByteLength(content);
    const reserveBytes = byteLength + WASM_INPUT_RESERVE_MARGIN_BYTES;

    try {
      this.wasmModule.reserve_input_capacity(reserveBytes);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  }

  createLayerRecoverySnapshot(layer) {
    const snapshot = {
      id: layer.id,
      kind: layer.kind ?? GERBER_LAYER_KIND,
      name: layer.name,
      visible: layer.visible,
      color: layer.color ? [...layer.color] : null,
      sourceContent: layer.sourceContent,
      offset: { ...normalizeLayerOffset(layer.offset) },
    };
    if (isDrillLayer(layer)) {
      snapshot.drillMetadata = layer.drillMetadata;
    }
    return snapshot;
  }

  async restoreLayerFromSnapshot(layer) {
    const options = {
      id: layer.id,
      visible: layer.visible,
      color: layer.color,
      sourceContent: layer.sourceContent,
      offset: layer.offset,
      skipFatalRecovery: true,
    };

    if (layer.kind === DRILL_LAYER_KIND) {
      await this.addDrillLayer(layer.name, layer.sourceContent, options);
    } else {
      await this.addLayer(layer.name, layer.sourceContent, options);
    }
  }

  preparePendingLayerRecordsForRecovery() {
    for (const layer of this.pendingLayerRecordsForRecovery ?? []) {
      if (layer && typeof layer.sourceContent === "string") {
        this.prepareLayerMetadata(layer);
      }
    }
  }

  snapshotLayersForRecovery() {
    this.preparePendingLayerRecordsForRecovery();
    const committedSnapshots = this.layers.map((layer) =>
      this.createLayerRecoverySnapshot(layer),
    );
    const committedIds = new Set(this.layers.map((layer) => layer.id));
    const pendingSnapshots = (this.pendingLayerRecordsForRecovery ?? [])
      .filter(
        (layer) =>
          layer &&
          !committedIds.has(layer.id) &&
          typeof layer.sourceContent === "string",
      )
      .map((layer) => this.createLayerRecoverySnapshot(layer));

    return [...committedSnapshots, ...pendingSnapshots];
  }

  collectPendingLayerRecoveryIds() {
    this.preparePendingLayerRecordsForRecovery();
    return new Set(
      (this.pendingLayerRecordsForRecovery ?? [])
        .filter((layer) => layer && typeof layer.sourceContent === "string")
        .map((layer) => layer.id),
    );
  }

  clearRecoveredPendingLayerRecords(recoveredLayerIds) {
    if (!this.pendingLayerRecordsForRecovery || recoveredLayerIds.size === 0) {
      return;
    }

    for (
      let index = 0;
      index < this.pendingLayerRecordsForRecovery.length;
      index++
    ) {
      const layer = this.pendingLayerRecordsForRecovery[index];
      if (layer && recoveredLayerIds.has(layer.id)) {
        this.pendingLayerRecordsForRecovery[index] = null;
      }
    }
  }

  disposeWasmProcessor() {
    if (!this.wasmProcessor) return;

    const processor = this.wasmProcessor;
    this.wasmProcessor = null;
    this.disposeWasmProcessorInstance(processor, "processor");
  }

  disposeWasmProcessorInstance(processor, label = "processor") {
    if (!processor) return;
    if (typeof processor.free === "function") {
      try {
        processor.free();
      } catch (error) {
        console.warn(`[WASM] Failed to dispose ${label}:`, error);
      }
    }
  }

  async waitForWasmProcessorRecovery() {
    if (this.isRecoveringWasmProcessor && this.wasmRecoveryPromise) {
      await this.wasmRecoveryPromise;
    }
  }

  async recoverWasmProcessorAfterFatalError(failedLayerName, error) {
    if (this.isRecoveringWasmProcessor) {
      await this.waitForWasmProcessorRecovery();
      return;
    }
    if (this.isWebGlContextLost) {
      return;
    }

    const recoveredPendingLayerIds = this.collectPendingLayerRecoveryIds();
    const layerSnapshot = this.snapshotLayersForRecovery();
    if (layerSnapshot.length === 0) {
      this.disposeWasmProcessor();
      this.createWebGlProcessor();
      this.clearRecoveredPendingLayerRecords(recoveredPendingLayerIds);
      return;
    }

    const viewState = this.captureCanvasViewState();
    const nextLayerDomId = this.nextLayerDomId;
    const nextColorIndex = this.nextColorIndex;
    let finishRecovery = null;

    this.wasmRecoveryPromise = new Promise((resolve) => {
      finishRecovery = resolve;
    });
    this.isRecoveringWasmProcessor = true;
    this.addDiagnostic(
      "warning",
      "Renderer recovered",
      `Rebuilding layers after ${failedLayerName} caused a fatal WebAssembly error: ${getErrorMessage(error)}`,
    );

    try {
      this.disposeWasmProcessor();
      this.layers = [];
      this.createWebGlProcessor();
      this.resizeCanvas({ allowProcessorResize: true, preserveViewState: viewState });

      for (const layer of layerSnapshot) {
        try {
          await this.restoreLayerFromSnapshot(layer);
        } catch (restoreError) {
          const message = getErrorMessage(restoreError);
          console.error(`[WASM] Failed to restore layer ${layer.name}:`, restoreError);
          this.addDiagnostic("error", `Restore failed: ${layer.name}`, message);
          if (isFatalWasmRuntimeError(restoreError)) {
            break;
          }
        }
      }

      this.nextLayerDomId = nextLayerDomId;
      this.nextColorIndex = nextColorIndex;
      this.restoreCanvasViewState(viewState);
      this.renderLayerList();
      this.requestRender();
    } finally {
      this.clearRecoveredPendingLayerRecords(recoveredPendingLayerIds);
      this.isRecoveringWasmProcessor = false;
      finishRecovery?.();
      this.wasmRecoveryPromise = null;
      this.updateUiState();
    }
  }

  showFileSizeWarning(oversizedFiles) {
    this.notifications.showFileSizeWarning(oversizedFiles);
  }

  showError(message) {
    this.notifications.showError(message);
  }

  showNotification(title, variant, duration, renderMessage) {
    this.notifications.show(title, variant, renderMessage, duration);
  }

  hideNotification() {
    this.notifications.hide();
  }

  createLayerMetadata(
    name,
    layerId,
    options = {},
    processor = this.wasmProcessor,
  ) {
    if (layerId === undefined || layerId === null) {
      throw new Error("Failed to get layer ID from WASM processor");
    }
    if (!processor) {
      throw new Error("WebGL renderer is not available");
    }

    const bounds = processor.get_layer_boundary(layerId);
    return {
      id: options.id ?? null,
      layerId: layerId,
      kind: options.kind ?? GERBER_LAYER_KIND,
      name: name,
      visible: options.visible ?? true,
      color: options.color ? [...options.color] : null,
      sourceContent: options.sourceContent,
      offset: normalizeLayerOffset(options.offset),
      bounds: {
        minX: bounds.min_x,
        maxX: bounds.max_x,
        minY: bounds.min_y,
        maxY: bounds.max_y,
      },
    };
  }

  commitLayerMetadata(layer, { updateUiState = true } = {}) {
    this.prepareLayerMetadata(layer);
    this.layers.push(layer);
    if (updateUiState) {
      this.updateUiState();
    }
    return layer;
  }

  prepareLayerMetadata(layer) {
    if (!layer.id) {
      layer.id = `layer-${this.nextLayerDomId++}`;
    }
    if (isDrillLayer(layer)) {
      layer.color = null;
      return layer;
    }
    if (layer.color) {
      layer.color = [...layer.color];
    } else {
      layer.color = [
        ...this.colorPalette[this.nextColorIndex % this.colorPalette.length],
      ];
      this.nextColorIndex++;
    }
    return layer;
  }

  addLayerMetadata(name, layerId, options = {}) {
    const layer = this.createLayerMetadata(name, layerId, options);
    return this.commitLayerMetadata(layer);
  }

  async addLayer(name, content, options = {}) {
    try {
      if (!options.skipFatalRecovery) {
        await this.waitForWasmProcessorRecovery();
      }
      if (!this.wasmProcessor || this.isWebGlContextLost) {
        throw new Error("WebGL renderer is not available");
      }

      // add layer to WASM processor and get layer ID
      this.ensureParserOptionsSupported();
      this.reserveWasmInputCapacity(content);
      const offset = normalizeLayerOffset(options.offset);
      if (
        hasLayerOffset(offset) &&
        typeof this.wasmProcessor.add_layer_with_offset !== "function"
      ) {
        throw new Error("Layer offset requires an updated WASM module");
      }
      const layerId = hasLayerOffset(offset)
        ? this.wasmProcessor.add_layer_with_offset(content, offset.x, offset.y)
        : this.wasmProcessor.add_layer(content);
      this.addLayerMetadata(name, layerId, {
        ...options,
        sourceContent: options.sourceContent ?? content,
        offset,
      });
    } catch (error) {
      if (isNoGeometryError(getErrorMessage(error))) {
        console.warn(`[Layer] Skipped layer ${name}:`, error);
        throw error;
      }

      if (isFatalWasmRuntimeError(error) && !options.skipFatalRecovery) {
        await this.recoverWasmProcessorAfterFatalError(name, error);
      }

      console.error(`[Layer] Failed to add layer ${name}:`, error);
      throw error;
    }
  }

  async addDrillLayer(name, content, options = {}) {
    const layer = await this.createDrillLayerRecord(name, content, options);
    return this.commitLayerMetadata(layer);
  }

  async createDrillLayerRecord(
    name,
    content,
    options = {},
    processor = this.wasmProcessor,
  ) {
    try {
      if (!options.skipFatalRecovery) {
        await this.waitForWasmProcessorRecovery();
      }
      if (!processor || this.isWebGlContextLost) {
        throw new Error("WebGL renderer is not available");
      }
      if (typeof processor.add_drill_layer !== "function") {
        throw new Error("Drill rendering requires an updated WASM module");
      }

      this.reserveWasmInputCapacity(content);
      const offset = normalizeLayerOffset(options.offset);
      let result;
      if (offset.x !== 0 || offset.y !== 0) {
        if (typeof processor.add_drill_layer_with_offset !== "function") {
          throw new Error("Drill layer offsets require an updated WASM module");
        }
        result = processor.add_drill_layer_with_offset(content, offset.x, offset.y);
      } else {
        result = processor.add_drill_layer(content);
      }
      const outlineLayerId = Number(result?.outlineLayerId);
      const fillLayerId = Number(result?.fillLayerId);
      if (!Number.isFinite(outlineLayerId) || !Number.isFinite(fillLayerId)) {
        throw new Error("Failed to get drill layer IDs from WASM processor");
      }

      const bounds = processor.get_layer_boundary(outlineLayerId);
      return {
        id: options.id ?? null,
        kind: DRILL_LAYER_KIND,
        name,
        visible: options.visible ?? true,
        color: null,
        layerId: outlineLayerId,
        outlineLayerId,
        fillLayerId,
        drillMetadata: normalizeDrillMetadata(result?.metadata),
        sourceContent: options.sourceContent ?? content,
        offset,
        bounds: {
          minX: bounds.min_x,
          maxX: bounds.max_x,
          minY: bounds.min_y,
          maxY: bounds.max_y,
        },
      };
    } catch (error) {
      if (isFatalWasmRuntimeError(error) && !options.skipFatalRecovery) {
        await this.recoverWasmProcessorAfterFatalError(name, error);
      }

      console.error(`[Layer] Failed to add drill layer ${name}:`, error);
      throw error;
    }
  }

  async addParsedLayer(name, parsedLayer, options = {}) {
    if (typeof options.sourceContent !== "string") {
      throw new Error(
        "addParsedLayer requires options.sourceContent for renderer recovery",
      );
    }

    const layer = await this.createParsedLayerRecord(name, parsedLayer, options);
    return this.commitLayerMetadata(layer);
  }

  async createParsedLayerRecord(
    name,
    parsedLayer,
    options = {},
    processor = this.wasmProcessor,
  ) {
    try {
      if (!options.skipFatalRecovery) {
        await this.waitForWasmProcessorRecovery();
      }
      if (!processor || this.isWebGlContextLost) {
        throw new Error("WebGL renderer is not available");
      }

      let layerId;
      if (typeof processor.add_render_payload === "function") {
        layerId = processor.add_render_payload(parsedLayer);
      } else if (typeof processor.add_parsed_layer === "function") {
        layerId = processor.add_parsed_layer(parsedLayer);
      } else {
        throw new Error("Parsed layer rendering requires an updated WASM module");
      }
      return this.createLayerMetadata(name, layerId, options, processor);
    } catch (error) {
      if (isNoGeometryError(getErrorMessage(error))) {
        console.warn(`[Layer] Skipped layer ${name}:`, error);
        throw error;
      }

      if (isFatalWasmRuntimeError(error) && !options.skipFatalRecovery) {
        await this.recoverWasmProcessorAfterFatalError(name, error);
      }

      console.error(`[Layer] Failed to add parsed layer ${name}:`, error);
      throw error;
    }
  }

  requestRender() {
    if (this.pendingRenderFrame !== null) {
      return;
    }

    this.pendingRenderFrame = requestAnimationFrame(() => {
      this.pendingRenderFrame = null;
      this.render();
    });
  }

  render() {
    if (
      !this.wasmProcessor ||
      this.isWebGlContextLost ||
      this.isRestoringWebGlContext
    ) {
      this.renderMeasurements();
      return;
    }

    try {
      const { activeLayerIds, colorData, blendModes } = this.getRenderLayerPayload();

      // Render with active layers
      if (blendModes.some((mode) => mode !== 0)) {
        if (typeof this.wasmProcessor.render_with_clear_and_blend_modes !== "function") {
          throw new Error("Drill fill rendering requires an updated WASM module");
        }
        this.wasmProcessor.render_with_clear_and_blend_modes(
          activeLayerIds,
          colorData,
          blendModes,
          this.getViewScaleX(),
          this.getViewScaleY(),
          this.camera.offsetX,
          this.camera.offsetY,
          this.globalAlpha,
          true,
        );
      } else {
        this.wasmProcessor.render(
          activeLayerIds,
          colorData,
          this.getViewScaleX(),
          this.getViewScaleY(),
          this.camera.offsetX,
          this.camera.offsetY,
          this.globalAlpha,
        );
      }
      this.zoomReadout.textContent = this.formatZoom();
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Render] Failed to render:", error);
      this.addDiagnostic("error", "Render failed", message);
    }

    this.renderMeasurements();
  }

  getRenderLayerPayload() {
    const selectedLayerIds = this.getSelectedLayerIds();
    const activeLayerIds = [];
    const colorData = [];
    const blendModes = [];
    const backgroundColor = this.isCanvasLight
      ? [248 / 255, 250 / 255, 252 / 255]
      : [2 / 255, 6 / 255, 23 / 255];
    const outlineColor = backgroundColor.map((value) => 1 - value);
    const drillAlpha = this.globalAlpha > 0 ? 1 / this.globalAlpha : 0;

    this.layers.forEach((layer) => {
      if (!isDrillLayer(layer) && selectedLayerIds.has(layer.id)) {
        activeLayerIds.push(layer.layerId);
        colorData.push(layer.color[0], layer.color[1], layer.color[2], 1);
        blendModes.push(0);
      }
    });

    this.layers.forEach((layer) => {
      if (isDrillLayer(layer) && layer.visible) {
        activeLayerIds.push(layer.outlineLayerId);
        colorData.push(outlineColor[0], outlineColor[1], outlineColor[2], drillAlpha);
        blendModes.push(0);
      }
    });

    this.layers.forEach((layer) => {
      if (isDrillLayer(layer) && layer.visible) {
        activeLayerIds.push(layer.fillLayerId);
        colorData.push(
          backgroundColor[0],
          backgroundColor[1],
          backgroundColor[2],
          drillAlpha,
        );
        blendModes.push(1);
      }
    });

    return {
      activeLayerIds: new Uint32Array(activeLayerIds),
      colorData: new Float32Array(colorData),
      blendModes: new Uint8Array(blendModes),
    };
  }

  renderMeasurements() {
    renderMeasurementOverlay({
      overlay: this.measurementOverlay,
      rect: this.canvas.getBoundingClientRect(),
      measurements: this.measurements,
      rulerStartPoint: this.rulerStartPoint,
      rulerHoverPoint: this.rulerHoverPoint,
      worldToCanvasPoint: (point) => this.worldToCanvasPoint(point),
      unit: this.measurementUnit,
    });
  }

  getSelectedLayerIds() {
    const selectedIds = new Set();
    this.layers.forEach((layer) => {
      if (layer.visible) {
        selectedIds.add(layer.id);
      }
    });
    return selectedIds;
  }

  fitView() {
    const fitView = this.calculateFitView();
    if (!fitView) return;

    this.camera.zoom = this.clampZoom(fitView.zoom);
    this.fitViewZoom = this.camera.zoom;
    this.camera.offsetX =
      fitView.targetX - fitView.centerX * this.getViewScaleX();
    this.camera.offsetY =
      fitView.targetY - fitView.centerY * this.getViewScaleY();

    this.requestRender();
    this.updateUiState();
  }

  getFitViewZoom() {
    const fitView = this.calculateFitView();
    if (!fitView) return null;
    return this.clampZoom(fitView.zoom);
  }

  calculateFitView() {
    return calculateViewportFit({
      layers: this.layers,
      selectedLayerIds: this.getSelectedLayerIds(),
      canvas: this.canvas,
      drawer: this.drawer,
      isMobileLayout: () => this.drawerController.isMobileLayout(),
    });
  }

  getVisibleCanvasViewport() {
    return getVisibleCanvasViewport({
      canvas: this.canvas,
      drawer: this.drawer,
      isMobileLayout: () => this.drawerController.isMobileLayout(),
    });
  }

  canvasLocalPointToCorrected(x, y, rect) {
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const ndcX = ((x - centerX) / rect.width) * 2;
    const ndcY = -((y - centerY) / rect.height) * 2;
    const aspect = this.canvas.width / this.canvas.height;

    return {
      x: aspect > 1.0 ? ndcX * aspect : ndcX,
      y: aspect > 1.0 ? ndcY : ndcY / aspect,
    };
  }

  handleWheel(e) {
    e.preventDefault();

    const zoomChange = Math.exp(-e.deltaY * this.getWheelZoomSensitivity(e));
    this.zoomAtCanvasPoint(e.clientX, e.clientY, zoomChange);
  }

  getWheelZoomSensitivity(e) {
    const baseSensitivity = 0.001;
    const trackpadSensitivity = 0.007;
    const isPixelMode = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
    const absDeltaY = Math.abs(e.deltaY);
    const absDeltaX = Math.abs(e.deltaX);
    const hasFineDelta = absDeltaY > 0 && absDeltaY < 50;
    const hasFineHorizontalDelta = absDeltaX > 0 && absDeltaX < 50;

    return isPixelMode && (hasFineDelta || hasFineHorizontalDelta)
      ? trackpadSensitivity
      : baseSensitivity;
  }

  clampZoom(zoom) {
    return clampViewportZoom(zoom, this.camera.zoom, this.minZoom, this.maxZoom);
  }

  zoomAtCanvasPoint(clientX, clientY, zoomChange) {
    const didZoom = zoomCameraAtCanvasPoint({
      clientX,
      clientY,
      zoomChange,
      canvas: this.canvas,
      camera: this.camera,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
    });
    if (didZoom) {
      this.requestRender();
    }
  }

  handleMouseDown(e) {
    if (this.isRulerActive) {
      if (e.button !== 0) return;
      e.preventDefault();
      this.handleRulerCanvasClick(e.clientX, e.clientY);
      return;
    }

    if (e.button === 2) return; // Ignore right-click
    this.isPanning = true;
    this.lastMousePos.x = e.clientX;
    this.lastMousePos.y = e.clientY;
  }

  handleMouseMove(e) {
    this.updateCursorReadout(e.clientX, e.clientY);

    if (this.isRulerActive) {
      if (this.rulerStartPoint) {
        this.rulerHoverPoint = this.canvasPointToWorld(e.clientX, e.clientY);
        this.renderMeasurements();
      }
      return;
    }

    if (!this.isPanning) return;

    const deltaX = e.clientX - this.lastMousePos.x;
    const deltaY = e.clientY - this.lastMousePos.y;

    // Visual feedback during drag
    const transform = `translate(${deltaX}px, ${deltaY}px)`;
    this.canvas.style.transform = transform;
    this.measurementOverlay.style.transform = transform;
  }

  updateCursorReadout(clientX, clientY) {
    const worldPoint = this.canvasPointToWorld(clientX, clientY);
    if (!worldPoint) return;

    this.cursorReadout.textContent = `${worldPoint.x.toFixed(3)}, ${worldPoint.y.toFixed(3)}`;
  }

  handleRulerCanvasClick(clientX, clientY) {
    const point = this.canvasPointToWorld(clientX, clientY);
    if (!point) {
      return;
    }

    if (!this.rulerStartPoint) {
      this.rulerStartPoint = point;
      this.rulerHoverPoint = null;
    } else {
      this.measurements.push({
        start: this.rulerStartPoint,
        end: point,
      });
      this.rulerStartPoint = null;
      this.rulerHoverPoint = null;
      this.isRulerActive = false;
    }

    this.renderMeasurements();
    this.updateRulerControls();
  }

  canvasPointToWorld(clientX, clientY) {
    return canvasPointToWorldCoordinate({
      clientX,
      clientY,
      canvas: this.canvas,
      camera: this.camera,
    });
  }

  worldToCanvasPoint(point, renderState = null) {
    return worldToCanvasCoordinate({
      point,
      canvas: this.canvas,
      camera: this.camera,
      renderState,
    });
  }

  handleMouseUp(e) {
    if (!this.isPanning) return;

    this.isPanning = false;

    // Reset transform
    this.canvas.style.transform = "";
    this.measurementOverlay.style.transform = "";

    const canvasRect = this.canvas.getBoundingClientRect();
    if (canvasRect.width === 0 || canvasRect.height === 0) {
      return;
    }

    const deltaX = e.clientX - this.lastMousePos.x;
    const deltaY = e.clientY - this.lastMousePos.y;
    panCameraByScreenDelta({
      deltaX,
      deltaY,
      canvas: this.canvas,
      camera: this.camera,
    });

    this.requestRender();
  }

  // Touch event handlers
  handleTouchStart(e) {
    e.preventDefault();

    this.isTouching = true;
    this.touches = Array.from(e.touches);

    if (this.isRulerActive) {
      if (this.touches.length === 1) {
        this.startRulerTouch(this.touches[0]);
        return;
      }

      this.resetRulerTouch();
    }

    if (this.touches.length === 2) {
      // Two-finger gesture: pinch-to-zoom
      this.initialPinchDistance = this.calculateTouchDistance(
        this.touches[0],
        this.touches[1],
      );
      this.lastPinchDistance = this.initialPinchDistance;

      const center = this.getTouchCenter(this.touches[0], this.touches[1]);
      this.lastTouchCenter = center;
    } else if (this.touches.length === 1) {
      // Single finger: pan
      this.lastTouchCenter = {
        x: this.touches[0].clientX,
        y: this.touches[0].clientY,
      };
    }
  }

  handleTouchMove(e) {
    e.preventDefault();

    if (!this.isTouching) return;

    this.touches = Array.from(e.touches);

    if (this.activeRulerTouchIdentifier !== null) {
      const touch = this.findTouchByIdentifier(
        this.touches,
        this.activeRulerTouchIdentifier,
      );

      if (!this.isRulerActive || this.touches.length !== 1 || !touch) {
        this.resetRulerTouch();
        return;
      }

      this.updateRulerTouch(touch);
      return;
    }

    if (this.touches.length === 2) {
      // Two-finger gesture: pinch-to-zoom + pan
      const currentDistance = this.calculateTouchDistance(
        this.touches[0],
        this.touches[1],
      );
      const currentCenter = this.getTouchCenter(
        this.touches[0],
        this.touches[1],
      );

      // Handle pinch zoom
      if (this.lastPinchDistance !== null) {
        const zoomChange = currentDistance / this.lastPinchDistance;
        this.zoomAtCanvasPoint(currentCenter.x, currentCenter.y, zoomChange);

        this.lastPinchDistance = currentDistance;
      }

      // Handle pan
      const deltaX = currentCenter.x - this.lastTouchCenter.x;
      const deltaY = currentCenter.y - this.lastTouchCenter.y;
      panCameraByScreenDelta({
        deltaX,
        deltaY,
        canvas: this.canvas,
        camera: this.camera,
      });

      this.lastTouchCenter = currentCenter;
      this.requestRender();
    } else if (this.touches.length === 1) {
      if (this.isRulerActive) {
        return;
      }

      // Single finger: pan
      const currentPos = {
        x: this.touches[0].clientX,
        y: this.touches[0].clientY,
      };

      const deltaX = currentPos.x - this.lastTouchCenter.x;
      const deltaY = currentPos.y - this.lastTouchCenter.y;
      panCameraByScreenDelta({
        deltaX,
        deltaY,
        canvas: this.canvas,
        camera: this.camera,
      });

      this.lastTouchCenter = currentPos;
      this.requestRender();
    }
  }

  handleTouchEnd(e) {
    e.preventDefault();

    this.touches = Array.from(e.touches);

    if (this.activeRulerTouchIdentifier !== null) {
      const activeTouch = this.findTouchByIdentifier(
        this.touches,
        this.activeRulerTouchIdentifier,
      );

      if (!activeTouch) {
        if (e.type === "touchend") {
          this.commitRulerTouch();
        } else {
          this.resetRulerTouch();
        }
      }

      if (this.touches.length === 0) {
        this.isTouching = false;
      }

      return;
    }

    if (this.touches.length < 2) {
      // Reset pinch state
      this.initialPinchDistance = null;
      this.lastPinchDistance = null;
    }

    if (this.touches.length === 0) {
      // All touches ended
      this.isTouching = false;
    } else if (this.touches.length === 1) {
      // Transitioned from multi-touch to single touch
      this.lastTouchCenter = {
        x: this.touches[0].clientX,
        y: this.touches[0].clientY,
      };
    }
  }

  startRulerTouch(touch) {
    const point = {
      x: touch.clientX,
      y: touch.clientY,
    };

    this.activeRulerTouchIdentifier = touch.identifier;
    this.rulerTouchStartPoint = point;
    this.rulerTouchPoint = point;
    this.updateCursorReadout(point.x, point.y);
    this.updateRulerTouchPreview(point.x, point.y);
  }

  updateRulerTouch(touch) {
    const point = {
      x: touch.clientX,
      y: touch.clientY,
    };

    this.rulerTouchPoint = point;
    this.updateCursorReadout(point.x, point.y);
    this.updateRulerTouchPreview(point.x, point.y);
  }

  updateRulerTouchPreview(clientX, clientY) {
    if (!this.rulerStartPoint) return;

    this.rulerHoverPoint = this.canvasPointToWorld(clientX, clientY);
    this.renderMeasurements();
  }

  commitRulerTouch() {
    const touchPoint = this.rulerStartPoint
      ? this.rulerTouchPoint
      : this.rulerTouchStartPoint;

    this.resetRulerTouch();

    if (!touchPoint) return;

    this.handleRulerCanvasClick(touchPoint.x, touchPoint.y);
  }

  resetRulerTouch() {
    this.activeRulerTouchIdentifier = null;
    this.rulerTouchStartPoint = null;
    this.rulerTouchPoint = null;
  }

  findTouchByIdentifier(touches, identifier) {
    return touches.find((touch) => touch.identifier === identifier) ?? null;
  }

  calculateTouchDistance(touch1, touch2) {
    const dx = touch2.clientX - touch1.clientX;
    const dy = touch2.clientY - touch1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getTouchCenter(touch1, touch2) {
    return {
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2,
    };
  }

  updateLayerColor(layerId, hexColor) {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer || isDrillLayer(layer)) return;

    const r = parseInt(hexColor.substr(1, 2), 16) / 255;
    const g = parseInt(hexColor.substr(3, 2), 16) / 255;
    const b = parseInt(hexColor.substr(5, 2), 16) / 255;

    layer.color = [r, g, b];
    this.requestRender();
    this.updateUiState();
  }

  updateGlobalAlpha(alpha) {
    this.globalAlpha = alpha;
    // Re-render with new alpha
    this.requestRender();
  }

  deleteLayer(layerId) {
    const index = this.layers.findIndex((l) => l.id === layerId);
    if (index !== -1) {
      const layer = this.layers[index];

      try {
        // remove from WASM processor and handle errors
        if (this.wasmProcessor) {
          this.removeWasmLayerRecord(layer);
        }

        // remove from JS array only if WASM removal succeeded
        this.layers.splice(index, 1);
        if (this.layers.length === 0) {
          this.fitViewZoom = null;
        }
      } catch (error) {
        console.error(`[Layer] Failed to remove layer ${layer.name}:`, error);
        return;
      }
    }

    this.renderLayerList();
    this.requestRender();
    this.updateUiState();
  }

  removeWasmLayerRecord(layer) {
    if (!this.wasmProcessor || !layer) return;

    const layerIds = isDrillLayer(layer)
      ? [layer.outlineLayerId, layer.fillLayerId]
      : [layer.layerId];

    for (const layerId of layerIds) {
      if (layerId !== undefined && layerId !== null) {
        this.wasmProcessor.remove_layer(layerId);
      }
    }
  }

  clearAllLayers() {
    try {
      // remove all layers from WASM processor
      if (this.wasmProcessor) {
        this.wasmProcessor.clear();
      }

      this.layers = [];
      this.nextColorIndex = 0;
      this.nextLayerDomId = 0;
      this.fitViewZoom = null;
      this.renderLayerList();
      this.requestRender();
      this.updateUiState();
    } catch (error) {
      console.error("[Layer] Failed to clear all layers:", error);
      this.addDiagnostic("error", "Clear failed", error.message);
    }
  }

  selectAllLayerCheckboxes() {
    this.layers.forEach((layer) => {
      layer.visible = true;
    });
    this.renderLayerList();
    this.requestRender();
    this.updateUiState();
  }

  selectLayersByFilter(kind) {
    this.layers.forEach((layer) => {
      if (!isDrillLayer(layer)) {
        layer.visible = this.layerFilterStore.matches(layer, kind);
      }
    });
    this.renderLayerList();
    this.requestRender();
    this.updateUiState();
  }

  unselectAllLayerCheckboxes() {
    this.layers.forEach((layer) => {
      layer.visible = false;
    });
    this.renderLayerList();
    this.requestRender();
    this.updateUiState();
  }

  handleLayerDragStart(event, layerId) {
    if (
      event.target instanceof Element &&
      event.target.closest("input, button")
    ) {
      event.preventDefault();
      return;
    }

    this.draggedLayerId = layerId;
    this.layerDropIndex = null;
    this.dropZone.classList.remove("drag-active");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", layerId);
    }
    event.currentTarget.classList.add("dragging");
  }

  handleLayerDragEnd(event) {
    event.currentTarget.classList.remove("dragging");
    this.draggedLayerId = null;
    this.layerDropIndex = null;
    this.dropZone.classList.remove("drag-active");
    this.clearLayerDropIndicator();
  }

  handleLayerListDragOver(event) {
    if (!this.draggedLayerId) return;

    const placement = this.getLayerDropPlacement(event.clientY);
    if (!placement) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    this.layerDropIndex = placement.dropIndex;
    this.clearLayerDropIndicator();
    placement.item.classList.add(
      placement.position === "after" ? "drop-after" : "drop-before",
    );
  }

  handleLayerDrop(event) {
    if (!this.draggedLayerId || this.layerDropIndex === null) return;

    event.preventDefault();
    event.stopPropagation();
    const gerberLayers = this.layers.filter((layer) => !isDrillLayer(layer));
    const drillLayers = this.layers.filter(isDrillLayer);
    const fromIndex = gerberLayers.findIndex(
      (layer) => layer.id === this.draggedLayerId,
    );
    if (fromIndex === -1) return;

    let toIndex = this.layerDropIndex;
    if (fromIndex < toIndex) {
      toIndex -= 1;
    }

    if (fromIndex !== toIndex) {
      const [layer] = gerberLayers.splice(fromIndex, 1);
      gerberLayers.splice(toIndex, 0, layer);
      this.layers = [...gerberLayers, ...drillLayers];
      this.renderLayerList();
      this.requestRender();
      this.updateUiState();
    }

    this.draggedLayerId = null;
    this.layerDropIndex = null;
    this.clearLayerDropIndicator();
  }

  getLayerDropPlacement(clientY) {
    const items = Array.from(
      this.layerList.querySelectorAll('.layer-item[draggable="true"][data-layer-id]'),
    );
    if (items.length === 0) return null;

    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const index = Number(item.dataset.layerIndex);
      if (clientY < rect.top + rect.height / 2) {
        return { item, dropIndex: index, position: "before" };
      }

      if (clientY < rect.bottom) {
        return { item, dropIndex: index + 1, position: "after" };
      }
    }

    return {
      item: items[items.length - 1],
      dropIndex: items.length,
      position: "after",
    };
  }

  clearLayerDropIndicator() {
    this.layerList
      .querySelectorAll(".drop-before, .drop-after")
      .forEach((item) => item.classList.remove("drop-before", "drop-after"));
  }

  renderLayerList() {
    renderLayerListView({
      container: this.layerList,
      layers: this.layers,
      formatBounds: (layer) => this.formatLayerBounds(layer),
      onDragStart: (event, layerId) =>
        this.handleLayerDragStart(event, layerId),
      onDragEnd: (event) => this.handleLayerDragEnd(event),
      onColorChange: (layerId, color) => this.updateLayerColor(layerId, color),
      onVisibilityChange: (layer, visible) => {
        layer.visible = visible;
        this.requestRender();
        this.updateUiState();
      },
      onToggleVisibility: (layer) => {
        layer.visible = !layer.visible;
        this.requestRender();
        this.updateUiState();
      },
      onDelete: (layerId) => this.deleteLayer(layerId),
    });
    this.refreshIcons();
  }

  formatLayerBounds(layer) {
    if (isDrillLayer(layer)) {
      return this.formatDrillLayerMeta(layer);
    }

    if (!layer.bounds) {
      return layer.visible ? "visible" : "hidden";
    }

    const width = layer.bounds.maxX - layer.bounds.minX;
    const height = layer.bounds.maxY - layer.bounds.minY;
    return formatDimensionPair(width, height, this.measurementUnit);
  }

  formatDrillLayerMeta(layer) {
    const metadata = layer.drillMetadata ?? {};
    const tools = Array.isArray(metadata.tools) ? metadata.tools : [];
    const totalHits = Number(metadata.hitCount ?? 0);
    const totalSlots = Number(metadata.slotCount ?? 0);
    const parts = tools.slice(0, 3).map((tool) => {
      const count = Number(tool.hitCount ?? 0) + Number(tool.slotCount ?? 0);
      return `${this.formatDrillDiameter(tool.diameterMm)} x ${count}`;
    });
    if (tools.length > 3) {
      parts.push(`+${tools.length - 3}`);
    }

    const countText =
      totalSlots > 0
        ? `${totalHits} hits, ${totalSlots} slots`
        : `${totalHits} hits`;
    return [countText, ...parts].join("\n");
  }

  formatDrillDiameter(diameterMm) {
    const value = Number(diameterMm);
    if (!Number.isFinite(value)) {
      return "Ø ?";
    }

    if (this.measurementUnit === "inch") {
      return `Ø ${(value / 25.4).toFixed(4)} in`;
    }

    return `Ø ${value.toFixed(3)} mm`;
  }

  triggerCanvasResize() {
    // Dispatch resize event to notify canvas needs update
    window.dispatchEvent(new Event("resize"));
  }

  // File drop handlers
  handleDragOver(e) {
    if (this.draggedLayerId) return;

    e.preventDefault();
    e.stopPropagation();
    if (this.isRendererBusy()) {
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "none";
      }
      this.dropZone.classList.remove("drag-active");
      return;
    }

    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    this.dropZone.classList.add("drag-active");
  }

  handleDragLeave(e) {
    if (this.draggedLayerId) return;

    e.preventDefault();
    e.stopPropagation();
    const isStillInside =
      e.relatedTarget instanceof Node
        ? this.dropZone.contains(e.relatedTarget)
        : this.isPointInsideElement(e.clientX, e.clientY, this.dropZone);

    if (!isStillInside) {
      this.dropZone.classList.remove("drag-active");
    }
  }

  handleDrop(e) {
    if (this.draggedLayerId) return;

    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.remove("drag-active");
    if (this.isRendererBusy()) return;

    const files = e.dataTransfer?.files;
    if (files?.length > 0) {
      this.handleFileUpload(files);
    }
  }

  isPointInsideElement(clientX, clientY, element) {
    const rect = element.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }
}
