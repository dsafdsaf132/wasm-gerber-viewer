const NOTIFICATION_DURATION_MS = 2000;
const MAX_FILE_SIZE_BYTES = 300 * 1024 * 1024;
const ZIP_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
]);
const GERBER_FILE_EXTENSIONS = new Set([
  ".art",
  ".bot",
  ".bsk",
  ".bsm",
  ".cmp",
  ".crc",
  ".crs",
  ".drd",
  ".gbl",
  ".gbo",
  ".gbr",
  ".gbs",
  ".gbp",
  ".gdo",
  ".ger",
  ".gko",
  ".gpb",
  ".gpt",
  ".gtl",
  ".gto",
  ".gtp",
  ".gts",
  ".pastebot",
  ".pastetop",
  ".pho",
  ".plb",
  ".plc",
  ".pls",
  ".plt",
  ".smb",
  ".smt",
  ".sol",
  ".spb",
  ".spt",
  ".ssb",
  ".sst",
  ".stc",
  ".sts",
  ".top",
  ".tsk",
  ".tsm",
]);

export class GerberViewer {
  constructor() {
    // Main canvas (WebGL2)
    this.canvas = document.getElementById("gerber-canvas");
    this.viewerSurface = this.canvas.closest(".viewer-surface");
    this.gl = null; // WebGL2 context

    // DOM elements
    this.fileInput = document.getElementById("file-input");
    this.selectFilesBtn = document.getElementById("select-files-btn");
    this.emptyUploadBtn = document.getElementById("empty-upload-btn");
    this.fitViewBtn = document.getElementById("fit-view-btn");
    this.flipHorizontalBtn = document.getElementById("flip-horizontal-btn");
    this.flipVerticalBtn = document.getElementById("flip-vertical-btn");
    this.canvasThemeToggle = document.getElementById("canvas-theme-toggle");
    this.screenshotBtn = document.getElementById("screenshot-btn");
    this.rulerToggleBtn = document.getElementById("ruler-toggle-btn");
    this.rulerClearBtn = document.getElementById("ruler-clear-btn");
    this.measurementUnitToggle = document.getElementById("measurement-unit-toggle");
    this.fullscreenBtn = document.getElementById("fullscreen-btn");
    this.selectAllBtn = document.getElementById("select-all-btn");
    this.selectTopBtn = document.getElementById("select-top-btn");
    this.selectBottomBtn = document.getElementById("select-bottom-btn");
    this.unselectAllBtn = document.getElementById("unselect-all-btn");
    this.clearAllBtn = document.getElementById("clear-all-btn");
    this.clearDiagnosticsBtn = document.getElementById("clear-diagnostics-btn");
    this.alphaSlider = document.getElementById("alpha-slider");
    this.alphaValue = document.getElementById("alpha-value");
    this.layerList = document.getElementById("layer-list");
    this.diagnosticList = document.getElementById("diagnostic-list");
    this.notification = document.getElementById("file-size-warning");
    this.notificationTitle = document.getElementById("warning-title");
    this.notificationMessage = document.getElementById("warning-message");
    this.notificationCloseBtn = this.notification.querySelector(
      "[data-notification-close]",
    );
    this.workspaceStatus = document.getElementById("workspace-status");
    this.emptyState = document.getElementById("empty-state");
    this.emptyFileSizeLimit = document.getElementById("empty-file-size-limit");
    this.dropOverlay = document.getElementById("drop-overlay");
    this.measurementOverlay = document.getElementById("measurement-overlay");
    this.visibleLayerCount = document.getElementById("visible-layer-count");
    this.zoomReadout = document.getElementById("zoom-readout");
    this.cursorReadout = document.getElementById("cursor-readout");
    this.boundsReadout = document.getElementById("bounds-readout");
    this.diagnosticsCount = document.getElementById("diagnostics-count");
    this.topFilterInput = document.getElementById("top-filter-input");
    this.bottomFilterInput = document.getElementById("bottom-filter-input");
    this.panelTabs = Array.from(document.querySelectorAll("[data-panel-tab]"));
    this.panelSections = Array.from(document.querySelectorAll("[data-panel]"));

    // Drawer elements
    this.drawer = document.getElementById("drawer");
    this.resizeHandle = document.getElementById("resize-handle");
    this.drawerToggleBtn = document.getElementById("drawer-toggle");

    // Drop zone
    this.dropZone = document.getElementById("drop-zone");

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

    // Drawer resize state
    this.isResizingDrawer = false;
    this.drawerCurrentWidth = 381;
    this.drawerCurrentHeight = 420;
    this.drawerPendingWidth = null;
    this.drawerPendingHeight = null;
    this.drawerMinWidth = 200;
    this.drawerMaxWidth = 600;
    this.drawerMinHeight = 300;
    this.drawerMaxHeight = 560;
    this.drawerMobileMaxHeightRatio = 0.72;
    this.drawerCollapsedWidth = 156;
    this.drawerCollapsedHeight = 95;
    this.drawerSnapThreshold = 50;
    this.drawerBottomCollapseThreshold = 200;

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
    this.notificationTimeout = null;
    this.diagnostics = [];
    this.activePanel = "layers";
    this.isCanvasLight = false;
    this.isRulerActive = false;
    this.rulerStartPoint = null;
    this.rulerHoverPoint = null;
    this.measurements = [];
    this.measurementUnit = "mm";
    this.layerFilterStorageKey = "wasm-gerber-viewer.layerFilters";
    this.layerFilters = this.loadLayerFilters();
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
      this.updateDrawerToggleState();
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

  resizeCanvas({ allowProcessorResize = false } = {}) {
    if (this.drawer && !this.drawer.classList.contains("collapsed")) {
      if (this.isMobileDrawerLayout()) {
        this.setDrawerHeight(this.drawerCurrentHeight);
      } else {
        this.setDrawerWidth(this.drawerCurrentWidth);
      }
    }

    const rect = this.canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
    this.canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));

