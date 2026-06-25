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
  formatMeasurementLength,
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
const RECYCLE_PARSE_WORKER_MEMORY_BYTES = 256 * BYTES_PER_MIB;
const RECYCLE_PARSE_WORKER_GROWTH_BYTES = 128 * BYTES_PER_MIB;
const WASM_LINEAR_MEMORY_RENDER_LIMIT_BYTES = 3584 * BYTES_PER_MIB;
const WASM_LINEAR_MEMORY_INTERACTION_LIMIT_BYTES = 3584 * BYTES_PER_MIB;
const ARC_TESSELLATION_QUALITY_LEVELS = {
  low: 0,
  normal: 1,
  high: 2,
};
const MINIMUM_FEATURE_PIXEL_VALUES = new Set([0, 1, 2]);
const DRILL_OUTLINE_PIXEL_VALUES = new Set([0, 1, 2, 3]);
const PTH_PLATING_MICROMETER_VALUES = new Set([10, 20, 30, 40, 50]);
const RENDERING_MODE_LAZY = "lazy";
const RENDERING_MODE_REALTIME = "realtime";
const RENDERING_MODE_VALUES = new Set([
  RENDERING_MODE_LAZY,
  RENDERING_MODE_REALTIME,
]);
const COMPOSITE_MODE_BLEND = "blend";
const COMPOSITE_MODE_STACK = "stack";
const COMPOSITE_MODE_VALUES = new Set([
  COMPOSITE_MODE_BLEND,
  COMPOSITE_MODE_STACK,
]);
const DEFAULT_BOARD_OUTLINE_BOUNDS_MARGIN_MM = 20;
const MM_PER_INCH = 25.4;
const BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_MM = "mm";
const BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_INCH = "inch";
const BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_VALUES = new Set([
  BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_MM,
  BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_INCH,
]);
const INTERACTION_MODE_ON = "on";
const INTERACTION_MODE_OFF = "off";
const INTERACTION_MODE_VALUES = new Set([
  INTERACTION_MODE_ON,
  INTERACTION_MODE_OFF,
]);
const BOARD_OUTLINE_AUTO = "auto";
const BOARD_OUTLINE_BOUNDS = "bounds";
const LAZY_WHEEL_RENDER_DELAY_MS = 140;
const LAYER_TOUCH_DRAG_DELAY_MS = 500;
const LAYER_TOUCH_DRAG_CANCEL_PX = 8;
const LAYER_TOUCH_AUTOSCROLL_EDGE_PX = 56;
const LAYER_TOUCH_AUTOSCROLL_MAX_PX = 14;
const LAYER_REORDER_ANIMATION_MS = 180;
const LAYER_CONTEXT_MENU_MARGIN_PX = 8;
const DRILL_LAYER_KIND = "drill";
const GERBER_LAYER_KIND = "gerber";
const PTH_DRILL_TYPE = "pth";
const NPTH_DRILL_TYPE = "npth";
const DEFAULT_PTH_DRILL_COLOR = [1.0, 1.0, 0.0];
const DEFAULT_NPTH_DRILL_COLOR = [1.0, 1.0, 1.0];
const POINTER_TAP_MAX_MOVEMENT_VIEWPORT_RATIO = 0.006;
const TOUCH_TAP_MAX_MOVEMENT_VIEWPORT_RATIO = 0.024;
const FEATURE_PICK_MOUSE_VIEWPORT_RATIO = 0.008;
const FEATURE_PICK_TOUCH_VIEWPORT_RATIO = 0.032;
const FEATURE_CYCLE_MOUSE_VIEWPORT_RATIO = 0.006;
const FEATURE_CYCLE_TOUCH_VIEWPORT_RATIO = 0.025;

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

function isBoardOutlineLayer(layer) {
  if (!layer || isDrillLayer(layer)) return false;

  return [layer.name, layer.sourceName, layer.fileName].some(isBoardOutlineName);
}

function isGerberLayer(layer) {
  return Boolean(layer && !isDrillLayer(layer));
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

  return /(^|[^a-z0-9])(board[-_. ]?outline|outline|edge[-_. ]?cuts?|profile|contour|mechanical|mech|dimension)([^a-z0-9]|$)/i.test(
    normalized,
  );
}

function getLayerRenderBounds(layer) {
  return layer?.renderBounds ?? layer?.bounds ?? null;
}

function getLayerRawBounds(layer) {
  return layer?.bounds ?? null;
}

function getDefaultDrillColor(name) {
  return getDrillType(name) === NPTH_DRILL_TYPE
    ? [...DEFAULT_NPTH_DRILL_COLOR]
    : [...DEFAULT_PTH_DRILL_COLOR];
}

function getDrillType(name) {
  const normalized = String(name ?? "").toLowerCase();
  const isNpth = /(^|[^a-z0-9])(npth|non[-_ ]?plated|nonplated)([^a-z0-9]|$)/i.test(
    normalized,
  );
  return isNpth ? NPTH_DRILL_TYPE : PTH_DRILL_TYPE;
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

function normalizeBoardOutlineBoundsMarginMm(value) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return DEFAULT_BOARD_OUTLINE_BOUNDS_MARGIN_MM;
  }
  const margin = Number(value);
  if (!Number.isFinite(margin)) {
    return DEFAULT_BOARD_OUTLINE_BOUNDS_MARGIN_MM;
  }
  return Math.max(0, margin);
}

function normalizeBoardOutlineBoundsMarginUnit(unit) {
  return BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_VALUES.has(unit)
    ? unit
    : BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_MM;
}

function formatBoardOutlineBoundsMarginInputValue(marginMm, unit) {
  const value =
    unit === BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_INCH
      ? marginMm / MM_PER_INCH
      : marginMm;
  const decimals = unit === BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_INCH ? 4 : 3;
  return String(Number(value.toFixed(decimals)));
}

function parseBoardOutlineBoundsMarginInputValue(value, unit) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return DEFAULT_BOARD_OUTLINE_BOUNDS_MARGIN_MM;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BOARD_OUTLINE_BOUNDS_MARGIN_MM;
  }
  const margin = Math.max(0, parsed);
  return unit === BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_INCH
    ? margin * MM_PER_INCH
    : margin;
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

function formatSelectedFeatureSummary(selection, { unit = "mm" } = {}) {
  if (!selection) return "";

  const { layer } = selection;
  const feature = selection.feature ?? selection;
  const parts = [];
  if (layer?.name) {
    parts.push(layer.name);
  }

  if (isDrillLayer(layer)) {
    parts.push(String(layer.drillType ?? PTH_DRILL_TYPE).toUpperCase());
  } else if (feature.aperture) {
    parts.push(feature.aperture);
  }

  parts.push(formatFeatureTypeLabel(feature, layer));

  if (
    !isDrillLayer(layer) &&
    feature.featureType !== "region" &&
    feature.apertureType
  ) {
    parts.push(formatApertureTypeLabel(feature));
  }

  parts.push(...formatFeaturePropertyParts(feature, unit));
  return parts.filter(Boolean).join(" | ");
}

function formatFeatureTypeLabel(feature, layer) {
  if (isDrillLayer(layer)) {
    return feature.aperture ?? "";
  }

  switch (feature.featureType) {
    case "aperture-flash":
      return "Aperture flash";
    case "aperture-draw":
      return "Aperture draw";
    case "arc-draw": {
      const arcCommand = feature.properties?.arcCommand;
      if (arcCommand === "G02" || arcCommand === "G03") {
        return `${arcCommand} arc draw`;
      }
      return "Arc draw";
    }
    case "region":
      return "Region";
    case "drill-hit":
      return "Drill hit";
    case "drill-slot":
      return "Drill slot";
    default:
      return "Feature";
  }
}

function formatApertureTypeLabel(feature) {
  if (feature.apertureType === "macro") {
    return feature.macroName
      ? `Macro aperture ${feature.macroName}`
      : "Macro aperture";
  }
  return `${feature.apertureType} aperture`;
}

