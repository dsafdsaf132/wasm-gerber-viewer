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
  getInitialSourceUrl,
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

export class GerberViewer {
  constructor() {
    Object.assign(this, getViewerElements());
    this.gl = null; // WebGL2 context

    // WASM module and single processor
    this.wasmModule = null;
    this.wasmProcessor = null;
    this.isWebGlContextLost = false;
    this.isRestoringWebGlContext = false;

    // Layers
    this.layers = [];
    this.nextLayerDomId = 0;
    this.draggedLayerId = null;
    this.layerDropIndex = null;

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
      [1.0, 0.0, 0.0], // Red
      [0.0, 1.0, 0.0], // Green
      [0.0, 0.0, 1.0], // Blue
      [1.0, 1.0, 0.0], // Yellow
      [1.0, 0.0, 1.0], // Magenta
      [0.0, 1.0, 1.0], // Cyan
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
    await this.wasmModule.default();
    this.wasmModule.init_panic_hook();

    this.createWebGlProcessor();

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
    this.syncFilterInputs();
    this.updateUiState();
    this.updateRulerControls();
    this.updateMeasurementUnitControl();
    this.updateViewFlipControls();
    this.render();
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

    this.render();
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

    const layerSnapshot = this.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      layerId: layer.layerId,
      bounds: layer.bounds ? { ...layer.bounds } : null,
      visible: layer.visible,
      color: [...layer.color],
      sourceContent: layer.sourceContent,
    }));

    this.isRestoringWebGlContext = true;
    this.updateUiState();

    try {
      this.gl = this.createWebGlContext();
      if (!this.wasmProcessor) {
        throw new Error("No parsed layer data available for WebGL restore");
      }
      this.wasmProcessor.restore_context(this.gl);
      this.isWebGlContextLost = false;
      this.resizeCanvas({ allowProcessorResize: true });
      this.layers = layerSnapshot;

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
      this.render();
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

  syncFilterInputs() {
    this.topFilterInput.value = this.layerFilterStore.get("top");
    this.bottomFilterInput.value = this.layerFilterStore.get("bottom");
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

  updateUiState() {
    const totalLayers = this.layers.length;
    const visibleLayers = this.layers.filter((layer) => layer.visible).length;

    if (this.isRestoringWebGlContext) {
      this.workspaceStatus.textContent = "Restoring WebGL";
    } else if (this.isWebGlContextLost) {
      this.workspaceStatus.textContent = "WebGL context lost";
    } else {
      this.workspaceStatus.textContent =
        totalLayers === 0
          ? "Ready"
          : `${visibleLayers} visible / ${totalLayers} loaded`;
    }

    const rendererBusy = this.isWebGlContextLost || this.isRestoringWebGlContext;
    this.fileInput.disabled = rendererBusy;
    this.selectFilesBtn.disabled = rendererBusy;
    this.emptyUploadBtn.disabled = rendererBusy;

    this.visibleLayerCount.textContent = `${visibleLayers} / ${totalLayers}`;
    this.diagnosticsCount.textContent = String(this.diagnostics.count);
    this.emptyState.classList.toggle("is-hidden", totalLayers > 0);
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

    this.render();
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
    if (!sourceUrl) return;

    try {
      const url = new URL(sourceUrl);
      await this.loadRemoteSource(url);
    } catch (error) {
      this.handleLayerLoadError(sourceUrl, error);
    }
  }

  async loadRemoteSource(url) {
    this.setWorkspaceStatus("Loading remote file");
    const file = await fetchRemoteFile(url);
    const layerSources = await this.collectLayerSources([file]);
    if (layerSources.length === 0) {
      this.updateUiState();
      return;
    }

    const results = await Promise.all(
      layerSources.map((source) =>
        this.loadLayerSource(source.name, source.readText),
      ),
    );
    const loadedCount = results.filter(Boolean).length;

    if (loadedCount > 0) {
      this.renderLayerList();
      this.render();
      this.fitView();
      this.addDiagnostic("info", "Remote file loaded", `${loadedCount} processed`);
    }

    this.updateUiState();
  }

  async handleFileUpload(files) {
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
      const layerSources = await this.collectLayerSources(validFiles);

      if (layerSources.length > 0) {
        const results = await Promise.all(
          layerSources.map((source) =>
            this.loadLayerSource(source.name, source.readText),
          ),
        );
        const loadedCount = results.filter(Boolean).length;

        if (loadedCount > 0) {
          this.renderLayerList();
          this.render();
          this.fitView();
          this.addDiagnostic("info", "Files loaded", `${loadedCount} processed`);
        }
      }
    }

    this.updateUiState();

    // Clear file input
    this.fileInput.value = "";
  }

  async collectLayerSources(files) {
    return collectLayerSources(files, {
      onArchiveWarning: (name, message) =>
        this.addDiagnostic("warning", name, message),
      onArchiveInfo: (name, message) => this.addDiagnostic("info", name, message),
      onArchiveError: (name, error) => this.handleLayerLoadError(name, error),
    });
  }

  async loadLayerSource(name, readText) {
    try {
      const content = await readText();
      await this.addLayer(name, content);
      return true;
    } catch (error) {
      this.handleLayerLoadError(name, error);
      return false;
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

  async addLayer(name, content, options = {}) {
    try {
      if (!this.wasmProcessor || this.isWebGlContextLost) {
        throw new Error("WebGL renderer is not available");
      }

      // add layer to WASM processor and get layer ID
      const layerId = this.wasmProcessor.add_layer(content);
      if (layerId === undefined || layerId === null) {
        throw new Error("Failed to get layer ID from WASM processor");
      }

      // Get this layer's boundary from WASM
      const bounds = this.wasmProcessor.get_layer_boundary(layerId);

      const color = options.color
        ? [...options.color]
        : this.colorPalette[this.nextColorIndex % this.colorPalette.length];
      if (!options.color) {
        this.nextColorIndex++;
      }

      const layer = {
        id: options.id ?? `layer-${this.nextLayerDomId++}`,
        layerId: layerId, // WASM layer_id
        name: name,
        visible: options.visible ?? true,
        color: color,
        sourceContent: options.sourceContent ?? content,
        bounds: {
          minX: bounds.min_x,
          maxX: bounds.max_x,
          minY: bounds.min_y,
          maxY: bounds.max_y,
        },
      };

      this.layers.push(layer);
      this.updateUiState();
    } catch (error) {
      if (isNoGeometryError(getErrorMessage(error))) {
        console.warn(`[Layer] Skipped layer ${name}:`, error);
        throw error;
      }

      console.error(`[Layer] Failed to add layer ${name}:`, error);
      throw error;
    }
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
      const { activeLayerIds, colorData } = this.getRenderLayerPayload();

      // Render with active layers
      this.wasmProcessor.render(
        activeLayerIds,
        colorData,
        this.getViewScaleX(),
        this.getViewScaleY(),
        this.camera.offsetX,
        this.camera.offsetY,
        this.globalAlpha,
      );
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

    this.layers.forEach((layer) => {
      if (selectedLayerIds.has(layer.id)) {
        activeLayerIds.push(layer.layerId);
        colorData.push(layer.color[0], layer.color[1], layer.color[2]);
      }
    });

    return {
      activeLayerIds: new Uint32Array(activeLayerIds),
      colorData: new Float32Array(colorData),
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

    this.render();
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
      this.render();
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

    this.render();
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
      this.render();
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
      this.render();
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
    if (!layer) return;

    const r = parseInt(hexColor.substr(1, 2), 16) / 255;
    const g = parseInt(hexColor.substr(3, 2), 16) / 255;
    const b = parseInt(hexColor.substr(5, 2), 16) / 255;

    layer.color = [r, g, b];
    this.render();
    this.updateUiState();
  }

  updateGlobalAlpha(alpha) {
    this.globalAlpha = alpha;
    // Re-render with new alpha
    this.render();
  }

  deleteLayer(layerId) {
    const index = this.layers.findIndex((l) => l.id === layerId);
    if (index !== -1) {
      const layer = this.layers[index];

      try {
        // remove from WASM processor and handle errors
        if (this.wasmProcessor) {
          this.wasmProcessor.remove_layer(layer.layerId);
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
    this.render();
    this.updateUiState();
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
      this.render();
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
    this.render();
    this.updateUiState();
  }

  selectLayersByFilter(kind) {
    this.layers.forEach((layer) => {
      layer.visible = this.layerFilterStore.matches(layer, kind);
    });
    this.renderLayerList();
    this.render();
    this.updateUiState();
  }

  unselectAllLayerCheckboxes() {
    this.layers.forEach((layer) => {
      layer.visible = false;
    });
    this.renderLayerList();
    this.render();
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
    const fromIndex = this.layers.findIndex(
      (layer) => layer.id === this.draggedLayerId,
    );
    if (fromIndex === -1) return;

    let toIndex = this.layerDropIndex;
    if (fromIndex < toIndex) {
      toIndex -= 1;
    }

    if (fromIndex !== toIndex) {
      const [layer] = this.layers.splice(fromIndex, 1);
      this.layers.splice(toIndex, 0, layer);
      this.renderLayerList();
      this.render();
      this.updateUiState();
    }

    this.draggedLayerId = null;
    this.layerDropIndex = null;
    this.clearLayerDropIndicator();
  }

  getLayerDropPlacement(clientY) {
    const items = Array.from(
      this.layerList.querySelectorAll(".layer-item[data-layer-id]"),
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
        this.render();
        this.updateUiState();
      },
      onToggleVisibility: (layer) => {
        layer.visible = !layer.visible;
        this.render();
        this.updateUiState();
      },
      onDelete: (layerId) => this.deleteLayer(layerId),
    });
    this.refreshIcons();
  }

  formatLayerBounds(layer) {
    if (!layer.bounds) {
      return layer.visible ? "visible" : "hidden";
    }

    const width = layer.bounds.maxX - layer.bounds.minX;
    const height = layer.bounds.maxY - layer.bounds.minY;
    return formatDimensionPair(width, height, this.measurementUnit);
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