    const canResizeProcessor =
      this.wasmProcessor &&
      !this.isWebGlContextLost &&
      (!this.isRestoringWebGlContext || allowProcessorResize);
    if (canResizeProcessor) {
      try {
        this.wasmProcessor.resize();
      } catch (error) {
        const message = this.getErrorMessage(error);
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
      this.exportScreenshot();
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

    // Drawer resize events (mouse)
    this.resizeHandle.addEventListener("mousedown", (e) =>
      this.startDrawerResize(e),
    );
    document.addEventListener("mousemove", (e) => this.resizeDrawer(e));
    document.addEventListener("mouseup", (e) => this.stopDrawerResize(e));

    // Drawer resize events (touch)
    this.resizeHandle.addEventListener(
      "touchstart",
      (e) => this.startDrawerResize(e),
      { passive: false },
    );
    document.addEventListener("touchmove", (e) => this.resizeDrawer(e), {
      passive: false,
    });
    document.addEventListener("touchend", (e) => this.stopDrawerResize(e), {
      passive: false,
    });

    // Drawer toggle event
    if (this.isMobileDrawerLayout()) {
      this.drawer.classList.add("collapsed");
    }
    this.updateDrawerToggleState();
    this.drawerToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.toggleDrawer();
    });
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
      const message = this.getErrorMessage(error);
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

  loadLayerFilters() {
    const defaults = {
      top:
        "top front -f .gtl .gto .gts .gtp .gpt .cmp .plc .stc .crc .top .smt .sst .spt .tsm .tsk .plt .pastetop f.cu f_cu f.mask f_mask f.silks f_silks f.paste f_paste mt.pho st.pho pt.pho #TOP",
      bottom:
        "bottom back -b .gbl .gbo .gbs .gbp .gpb .sol .pls .sts .crs .bot .smb .ssb .spb .bsm .bsk .plb .pastebot b.cu b_cu b.mask b_mask b.silks b_silks b.paste b_paste mb.pho sb.pho pb.pho #BOT",
    };
    const previousDefaults = {
      top: [
        "top -f .gtl .gto .gts .gtp #TOP",
        "top .gtl .gto .gts .gtp #TOP",
      ],
      bottom: [
        "bottom -b .gbl .gbo .gbs .gbp #BOT",
        "bottom .gbl .gbo .gbs .gbp #BOT",
      ],
      front: ["front .gtl .gto .gts .gtp #TOP"],
      back: ["back .gbl .gbo .gbs .gbp #BOT"],
    };

    try {
      const stored = JSON.parse(
        window.localStorage.getItem(this.layerFilterStorageKey) || "{}",
      );
      const normalizeFilter = (value, previousDefaultValues, currentDefault) =>
        previousDefaultValues.includes(value) ? currentDefault : value;

      return {
        top:
          typeof stored.top === "string"
            ? normalizeFilter(stored.top, previousDefaults.top, defaults.top)
            : typeof stored.front === "string"
              ? normalizeFilter(stored.front, previousDefaults.front, defaults.top)
              : defaults.top,
        bottom:
          typeof stored.bottom === "string"
            ? normalizeFilter(
                stored.bottom,
                previousDefaults.bottom,
                defaults.bottom,
              )
            : typeof stored.back === "string"
              ? normalizeFilter(
                  stored.back,
                  previousDefaults.back,
                  defaults.bottom,
                )
              : defaults.bottom,
      };
    } catch {
      return defaults;
    }
  }

  saveLayerFilters() {
    window.localStorage.setItem(
      this.layerFilterStorageKey,
      JSON.stringify(this.layerFilters),
    );
  }

  syncFilterInputs() {
    this.topFilterInput.value = this.layerFilters.top;
    this.bottomFilterInput.value = this.layerFilters.bottom;
  }

  updateLayerFilter(kind, value) {
    this.layerFilters[kind] = value;
    this.saveLayerFilters();
  }