function formatFeaturePropertyParts(feature, unit) {
  const properties = feature.properties ?? {};
  const parts = [];
  const diameter = Number(properties.diameter);
  const width = Number(properties.width);
  const height = Number(properties.height);
  const rotation = Number(properties.rotation);
  const vertices = Number(properties.vertices);
  const toolCode = Number(properties.toolCode);

  if (Number.isFinite(diameter) && diameter > 0) {
    parts.push(`dia ${formatMeasurementLength(diameter, unit)}`);
  } else if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  ) {
    parts.push(`size ${formatDimensionPair(width, height, unit)}`);
  }

  if (Number.isFinite(rotation) && rotation !== 0) {
    parts.push(`rot ${((-rotation * 180) / Math.PI).toFixed(2)} deg`);
  }
  if (Number.isFinite(vertices) && vertices > 0) {
    parts.push(`${Math.trunc(vertices)} vertices`);
  }
  const formattedToolCode = Number.isFinite(toolCode) && toolCode > 0
    ? `T${String(Math.trunc(toolCode)).padStart(2, "0")}`
    : "";
  if (formattedToolCode && formattedToolCode !== feature.aperture) {
    parts.push(formattedToolCode);
  }

  return parts;
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
          interactionsEnabled: task.options.interactionsEnabled,
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
      task.resolve({
        renderPayload: event.data.parsedLayer,
        interactionPayload: event.data.interactionPayload ?? null,
      });
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
    this.interactionProcessor = null;
    this.interactionsEnabled = true;
    this.featurePickingAvailable = true;
    this.isWebGlContextLost = false;
    this.isRestoringWebGlContext = false;
    this.isRecoveringWasmProcessor = false;
    this.wasmRecoveryPromise = null;
    this.pendingFatalWasmRecovery = false;
    this.isInitialUrlLoading = Boolean(getInitialSourceUrl());
    this.isLoadingLayers = false;
    this.loadingWorkspaceStatus = "Loading files";
    this.pendingRenderFrame = null;

    // Layers
    this.layers = [];
    this.nextLayerDomId = 0;
    this.draggedLayerId = null;
    this.layerDropIndex = null;
    this.layerTouchDrag = null;
    this.layerTouchDragTimer = null;
    this.layerTouchScrollFrame = null;
    this.layerTouchScrollVelocity = 0;
    this.layerTouchSuppressClickUntil = 0;
    this.layerContextMenuButtons = new Map();
    this.layerContextMenu = this.createLayerContextMenu();
    this.layerContextMenuLayerId = null;
    this.pendingLayerRecordsForRecovery = null;
    this.wasmMemoryExhausted = false;
    this.pendingLazyRenderTimer = null;
    this.lazyViewportRenderState = null;
    this.isViewportTransformActive = false;
    this.boardOutlineSelection = BOARD_OUTLINE_AUTO;

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
    this.pointerGestureDidPan = false;
    this.lastMousePos = { x: 0, y: 0 };
    this.mouseDownPos = { x: 0, y: 0 };
    this.selectedFeature = null;
    this.lastFeaturePick = null;

    // Touch interaction
    this.isTouching = false;
    this.touches = [];
    this.initialPinchDistance = null;
    this.lastPinchDistance = null;
    this.lastTouchCenter = { x: 0, y: 0 };
    this.touchStartPoint = null;
    this.touchTapPoint = null;
    this.touchTapIdentifier = null;
    this.touchTapCandidate = false;
    this.touchGestureWasMultitouch = false;
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
      this.viewerOptionsStore.get("minimumFeaturePixels") ?? 1,
    );
    this.boardOutlineBoundsMarginMm = normalizeBoardOutlineBoundsMarginMm(
      this.viewerOptionsStore.get("boardOutlineBoundsMarginMm"),
    );
    this.boardOutlineBoundsMarginUnit = normalizeBoardOutlineBoundsMarginUnit(
      this.viewerOptionsStore.get("boardOutlineBoundsMarginUnit"),
    );
    this.drillOutlinePixels = Number(
      this.viewerOptionsStore.get("drillOutlinePixels") ?? 0,
    );
    this.pthPlatingMicrometers = Number(
      this.viewerOptionsStore.get("pthPlatingMicrometers") ?? 20,
    );
    const storedRenderingMode = this.viewerOptionsStore.get("renderingMode");
    this.renderingMode = RENDERING_MODE_VALUES.has(storedRenderingMode)
      ? storedRenderingMode
      : RENDERING_MODE_LAZY;
    const storedCompositeMode = this.viewerOptionsStore.get("compositeMode");
    this.compositeMode = COMPOSITE_MODE_VALUES.has(storedCompositeMode)
      ? storedCompositeMode
      : COMPOSITE_MODE_BLEND;
    this.interactionsOptionEnabled =
      this.viewerOptionsStore.get("interactionsEnabled") !== false;
    this.interactionsEnabled = this.interactionsOptionEnabled;
    this.featurePickingAvailable = this.interactionsEnabled;
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
        globalAlpha: this.getCompositeAlpha(),
        compositeMode: this.compositeMode,
        backgroundColor: this.isCanvasLight ? "#f8fafc" : "#020617",
      }),
      isWebGlUnavailable: () =>
        this.isWebGlContextLost || this.isRestoringWebGlContext,
      drawMeasurements: (context, renderState) =>
        this.drawMeasurementsOnContext(context, renderState),
      showError: (message) => this.showError(message),
      getBoardOutlineSelection: () => this.boardOutlineSelection,
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
    const handleViewportResize = () => {
      this.resizeCanvas();
      this.drawerController.updateToggleState();
      if (this.screenshotDialog.open) {
        this.updateScreenshotResolutionPreview();
      }
    };
    window.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("resize", handleViewportResize);

    this.setupEventListeners();

    // Initial render
    this.updateEmptyStateHint();
    this.renderLayerList();
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

  createLayerContextMenu() {
    const menu = document.createElement("div");
    menu.className = "layer-context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Layer actions");
    menu.hidden = true;

    const itemGroups = [
      [
        { action: "show-all", icon: "eye", label: "Show All" },
        { action: "hide-all", icon: "eye-off", label: "Hide All" },
      ],
      [
        { action: "show-top", icon: "panel-top", label: "Show Top" },
        { action: "show-bottom", icon: "panel-bottom", label: "Show Bottom" },
      ],
      [
        {
          action: "invert-layer",
          icon: "contrast",
          label: "Invert Layer",
          checkable: true,
        },
        {
          action: "delete-layer",
          icon: "trash-2",
          label: "Delete Layer",
          danger: true,
        },
      ],
    ];

    for (const [groupIndex, group] of itemGroups.entries()) {
      if (groupIndex > 0) {
        const separator = document.createElement("div");
        separator.className = "layer-context-menu-separator";
        separator.setAttribute("role", "separator");
        menu.appendChild(separator);
      }

      for (const item of group) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = item.danger
          ? "layer-context-menu-item danger"
          : "layer-context-menu-item";
        button.dataset.layerMenuAction = item.action;
        button.setAttribute("role", item.checkable ? "menuitemcheckbox" : "menuitem");

        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", item.icon);
        const label = document.createElement("span");
        label.textContent = item.label;
        button.append(icon, label);
        menu.appendChild(button);
        this.layerContextMenuButtons.set(item.action, button);
      }
    }

    menu.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest("[data-layer-menu-action]")
        : null;
      if (!button || button.disabled) return;

      event.preventDefault();
      event.stopPropagation();
      this.runLayerContextMenuAction(button.dataset.layerMenuAction);
    });

    this.dropZone.appendChild(menu);
    return menu;
  }

  showLayerContextMenu({ layerId, clientX, clientY }) {
    if (this.draggedLayerId) return;

    const layer = this.layers.find((candidate) => candidate.id === layerId);
    if (!layer) {
      this.closeLayerContextMenu();
      return;
    }

    this.layerContextMenuLayerId = layerId;
    this.syncLayerContextMenuState(layer);
    this.positionLayerContextMenu(clientX, clientY);
  }

  syncLayerContextMenuState(layer) {
    this.setLayerContextMenuItemDisabled("delete-layer", !layer);
    this.setLayerContextMenuItemDisabled("invert-layer", !this.canInvertLayer(layer));
    this.setLayerContextMenuItemChecked("invert-layer", Boolean(layer?.inverted));
  }

  setLayerContextMenuItemDisabled(action, disabled) {
    const button = this.layerContextMenuButtons.get(action);
    if (!button) return;

    button.disabled = Boolean(disabled);
    button.setAttribute("aria-disabled", disabled ? "true" : "false");
  }

  setLayerContextMenuItemChecked(action, checked) {
    const button = this.layerContextMenuButtons.get(action);
    if (!button) return;

    button.classList.toggle("active", Boolean(checked));
    button.setAttribute("aria-checked", checked ? "true" : "false");
  }

  positionLayerContextMenu(clientX, clientY) {
    const menu = this.layerContextMenu;
    if (!menu) return;

    menu.hidden = false;
    menu.classList.add("open");
    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";

    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const left = Math.max(
      LAYER_CONTEXT_MENU_MARGIN_PX,
      Math.min(
        Number(clientX) || LAYER_CONTEXT_MENU_MARGIN_PX,
        viewportWidth - rect.width - LAYER_CONTEXT_MENU_MARGIN_PX,
      ),
    );
    const top = Math.max(
      LAYER_CONTEXT_MENU_MARGIN_PX,
      Math.min(
        Number(clientY) || LAYER_CONTEXT_MENU_MARGIN_PX,
        viewportHeight - rect.height - LAYER_CONTEXT_MENU_MARGIN_PX,
      ),
    );

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "";
    this.refreshIcons();

    const firstEnabledButton = menu.querySelector(
      ".layer-context-menu-item:not(:disabled)",
    );
    firstEnabledButton?.focus({ preventScroll: true });
  }

  closeLayerContextMenu() {
    if (!this.layerContextMenu || this.layerContextMenu.hidden) return;

    this.layerContextMenu.hidden = true;
    this.layerContextMenu.classList.remove("open");
    this.layerContextMenuLayerId = null;
  }

  handleLayerContextMenuPointerDown(event) {
    if (
      this.layerContextMenu?.hidden ||
      !(event.target instanceof Node) ||
      this.layerContextMenu.contains(event.target)
    ) {
      return;
    }

    this.closeLayerContextMenu();
  }

  handleLayerContextMenuKeyDown(event) {
    if (this.layerContextMenu?.hidden) return;

    if (event.key === "Escape") {
      event.preventDefault();
      this.closeLayerContextMenu();
      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    const buttons = Array.from(
      this.layerContextMenu.querySelectorAll(
        ".layer-context-menu-item:not(:disabled)",
      ),
    );
    if (buttons.length === 0) return;

    event.preventDefault();
    const activeIndex = buttons.indexOf(document.activeElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      activeIndex === -1
        ? 0
        : (activeIndex + direction + buttons.length) % buttons.length;
    buttons[nextIndex].focus({ preventScroll: true });
  }

  handleDocumentContextMenu(event) {
    if (
      this.layerContextMenu?.hidden ||
      !(event.target instanceof Node) ||
      this.layerList.contains(event.target) ||
      this.layerContextMenu.contains(event.target)
    ) {
      return;
    }

    this.closeLayerContextMenu();
  }

  runLayerContextMenuAction(action) {
    const layerId = this.layerContextMenuLayerId;
    const layer = this.layers.find((candidate) => candidate.id === layerId);
    this.closeLayerContextMenu();

    switch (action) {
      case "show-all":
        this.selectAllLayerCheckboxes();
        break;
      case "hide-all":
        this.unselectAllLayerCheckboxes();
        break;
      case "show-top":
        this.selectLayersByFilter("top");
        break;
      case "show-bottom":
        this.selectLayersByFilter("bottom");
        break;
      case "invert-layer":
        if (this.canInvertLayer(layer)) {
          this.updateLayerInverted(layer, !layer.inverted);
        }
        break;
      case "delete-layer":
        if (layerId) {
          this.deleteLayer(layerId);
        }
        break;
      default:
        break;
    }
  }

  canInvertLayer(layer) {
    return Boolean(layer && !isDrillLayer(layer));
  }

  createWebGlContext() {
    const gl = this.canvas.getContext("webgl2", {
      preserveDrawingBuffer: true,
      stencil: true,
    });
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

  createInteractionProcessor() {
    if (!this.gl || this.isWebGlContextLost) {
      throw new Error("WebGL renderer is not available");
    }

    const processor = new this.wasmModule.GerberProcessor();
    try {
      processor.init(this.gl);
      this.configureWasmProcessorOptions(processor, {
        interactionsEnabled: true,
      });
      processor.resize();
      return processor;
    } catch (error) {
      this.disposeWasmProcessorInstance(processor, "interaction processor");
      throw error;
    }
  }

  configureWasmProcessorOptions(
    processor,
    { interactionsEnabled = this.interactionsEnabled } = {},
  ) {
    if (typeof processor?.set_preserve_arc_regions === "function") {
      processor.set_preserve_arc_regions(this.preserveArcRegions);
    }

    if (typeof processor?.set_arc_tessellation_quality === "function") {
      processor.set_arc_tessellation_quality(this.getArcTessellationQualityLevel());
    }

    if (typeof processor?.set_minimum_feature_pixels === "function") {
      processor.set_minimum_feature_pixels(this.minimumFeaturePixels);
    }

    if (typeof processor?.set_interactions_enabled === "function") {
      processor.set_interactions_enabled(interactionsEnabled);
    }
  }

  disableProcessorInteractions(processor) {
    if (typeof processor?.set_interactions_enabled === "function") {
      processor.set_interactions_enabled(false);
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
  } = {}, processor = this.wasmProcessor) {
    if (
      !preserveArcRegions &&
      typeof processor?.set_preserve_arc_regions !== "function"
    ) {
      throw new Error("Region arc options require an updated WASM module");
    }

    if (
      !preserveArcRegions &&
      arcTessellationQuality !== "normal" &&
      typeof processor?.set_arc_tessellation_quality !== "function"
    ) {
      throw new Error("Arc tessellation quality requires an updated WASM module");
    }
  }

  resizeCanvas({
    allowProcessorResize = false,
    preserveViewState = null,
    commitDrawerLayout = false,
  } = {}) {
    this.flushLazyViewportRender();
    this.drawerController.syncLayout({ commitLayout: commitDrawerLayout });

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
        this.interactionProcessor?.resize?.();
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
      this.openFilePicker();
    });

    this.emptyUploadBtn.addEventListener("click", () => {
      this.openFilePicker();
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
    document.addEventListener(
      "pointerdown",
      (event) => this.handleLayerContextMenuPointerDown(event),
      true,
    );
    document.addEventListener("keydown", (event) =>
      this.handleLayerContextMenuKeyDown(event),
    );
    document.addEventListener(
      "contextmenu",
      (event) => this.handleDocumentContextMenu(event),
      true,
    );
    document.addEventListener(
      "scroll",
      () => this.closeLayerContextMenu(),
      true,
    );
    window.addEventListener("resize", () => this.closeLayerContextMenu());

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

    this.toolbarClearAllBtn.addEventListener("click", () => {
      this.clearAllLayers();
    });

    this.clearDiagnosticsBtn.addEventListener("click", () => {
      this.clearDiagnostics();
    });

    for (const input of this.getRenderingModeInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.setRenderingMode(input.value);
        }
      });
    }

    for (const input of this.getCompositeModeInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.setCompositeMode(input.value);
        }
      });
    }

    for (const input of this.getInteractionModeInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.setInteractionMode(input.value);
        }
      });
    }

    // Alpha slider
    this.alphaSlider.addEventListener("input", (e) => {
      const alpha = parseInt(e.target.value) / 100;
      this.alphaValue.textContent = `${e.target.value}%`;
      this.updateGlobalAlpha(alpha);
    });

    this.boardOutlineSelect.addEventListener("change", () => {
      this.setBoardOutlineSelection(this.boardOutlineSelect.value);
    });

    this.boardOutlineBoundsMarginInput.addEventListener("change", () => {
      this.setBoardOutlineBoundsMargin(
        this.boardOutlineBoundsMarginInput.value,
      );
    });

    for (const input of this.getBoardOutlineBoundsMarginUnitInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.setBoardOutlineBoundsMarginUnit(input.value);
        }
      });
    }

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

    for (const input of this.getDrillOutlineInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.setDrillOutlinePixels(Number(input.value));
        }
      });
    }

    for (const input of this.getPthPlatingInputs()) {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.setPthPlatingMicrometers(Number(input.value));
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
    this.viewerSurface.addEventListener("wheel", (e) => this.handleWheel(e), {
      passive: false,
    });

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
    this.layerList.addEventListener(
      "touchstart",
      (e) => this.handleLayerTouchStart(e),
      { passive: false },
    );
    this.layerList.addEventListener(
      "touchmove",
      (e) => this.handleLayerTouchMove(e),
      { passive: false },
    );
    this.layerList.addEventListener(
      "touchend",
      (e) => this.handleLayerTouchEnd(e),
      { passive: false },
    );
    this.layerList.addEventListener(
      "touchcancel",
      (e) => this.handleLayerTouchCancel(e),
      { passive: false },
    );
    this.layerList.addEventListener(
      "click",
      (e) => this.suppressLayerClickAfterTouchDrag(e),
      true,
    );

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
        try {
          this.interactionProcessor?.restore_context?.(this.gl);
        } catch (interactionRestoreError) {
          this.disableFeaturePickingForCurrentDocument(
            "Feature picking failed",
            `Picking data could not be restored after WebGL context recovery: ${getErrorMessage(interactionRestoreError)}`,
            { abandon: isFatalWasmRuntimeError(interactionRestoreError) },
          );
        }
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

    this.disposeWasmProcessor({ abandon: true });
    this.disposeInteractionProcessor({ abandon: true });
    this.featurePickingAvailable = false;
    this.layers = [];
    this.clearSelectedFeature({ refresh: false });
    this.createWebGlProcessor();
    this.disableProcessorInteractions(this.wasmProcessor);
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

  getParseOptions({ forceInteractions = false } = {}) {
    return {
      preserveArcRegions: this.preserveArcRegions,
      arcTessellationQuality: this.getArcTessellationQualityLevel(),
      interactionsEnabled:
        this.interactionsEnabled &&
        (forceInteractions || this.featurePickingAvailable),
    };
  }

  getRenderOptions() {
    return {
      minimumFeaturePixels: this.minimumFeaturePixels,
      boardOutlineBoundsMarginMm: this.boardOutlineBoundsMarginMm,
      drillOutlinePixels: this.drillOutlinePixels,
      pthPlatingMicrometers: this.pthPlatingMicrometers,
      compositeMode: this.compositeMode,
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

  getBoardOutlineBoundsMarginUnitInputs() {
    return [
      this.boardOutlineBoundsMarginUnitMmInput,
      this.boardOutlineBoundsMarginUnitInchInput,
    ];
  }

  getDrillOutlineInputs() {
    return [
      this.drillOutlineOffInput,
      this.drillOutline1Input,
      this.drillOutline2Input,
      this.drillOutline3Input,
    ];
  }

  getPthPlatingInputs() {
    return [
      this.pthPlating10Input,
      this.pthPlating20Input,
      this.pthPlating30Input,
      this.pthPlating40Input,
      this.pthPlating50Input,
    ];
  }

  getRenderingModeInputs() {
    return [this.renderingModeLazyInput, this.renderingModeRealtimeInput];
  }

  getCompositeModeInputs() {
    return [this.compositeModeBlendInput, this.compositeModeStackInput];
  }

  getInteractionModeInputs() {
    return [this.interactionModeOnInput, this.interactionModeOffInput];
  }

  syncRenderingModeControls() {
    const renderingModeDisabled =
      this.isRendererBusy() || this.isViewportGestureActive();
    for (const input of this.getRenderingModeInputs()) {
      input.checked = input.value === this.renderingMode;
      input.disabled = renderingModeDisabled;
    }
  }

  syncOptionControls() {
    this.syncRenderingModeControls();

    for (const input of this.getCompositeModeInputs()) {
      input.checked = input.value === this.compositeMode;
      input.disabled = this.isRendererBusy();
    }

    this.syncInteractionModeControls();

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

    this.syncBoardOutlineBoundsMarginControl();

    for (const input of this.getDrillOutlineInputs()) {
      input.checked = Number(input.value) === this.drillOutlinePixels;
      input.disabled = this.isRendererBusy();
    }

    for (const input of this.getPthPlatingInputs()) {
      input.checked = Number(input.value) === this.pthPlatingMicrometers;
      input.disabled = this.isRendererBusy();
    }
  }

  syncInteractionModeControls(rendererBusy = this.isRendererBusy()) {
    const mode = this.interactionsOptionEnabled
      ? INTERACTION_MODE_ON
      : INTERACTION_MODE_OFF;
    for (const input of this.getInteractionModeInputs()) {
      input.checked = input.value === mode;
      input.disabled = rendererBusy;
    }
  }

  syncBoardOutlineBoundsMarginControl(rendererBusy = this.isRendererBusy()) {
    this.boardOutlineBoundsMarginInput.value =
      formatBoardOutlineBoundsMarginInputValue(
        this.boardOutlineBoundsMarginMm,
        this.boardOutlineBoundsMarginUnit,
      );
    this.boardOutlineBoundsMarginInput.step =
      this.boardOutlineBoundsMarginUnit === BOARD_OUTLINE_BOUNDS_MARGIN_UNIT_INCH
        ? "0.001"
        : "0.1";
    this.boardOutlineBoundsMarginInput.disabled = rendererBusy;
    for (const input of this.getBoardOutlineBoundsMarginUnitInputs()) {
      input.checked = input.value === this.boardOutlineBoundsMarginUnit;
      input.disabled = rendererBusy;
    }
  }

  syncFilterInputs() {
    this.topFilterInput.value = this.layerFilterStore.get("top");
    this.bottomFilterInput.value = this.layerFilterStore.get("bottom");
  }

  syncBoardOutlineSelect() {
    const currentValue = this.boardOutlineSelection;
    const outlineLayers = this.layers.filter(isGerberLayer);
    const validValues = new Set([
      BOARD_OUTLINE_AUTO,
      BOARD_OUTLINE_BOUNDS,
      ...outlineLayers.map((layer) => layer.id),
    ]);
    if (!validValues.has(this.boardOutlineSelection)) {
      this.boardOutlineSelection = BOARD_OUTLINE_AUTO;
    }

    const options = [
      { value: BOARD_OUTLINE_AUTO, label: "Auto" },
      { value: BOARD_OUTLINE_BOUNDS, label: "Bounds" },
      ...outlineLayers.map((layer) => ({
        value: layer.id,
        label: layer.name,
      })),
    ];
    this.boardOutlineSelect.replaceChildren(
      ...options.map((option) => {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        return element;
      }),
    );
    this.boardOutlineSelect.value = this.boardOutlineSelection;
    this.boardOutlineSelect.disabled = this.isRendererBusy() || this.layers.length === 0;

    if (currentValue !== this.boardOutlineSelection) {
      this.clearAllInvertedLayerCaches();
      this.requestRender();
    }
  }

  setBoardOutlineSelection(value) {
    const nextValue = String(value ?? BOARD_OUTLINE_AUTO);
    const validLayer = this.layers.some(
      (layer) => isGerberLayer(layer) && layer.id === nextValue,
    );
    if (
      nextValue !== BOARD_OUTLINE_AUTO &&
      nextValue !== BOARD_OUTLINE_BOUNDS &&
      !validLayer
    ) {
      this.boardOutlineSelection = BOARD_OUTLINE_AUTO;
    } else {
      this.boardOutlineSelection = nextValue;
    }

    this.clearAllInvertedLayerCaches();
    this.syncBoardOutlineSelect();
    this.requestRender();
    this.updateUiState();
  }

  setRenderingMode(mode) {
    if (!RENDERING_MODE_VALUES.has(mode)) {
      this.syncOptionControls();
      return;
    }
    if (mode === this.renderingMode) {
      return;
    }
    if (this.isRendererBusy() || this.isViewportGestureActive()) {
      this.syncOptionControls();
      return;
    }

    this.renderingMode = mode;
    this.viewerOptionsStore.set("renderingMode", this.renderingMode);
    this.syncOptionControls();

    if (this.isRealtimeRendering()) {
      this.flushLazyViewportRender();
    }

    this.updateUiState();
  }

  isRealtimeRendering() {
    return this.renderingMode === RENDERING_MODE_REALTIME;
  }

  shouldRenderViewportRealtime() {
    return this.isRealtimeRendering();
  }

  setCompositeMode(mode) {
    if (!COMPOSITE_MODE_VALUES.has(mode)) {
      this.syncOptionControls();
      return;
    }
    if (mode === this.compositeMode) {
      return;
    }
    if (this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    this.compositeMode = mode;
    this.viewerOptionsStore.set("compositeMode", this.compositeMode);
    this.syncOptionControls();
    this.requestRender();
    this.updateUiState();
  }

  setInteractionMode(mode) {
    if (!INTERACTION_MODE_VALUES.has(mode)) {
      this.syncOptionControls();
      return;
    }
    if (this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    const nextEnabled = mode === INTERACTION_MODE_ON;
    if (nextEnabled === this.interactionsOptionEnabled) {
      return;
    }

    this.interactionsOptionEnabled = nextEnabled;
    this.viewerOptionsStore.set(
      "interactionsEnabled",
      this.interactionsOptionEnabled,
    );
    this.syncOptionControls();
    if (this.interactionsOptionEnabled !== this.interactionsEnabled) {
      this.showNotification(
        "Page reload required",
        "info",
        NOTIFICATION_DURATION_MS,
        (messageElement) => {
          messageElement.textContent = "Feature picking setting will apply after page reload.";
        },
      );
    } else {
      this.hideNotification();
    }
    this.updateUiState();
  }

  isStackCompositeMode() {
    return this.compositeMode === COMPOSITE_MODE_STACK;
  }

  updateAlphaControlState(rendererBusy = this.isRendererBusy()) {
    const shouldHide = this.isStackCompositeMode();
    const alphaControl = this.alphaSlider.closest(".alpha-control");
    if (alphaControl) {
      alphaControl.hidden = shouldHide;
    }
    this.alphaSlider.disabled = rendererBusy || shouldHide;
  }

  isViewportGestureActive() {
    return (
      this.isPanning ||
      this.isTouching ||
      this.isViewportTransformActive ||
      this.isLazyViewportPreviewActive()
    );
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

  setBoardOutlineBoundsMargin(value) {
    const margin = parseBoardOutlineBoundsMarginInputValue(
      value,
      this.boardOutlineBoundsMarginUnit,
    );
    if (margin === this.boardOutlineBoundsMarginMm) {
      this.syncOptionControls();
      return;
    }
    if (this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    this.boardOutlineBoundsMarginMm = margin;
    this.syncOptionControls();
    this.viewerOptionsStore.set(
      "boardOutlineBoundsMarginMm",
      this.boardOutlineBoundsMarginMm,
    );
    this.clearAllInvertedLayerCaches();
    this.requestRender();
    this.updateUiState();
  }

  setBoardOutlineBoundsMarginUnit(unit) {
    const nextUnit = normalizeBoardOutlineBoundsMarginUnit(unit);
    if (nextUnit === this.boardOutlineBoundsMarginUnit) {
      this.syncOptionControls();
      return;
    }
    if (this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    this.boardOutlineBoundsMarginUnit = nextUnit;
    this.viewerOptionsStore.set(
      "boardOutlineBoundsMarginUnit",
      this.boardOutlineBoundsMarginUnit,
    );
    this.syncOptionControls();
  }

  setDrillOutlinePixels(pixels) {
    if (!DRILL_OUTLINE_PIXEL_VALUES.has(pixels)) {
      this.syncOptionControls();
      return;
    }
    if (pixels === this.drillOutlinePixels) {
      return;
    }
    if (this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    const previousPixels = this.drillOutlinePixels;
    this.drillOutlinePixels = pixels;
    this.syncOptionControls();
    this.viewerOptionsStore.set("drillOutlinePixels", this.drillOutlinePixels);

    try {
      this.applyDrillOutlineStyles();
      this.requestRender();
    } catch (error) {
      this.drillOutlinePixels = previousPixels;
      this.syncOptionControls();
      this.viewerOptionsStore.set("drillOutlinePixels", this.drillOutlinePixels);
      this.configureWasmProcessorOptions(this.wasmProcessor);
      this.applyDrillOutlineStyles();
      this.showError(`Failed to apply drill outline: ${getErrorMessage(error)}`);
    } finally {
      this.updateUiState();
    }
  }

  setPthPlatingMicrometers(micrometers) {
    if (!PTH_PLATING_MICROMETER_VALUES.has(micrometers)) {
      this.syncOptionControls();
      return;
    }
    if (micrometers === this.pthPlatingMicrometers) {
      return;
    }
    if (this.isRendererBusy()) {
      this.syncOptionControls();
      return;
    }

    const previousMicrometers = this.pthPlatingMicrometers;
    this.pthPlatingMicrometers = micrometers;
    this.syncOptionControls();
    this.viewerOptionsStore.set(
      "pthPlatingMicrometers",
      this.pthPlatingMicrometers,
    );

    try {
      this.applyDrillOutlineStyles();
      this.requestRender();
    } catch (error) {
      this.pthPlatingMicrometers = previousMicrometers;
      this.syncOptionControls();
      this.viewerOptionsStore.set(
        "pthPlatingMicrometers",
        this.pthPlatingMicrometers,
      );
      this.configureWasmProcessorOptions(this.wasmProcessor);
      this.applyDrillOutlineStyles();
      this.showError(`Failed to apply PTH plating: ${getErrorMessage(error)}`);
    } finally {
      this.updateUiState();
    }
  }

  getDrillOutlineStyle(layer) {
    if (layer.drillType === NPTH_DRILL_TYPE) {
      return {
        pixels: this.drillOutlinePixels,
        worldMm: 0,
      };
    }

    return {
      pixels: 0,
      worldMm: this.pthPlatingMicrometers / 1000,
    };
  }

  shouldRenderDrillOutline(layer) {
    const style = this.getDrillOutlineStyle(layer);
    return style.pixels > 0 || style.worldMm > 0;
  }

  applyDrillLayerOutlineStyle(layer, processor = this.wasmProcessor) {
    if (!processor || !isDrillLayer(layer)) return;

    const style = this.getDrillOutlineStyle(layer);
    if (typeof processor.set_layer_inner_outline === "function") {
      processor.set_layer_inner_outline(
        layer.outlineLayerId,
        style.pixels,
        style.worldMm,
      );
      this.updateDrillLayerBounds(layer, style);
      return;
    }

    if (style.pixels > 0 || style.worldMm > 0) {
      throw new Error("Drill outline rendering requires an updated WASM module.");
    }
  }

  updateDrillLayerBounds(layer, style = this.getDrillOutlineStyle(layer)) {
    if (!isDrillLayer(layer) || !layer.rawBounds) return;
    layer.bounds = expandBounds(layer.rawBounds, style.worldMm);
  }

  applyDrillOutlineStyles(processor = this.wasmProcessor) {
    if (!processor) return;
    for (const layer of this.layers) {
      this.applyDrillLayerOutlineStyle(layer, processor);
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
            const parseResult = await this.parseLayerContent(
              layer.sourceContent,
              layer.offset,
              null,
              { forceInteractions: true },
            );
            parsedLayers.push({
              ...layer,
              parsedLayer: parseResult.renderPayload,
              interactionPayload: parseResult.interactionPayload,
            });
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
            inverted: layer.inverted,
            sourceContent: layer.sourceContent,
            offset: layer.offset,
            drillType: layer.drillType,
            interactionPayload: layer.interactionPayload,
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
          if (layer.kind !== DRILL_LAYER_KIND) {
            layerRecord.interactionPayload = layer.interactionPayload ?? null;
          }
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
        this.disposeInteractionProcessor();
        this.featurePickingAvailable = this.interactionsEnabled;
        this.clearSelectedFeature({ refresh: false });
        this.disposeWasmProcessorInstance(previousProcessor, "previous processor");
        await this.buildInteractionLayersForRecords(stagedLayers, {
          title: "Applying options",
        });
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

  openFilePicker() {
    if (this.fileInput.disabled || this.isRendererBusy()) return;
    this.fileInput.click();
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
    this.updateAlphaControlState(rendererBusy);
    this.syncBoardOutlineSelect();
    this.clearAllBtn.disabled = rendererBusy || totalLayers === 0;
    this.toolbarClearAllBtn.disabled = rendererBusy || totalLayers === 0;
    this.updateEmptyLayerListActionState(rendererBusy);
    this.syncRenderingModeControls();
    for (const input of this.getCompositeModeInputs()) {
      input.disabled = rendererBusy;
    }
    this.syncInteractionModeControls(rendererBusy);
    this.regionArcExactInput.disabled = rendererBusy;
    this.regionArcApproximateInput.disabled = rendererBusy;
    for (const input of this.getArcQualityInputs()) {
      input.disabled = rendererBusy || this.preserveArcRegions;
    }
    for (const input of this.getMinimumVisibilityInputs()) {
      input.disabled = rendererBusy;
    }
    this.syncBoardOutlineBoundsMarginControl(rendererBusy);
    for (const input of this.getDrillOutlineInputs()) {
      input.disabled = rendererBusy;
    }
    for (const input of this.getPthPlatingInputs()) {
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

  updateEmptyLayerListActionState(disabled) {
    const item = this.layerList.querySelector(".layer-empty-item");
    if (!item) return;

    item.setAttribute("aria-disabled", String(disabled));
    item.tabIndex = disabled ? -1 : 0;
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
    if (this.selectedFeature) {
      return formatSelectedFeatureSummary(this.selectedFeature, {
        unit: this.measurementUnit,
      });
    }

    if (this.layers.length === 0) {
      return "No bounds";
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const layer of this.layers) {
      const bounds = this.getLayerDisplayBounds(layer);
      if (!bounds) continue;
      minX = Math.min(minX, bounds.minX);
      maxX = Math.max(maxX, bounds.maxX);
      minY = Math.min(minY, bounds.minY);
      maxY = Math.max(maxY, bounds.maxY);
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
    this.flushLazyViewportRender();
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
    this.flushLazyViewportRender();
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
    this.flushLazyViewportRender();
    this.screenshotExporter.openDialog();
  }

  closeScreenshotDialog() {
    this.screenshotExporter.closeDialog();
  }

  getSelectedScreenshotScale() {
    return this.screenshotExporter.getSelectedScale();
  }

  updateScreenshotResolutionPreview() {
    this.flushLazyViewportRender();
    this.screenshotExporter.updateResolutionPreview();
  }

  shouldTileScreenshot(scale) {
    return this.screenshotExporter.shouldTile(scale);
  }

  get isExportingScreenshot() {
    return this.screenshotExporter.isExporting;
  }

  async exportScreenshot({ includeBackground = false, scale = 1 } = {}) {
    this.flushLazyViewportRender();
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
    this.wasmMemoryExhausted = false;
    if (this.layers.length === 0) {
      this.disposeInteractionProcessor();
      this.featurePickingAvailable = this.interactionsEnabled;
      this.configureWasmProcessorOptions(this.wasmProcessor, {
        interactionsEnabled: this.interactionsEnabled,
      });
    }
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
      if (this.wasmMemoryExhausted) {
        results.push(...Array(layerSources.length - index).fill(false));
        break;
      }
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
        if (isResolved) {
          return;
        }
        // Allow early finish when WASM memory is exhausted and no tasks are running.
        // Un-started tasks will never complete, so we finalize with partial results.
        const memoryExhausted = this.wasmMemoryExhausted && activeTasks === 0;
        if (!memoryExhausted && completedTasks < total) {
          return;
        }

        isResolved = true;
        let didCommitLayer = false;
        const committedLayers = [];
        for (let index = 0; index < layerRecords.length; index++) {
          const layerRecord = layerRecords[index];
          if (layerRecord) {
            this.prepareLayerMetadata(layerRecord);
            this.commitLayerMetadata(layerRecord, { updateUiState: false });
            committedLayers.push(layerRecord);
            layerRecords[index] = null;
            didCommitLayer = true;
          }
        }
        restorePendingLayerRecords();
        void (async () => {
          if (didCommitLayer) {
            this.updateUiState();
            await this.buildInteractionLayersForRecords(committedLayers, {
              title,
            });
          }
          resolve(results);
        })().catch(reject);
      };

      const launchMore = () => {
        if (this.wasmMemoryExhausted) {
          finishIfDone();
          return;
        }
        while (activeTasks < concurrency && scheduledTasks < total) {
          const task = this.pickNextLayerParseTask(parseTasks);
          if (!task) break;

          task.scheduled = true;
          scheduledTasks++;
          const { index, source } = task;
          activeTasks++;

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
      scheduled: false,
    }));
  }

  pickNextLayerParseTask(parseTasks) {
    return parseTasks.find((task) => !task.scheduled) ?? null;
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

  async parseLayerContent(
    content,
    offset,
    parseWorkerPool,
    parseOptionOverrides = {},
  ) {
    const normalizedOffset = normalizeLayerOffset(offset);
    const parseOptions = this.getParseOptions(parseOptionOverrides);

    if (parseWorkerPool) {
      return parseWorkerPool.parse(content, normalizedOffset, parseOptions);
    }

    const parsePayloadWithOptions =
      this.wasmModule?.parse_gerber_layer_payload_with_options;
    if (
      parseOptions.interactionsEnabled &&
      typeof parsePayloadWithOptions === "function"
    ) {
      this.reserveWasmInputCapacity(content);
      const payload = parsePayloadWithOptions(
        content,
        normalizedOffset.x,
        normalizedOffset.y,
        parseOptions.preserveArcRegions,
        parseOptions.arcTessellationQuality,
      );
      return {
        renderPayload: payload.renderPayload,
        interactionPayload: payload.interactionPayload ?? null,
      };
    }
    if (parseOptions.interactionsEnabled) {
      throw new Error(
        "Interaction parsing requires an updated WASM module",
      );
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
      return {
        renderPayload: parseWithOptions(
          content,
          normalizedOffset.x,
          normalizedOffset.y,
          parseOptions.preserveArcRegions,
          parseOptions.arcTessellationQuality,
        ),
        interactionPayload: null,
      };
    }

    if (
      !parseOptions.preserveArcRegions ||
      typeof this.wasmModule?.parse_gerber_layer !== "function"
    ) {
      throw new Error("Parallel parsing requires an updated WASM module");
    }

    this.reserveWasmInputCapacity(content);
    return {
      renderPayload: this.wasmModule.parse_gerber_layer(
        content,
        normalizedOffset.x,
        normalizedOffset.y,
      ),
      interactionPayload: null,
    };
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
      const { renderPayload, interactionPayload = null } = await this.parseLayerContent(
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
        parsedLayer: renderPayload,
        interactionPayload,
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
      // Yield one frame so the browser can repaint the progress modal before
      // the synchronous WASM parse+interaction-build blocks the main thread.
      await new Promise((resolve) => requestAnimationFrame(resolve));

      let layerRecord = null;
      if (isDrillSource(source)) {
        layerRecord = await this.addDrillLayer(name, content, {
          offset: source.offset,
        });
      } else {
        let renderPayload = null;
        let interactionPayload = null;
        try {
          const parseResult = await this.parseLayerContent(
            content,
            source.offset,
            null,
          );
          renderPayload = parseResult.renderPayload;
          interactionPayload = parseResult.interactionPayload ?? null;
          layerRecord = await this.addParsedLayer(name, renderPayload, {
            offset: source.offset,
            sourceContent: content,
          });
          layerRecord.interactionPayload = interactionPayload;
          await this.buildInteractionLayersForRecords([layerRecord], { title });
        } finally {
          renderPayload = null;
          interactionPayload = null;
        }
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

    if (this.wasmMemoryExhausted) {
      const completed = this.markLayerLoadComplete(progress);
      this.updateLoadingModal({
        title,
        stage: "Skipped",
        fileName: name,
        current: completed,
        total,
      });
      parseResult.parsedLayer = null;
      parseResult.interactionPayload = null;
      parseResult.sourceContent = null;
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
          interactionPayload: parseResult.interactionPayload,
        },
      );
      layerRecord.interactionPayload = parseResult.interactionPayload ?? null;
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
      parseResult.interactionPayload = null;
      parseResult.sourceContent = null;
    }
  }

  async buildInteractionLayersForRecords(
    layerRecords,
    { title = "Loading files" } = {},
  ) {
    if (!this.interactionsEnabled || !this.featurePickingAvailable) {
      this.clearInteractionPayloads(layerRecords);
      return;
    }

    const candidates = layerRecords.filter(
      (layer) =>
        layer &&
        !isDrillLayer(layer) &&
        layer.interactionPayload &&
        Number.isFinite(Number(layer.layerId)),
    );
    if (candidates.length === 0) {
      this.clearInteractionPayloads(layerRecords);
      return;
    }

    let processor = this.interactionProcessor;
    try {
      if (!processor) {
        processor = this.createInteractionProcessor();
        this.interactionProcessor = processor;
      }
      if (typeof processor.add_interaction_payload !== "function") {
        throw new Error("Feature picking requires an updated WASM module");
      }

      this.featurePickingAvailable = false;
      this.clearSelectedFeature({ refresh: false });
      for (const [index, layer] of candidates.entries()) {
        this.updateLoadingModal({
          title,
          stage: "Building picking index",
          fileName: layer.name,
          current: index,
          total: candidates.length,
        });
        await new Promise((resolve) => requestAnimationFrame(resolve));
        this.ensureInteractionMemoryHeadroom();
        processor.add_interaction_payload(layer.layerId, layer.interactionPayload);
      }

      this.featurePickingAvailable = true;
      this.updateLoadingModal({
        title,
        stage: "Picking ready",
        current: candidates.length,
        total: candidates.length,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Interaction] Failed to build picking index:", error);
      this.disableFeaturePickingForCurrentDocument(
        "Feature picking failed",
        `Picking data could not be built; feature picking is disabled for this document: ${message}`,
        { abandon: isFatalWasmRuntimeError(error) },
      );
    } finally {
      this.clearInteractionPayloads(layerRecords);
      this.updateUiState();
    }
  }

  clearInteractionPayloads(layerRecords) {
    for (const layer of layerRecords) {
      if (layer) {
        layer.interactionPayload = null;
      }
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

  getWasmLinearMemoryBytes() {
    const byteLength = Number(this.wasmExports?.memory?.buffer?.byteLength);
    return Number.isFinite(byteLength) && byteLength > 0 ? byteLength : null;
  }

  hasWasmLinearMemoryHeadroom(limitBytes) {
    const currentBytes = this.getWasmLinearMemoryBytes();
    if (!Number.isFinite(currentBytes)) {
      return true;
    }
    return currentBytes < limitBytes;
  }

  ensureRenderPayloadMemoryHeadroom() {
    if (this.hasWasmLinearMemoryHeadroom(WASM_LINEAR_MEMORY_RENDER_LIMIT_BYTES)) {
      return;
    }

    this.wasmMemoryExhausted = true;
    throw new Error("WASM memory limit reached");
  }

  ensureInteractionMemoryHeadroom() {
    if (
      this.hasWasmLinearMemoryHeadroom(WASM_LINEAR_MEMORY_INTERACTION_LIMIT_BYTES)
    ) {
      return;
    }
    throw new Error("WASM memory limit reached");
  }

  createLayerRecoverySnapshot(layer) {
    const snapshot = {
      id: layer.id,
      layerId: layer.layerId,
      kind: layer.kind ?? GERBER_LAYER_KIND,
      name: layer.name,
      visible: layer.visible,
      color: layer.color ? [...layer.color] : null,
      inverted: Boolean(layer.inverted),
      invertedLayerId: layer.invertedLayerId ?? null,
      invertedOutlineLayerId: layer.invertedOutlineLayerId ?? null,
      invertedErrorKey: layer.invertedErrorKey ?? null,
      invertedSourceKey: layer.invertedSourceKey ?? null,
      sourceContent: layer.sourceContent,
      offset: { ...normalizeLayerOffset(layer.offset) },
      bounds: layer.bounds ? { ...layer.bounds } : null,
      renderBounds: layer.renderBounds ? { ...layer.renderBounds } : null,
    };
    if (isDrillLayer(layer)) {
      snapshot.outlineLayerId = layer.outlineLayerId;
      snapshot.fillLayerId = layer.fillLayerId;
      snapshot.drillMetadata = layer.drillMetadata;
      snapshot.drillType = layer.drillType;
      snapshot.rawBounds = layer.rawBounds ? { ...layer.rawBounds } : null;
    }
    return snapshot;
  }

  async restoreLayerFromSnapshot(layer) {
    const options = {
      id: layer.id,
      visible: layer.visible,
      color: layer.color,
      inverted: layer.inverted,
      sourceContent: layer.sourceContent,
      offset: layer.offset,
      drillType: layer.drillType,
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

  disposeWasmProcessor({ abandon = false } = {}) {
    if (!this.wasmProcessor) return;

    const processor = this.wasmProcessor;
    this.wasmProcessor = null;
    this.disposeWasmProcessorInstance(processor, "processor", { abandon });
  }

  disposeInteractionProcessor({ abandon = false } = {}) {
    if (!this.interactionProcessor) return;

    const processor = this.interactionProcessor;
    this.interactionProcessor = null;
    this.disposeWasmProcessorInstance(processor, "interaction processor", {
      abandon,
    });
  }

  getFeaturePickingProcessorForGerber() {
    if (!this.interactionsEnabled || !this.featurePickingAvailable) {
      return null;
    }
    return this.interactionProcessor ?? this.wasmProcessor;
  }

  getFeaturePickingProcessorForLayer(layer) {
    if (!this.interactionsEnabled || !this.featurePickingAvailable) {
      return null;
    }
    return isDrillLayer(layer)
      ? this.wasmProcessor
      : this.getFeaturePickingProcessorForGerber();
  }

  disableFeaturePickingForCurrentDocument(
    title,
    detail,
    { abandon = false } = {},
  ) {
    this.featurePickingAvailable = false;
    this.disposeInteractionProcessor({ abandon });
    this.clearSelectedFeature({ refresh: false });
    this.addDiagnostic("error", title, detail);
    this.showError(`${title}: ${detail}`);
    this.updateUiState();
    this.requestRender();
  }

  disposeWasmProcessorInstance(processor, label = "processor", { abandon = false } = {}) {
    if (!processor) return;
    if (abandon) {
      try {
        processor.__destroy_into_raw?.();
      } catch (error) {
        console.warn(`[WASM] Failed to abandon ${label}:`, error);
      }
      return;
    }
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
      this.disposeWasmProcessor({ abandon: true });
      this.disposeInteractionProcessor({ abandon: true });
      this.featurePickingAvailable = false;
      this.createWebGlProcessor();
      this.disableProcessorInteractions(this.wasmProcessor);
      this.clearSelectedFeature({ refresh: false });
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
      this.disposeWasmProcessor({ abandon: true });
      this.disposeInteractionProcessor({ abandon: true });
      this.featurePickingAvailable = false;
      this.layers = [];
      this.clearSelectedFeature({ refresh: false });
      this.createWebGlProcessor();
      this.disableProcessorInteractions(this.wasmProcessor);
      this.resizeCanvas({ allowProcessorResize: true, preserveViewState: viewState });

      let restoreCausedFatalError = false;
      for (const layer of layerSnapshot) {
        try {
          await this.restoreLayerFromSnapshot(layer);
        } catch (restoreError) {
          const message = getErrorMessage(restoreError);
          console.error(`[WASM] Failed to restore layer ${layer.name}:`, restoreError);
          this.addDiagnostic("error", `Restore failed: ${layer.name}`, message);
          if (isFatalWasmRuntimeError(restoreError)) {
            restoreCausedFatalError = true;
            break;
          }
        }
      }

      if (restoreCausedFatalError) {
        // The new processor also OOM'd during restore; create a fresh empty one
        // so subsequent callers don't encounter a trapped WASM module.
        this.layers = [];
        this.disposeWasmProcessor({ abandon: true });
        this.createWebGlProcessor();
        this.disableProcessorInteractions(this.wasmProcessor);
        this.resizeCanvas({ allowProcessorResize: true, preserveViewState: viewState });
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
      inverted: options.inverted ?? false,
      invertedLayerId: options.invertedLayerId ?? null,
      invertedOutlineLayerId: options.invertedOutlineLayerId ?? null,
      invertedErrorKey: null,
      invertedSourceKey: null,
      sourceName: options.sourceName ?? name,
      sourceContent: options.sourceContent,
      offset: normalizeLayerOffset(options.offset),
      renderBounds: options.renderBounds ?? null,
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
      layer.drillType = layer.drillType ?? getDrillType(layer.name);
      layer.color = layer.color
        ? [...layer.color]
        : getDefaultDrillColor(layer.name);
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
    const layer = await this.createGerberLayerRecord(name, content, options);
    return this.commitLayerMetadata(layer);
  }

  async createGerberLayerRecord(
    name,
    content,
    options = {},
    processor = this.wasmProcessor,
  ) {
    try {
      if (!options.skipFatalRecovery) {
        await this.waitForWasmProcessorRecovery();
        if (this.wasmMemoryExhausted) {
          throw new Error("WASM memory limit reached");
        }
      }
      if (!processor || this.isWebGlContextLost) {
        throw new Error("WebGL renderer is not available");
      }

      // add layer to WASM processor and get layer ID
      this.ensureParserOptionsSupported({}, processor);
      this.reserveWasmInputCapacity(content);
      const offset = normalizeLayerOffset(options.offset);
      if (
        hasLayerOffset(offset) &&
        typeof processor.add_layer_with_offset !== "function"
      ) {
        throw new Error("Layer offset requires an updated WASM module");
      }
      const layerId = hasLayerOffset(offset)
        ? processor.add_layer_with_offset(content, offset.x, offset.y)
        : processor.add_layer(content);
      return this.createLayerMetadata(name, layerId, {
        ...options,
        sourceContent: options.sourceContent ?? content,
        offset,
      }, processor);
    } catch (error) {
      if (isNoGeometryError(getErrorMessage(error))) {
        console.warn(`[Layer] Skipped layer ${name}:`, error);
        throw error;
      }

      if (isFatalWasmRuntimeError(error) && !options.skipFatalRecovery) {
        await this.recoverWasmProcessorAfterFatalError(name, error);
        this.wasmMemoryExhausted = true;
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
        if (this.wasmMemoryExhausted) {
          throw new Error("WASM memory limit reached");
        }
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
      const drillType = options.drillType ?? getDrillType(name);
      const outlineStyle = this.getDrillOutlineStyle({ drillType });
      const rawBounds = {
        minX: bounds.min_x,
        maxX: bounds.max_x,
        minY: bounds.min_y,
        maxY: bounds.max_y,
      };
      const layer = {
        id: options.id ?? null,
        kind: DRILL_LAYER_KIND,
        name,
        drillType,
        visible: options.visible ?? true,
        color: options.color ? [...options.color] : getDefaultDrillColor(name),
        layerId: outlineLayerId,
        outlineLayerId,
        fillLayerId,
        drillMetadata: normalizeDrillMetadata(result?.metadata),
        sourceContent: options.sourceContent ?? content,
        offset,
        rawBounds,
        bounds: expandBounds(rawBounds, outlineStyle.worldMm),
      };
      this.applyDrillLayerOutlineStyle(layer, processor);
      return layer;
    } catch (error) {
      if (isFatalWasmRuntimeError(error) && !options.skipFatalRecovery) {
        await this.recoverWasmProcessorAfterFatalError(name, error);
        this.wasmMemoryExhausted = true;
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
        if (this.wasmMemoryExhausted) {
          throw new Error("WASM memory limit reached");
        }
      }
      if (!processor || this.isWebGlContextLost) {
        throw new Error("WebGL renderer is not available");
      }

      let layerId;
      this.ensureRenderPayloadMemoryHeadroom();
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
        this.wasmMemoryExhausted = true;
      }

      console.error(`[Layer] Failed to add parsed layer ${name}:`, error);
      throw error;
    }
  }

  requestRender() {
    this.cancelLazyViewportRender();

    if (this.pendingRenderFrame !== null) {
      return;
    }

    this.pendingRenderFrame = requestAnimationFrame(() => {
      this.pendingRenderFrame = null;
      this.render();
    });
  }

  scheduleLazyViewportRender(delayMs = LAZY_WHEEL_RENDER_DELAY_MS) {
    if (this.pendingLazyRenderTimer !== null) {
      clearTimeout(this.pendingLazyRenderTimer);
    }

    this.pendingLazyRenderTimer = window.setTimeout(() => {
      this.pendingLazyRenderTimer = null;
      this.lazyViewportRenderState = null;
      this.clearViewportCssTransform();
      this.syncRenderingModeControls();
      this.requestRender();
    }, delayMs);
    this.syncRenderingModeControls();
  }

  flushLazyViewportRender() {
    const hadPendingRender = this.pendingLazyRenderTimer !== null;
    const hadViewportTransform = this.isViewportTransformActive;
    this.cancelLazyViewportRender();
    if (hadPendingRender || hadViewportTransform) {
      this.requestRender();
    }
  }

  cancelLazyViewportRender() {
    const hadLazyViewportState =
      this.pendingLazyRenderTimer !== null ||
      this.lazyViewportRenderState !== null ||
      this.isViewportTransformActive;
    if (this.pendingLazyRenderTimer !== null) {
      clearTimeout(this.pendingLazyRenderTimer);
      this.pendingLazyRenderTimer = null;
    }
    this.lazyViewportRenderState = null;
    this.clearViewportCssTransform();
    if (hadLazyViewportState) {
      this.syncRenderingModeControls();
    }
  }

  cancelPendingRenderFrame() {
    if (this.pendingRenderFrame === null) {
      return;
    }
    cancelAnimationFrame(this.pendingRenderFrame);
    this.pendingRenderFrame = null;
  }

  flushPendingRenderFrame() {
    if (this.pendingRenderFrame === null) {
      return;
    }
    this.cancelPendingRenderFrame();
    this.render();
  }

  isLazyViewportPreviewActive() {
    return (
      this.pendingLazyRenderTimer !== null ||
      this.lazyViewportRenderState !== null
    );
  }

  applyViewportCssTransform(transform, origin = "50% 50%") {
    this.isViewportTransformActive = true;
    this.canvas.style.transformOrigin = origin;
    this.canvas.style.transform = transform;
  }

  clearViewportCssTransform() {
    if (!this.isViewportTransformActive) {
      return;
    }
    this.isViewportTransformActive = false;
    this.canvas.style.transform = "";
    this.canvas.style.transformOrigin = "";
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
      const { activeLayerIds, colorData, blendModes, alpha } =
        this.getRenderLayerPayload();

      // Render with active layers
      if (blendModes.some((mode) => mode !== 0)) {
        if (typeof this.wasmProcessor.render_with_clear_and_blend_modes !== "function") {
          throw new Error("Stack compositing and drill rendering require an updated WASM module");
        }
        this.wasmProcessor.render_with_clear_and_blend_modes(
          activeLayerIds,
          colorData,
          blendModes,
          this.getViewScaleX(),
          this.getViewScaleY(),
          this.camera.offsetX,
          this.camera.offsetY,
          alpha,
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
          alpha,
        );
      }
      this.renderSelectedFeatureHighlight();
      this.zoomReadout.textContent = this.formatZoom();
      this.boundsReadout.textContent = this.formatCombinedBounds();
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Render] Failed to render:", error);
      this.addDiagnostic("error", "Render failed", message);
    }

    this.renderMeasurements();
  }

  renderSelectedFeatureHighlight() {
    const pickingProcessor = this.getFeaturePickingProcessorForLayer(
      this.selectedFeature?.layer,
    );
    if (
      !this.selectedFeature ||
      typeof pickingProcessor?.render_interaction_highlight !== "function"
    ) {
      return;
    }

    try {
      if (this.clearSelectedFeatureIfUnavailable()) {
        return;
      }
      pickingProcessor.render_interaction_highlight(
        this.selectedFeature.layerId,
        this.selectedFeature.featureId,
        this.getViewScaleX(),
        this.getViewScaleY(),
        this.camera.offsetX,
        this.camera.offsetY,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("[Render] Failed to render feature highlight:", error);
      this.addDiagnostic("error", "Feature highlight failed", message);
      this.clearSelectedFeature();
    }
  }

  getVisibleGerberBounds({
    excludeLayerId = null,
    selectedLayerIds = null,
    useRenderBounds = false,
  } = {}) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let count = 0;

    for (const layer of this.layers) {
      if (
        isDrillLayer(layer) ||
        !layer.visible ||
        layer.id === excludeLayerId ||
        (selectedLayerIds && !selectedLayerIds.has(layer.id)) ||
        !(useRenderBounds ? getLayerRenderBounds(layer) : getLayerRawBounds(layer))
      ) {
        continue;
      }

      const bounds = useRenderBounds ? getLayerRenderBounds(layer) : getLayerRawBounds(layer);
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

  getLayerDisplayBounds(layer, selectedLayerIds = null) {
    if (!layer?.inverted || isDrillLayer(layer)) {
      return getLayerRenderBounds(layer);
    }
    const fillSource = this.getInvertedFillSource(layer, selectedLayerIds);
    const targetRenderBounds = getLayerRenderBounds(layer);
    if (
      layer.invertedErrorKey &&
      !this.hasInvertedLayerCache(layer)
    ) {
      return targetRenderBounds;
    }
    if (fillSource?.type === "outline") {
      const targetOffset = normalizeLayerOffset(layer.offset);
      const sourceKey = this.getInvertedLayerSourceKey(layer, fillSource, targetOffset);
      if (
        layer.renderBounds &&
        String(layer.invertedSourceKey ?? "").startsWith(`${sourceKey}|fallback:`)
      ) {
        return (
          this.getInvertedBoundsFillSource(layer, selectedLayerIds)?.bounds ??
          layer.renderBounds
        );
      }
    }
    return fillSource?.bounds ?? targetRenderBounds;
  }

  getViewportFitLayers(selectedLayerIds) {
    return this.layers.map((layer) => {
      const bounds = this.getLayerDisplayBounds(layer, selectedLayerIds);
      if (bounds === getLayerRenderBounds(layer)) {
        return layer;
      }
      return {
        ...layer,
        renderBounds: bounds,
      };
    });
  }

  findAutomaticBoardOutlineLayer(targetLayer = null) {
    return (
      this.layers.find(
        (layer) =>
          layer.id !== targetLayer?.id &&
          typeof layer.sourceContent === "string" &&
          isBoardOutlineLayer(layer),
      ) ?? null
    );
  }

  getInvertedFillSource(layer, selectedLayerIds) {
    const selectedOutlineLayer =
      this.boardOutlineSelection !== BOARD_OUTLINE_AUTO &&
      this.boardOutlineSelection !== BOARD_OUTLINE_BOUNDS
        ? this.layers.find((candidate) => candidate.id === this.boardOutlineSelection)
        : null;
    const outlineLayer =
      selectedOutlineLayer && selectedOutlineLayer.id !== layer.id
        ? selectedOutlineLayer
        : this.boardOutlineSelection === BOARD_OUTLINE_AUTO
          ? this.findAutomaticBoardOutlineLayer(layer)
          : null;

    if (outlineLayer && typeof outlineLayer.sourceContent === "string") {
      const outlineOffset = normalizeLayerOffset(outlineLayer.offset);
      return {
        type: "outline",
        key: `outline:${outlineLayer.id}:${outlineLayer.layerId}:${outlineOffset.x}:${outlineOffset.y}`,
        outlineLayer,
        outlineOffset,
        bounds: getLayerRenderBounds(outlineLayer),
      };
    }

    return this.getInvertedBoundsFillSource(layer, selectedLayerIds);
  }

  getInvertedBoundsFillSource(layer, selectedLayerIds) {
    const rawBounds = this.getVisibleGerberBounds({ selectedLayerIds });
    if (!rawBounds) {
      return null;
    }
    const margin = this.boardOutlineBoundsMarginMm;
    const bounds = expandBounds(rawBounds, margin);

    return {
      type: "bounds",
      key: `bounds:${bounds.minX}:${bounds.maxX}:${bounds.minY}:${bounds.maxY}:margin:${margin}`,
      bounds,
    };
  }

  addInvertedLayerToProcessor(layer, fillSource, targetOffset) {
    const processor = this.wasmProcessor;
    if (fillSource.type === "outline") {
      if (typeof processor.add_inverted_layer_with_outline !== "function") {
        throw new Error("Inverted outline rendering requires an updated WASM module.");
      }
      this.reserveWasmInputCapacity(layer.sourceContent);
      this.reserveWasmInputCapacity(fillSource.outlineLayer.sourceContent);
      return processor.add_inverted_layer_with_outline(
        layer.sourceContent,
        fillSource.outlineLayer.sourceContent,
        targetOffset.x,
        targetOffset.y,
        fillSource.outlineOffset.x,
        fillSource.outlineOffset.y,
      );
    }

    if (typeof processor.add_inverted_layer_with_bounds !== "function") {
      throw new Error("Inverted bounds rendering requires an updated WASM module.");
    }
    this.reserveWasmInputCapacity(layer.sourceContent);
    return processor.add_inverted_layer_with_bounds(
      layer.sourceContent,
      targetOffset.x,
      targetOffset.y,
      fillSource.bounds.minX,
      fillSource.bounds.maxX,
      fillSource.bounds.minY,
      fillSource.bounds.maxY,
    );
  }

  getInvertedFillSourceBounds(fillSource) {
    return fillSource.type === "outline" ? fillSource.bounds : fillSource.bounds;
  }

  getInvertedLayerSourceKey(layer, fillSource, targetOffset) {
    return `target:${layer.layerId}:${targetOffset.x}:${targetOffset.y}|${fillSource.key}`;
  }

  hasInvertedLayerCache(layer) {
    const rawInvertedLayerId = layer?.invertedLayerId;
    return (
      rawInvertedLayerId !== undefined &&
      rawInvertedLayerId !== null &&
      Number.isFinite(Number(rawInvertedLayerId))
    );
  }

  getInvertedFallbackSourceKey(sourceKey, fallbackSource) {
    return `${sourceKey}|fallback:${fallbackSource.key}`;
  }

  getCurrentInvertedFallbackSourceKey(layer, selectedLayerIds, sourceKey) {
    const fallbackSource = this.getInvertedBoundsFillSource(layer, selectedLayerIds);
    return fallbackSource
      ? this.getInvertedFallbackSourceKey(sourceKey, fallbackSource)
      : null;
  }

  recoverAfterFatalInvertedLayerError(layer, error) {
    this.wasmMemoryExhausted = true;
    layer.inverted = false;
    layer.invertedLayerId = null;
    layer.invertedSourceKey = null;
    layer.invertedErrorKey = "fatal-wasm-error";
    layer.renderBounds = null;
    this.addDiagnostic(
      "error",
      `Inverted layer failed: ${layer.name}`,
      `${getErrorMessage(error)}; inverted rendering was disabled for this layer.`,
    );
    if (
      this.pendingFatalWasmRecovery ||
      this.isRecoveringWasmProcessor ||
      this.isWebGlContextLost
    ) {
      return;
    }
    this.pendingFatalWasmRecovery = true;
    void Promise.resolve().then(async () => {
      try {
        await this.recoverWasmProcessorAfterFatalError(
          `inverted layer ${layer.name}`,
          error,
        );
      } catch (recoveryError) {
        console.error("[WASM] Failed to recover inverted layer renderer:", recoveryError);
        this.addDiagnostic(
          "error",
          "Renderer recovery failed",
          getErrorMessage(recoveryError),
        );
      } finally {
        this.pendingFatalWasmRecovery = false;
      }
    });
  }

  getInvertedRenderLayerId(layer, selectedLayerIds) {
    if (!layer.inverted) {
      return layer.layerId;
    }
    if (typeof layer.sourceContent !== "string") {
      this.reportInvertedLayerWarningOnce(
        layer,
        "missing-source",
        "Reload files before using inverted layer rendering.",
      );
      return layer.layerId;
    }

    const processor = this.wasmProcessor;
    const fillSource = this.getInvertedFillSource(layer, selectedLayerIds);
    if (!processor || !fillSource) {
      this.reportInvertedLayerWarningOnce(
        layer,
        "missing-fill-source",
        "Inverted layer rendering needs a board outline or visible layer bounds.",
      );
      return layer.layerId;
    }

    const targetOffset = normalizeLayerOffset(layer.offset);
    const sourceKey = this.getInvertedLayerSourceKey(layer, fillSource, targetOffset);
    const hasInvertedCache = this.hasInvertedLayerCache(layer);
    if (
      hasInvertedCache &&
      (layer.invertedSourceKey === sourceKey ||
        layer.invertedSourceKey ===
          this.getCurrentInvertedFallbackSourceKey(layer, selectedLayerIds, sourceKey))
    ) {
      if (layer.invertedSourceKey === sourceKey) {
        layer.renderBounds = this.getInvertedFillSourceBounds(fillSource);
      }
      return layer.invertedLayerId;
    }
    if (!hasInvertedCache && layer.invertedErrorKey === sourceKey) {
      layer.renderBounds = null;
      return layer.layerId;
    }

    this.removeInvertedLayerCache(layer);
    try {
      const invertedLayerId = this.addInvertedLayerToProcessor(
        layer,
        fillSource,
        targetOffset,
      );

      layer.invertedLayerId = Number(invertedLayerId);
      layer.invertedSourceKey = sourceKey;
      layer.invertedErrorKey = null;
      layer.renderBounds = this.getInvertedFillSourceBounds(fillSource);
      return layer.invertedLayerId;
    } catch (error) {
      if (isFatalWasmRuntimeError(error)) {
        this.recoverAfterFatalInvertedLayerError(layer, error);
        layer.renderBounds = null;
        return layer.layerId;
      }
      const message = getErrorMessage(error);
      if (
        fillSource.type === "outline" &&
        this.boardOutlineSelection === BOARD_OUTLINE_AUTO
      ) {
        const fallbackSource = this.getInvertedBoundsFillSource(layer, selectedLayerIds);
        if (fallbackSource) {
          const fallbackKey = this.getInvertedFallbackSourceKey(
            sourceKey,
            fallbackSource,
          );
          try {
            const invertedLayerId = this.addInvertedLayerToProcessor(
              layer,
              fallbackSource,
              targetOffset,
            );
            layer.invertedLayerId = Number(invertedLayerId);
            layer.invertedSourceKey = fallbackKey;
            layer.invertedErrorKey = null;
            layer.renderBounds = fallbackSource.bounds;
            this.reportInvertedLayerWarningOnce(
              layer,
              `${sourceKey}:fallback`,
              `${message}; using visible layer bounds instead.`,
            );
            return layer.invertedLayerId;
          } catch (fallbackError) {
            if (isFatalWasmRuntimeError(fallbackError)) {
              this.recoverAfterFatalInvertedLayerError(layer, fallbackError);
              layer.renderBounds = null;
              return layer.layerId;
            }
            this.reportInvertedLayerWarningOnce(
              layer,
              fallbackKey,
              getErrorMessage(fallbackError),
            );
          }
        }
      }
      this.reportInvertedLayerWarningOnce(layer, sourceKey, message);
      layer.renderBounds = null;
      return layer.layerId;
    }
  }

  reportInvertedLayerWarningOnce(layer, key, message) {
    if (layer.invertedErrorKey === key) return;
    layer.invertedErrorKey = key;
    this.addDiagnostic("warning", `Inverted layer skipped: ${layer.name}`, message);
  }

  removeInvertedLayerCache(layer) {
    const rawInvertedLayerId = layer?.invertedLayerId;
    const invertedLayerId = Number(rawInvertedLayerId);
    if (
      this.wasmProcessor &&
      rawInvertedLayerId !== undefined &&
      rawInvertedLayerId !== null &&
      Number.isFinite(invertedLayerId)
    ) {
      try {
        this.wasmProcessor.remove_layer(invertedLayerId);
      } catch (error) {
        console.warn("[Layer] Failed to remove inverted layer cache:", error);
      }
    }

    if (layer) {
      layer.invertedLayerId = null;
      layer.invertedSourceKey = null;
      layer.invertedErrorKey = null;
      layer.renderBounds = null;
    }
  }

  clearAllInvertedLayerCaches() {
    for (const layer of this.layers) {
      this.removeInvertedLayerCache(layer);
    }
  }

  getRenderLayerPayload() {
    const selectedLayerIds = this.getSelectedLayerIds();
    const activeLayerIds = [];
    const colorData = [];
    const blendModes = [];
    const alpha = this.getCompositeAlpha();
    const isStack = this.isStackCompositeMode();
    const backgroundColor = this.isCanvasLight
      ? [248 / 255, 250 / 255, 252 / 255]
      : [2 / 255, 6 / 255, 23 / 255];
    const drillAlpha = alpha > 0 ? 1 / alpha : 0;

    const gerberLayers = this.layers.filter(
      (layer) => !isDrillLayer(layer) && selectedLayerIds.has(layer.id),
    );
    const orderedGerberLayers = isStack
      ? [...gerberLayers].reverse()
      : gerberLayers;
    orderedGerberLayers.forEach((layer) => {
      activeLayerIds.push(this.getInvertedRenderLayerId(layer, selectedLayerIds));
      colorData.push(layer.color[0], layer.color[1], layer.color[2], 1);
      blendModes.push(isStack ? 1 : 0);
    });

    this.layers.forEach((layer) => {
      if (isDrillLayer(layer) && layer.visible && this.shouldRenderDrillOutline(layer)) {
        activeLayerIds.push(layer.outlineLayerId);
        colorData.push(
          layer.color[0],
          layer.color[1],
          layer.color[2],
          drillAlpha,
        );
        blendModes.push(1);
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
      alpha,
    };
  }

  getCompositeAlpha() {
    return this.isStackCompositeMode() ? 1 : this.globalAlpha;
  }

  renderMeasurements() {
    renderMeasurementOverlay({
      overlay: this.measurementOverlay,
      rect: this.getViewportRect(),
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
    this.flushLazyViewportRender();
    this.flushPendingRenderFrame();
    const fitView = this.calculateFitView();
    if (!fitView) return;

    this.camera.zoom = this.clampZoom(fitView.zoom);
    this.fitViewZoom = this.camera.zoom;
    this.camera.offsetX =
      fitView.targetX - fitView.centerX * this.getViewScaleX();
    this.camera.offsetY =
      fitView.targetY - fitView.centerY * this.getViewScaleY();

    this.resetSelectionCycle();
    this.requestRender();
    this.updateUiState();
  }

  getFitViewZoom() {
    const fitView = this.calculateFitView();
    if (!fitView) return null;
    return this.clampZoom(fitView.zoom);
  }

  calculateFitView() {
    const selectedLayerIds = this.getSelectedLayerIds();
    return calculateViewportFit({
      layers: this.getViewportFitLayers(selectedLayerIds),
      selectedLayerIds,
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
    if (this.shouldRenderViewportRealtime()) {
      const canvasPoint = this.getClampedCanvasClientPoint(e.clientX, e.clientY);
      if (canvasPoint) {
        this.zoomAtCanvasPoint(canvasPoint.x, canvasPoint.y, zoomChange);
      }
      return;
    }

    if (this.isPanning || this.isTouching) {
      return;
    }

    this.prepareLazyViewportPreview();
    const canvasPoint = this.getClampedCanvasClientPoint(e.clientX, e.clientY);
    if (
      !canvasPoint ||
      !this.applyZoomAtCanvasPoint(canvasPoint.x, canvasPoint.y, zoomChange)
    ) {
      this.cancelLazyViewportRender();
      return;
    }

    this.resetSelectionCycle();
    this.updateLazyViewportTransform();
    this.zoomReadout.textContent = this.formatZoom();
    this.renderMeasurements();
    this.scheduleLazyViewportRender();
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

  applyZoomAtCanvasPoint(clientX, clientY, zoomChange) {
    const didZoom = zoomCameraAtCanvasPoint({
      clientX,
      clientY,
      zoomChange,
      canvas: this.canvas,
      camera: this.camera,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      rect: this.getViewportRect(),
    });
    return didZoom;
  }

  getClampedCanvasClientPoint(clientX, clientY) {
    const rect = this.getViewportRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    return {
      x: Math.min(Math.max(clientX, rect.left), rect.right),
      y: Math.min(Math.max(clientY, rect.top), rect.bottom),
    };
  }

  zoomAtCanvasPoint(clientX, clientY, zoomChange) {
    if (this.applyZoomAtCanvasPoint(clientX, clientY, zoomChange)) {
      this.resetSelectionCycle();
      this.requestRender();
    }
  }

  prepareLazyViewportPreview() {
    this.flushPendingRenderFrame();
    this.clearViewportCssTransform();

    if (this.lazyViewportRenderState !== null) {
      return;
    }

    this.lazyViewportRenderState = this.captureViewportRenderState();
    this.syncRenderingModeControls();
  }

  captureViewportRenderState() {
    const rect = this.getViewportRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    return {
      rectWidth: rect.width,
      rectHeight: rect.height,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      viewScaleX: this.getViewScaleX(),
      viewScaleY: this.getViewScaleY(),
      offsetX: this.camera.offsetX,
      offsetY: this.camera.offsetY,
    };
  }

  getCurrentViewportRenderState(baseState) {
    return {
      rectWidth: baseState.rectWidth,
      rectHeight: baseState.rectHeight,
      canvasWidth: baseState.canvasWidth,
      canvasHeight: baseState.canvasHeight,
      viewScaleX: this.getViewScaleX(),
      viewScaleY: this.getViewScaleY(),
      offsetX: this.camera.offsetX,
      offsetY: this.camera.offsetY,
    };
  }

  updateLazyViewportTransform() {
    const baseState = this.lazyViewportRenderState;
    if (!baseState || baseState.viewScaleX === 0 || baseState.viewScaleY === 0) {
      return;
    }

    const originWorld = { x: 0, y: 0 };
    const basePoint = this.worldToCanvasPoint(originWorld, baseState);
    const currentPoint = this.worldToCanvasPoint(
      originWorld,
      this.getCurrentViewportRenderState(baseState),
    );
    if (!basePoint || !currentPoint) {
      return;
    }

    const scaleX = this.getViewScaleX() / baseState.viewScaleX;
    const scaleY = this.getViewScaleY() / baseState.viewScaleY;
    const translateX = currentPoint.x - basePoint.x * scaleX;
    const translateY = currentPoint.y - basePoint.y * scaleY;
    this.applyViewportCssTransform(
      `matrix(${scaleX}, 0, 0, ${scaleY}, ${translateX}, ${translateY})`,
      "0 0",
    );
  }

  handleMouseDown(e) {
    if (this.isRulerActive) {
      if (e.button !== 0) return;
      e.preventDefault();
      this.handleRulerCanvasClick(e.clientX, e.clientY);
      return;
    }

    if (e.button === 2) return; // Ignore right-click
    if (!this.shouldRenderViewportRealtime() && this.isLazyViewportPreviewActive()) {
      return;
    }
    this.isPanning = true;
    this.pointerGestureDidPan = false;
    this.lastMousePos.x = e.clientX;
    this.lastMousePos.y = e.clientY;
    this.mouseDownPos.x = e.clientX;
    this.mouseDownPos.y = e.clientY;
    if (!this.shouldRenderViewportRealtime()) {
      this.prepareLazyViewportPreview();
    }
    this.syncRenderingModeControls();
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

    const totalDeltaX = e.clientX - this.mouseDownPos.x;
    const totalDeltaY = e.clientY - this.mouseDownPos.y;

    if (this.shouldRenderViewportRealtime()) {
      if (
        Math.hypot(totalDeltaX, totalDeltaY) <=
        this.getViewportRelativeDistance(POINTER_TAP_MAX_MOVEMENT_VIEWPORT_RATIO)
      ) {
        return;
      }

      const deltaX = e.clientX - this.lastMousePos.x;
      const deltaY = e.clientY - this.lastMousePos.y;
      this.resetSelectionCycle();
      if (panCameraByScreenDelta({
        deltaX,
        deltaY,
        canvas: this.canvas,
        camera: this.camera,
        rect: this.getViewportRect(),
      })) {
        this.pointerGestureDidPan = true;
        this.lastMousePos.x = e.clientX;
        this.lastMousePos.y = e.clientY;
        this.requestRender();
      }
      return;
    }

    if (
      Math.hypot(totalDeltaX, totalDeltaY) <=
      this.getViewportRelativeDistance(POINTER_TAP_MAX_MOVEMENT_VIEWPORT_RATIO)
    ) {
      return;
    }

    const deltaX = e.clientX - this.lastMousePos.x;
    const deltaY = e.clientY - this.lastMousePos.y;
    this.resetSelectionCycle();
    if (panCameraByScreenDelta({
      deltaX,
      deltaY,
      canvas: this.canvas,
      camera: this.camera,
      rect: this.getViewportRect(),
    })) {
      this.pointerGestureDidPan = true;
      this.lastMousePos.x = e.clientX;
      this.lastMousePos.y = e.clientY;
      this.updateLazyViewportTransform();
      this.renderMeasurements();
    }
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
      rect: this.getViewportRect(),
    });
  }

  worldToCanvasPoint(point, renderState = null) {
    return worldToCanvasCoordinate({
      point,
      canvas: this.canvas,
      camera: this.camera,
      renderState,
      rect: renderState ? null : this.getViewportRect(),
    });
  }

  getViewportRect() {
    const rect = this.measurementOverlay.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }
    return this.canvas.getBoundingClientRect();
  }

  handleMouseUp(e) {
    if (!this.isPanning) return;

    this.isPanning = false;

    // Reset transform
    this.clearViewportCssTransform();

    const canvasRect = this.canvas.getBoundingClientRect();
    if (canvasRect.width === 0 || canvasRect.height === 0) {
      this.pointerGestureDidPan = false;
      this.cancelLazyViewportRender();
      this.syncRenderingModeControls();
      return;
    }

    const totalDeltaX = e.clientX - this.mouseDownPos.x;
    const totalDeltaY = e.clientY - this.mouseDownPos.y;
    if (
      !this.pointerGestureDidPan &&
      e.type === "mouseup" &&
      Math.hypot(totalDeltaX, totalDeltaY) <=
        this.getViewportRelativeDistance(POINTER_TAP_MAX_MOVEMENT_VIEWPORT_RATIO)
    ) {
      this.pointerGestureDidPan = false;
      this.cancelLazyViewportRender();
      this.syncRenderingModeControls();
      this.selectFeatureAtCanvasPoint(e.clientX, e.clientY, {
        inputType: "mouse",
      });
      return;
    }

    this.resetSelectionCycle();
    if (this.pointerGestureDidPan) {
      panCameraByScreenDelta({
        deltaX: e.clientX - this.lastMousePos.x,
        deltaY: e.clientY - this.lastMousePos.y,
        canvas: this.canvas,
        camera: this.camera,
        rect: this.getViewportRect(),
      });
    } else {
      panCameraByScreenDelta({
        deltaX: totalDeltaX,
        deltaY: totalDeltaY,
        canvas: this.canvas,
        camera: this.camera,
        rect: this.getViewportRect(),
      });
    }
    this.pointerGestureDidPan = false;
    this.syncRenderingModeControls();

    this.requestRender();
  }

  selectFeatureAtCanvasPoint(clientX, clientY, { inputType = "mouse" } = {}) {
    const point = this.canvasPointToWorld(clientX, clientY);
    if (!point || !this.interactionsEnabled || !this.featurePickingAvailable) {
      this.clearSelectedFeature();
      return;
    }

    const tolerance = this.getFeatureHitToleranceWorld(clientX, clientY, inputType);
    const shouldCycle = this.shouldCycleFeatureSelection(clientX, clientY, inputType);
    const hit = this.pickFeatureAcrossProcessors(point, tolerance, shouldCycle);
    this.selectedFeature = hit ? this.attachLayerToSelectedFeature(hit) : null;
    if (this.selectedFeature) {
      this.lastFeaturePick = { x: clientX, y: clientY, inputType };
    } else {
      this.resetSelectionCycle();
    }
    this.updateUiState();
    this.renderMeasurements();
    this.requestRender();
  }

  pickFeatureAcrossProcessors(point, tolerance, shouldCycle) {
    const selectedIsDrill = isDrillLayer(this.selectedFeature?.layer);
    if (shouldCycle && this.selectedFeature) {
      const primaryHit = selectedIsDrill
        ? this.pickFeatureWithProcessor(
            this.wasmProcessor,
            this.getVisibleDrillInteractionLayerIds(),
            point,
            tolerance,
            true,
          )
        : this.pickFeatureWithProcessor(
            this.getFeaturePickingProcessorForGerber(),
            this.getVisibleGerberInteractionLayerIds(),
            point,
            tolerance,
            true,
          );
      if (primaryHit && !this.isSelectedFeatureHit(primaryHit)) {
        return primaryHit;
      }

      const alternateHit = selectedIsDrill
        ? this.pickFeatureWithProcessor(
            this.getFeaturePickingProcessorForGerber(),
            this.getVisibleGerberInteractionLayerIds(),
            point,
            tolerance,
            false,
          )
        : this.pickFeatureWithProcessor(
            this.wasmProcessor,
            this.getVisibleDrillInteractionLayerIds(),
            point,
            tolerance,
            false,
          );
      return alternateHit ?? primaryHit;
    }

    return (
      this.pickFeatureWithProcessor(
        this.wasmProcessor,
        this.getVisibleDrillInteractionLayerIds(),
        point,
        tolerance,
        false,
      ) ??
      this.pickFeatureWithProcessor(
        this.getFeaturePickingProcessorForGerber(),
        this.getVisibleGerberInteractionLayerIds(),
        point,
        tolerance,
        false,
      )
    );
  }

  isSelectedFeatureHit(feature) {
    return (
      Number(feature?.layerId) === Number(this.selectedFeature?.layerId) &&
      Number(feature?.featureId) === Number(this.selectedFeature?.featureId)
    );
  }

  pickFeatureWithProcessor(processor, layerIds, point, tolerance, shouldCycle) {
    if (
      !processor ||
      layerIds.length === 0 ||
      typeof processor.pick_interaction_feature !== "function"
    ) {
      return null;
    }

    const selectedLayerId = Number(this.selectedFeature?.layerId);
    const canCycle =
      shouldCycle &&
      Number.isFinite(selectedLayerId) &&
      layerIds.includes(selectedLayerId) &&
      typeof processor.pick_interaction_feature_after === "function";
    const packedLayerIds = new Uint32Array(layerIds);
    return canCycle
      ? processor.pick_interaction_feature_after(
          packedLayerIds,
          point.x,
          point.y,
          tolerance,
          this.selectedFeature.layerId,
          this.selectedFeature.featureId,
        )
      : processor.pick_interaction_feature(
          packedLayerIds,
          point.x,
          point.y,
          tolerance,
        );
  }

  clearSelectedFeature({ refresh = true, resetCycle = true } = {}) {
    if (!this.selectedFeature) {
      if (resetCycle) {
        this.resetSelectionCycle();
      }
      return;
    }
    this.selectedFeature = null;
    if (resetCycle) {
      this.resetSelectionCycle();
    }
    if (!refresh) return;
    this.updateUiState();
    this.renderMeasurements();
    this.requestRender();
  }

  resetSelectionCycle() {
    this.lastFeaturePick = null;
  }

  getViewportRelativeDistance(ratio) {
    const rect = this.getViewportRect();
    const basis = Math.min(rect.width, rect.height);
    if (!Number.isFinite(basis) || basis <= 0) {
      return 0;
    }
    return basis * ratio;
  }

  shouldCycleFeatureSelection(clientX, clientY, inputType) {
    if (!this.selectedFeature || !this.lastFeaturePick) {
      return false;
    }
    if (this.lastFeaturePick.inputType !== inputType) {
      return false;
    }

    const radius = inputType === "touch"
      ? this.getViewportRelativeDistance(FEATURE_CYCLE_TOUCH_VIEWPORT_RATIO)
      : this.getViewportRelativeDistance(FEATURE_CYCLE_MOUSE_VIEWPORT_RATIO);
    return (
      radius > 0 &&
      Math.hypot(
        clientX - this.lastFeaturePick.x,
        clientY - this.lastFeaturePick.y,
      ) <= radius
    );
  }

  clearSelectedFeatureForHiddenLayer(layer) {
    if (!layer.visible && this.selectedFeature?.layerId === this.getLayerInteractionLayerId(layer)) {
      this.clearSelectedFeature();
    }
  }

  attachLayerToSelectedFeature(feature) {
    const layerId = Number(feature?.layerId);
    const featureId = Number(feature?.featureId);
    if (!Number.isFinite(layerId) || !Number.isFinite(featureId)) {
      return null;
    }

    const layer = this.layers.find(
      (candidate) => this.getLayerInteractionLayerId(candidate) === layerId,
    );
    if (!layer || !layer.visible) {
      return null;
    }

    return {
      ...feature,
      layerId,
      featureId,
      layer,
    };
  }

  getSelectedFeatureLayer() {
    if (!this.selectedFeature) return null;
    return this.layers.find(
      (layer) =>
        this.getLayerInteractionLayerId(layer) === this.selectedFeature.layerId,
    ) ?? null;
  }

  clearSelectedFeatureIfUnavailable() {
    const layer = this.getSelectedFeatureLayer();
    if (this.selectedFeature && (!layer || !layer.visible)) {
      this.clearSelectedFeature();
      return true;
    }
    return false;
  }

  getVisibleGerberInteractionLayerIds() {
    const layerIds = [];
    // this.layers follows the layer-list UI order (top-to-bottom). Rust scans
    // ids in reverse, so pass bottom-to-top ids for top-first picking.
    for (const layer of [...this.layers].reverse()) {
      if (layer.visible && !isDrillLayer(layer)) {
        layerIds.push(layer.layerId);
      }
    }
    return layerIds.filter(Number.isFinite);
  }

  getVisibleDrillInteractionLayerIds() {
    const layerIds = [];
    // Drill layers are rendered in this.layers order, so the same order is
    // bottom-to-top for Rust's reverse scan.
    for (const layer of this.layers) {
      if (layer.visible && isDrillLayer(layer)) {
        layerIds.push(layer.outlineLayerId);
      }
    }
    return layerIds.filter(Number.isFinite);
  }

  getLayerInteractionLayerId(layer) {
    return isDrillLayer(layer) ? layer?.outlineLayerId : layer?.layerId;
  }

  getFeatureHitToleranceWorld(clientX, clientY, inputType = "mouse") {
    const point = this.canvasPointToWorld(clientX, clientY);
    const radius = inputType === "touch"
      ? this.getViewportRelativeDistance(FEATURE_PICK_TOUCH_VIEWPORT_RATIO)
      : this.getViewportRelativeDistance(FEATURE_PICK_MOUSE_VIEWPORT_RATIO);
    const offsetPoint = this.canvasPointToWorld(clientX + radius, clientY);
    if (!point || !offsetPoint) {
      return 0.05;
    }
    return Math.max(
      0.01,
      Math.hypot(offsetPoint.x - point.x, offsetPoint.y - point.y),
    );
  }

  // Touch event handlers
  handleTouchStart(e) {
    e.preventDefault();

    if (
      !this.isTouching &&
      !this.shouldRenderViewportRealtime() &&
      this.isLazyViewportPreviewActive()
    ) {
      return;
    }

    this.isTouching = true;
    this.touches = Array.from(e.touches);
    this.syncRenderingModeControls();

    if (this.isRulerActive) {
      if (this.touches.length === 1) {
        this.startRulerTouch(this.touches[0]);
        return;
      }

      this.resetRulerTouch();
    }

    if (this.touches.length === 2) {
      this.cancelTouchTapTracking();
      this.resetSelectionCycle();
      this.touchGestureWasMultitouch = true;
      // Two-finger gesture: pinch-to-zoom
      this.initialPinchDistance = this.calculateTouchDistance(
        this.touches[0],
        this.touches[1],
      );
      this.lastPinchDistance = this.initialPinchDistance;

      const center = this.getTouchCenter(this.touches[0], this.touches[1]);
      this.lastTouchCenter = center;
      if (!this.shouldRenderViewportRealtime()) {
        this.prepareLazyViewportPreview();
      }
    } else if (this.touches.length === 1) {
      this.startTouchTapTracking(this.touches[0]);
      // Single finger: pan
      const center = {
        x: this.touches[0].clientX,
        y: this.touches[0].clientY,
      };
      this.lastTouchCenter = center;
      if (!this.shouldRenderViewportRealtime()) {
        this.prepareLazyViewportPreview();
      }
    } else {
      this.cancelTouchTapTracking();
      this.resetSelectionCycle();
      this.touchGestureWasMultitouch = true;
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
      this.cancelTouchTapTracking();
      this.resetSelectionCycle();
      this.touchGestureWasMultitouch = true;
      // Two-finger gesture: pinch-to-zoom + pan
      const currentDistance = this.calculateTouchDistance(
        this.touches[0],
        this.touches[1],
      );
      const currentCenter = this.getTouchCenter(
        this.touches[0],
        this.touches[1],
      );

      if (!this.shouldRenderViewportRealtime()) {
        let didUpdate = false;
        if (this.lastPinchDistance !== null) {
          didUpdate = this.applyZoomAtCanvasPoint(
            currentCenter.x,
            currentCenter.y,
            currentDistance / this.lastPinchDistance,
          ) || didUpdate;
          this.lastPinchDistance = currentDistance;
        }
        didUpdate = panCameraByScreenDelta({
          deltaX: currentCenter.x - this.lastTouchCenter.x,
          deltaY: currentCenter.y - this.lastTouchCenter.y,
          canvas: this.canvas,
          camera: this.camera,
          rect: this.getViewportRect(),
        }) || didUpdate;
        this.lastTouchCenter = currentCenter;
        if (didUpdate) {
          this.updateLazyViewportTransform();
          this.renderMeasurements();
        }
        return;
      }

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
        rect: this.getViewportRect(),
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
      this.updateTouchTapTracking(this.touches[0]);
      if (this.touchTapCandidate) {
        return;
      }

      this.resetSelectionCycle();
      if (!this.shouldRenderViewportRealtime()) {
        if (panCameraByScreenDelta({
          deltaX: currentPos.x - this.lastTouchCenter.x,
          deltaY: currentPos.y - this.lastTouchCenter.y,
          canvas: this.canvas,
          camera: this.camera,
          rect: this.getViewportRect(),
        })) {
          this.updateLazyViewportTransform();
          this.renderMeasurements();
        }
        this.lastTouchCenter = currentPos;
        return;
      }

      const deltaX = currentPos.x - this.lastTouchCenter.x;
      const deltaY = currentPos.y - this.lastTouchCenter.y;
      panCameraByScreenDelta({
        deltaX,
        deltaY,
        canvas: this.canvas,
        camera: this.camera,
        rect: this.getViewportRect(),
      });

      this.lastTouchCenter = currentPos;
      this.requestRender();
    } else if (this.touches.length > 2) {
      this.cancelTouchTapTracking();
      this.resetSelectionCycle();
      this.touchGestureWasMultitouch = true;
    }
  }

  handleTouchEnd(e) {
    e.preventDefault();

    if (!this.isTouching && this.activeRulerTouchIdentifier === null) {
      return;
    }

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
        this.syncRenderingModeControls();
      }

      return;
    }

    if (e.type !== "touchend") {
      this.commitLazyTouchViewportChange(e);
      this.resetTouchTapTracking();
      this.initialPinchDistance = null;
      this.lastPinchDistance = null;

      if (this.touches.length === 0) {
        this.resetTouchViewportGesture();
        this.isTouching = false;
      } else {
        this.isTouching = true;
        this.resetSelectionCycle();
        this.touchGestureWasMultitouch = true;

        if (this.touches.length >= 2) {
          this.initialPinchDistance = this.calculateTouchDistance(
            this.touches[0],
            this.touches[1],
          );
          this.lastPinchDistance = this.initialPinchDistance;
          this.lastTouchCenter = this.getTouchCenter(
            this.touches[0],
            this.touches[1],
          );
        } else {
          this.lastTouchCenter = {
            x: this.touches[0].clientX,
            y: this.touches[0].clientY,
          };
        }

        if (!this.shouldRenderViewportRealtime()) {
          this.prepareLazyViewportPreview();
        }
      }
      this.syncRenderingModeControls();
      return;
    }

    if (this.touches.length > 0 && this.touches.length < 2) {
      // Reset pinch state
      this.initialPinchDistance = null;
      this.lastPinchDistance = null;
    }

    if (this.touches.length === 0) {
      if (!this.commitTouchTapSelection(e)) {
        this.commitLazyTouchViewportChange(e);
      }
      this.initialPinchDistance = null;
      this.lastPinchDistance = null;
      this.resetTouchTapTracking();
      this.resetTouchViewportGesture();
      // All touches ended
      this.isTouching = false;
      this.syncRenderingModeControls();
    } else if (this.touches.length === 1) {
      this.cancelTouchTapTracking();
      this.resetSelectionCycle();
      this.touchGestureWasMultitouch = true;
      // Transitioned from multi-touch to single touch
      const center = {
        x: this.touches[0].clientX,
        y: this.touches[0].clientY,
      };
      this.lastTouchCenter = center;
      if (
        !this.shouldRenderViewportRealtime() &&
        !this.isLazyViewportPreviewActive()
      ) {
        this.prepareLazyViewportPreview();
      }
    }
  }

  commitLazyTouchViewportChange(event) {
    if (this.shouldRenderViewportRealtime()) {
      return false;
    }

    if (
      this.touchTapCandidate ||
      (!this.isViewportTransformActive && this.lazyViewportRenderState === null)
    ) {
      return false;
    }

    this.clearViewportCssTransform();
    this.resetSelectionCycle();
    this.requestRender();
    return true;
  }

  resetTouchViewportGesture() {
    this.cancelLazyViewportRender();
  }

  startTouchTapTracking(touch) {
    const point = {
      x: touch.clientX,
      y: touch.clientY,
    };
    this.touchStartPoint = point;
    this.touchTapPoint = point;
    this.touchTapIdentifier = touch.identifier;
    this.touchTapCandidate = true;
    this.touchGestureWasMultitouch = false;
  }

  updateTouchTapTracking(touch) {
    if (
      !this.touchTapCandidate ||
      this.touchTapIdentifier !== touch.identifier ||
      !this.touchStartPoint
    ) {
      return;
    }

    const point = {
      x: touch.clientX,
      y: touch.clientY,
    };
    this.touchTapPoint = point;
    if (
      Math.hypot(
        point.x - this.touchStartPoint.x,
        point.y - this.touchStartPoint.y,
      ) > this.getViewportRelativeDistance(TOUCH_TAP_MAX_MOVEMENT_VIEWPORT_RATIO)
    ) {
      this.touchTapCandidate = false;
    }
  }

  commitTouchTapSelection(event) {
    if (
      event.type !== "touchend" ||
      !this.touchTapCandidate ||
      this.touchGestureWasMultitouch ||
      this.touchTapIdentifier === null
    ) {
      return false;
    }

    const endedTouch = Array.from(event.changedTouches).find(
      (touch) => touch.identifier === this.touchTapIdentifier,
    );
    if (!endedTouch) {
      return false;
    }

    this.updateTouchTapTracking(endedTouch);
    if (!this.touchTapCandidate) {
      return false;
    }

    const point = {
      x: endedTouch.clientX,
      y: endedTouch.clientY,
    };
    this.selectFeatureAtCanvasPoint(point.x, point.y, { inputType: "touch" });
    return true;
  }

  cancelTouchTapTracking() {
    this.touchTapCandidate = false;
  }

  resetTouchTapTracking() {
    this.touchStartPoint = null;
    this.touchTapPoint = null;
    this.touchTapIdentifier = null;
    this.touchTapCandidate = false;
    this.touchGestureWasMultitouch = false;
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
    if (!layer) return;

    const r = parseInt(hexColor.substr(1, 2), 16) / 255;
    const g = parseInt(hexColor.substr(3, 2), 16) / 255;
    const b = parseInt(hexColor.substr(5, 2), 16) / 255;

    layer.color = [r, g, b];
    this.requestRender();
    this.updateUiState();
  }

  updateLayerInverted(layer, inverted) {
    if (!layer || isDrillLayer(layer)) return;

    layer.inverted = Boolean(inverted);
    this.removeInvertedLayerCache(layer);
    this.renderLayerList();
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
        if (!isDrillLayer(layer) && this.interactionProcessor) {
          this.invalidateFeaturePickingAfterLayerSetChange(
            `${layer.name} was removed; rebuild the document to enable feature picking again.`,
          );
        }

        // remove from JS array only if WASM removal succeeded
        this.layers.splice(index, 1);
        if (
          this.selectedFeature?.layerId === this.getLayerInteractionLayerId(layer)
        ) {
          this.clearSelectedFeature({ refresh: false });
        }
        if (this.layers.length === 0) {
          this.fitViewZoom = null;
        }
        this.clearAllInvertedLayerCaches();
      } catch (error) {
        console.error(`[Layer] Failed to remove layer ${layer.name}:`, error);
        return;
      }
    }

    this.renderLayerList();
    this.requestRender();
    this.updateUiState();
  }

  invalidateFeaturePickingAfterLayerSetChange(detail) {
    this.featurePickingAvailable = false;
    this.disposeInteractionProcessor();
    this.clearSelectedFeature({ refresh: false });
    this.addDiagnostic("warning", "Feature picking cleared", detail);
  }

  removeWasmLayerRecord(layer) {
    if (!this.wasmProcessor || !layer) return;

    const layerIds = isDrillLayer(layer)
      ? [layer.outlineLayerId, layer.fillLayerId]
      : [layer.layerId, layer.invertedLayerId];

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
      this.disposeInteractionProcessor();

      this.layers = [];
      this.clearSelectedFeature({ refresh: false });
      this.wasmMemoryExhausted = false;
      this.featurePickingAvailable = this.interactionsEnabled;
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
    this.clearAllInvertedLayerCaches();
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
    this.clearAllInvertedLayerCaches();
    this.clearSelectedFeatureIfUnavailable();
    this.renderLayerList();
    this.requestRender();
    this.updateUiState();
  }

  unselectAllLayerCheckboxes() {
    this.layers.forEach((layer) => {
      layer.visible = false;
    });
    this.clearAllInvertedLayerCaches();
    this.clearSelectedFeature();
    this.renderLayerList();
    this.requestRender();
    this.updateUiState();
  }

  handleLayerDragStart(event, layerId) {
    if (
      event.target instanceof Element &&
      event.target.closest("input, button, select")
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
    this.reorderGerberLayer(this.draggedLayerId, this.layerDropIndex);
    this.draggedLayerId = null;
    this.layerDropIndex = null;
    this.clearLayerDropIndicator();
  }

  reorderGerberLayer(layerId, dropIndex) {
    const gerberLayers = this.layers.filter((layer) => !isDrillLayer(layer));
    const drillLayers = this.layers.filter(isDrillLayer);
    const fromIndex = gerberLayers.findIndex(
      (layer) => layer.id === layerId,
    );
    if (fromIndex === -1) return false;

    let toIndex = dropIndex;
    if (fromIndex < toIndex) {
      toIndex -= 1;
    }

    if (fromIndex !== toIndex) {
      const previousRects = this.captureLayerItemRects();
      const [layer] = gerberLayers.splice(fromIndex, 1);
      gerberLayers.splice(toIndex, 0, layer);
      this.layers = [...gerberLayers, ...drillLayers];
      this.renderLayerList();
      this.animateLayerReorder(previousRects);
      this.requestRender();
      this.updateUiState();
    }

    return fromIndex !== toIndex;
  }

  captureLayerItemRects() {
    const rects = new Map();
    for (const item of this.layerList.querySelectorAll(".layer-item[data-layer-id]")) {
      rects.set(item.dataset.layerId, item.getBoundingClientRect());
    }
    return rects;
  }

  animateLayerReorder(previousRects) {
    if (
      !previousRects?.size ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    for (const item of this.layerList.querySelectorAll(".layer-item[data-layer-id]")) {
      const previousRect = previousRects.get(item.dataset.layerId);
      if (!previousRect) continue;

      const currentRect = item.getBoundingClientRect();
      const deltaX = previousRect.left - currentRect.left;
      const deltaY = previousRect.top - currentRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      item.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: LAYER_REORDER_ANIMATION_MS,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        },
      );
    }
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

  handleLayerTouchStart(event) {
    if (event.touches.length !== 1 || this.layerTouchDrag) {
      this.cancelLayerTouchDrag();
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest("input, button, select")
    ) {
      return;
    }

    const item = event.target instanceof Element
      ? event.target.closest('.layer-item[draggable="true"][data-layer-id]')
      : null;
    if (!item) {
      return;
    }

    const touch = event.touches[0];
    const layerId = item.dataset.layerId;
    const scrollElement = this.getLayerListScrollElement();
    this.layerTouchDrag = {
      active: false,
      identifier: touch.identifier,
      layerId,
      item,
      startX: touch.clientX,
      startY: touch.clientY,
      lastClientY: touch.clientY,
      scrollElement,
    };
    this.layerTouchDragTimer = window.setTimeout(() => {
      this.activateLayerTouchDrag();
    }, LAYER_TOUCH_DRAG_DELAY_MS);
  }

  handleLayerTouchMove(event) {
    if (!this.layerTouchDrag) return;

    if (event.touches.length !== 1) {
      if (this.layerTouchDrag.active) {
        event.preventDefault();
        event.stopPropagation();
        this.layerTouchSuppressClickUntil = Date.now() + 500;
      }
      this.cancelLayerTouchDrag();
      return;
    }

    const touch = this.findLayerTouch(event.touches);
    if (!touch) {
      this.cancelLayerTouchDrag();
      return;
    }

    const drag = this.layerTouchDrag;
    const distance = Math.hypot(
      touch.clientX - drag.startX,
      touch.clientY - drag.startY,
    );

    if (!drag.active) {
      if (distance > LAYER_TOUCH_DRAG_CANCEL_PX) {
        this.cancelLayerTouchDrag();
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    drag.lastClientY = touch.clientY;
    this.updateLayerTouchDropPlacement(touch.clientY);
    this.updateLayerTouchAutoScroll(touch.clientY);
  }

  handleLayerTouchEnd(event) {
    if (!this.layerTouchDrag) return;

    const drag = this.layerTouchDrag;
    if (!this.findLayerTouch(event.changedTouches)) {
      return;
    }

    const wasActive = drag.active;
    if (wasActive) {
      event.preventDefault();
      event.stopPropagation();
      if (this.draggedLayerId && this.layerDropIndex !== null) {
        this.reorderGerberLayer(this.draggedLayerId, this.layerDropIndex);
      }
      this.layerTouchSuppressClickUntil = Date.now() + 500;
    }
    this.cancelLayerTouchDrag();
  }

  handleLayerTouchCancel(event) {
    if (!this.layerTouchDrag) return;
    if (this.layerTouchDrag.active) {
      event.preventDefault();
      event.stopPropagation();
      this.layerTouchSuppressClickUntil = Date.now() + 500;
    }
    this.cancelLayerTouchDrag();
  }

  activateLayerTouchDrag() {
    const drag = this.layerTouchDrag;
    if (!drag || drag.active) return;

    drag.active = true;
    this.draggedLayerId = drag.layerId;
    this.layerDropIndex = null;
    this.dropZone.classList.remove("drag-active");
    drag.item.classList.add("dragging", "touch-dragging");
    this.updateLayerTouchDropPlacement(drag.lastClientY);
  }

  cancelLayerTouchDrag() {
    if (this.layerTouchDragTimer !== null) {
      clearTimeout(this.layerTouchDragTimer);
      this.layerTouchDragTimer = null;
    }
    this.stopLayerTouchAutoScroll();
    if (this.layerTouchDrag?.item) {
      this.layerTouchDrag.item.classList.remove("dragging", "touch-dragging");
    }
    this.layerTouchDrag = null;
    this.draggedLayerId = null;
    this.layerDropIndex = null;
    this.layerTouchScrollVelocity = 0;
    this.clearLayerDropIndicator();
  }

  findLayerTouch(touchList) {
    const drag = this.layerTouchDrag;
    if (!drag) return null;
    return Array.from(touchList).find(
      (touch) => touch.identifier === drag.identifier,
    ) ?? null;
  }

  getLayerListScrollElement() {
    return this.layerList.closest(".layer-list-scroll") ?? this.layerList;
  }

  updateLayerTouchDropPlacement(clientY) {
    const placement = this.getLayerDropPlacement(clientY);
    if (!placement) return;

    this.layerDropIndex = placement.dropIndex;
    this.clearLayerDropIndicator();
    placement.item.classList.add(
      placement.position === "after" ? "drop-after" : "drop-before",
    );
  }

  updateLayerTouchAutoScroll(clientY) {
    const drag = this.layerTouchDrag;
    const scrollElement = drag?.scrollElement;
    if (!drag?.active || !scrollElement) return;

    const rect = scrollElement.getBoundingClientRect();
    let velocity = 0;
    if (clientY < rect.top + LAYER_TOUCH_AUTOSCROLL_EDGE_PX) {
      const ratio =
        (rect.top + LAYER_TOUCH_AUTOSCROLL_EDGE_PX - clientY) /
        LAYER_TOUCH_AUTOSCROLL_EDGE_PX;
      velocity = -Math.ceil(ratio * LAYER_TOUCH_AUTOSCROLL_MAX_PX);
    } else if (clientY > rect.bottom - LAYER_TOUCH_AUTOSCROLL_EDGE_PX) {
      const ratio =
        (clientY - (rect.bottom - LAYER_TOUCH_AUTOSCROLL_EDGE_PX)) /
        LAYER_TOUCH_AUTOSCROLL_EDGE_PX;
      velocity = Math.ceil(ratio * LAYER_TOUCH_AUTOSCROLL_MAX_PX);
    }

    this.layerTouchScrollVelocity = velocity;
    if (velocity === 0) {
      this.stopLayerTouchAutoScroll();
      return;
    }

    if (this.layerTouchScrollFrame === null) {
      this.layerTouchScrollFrame = requestAnimationFrame(() =>
        this.stepLayerTouchAutoScroll(),
      );
    }
  }

  stepLayerTouchAutoScroll() {
    this.layerTouchScrollFrame = null;
    const drag = this.layerTouchDrag;
    const scrollElement = drag?.scrollElement;
    if (!drag?.active || !scrollElement || this.layerTouchScrollVelocity === 0) {
      return;
    }

    scrollElement.scrollTop += this.layerTouchScrollVelocity;
    this.updateLayerTouchDropPlacement(drag.lastClientY);
    this.layerTouchScrollFrame = requestAnimationFrame(() =>
      this.stepLayerTouchAutoScroll(),
    );
  }

  stopLayerTouchAutoScroll() {
    if (this.layerTouchScrollFrame !== null) {
      cancelAnimationFrame(this.layerTouchScrollFrame);
      this.layerTouchScrollFrame = null;
    }
  }

  suppressLayerClickAfterTouchDrag(event) {
    if (Date.now() > this.layerTouchSuppressClickUntil) return;

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  renderLayerList() {
    this.closeLayerContextMenu();
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
        this.clearAllInvertedLayerCaches();
        this.clearSelectedFeatureForHiddenLayer(layer);
        this.requestRender();
        this.updateUiState();
      },
      onToggleVisibility: (layer) => {
        layer.visible = !layer.visible;
        this.clearAllInvertedLayerCaches();
        this.clearSelectedFeatureForHiddenLayer(layer);
        this.requestRender();
        this.updateUiState();
      },
      onContextMenu: (detail) => this.showLayerContextMenu(detail),
      onOpenFiles: () => this.openFilePicker(),
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