  getFilterTokens(kind) {
    return this.layerFilters[kind]
      .split(/[\s,;|]+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  layerMatchesFilter(layer, kind) {
    const tokens = this.getFilterTokens(kind);
    if (tokens.length === 0) return false;
    const layerName = layer.name;
    const lowerLayerName = layerName.toLowerCase();
    return tokens.some((token) => {
      if (token.startsWith("#") && token.length > 1) {
        return layerName.includes(token.slice(1));
      }

      return lowerLayerName.includes(token.toLowerCase());
    });
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
    this.diagnosticsCount.textContent = String(this.diagnostics.length);
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

    const fitZoom = this.getFitViewZoom() ?? this.fitViewZoom;
    if (!Number.isFinite(fitZoom) || fitZoom <= 0) {
      return "100%";
    }

    const zoomPercent = (this.camera.zoom / fitZoom) * 100;
    return `${Math.trunc(zoomPercent)}%`;
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
    return this.formatDimensionPair(width, height);
  }

  setWorkspaceStatus(status) {
    this.workspaceStatus.textContent = status;
  }

  addDiagnostic(level, title, detail = "") {
    if (level === "info") {
      return;
    }

    this.diagnostics.unshift({
      level,
      title,
      detail,
      time: new Date().toLocaleTimeString(),
    });
    this.diagnostics = this.diagnostics.slice(0, 30);
    this.updateUiState();
  }

  renderDiagnostics() {
    this.diagnosticList.replaceChildren();

    if (this.diagnostics.length === 0) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      title.textContent = "No diagnostics";
      detail.textContent = "Ready";
      item.append(title, detail);
      this.diagnosticList.appendChild(item);
      return;
    }

    for (const diagnostic of this.diagnostics) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      title.textContent = diagnostic.title;
      detail.textContent = `${diagnostic.time} · ${diagnostic.level}${diagnostic.detail ? ` · ${diagnostic.detail}` : ""}`;
      item.append(title, detail);
      this.diagnosticList.appendChild(item);
    }
  }

  clearDiagnostics() {
    this.diagnostics = [];
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
    return this.camera.zoom * (this.camera.flipX ? -1 : 1);
  }

  getViewScaleY() {
    return this.camera.zoom * (this.camera.flipY ? -1 : 1);
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

  async exportScreenshot() {
    this.render();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.showError("Cannot export screenshot because the canvas has no size.");
      return;
    }

    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(rect.width * scale));
    output.height = Math.max(1, Math.round(rect.height * scale));

    const context = output.getContext("2d");
    context.scale(scale, scale);
    context.fillStyle = this.isCanvasLight ? "#f8fafc" : "#020617";
    context.fillRect(0, 0, rect.width, rect.height);
    context.drawImage(this.canvas, 0, 0, rect.width, rect.height);
    this.drawMeasurementsOnContext(context);

    output.toBlob((blob) => {
      if (!blob) {
        this.showError("Failed to export screenshot.");
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `gerber-viewer-${this.getTimestampForFileName()}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  drawMeasurementsOnContext(context) {
    for (const measurement of this.measurements) {
      this.drawMeasurementOnContext(context, measurement.start, measurement.end, false);
    }

    if (this.rulerStartPoint && this.rulerHoverPoint) {
      this.drawMeasurementOnContext(
        context,
        this.rulerStartPoint,
        this.rulerHoverPoint,
        true,
      );
    } else if (this.rulerStartPoint) {
      this.drawMeasurementPointOnContext(context, this.rulerStartPoint);
    }
  }

  drawMeasurementOnContext(context, start, end, isPreview) {
    const startPoint = this.worldToCanvasPoint(start);
    const endPoint = this.worldToCanvasPoint(end);
    if (!startPoint || !endPoint) return;

    context.save();
    context.globalAlpha = isPreview ? 0.7 : 1;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#000";
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(startPoint.x, startPoint.y);
    context.lineTo(endPoint.x, endPoint.y);
    context.stroke();
    context.strokeStyle = "#fff";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(startPoint.x, startPoint.y);
    context.lineTo(endPoint.x, endPoint.y);
    context.stroke();
    context.restore();

    this.drawMeasurementPointOnContext(context, start);
    this.drawMeasurementPointOnContext(context, end);

    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const x = (startPoint.x + endPoint.x) / 2;
    const y = (startPoint.y + endPoint.y) / 2 - 8;
    context.save();
    context.font = "700 12px Inter, ui-sans-serif, system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineWidth = 4;
    context.strokeStyle = "#000";
    context.fillStyle = "#fff";
    context.strokeText(this.formatMeasurementLength(distance), x, y);
    context.fillText(this.formatMeasurementLength(distance), x, y);
    context.restore();
  }

  drawMeasurementPointOnContext(context, point) {
    const canvasPoint = this.worldToCanvasPoint(point);
    if (!canvasPoint) return;

    context.save();
    context.fillStyle = "#fff";
    context.strokeStyle = "#000";
    context.lineWidth = 1;
    context.beginPath();
    context.arc(canvasPoint.x, canvasPoint.y, 4, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }

  getTimestampForFileName() {
    return new Date().toISOString().replace(/[:.]/g, "-");
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
      `Max ${this.formatFileSize(MAX_FILE_SIZE_BYTES)} per file`;
  }

  async loadInitialUrlSource() {
    const sourceUrl = this.getInitialSourceUrl();
    if (!sourceUrl) return;

    try {
      const url = new URL(sourceUrl);
      await this.loadRemoteSource(url);
    } catch (error) {
      this.handleLayerLoadError(sourceUrl, error);
    }
  }

  getInitialSourceUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get("url") || params.get("source") || params.get("file");
  }

  async loadRemoteSource(url) {
    this.setWorkspaceStatus("Loading remote file");
    const response = await fetch(url.href);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while loading ${url.href}`);
    }

    const fileName = this.getBaseFileName(decodeURIComponent(url.pathname));
    const file = new File([await response.blob()], fileName, {
      type: response.headers.get("content-type") || "",
    });

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
          size: this.formatFileSize(file.size),
          limit: this.formatFileSize(MAX_FILE_SIZE_BYTES),
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
    const layerSources = [];

    for (const file of files) {
      if (this.isZipFile(file)) {
        layerSources.push(...(await this.collectZipLayerSources(file)));
        continue;
      }

      layerSources.push({
        name: file.name,
        readText: () => file.text(),
      });
    }

    return layerSources;
  }

  async collectZipLayerSources(file) {
    if (!window.JSZip) {
      this.handleLayerLoadError(file.name, new Error("ZIP support failed to load"));
      return [];
    }

    try {
      const zip = await window.JSZip.loadAsync(file);
      const entries = Object.values(zip.files)
        .filter(
          (entry) =>
            !entry.dir &&
            !this.isArchiveMetadataPath(entry.name) &&
            this.isSupportedGerberPath(entry.name),
        )
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );

      if (entries.length === 0) {
        this.addDiagnostic(
          "warning",
          file.name,
          "No supported Gerber files found in archive",
        );
        return [];
      }

      this.addDiagnostic(
        "info",
        file.name,
        `${entries.length} Gerber files found in archive`,
      );

      return entries.map((entry) => ({
        name: this.getBaseFileName(entry.name),
        readText: () => entry.async("string"),
      }));
    } catch (error) {
      this.handleLayerLoadError(file.name, error);
      return [];
    }
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
    const message = this.getErrorMessage(error);
    if (this.isNoGeometryError(message)) {
      console.warn(`Skipped file ${name}:`, error);
      this.addDiagnostic("warning", name, message);
      return;
    }

    console.error(`Failed to load file ${name}:`, error);
    this.addDiagnostic("error", name, message);
    this.showError(`Failed to load file ${name}: ${message}`);
  }

  isZipFile(file) {
    return this.getFileExtension(file.name) === ".zip" || ZIP_MIME_TYPES.has(file.type);
  }

  isSupportedGerberPath(path) {
    return GERBER_FILE_EXTENSIONS.has(this.getFileExtension(path));
  }

  isArchiveMetadataPath(path) {
    const normalizedPath = path.replaceAll("\\", "/");
    const fileName = normalizedPath.split("/").pop() ?? normalizedPath;
    return normalizedPath.startsWith("__MACOSX/") || fileName.startsWith("._");
  }

  getFileExtension(path) {
    const fileName = this.getBaseFileName(path);
    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex <= 0) {
      return "";
    }

    return fileName.slice(dotIndex).toLowerCase();
  }

  getBaseFileName(path) {
    return path.split(/[\\/]/).pop() ?? path;
  }

  formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  }

  showFileSizeWarning(oversizedFiles) {
    this.showNotification(
      "Warning",
      "warning",
      NOTIFICATION_DURATION_MS,
      (messageElement) => {
        const list = document.createElement("ul");
        list.className = "mb-0 mt-2 ps-3";

        oversizedFiles.forEach((file) => {
          const item = document.createElement("li");
          const fileName = document.createElement("strong");
          fileName.textContent = file.name;

          item.appendChild(fileName);
          item.append(
            document.createTextNode(`: ${file.size} (limit: ${file.limit})`),
          );
          list.appendChild(item);
        });

        messageElement.appendChild(list);
      },
    );
  }

  showError(message) {
    this.showNotification(
      "Error",
      "danger",
      NOTIFICATION_DURATION_MS,
      (messageElement) => {
        messageElement.textContent = message;
      },
    );
  }

  getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  isNoGeometryError(message) {
    return message.toLowerCase().includes("no geometry found");
  }

  showNotification(title, variant, duration, renderMessage) {
    if (this.notificationTimeout !== null) {
      clearTimeout(this.notificationTimeout);
    }

    this.notification.classList.remove("danger", "show");
    if (variant === "danger") {
      this.notification.classList.add("danger");
    }
    this.notificationTitle.textContent = title;
    this.notificationMessage.replaceChildren();
    renderMessage(this.notificationMessage);
    this.addDiagnostic(variant, title, this.notificationMessage.textContent.trim());

    requestAnimationFrame(() => {
      this.notification.classList.add("show");
    });

    this.notificationTimeout = setTimeout(() => {
      this.hideNotification();
    }, duration);
  }

  hideNotification() {
    if (this.notificationTimeout !== null) {
      clearTimeout(this.notificationTimeout);
      this.notificationTimeout = null;
    }

    this.notification.classList.remove("show");
    this.notificationTitle.textContent = "Notice";
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
      if (this.isNoGeometryError(this.getErrorMessage(error))) {
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
      // Get selected layers
      const selectedLayerIds = this.getSelectedLayerIds();

      const activeLayerIds = [];
      const colorData = [];

      this.layers.forEach((layer) => {
        if (selectedLayerIds.has(layer.id)) {
          activeLayerIds.push(layer.layerId);

          // Add RGB color (no alpha)
          colorData.push(layer.color[0]);
          colorData.push(layer.color[1]);
          colorData.push(layer.color[2]);
        }
      });

      // Render with active layers
      this.wasmProcessor.render(
        new Uint32Array(activeLayerIds),
        new Float32Array(colorData),
        this.getViewScaleX(),
        this.getViewScaleY(),
        this.camera.offsetX,
        this.camera.offsetY,
        this.globalAlpha,
      );
      this.zoomReadout.textContent = this.formatZoom();
    } catch (error) {
      const message = this.getErrorMessage(error);
      console.error("[Render] Failed to render:", error);
      this.addDiagnostic("error", "Render failed", message);
    }

    this.renderMeasurements();
  }

  renderMeasurements() {
    const rect = this.canvas.getBoundingClientRect();
    this.measurementOverlay.replaceChildren();

    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    this.measurementOverlay.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

    for (const measurement of this.measurements) {
      this.drawMeasurement(measurement.start, measurement.end, false);
    }

    if (this.rulerStartPoint) {
      this.drawMeasurementPoint(this.rulerStartPoint);
      if (this.rulerHoverPoint) {
        this.drawMeasurement(this.rulerStartPoint, this.rulerHoverPoint, true);
      }
    }
  }

  drawMeasurement(start, end, isPreview) {
    const startPoint = this.worldToCanvasPoint(start);
    const endPoint = this.worldToCanvasPoint(end);
    if (!startPoint || !endPoint) return;

    const outline = this.createMeasurementLine(startPoint, endPoint, "measurement-line-outline");
    const line = this.createMeasurementLine(startPoint, endPoint, "measurement-line");
    if (isPreview) {
      outline.setAttribute("opacity", "0.7");
      line.setAttribute("opacity", "0.7");
    }
    this.measurementOverlay.appendChild(outline);
    this.measurementOverlay.appendChild(line);

    this.drawMeasurementPoint(start);
    this.drawMeasurementPoint(end);

    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const label = this.createSvgElement("text");
    label.textContent = this.formatMeasurementLength(distance);
    label.setAttribute("x", (startPoint.x + endPoint.x) / 2);
    label.setAttribute("y", (startPoint.y + endPoint.y) / 2 - 8);
    label.setAttribute("text-anchor", "middle");
    this.measurementOverlay.appendChild(label);
  }

  createMeasurementLine(startPoint, endPoint, className) {
    const line = this.createSvgElement("line");
    line.setAttribute("class", className);
    line.setAttribute("x1", startPoint.x);
    line.setAttribute("y1", startPoint.y);
    line.setAttribute("x2", endPoint.x);
    line.setAttribute("y2", endPoint.y);
    return line;
  }

  drawMeasurementPoint(point) {
    const canvasPoint = this.worldToCanvasPoint(point);
    if (!canvasPoint) return;

    const circle = this.createSvgElement("circle");
    circle.setAttribute("cx", canvasPoint.x);
    circle.setAttribute("cy", canvasPoint.y);
    circle.setAttribute("r", "4");
    this.measurementOverlay.appendChild(circle);
  }

  createSvgElement(tagName) {
    return document.createElementNS("http://www.w3.org/2000/svg", tagName);
  }

  formatMeasurementLength(length) {
    if (this.measurementUnit === "inch") {
      const inches = length / 25.4;
      const decimals = inches >= 1 ? 4 : 5;
      return `${inches.toFixed(decimals)} in`;
    }

    const decimals = length >= 10 ? 2 : 3;
    return `${length.toFixed(decimals)} mm`;
  }

  formatDimensionPair(widthMm, heightMm) {
    if (this.measurementUnit === "inch") {
      return `${(widthMm / 25.4).toFixed(4)} x ${(heightMm / 25.4).toFixed(4)} in`;
    }

    return `${widthMm.toFixed(3)} x ${heightMm.toFixed(3)} mm`;
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
    const selectedLayerIds = this.getSelectedLayerIds();
    if (selectedLayerIds.size === 0) return null;

    const selectedLayers = this.layers.filter((layer) =>
      selectedLayerIds.has(layer.id),
    );
    if (selectedLayers.length === 0) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const layer of selectedLayers) {
      if (layer.bounds) {
        minX = Math.min(minX, layer.bounds.minX);
        maxX = Math.max(maxX, layer.bounds.maxX);
        minY = Math.min(minY, layer.bounds.minY);
        maxY = Math.max(maxY, layer.bounds.maxY);
      }
    }

    if (
      !isFinite(minX) ||
      !isFinite(maxX) ||
      !isFinite(minY) ||
      !isFinite(maxY) ||
      this.canvas.width === 0 ||
      this.canvas.height === 0
    ) {
      return null;
    }

    const viewport = this.getVisibleCanvasViewport();
    if (!viewport) return null;

    const boundsWidth = maxX - minX;
    const boundsHeight = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const targetX = (viewport.left + viewport.right) / 2;
    const targetY = (viewport.top + viewport.bottom) / 2;

    if (boundsWidth === 0 && boundsHeight === 0) {
      return { centerX, centerY, targetX, targetY, zoom: 2.0 };
    }

    let zoom;
    if (boundsWidth === 0) {
      zoom = (viewport.height / boundsHeight) * 0.9;
    } else if (boundsHeight === 0) {
      zoom = (viewport.width / boundsWidth) * 0.9;
    } else {
      zoom =
        Math.min(viewport.width / boundsWidth, viewport.height / boundsHeight) *
        0.9;
    }

    return { centerX, centerY, targetX, targetY, zoom };
  }

  getVisibleCanvasViewport() {
    const rect = this.canvas.getBoundingClientRect();
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      this.canvas.width === 0 ||
      this.canvas.height === 0
    ) {
      return null;
    }

    const visibleRect = {
      left: 0,
      top: 0,
      right: rect.width,
      bottom: rect.height,
    };
    const drawerRect = this.drawer.getBoundingClientRect();
    const intersectsCanvas =
      drawerRect.right > rect.left &&
      drawerRect.left < rect.right &&
      drawerRect.bottom > rect.top &&
      drawerRect.top < rect.bottom;

    if (intersectsCanvas) {
      if (this.isMobileDrawerLayout()) {
        visibleRect.bottom = Math.max(
          visibleRect.top + 1,
          Math.min(visibleRect.bottom, drawerRect.top - rect.top),
        );
      } else {
        visibleRect.right = Math.max(
          visibleRect.left + 1,
          Math.min(visibleRect.right, drawerRect.left - rect.left),
        );
      }
    }

    const topLeft = this.canvasLocalPointToCorrected(
      visibleRect.left,
      visibleRect.top,
      rect,
    );
    const bottomRight = this.canvasLocalPointToCorrected(
      visibleRect.right,
      visibleRect.bottom,
      rect,
    );

    return {
      left: topLeft.x,
      right: bottomRight.x,
      top: topLeft.y,
      bottom: bottomRight.y,
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(topLeft.y - bottomRight.y),
    };
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
    if (!Number.isFinite(zoom)) {
      return this.camera.zoom;
    }

    return Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }

  zoomAtCanvasPoint(clientX, clientY, zoomChange) {
    if (!Number.isFinite(zoomChange) || zoomChange <= 0) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    const mxScreen = clientX - rect.left;
    const myScreen = clientY - rect.top;

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const mouseXNDC = ((mxScreen - centerX) / rect.width) * 2;
    const mouseYNDC = -((myScreen - centerY) / rect.height) * 2;

    const aspect = this.canvas.width / this.canvas.height;
    const mouseXCorrected = aspect > 1.0 ? mouseXNDC * aspect : mouseXNDC;
    const mouseYCorrected = aspect > 1.0 ? mouseYNDC : mouseYNDC / aspect;

    const prevZoom = this.camera.zoom;
    const newZoom = this.clampZoom(prevZoom * zoomChange);
    const zoomRatio = newZoom / prevZoom;

    this.camera.offsetX =
      (this.camera.offsetX - mouseXCorrected) * zoomRatio + mouseXCorrected;
    this.camera.offsetY =
      (this.camera.offsetY - mouseYCorrected) * zoomRatio + mouseYCorrected;
    this.camera.zoom = newZoom;

    this.render();
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
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    const mxScreen = clientX - rect.left;
    const myScreen = clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const mouseXNDC = ((mxScreen - centerX) / rect.width) * 2;
    const mouseYNDC = -((myScreen - centerY) / rect.height) * 2;
    const aspect = this.canvas.width / this.canvas.height;
    const correctedX = aspect > 1.0 ? mouseXNDC * aspect : mouseXNDC;
    const correctedY = aspect > 1.0 ? mouseYNDC : mouseYNDC / aspect;
    const worldX = (correctedX - this.camera.offsetX) / this.getViewScaleX();
    const worldY = (correctedY - this.camera.offsetY) / this.getViewScaleY();
    return { x: worldX, y: worldY };
  }

  worldToCanvasPoint(point) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    const aspect = this.canvas.width / this.canvas.height;
    const correctedX = point.x * this.getViewScaleX() + this.camera.offsetX;
    const correctedY = point.y * this.getViewScaleY() + this.camera.offsetY;
    const ndcX = aspect > 1.0 ? correctedX / aspect : correctedX;
    const ndcY = aspect > 1.0 ? correctedY : correctedY * aspect;
    return {
      x: ((ndcX + 1) / 2) * rect.width,
      y: ((1 - ndcY) / 2) * rect.height,
    };
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

    const deltaXNDC = (deltaX / canvasRect.width) * 2;
    const deltaYNDC = (-deltaY / canvasRect.height) * 2;
    const aspect = this.canvas.width / this.canvas.height;

    if (aspect > 1.0) {
      this.camera.offsetX += deltaXNDC * aspect;
      this.camera.offsetY += deltaYNDC;
    } else {
      this.camera.offsetX += deltaXNDC;
      this.camera.offsetY += deltaYNDC / aspect;
    }

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

      const canvasRect = this.canvas.getBoundingClientRect();
      if (canvasRect.width > 0 && canvasRect.height > 0) {
        const deltaXNDC = (deltaX / canvasRect.width) * 2;
        const deltaYNDC = (-deltaY / canvasRect.height) * 2;
        const aspect = this.canvas.width / this.canvas.height;

        if (aspect > 1.0) {
          this.camera.offsetX += deltaXNDC * aspect;
          this.camera.offsetY += deltaYNDC;
        } else {
          this.camera.offsetX += deltaXNDC;
          this.camera.offsetY += deltaYNDC / aspect;
        }
      }

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

      const canvasRect = this.canvas.getBoundingClientRect();
      if (canvasRect.width > 0 && canvasRect.height > 0) {
        const deltaXNDC = (deltaX / canvasRect.width) * 2;
        const deltaYNDC = (-deltaY / canvasRect.height) * 2;
        const aspect = this.canvas.width / this.canvas.height;

        if (aspect > 1.0) {
          this.camera.offsetX += deltaXNDC * aspect;
          this.camera.offsetY += deltaYNDC;
        } else {
          this.camera.offsetX += deltaXNDC;
          this.camera.offsetY += deltaYNDC / aspect;
        }
      }

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
      layer.visible = this.layerMatchesFilter(layer, kind);
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
    this.layerList.replaceChildren();

    this.layers.forEach((layer, index) => {
      const li = document.createElement("li");
      li.className = "layer-item";
      li.dataset.layerId = layer.id;
      li.dataset.layerIndex = String(index);
      li.draggable = true;
      li.addEventListener("dragstart", (event) =>
        this.handleLayerDragStart(event, layer.id),
      );
      li.addEventListener("dragend", (event) => this.handleLayerDragEnd(event));

      // Color picker
      const colorPicker = document.createElement("input");
      colorPicker.type = "color";
      colorPicker.className = "layer-color-picker";
      colorPicker.value = this.rgbToHex(layer.color);
      colorPicker.addEventListener("change", (e) => {
        this.updateLayerColor(layer.id, e.target.value);
      });

      // Checkbox
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "layer-checkbox";
      checkbox.checked = layer.visible;
      checkbox.addEventListener("change", () => {
        layer.visible = checkbox.checked;
        this.render();
        this.updateUiState();
      });

      // Label
      const label = document.createElement("label");
      label.className = "layer-label";
      const layerName = document.createElement("strong");
      const layerMeta = document.createElement("span");
      layerName.textContent = layer.name;
      layerMeta.textContent = this.formatLayerBounds(layer);
      label.append(layerName, layerMeta);
      label.addEventListener("click", () => {
        layer.visible = !layer.visible;
        checkbox.checked = layer.visible;
        this.render();
        this.updateUiState();
      });

      // Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "icon-button layer-delete-btn";
      deleteBtn.setAttribute("aria-label", "Delete layer");
      deleteBtn.title = "Delete layer";
      const deleteIcon = document.createElement("i");
      deleteIcon.setAttribute("data-lucide", "trash-2");
      deleteBtn.appendChild(deleteIcon);
      deleteBtn.addEventListener("click", () => {
        this.deleteLayer(layer.id);
      });

      li.appendChild(colorPicker);
      li.appendChild(checkbox);
      li.appendChild(label);
      li.appendChild(deleteBtn);
      this.layerList.appendChild(li);
    });

    if (this.layers.length === 0) {
      const li = document.createElement("li");
      li.className = "layer-item";
      li.style.gridTemplateColumns = "1fr";
      const label = document.createElement("label");
      label.className = "layer-label";
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      title.textContent = "No layers";
      detail.textContent = "Ready";
      label.append(title, detail);
      li.appendChild(label);
      this.layerList.appendChild(li);
    }

    this.refreshIcons();
  }

  formatLayerBounds(layer) {
    if (!layer.bounds) {
      return layer.visible ? "visible" : "hidden";
    }

    const width = layer.bounds.maxX - layer.bounds.minX;
    const height = layer.bounds.maxY - layer.bounds.minY;
    return this.formatDimensionPair(width, height);
  }

  rgbToHex(rgb) {
    const r = Math.round(rgb[0] * 255)
      .toString(16)
      .padStart(2, "0");
    const g = Math.round(rgb[1] * 255)
      .toString(16)
      .padStart(2, "0");
    const b = Math.round(rgb[2] * 255)
      .toString(16)
      .padStart(2, "0");
    return `#${r}${g}${b}`;
  }

  // Drawer management methods
  isMobileDrawerLayout() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  getCssPixelValue(propertyName, fallback) {
    const rawValue = getComputedStyle(this.dropZone)
      .getPropertyValue(propertyName)
      .trim();
    const parsedValue = parseFloat(rawValue);
    return Number.isFinite(parsedValue) ? parsedValue : fallback;
  }

  getDrawerCollapsedWidth() {
    return this.getCssPixelValue(
      "--panel-collapsed-width",
      this.drawerCollapsedWidth,
    );
  }

  getDrawerCollapsedHeight() {
    return this.getCssPixelValue(
      "--panel-collapsed-height",
      this.drawerCollapsedHeight,
    );
  }

  getDrawerSnapThreshold() {
    return this.getCssPixelValue(
      "--panel-snap-threshold",
      this.drawerSnapThreshold,
    );
  }

  getDrawerBottomCollapseThreshold() {
    return this.getCssPixelValue(
      "--panel-bottom-collapse-threshold",
      this.drawerBottomCollapseThreshold,
    );
  }

  getDrawerMaxWidth() {
    const viewportLimit = Math.max(this.drawerMinWidth, window.innerWidth - 48);
    return Math.min(this.drawerMaxWidth, viewportLimit);
  }

  clampDrawerWidth(width) {
    if (!Number.isFinite(width)) {
      return this.drawerCurrentWidth;
    }

    return Math.min(
      this.getDrawerMaxWidth(),
      Math.max(this.drawerMinWidth, width),
    );
  }

  setDrawerWidth(width, { commitLayout = true } = {}) {
    const clampedWidth = this.clampDrawerWidth(width);
    this.dropZone.style.setProperty("--panel-overlay-width", `${clampedWidth}px`);
    if (commitLayout) {
      this.drawerCurrentWidth = clampedWidth;
      this.drawerPendingWidth = null;
      this.dropZone.style.setProperty("--panel-width", `${clampedWidth}px`);
    } else {
      this.drawerPendingWidth = clampedWidth;
    }
    this.drawer.style.height = "";
    this.drawer.style.width = `${clampedWidth}px`;
  }

  getDrawerMaxHeight() {
    const viewportLimit = Math.max(
      1,
      Math.floor(window.innerHeight * this.drawerMobileMaxHeightRatio),
    );
    return Math.min(this.drawerMaxHeight, viewportLimit);
  }

  clampDrawerHeight(height) {
    if (!Number.isFinite(height)) {
      return this.drawerCurrentHeight;
    }

    const maxHeight = this.getDrawerMaxHeight();
    const minHeight = Math.min(this.drawerMinHeight, maxHeight);

    return Math.min(maxHeight, Math.max(minHeight, height));
  }

  setDrawerHeight(height, { commitLayout = true } = {}) {
    const clampedHeight = this.clampDrawerHeight(height);
    this.dropZone.style.setProperty("--panel-overlay-height", `${clampedHeight}px`);
    if (commitLayout) {
      this.drawerCurrentHeight = clampedHeight;
      this.drawerPendingHeight = null;
      this.dropZone.style.setProperty("--panel-height", `${clampedHeight}px`);
    } else {
      this.drawerPendingHeight = clampedHeight;
    }
    this.drawer.style.width = "";
    this.drawer.style.height = `${clampedHeight}px`;
  }

  startDrawerResize(e) {
    e.preventDefault();
    this.isResizingDrawer = true;
    this.drawer.classList.add("resizing");
    document.body.style.userSelect = "none";
    document.body.style.cursor = this.isMobileDrawerLayout()
      ? "ns-resize"
      : "ew-resize";
  }

  resizeDrawer(e) {
    if (!this.isResizingDrawer) return;

    e.preventDefault();

    if (this.isMobileDrawerLayout()) {
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      this.previewDrawerResize(window.innerHeight - clientY, "height");
      return;
    }

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    this.previewDrawerResize(window.innerWidth - clientX, "width");
  }

  previewDrawerResize(rawSize, axis) {
    const wasCollapsed = this.drawer.classList.contains("collapsed");
    const collapsedSize =
      axis === "height"
        ? this.getDrawerCollapsedHeight()
        : this.getDrawerCollapsedWidth();
    const collapseThreshold =
      axis === "height"
        ? this.getDrawerBottomCollapseThreshold()
        : collapsedSize + this.getDrawerSnapThreshold();

    if (rawSize <= collapseThreshold) {
      this.drawer.classList.add("collapsed");
      if (axis === "height") {
        this.drawerPendingHeight = null;
        this.dropZone.style.setProperty(
          "--panel-overlay-height",
          `${collapsedSize}px`,
        );
        this.drawer.style.height = `${this.drawerCurrentHeight}px`;
      } else {
        this.drawerPendingWidth = null;
        this.dropZone.style.setProperty(
          "--panel-overlay-width",
          `${collapsedSize}px`,
        );
        this.drawer.style.width = `${this.drawerCurrentWidth}px`;
      }
      if (!wasCollapsed) {
        this.updateDrawerToggleState();
      }
      return;
    }

    this.drawer.classList.remove("collapsed");
    if (axis === "height") {
      this.setDrawerHeight(rawSize, { commitLayout: false });
    } else {
      this.setDrawerWidth(rawSize, { commitLayout: false });
    }
    if (wasCollapsed) {
      this.updateDrawerToggleState();
    }
  }

  stopDrawerResize(e) {
    if (!this.isResizingDrawer) return;

    if (this.drawer.classList.contains("collapsed")) {
      this.drawerPendingHeight = null;
      this.drawerPendingWidth = null;
    } else if (this.isMobileDrawerLayout()) {
      if (this.drawerPendingHeight !== null) {
        this.setDrawerHeight(this.drawerPendingHeight);
      }
    } else if (this.drawerPendingWidth !== null) {
      this.setDrawerWidth(this.drawerPendingWidth);
    }

    this.isResizingDrawer = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    requestAnimationFrame(() => {
      this.drawer.classList.remove("resizing");
    });
    this.render();
  }

  triggerCanvasResize() {
    // Dispatch resize event to notify canvas needs update
    window.dispatchEvent(new Event("resize"));
  }

  toggleDrawer(forceOpen = null) {
    const isCollapsed = this.drawer.classList.contains("collapsed");
    const shouldOpen = forceOpen === null ? isCollapsed : forceOpen;

    if (shouldOpen) {
      // Expand drawer
      this.drawer.classList.remove("collapsed");
      if (this.isMobileDrawerLayout()) {
        this.setDrawerHeight(this.drawerCurrentHeight);
      } else {
        this.setDrawerWidth(this.drawerCurrentWidth);
      }
    } else {
      // Collapse drawer
      const drawerRect = this.drawer.getBoundingClientRect();
      if (this.isMobileDrawerLayout()) {
        this.drawerCurrentHeight = this.clampDrawerHeight(
          drawerRect.height || this.drawerCurrentHeight,
        );
      } else {
        this.drawerCurrentWidth = this.clampDrawerWidth(
          drawerRect.width || this.drawerCurrentWidth,
        );
      }
      this.drawer.classList.add("collapsed");
    }

    this.updateDrawerToggleState();
  }

  updateDrawerToggleState() {
    const isCollapsed = this.drawer.classList.contains("collapsed");
    const label = isCollapsed ? "Show panel" : "Hide panel";
    const iconName = this.isMobileDrawerLayout()
      ? isCollapsed
        ? "chevron-up"
        : "chevron-down"
      : isCollapsed
        ? "panel-right-open"
        : "panel-right-close";
    this.drawerToggleBtn.setAttribute("aria-label", label);
    this.drawerToggleBtn.setAttribute("aria-expanded", String(!isCollapsed));
    this.drawerToggleBtn.title = label;
    this.drawerToggleBtn.replaceChildren();
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", iconName);
    this.drawerToggleBtn.appendChild(icon);
    this.refreshIcons();
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
