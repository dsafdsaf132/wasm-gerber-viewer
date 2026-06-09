export class DrawerController {
  constructor({
    drawer,
    resizeHandle,
    toggleButton,
    dropZone,
    refreshIcons,
    captureViewState = () => null,
    onResizeEnd,
    documentRef = document,
    windowRef = window,
  }) {
    this.drawer = drawer;
    this.resizeHandle = resizeHandle;
    this.toggleButton = toggleButton;
    this.dropZone = dropZone;
    this.refreshIcons = refreshIcons;
    this.captureViewState = captureViewState;
    this.onResizeEnd = onResizeEnd;
    this.document = documentRef;
    this.window = windowRef;

    this.isResizing = false;
    this.resizeViewState = null;
    this.currentWidth = 381;
    this.currentHeight = 420;
    this.pendingWidth = null;
    this.pendingHeight = null;
    this.minWidth = 200;
    this.maxWidth = 600;
    this.minHeight = 300;
    this.maxHeight = 560;
    this.mobileMaxHeightRatio = 0.72;
    this.collapsedWidth = 156;
    this.collapsedHeight = 122;
    this.snapThreshold = 50;
    this.bottomCollapseThreshold = 200;
  }

  bindEvents() {
    this.resizeHandle.addEventListener("mousedown", (event) =>
      this.startResize(event),
    );
    this.document.addEventListener("mousemove", (event) =>
      this.resize(event),
    );
    this.document.addEventListener("mouseup", (event) => this.stopResize(event));

    this.resizeHandle.addEventListener(
      "touchstart",
      (event) => this.startResize(event),
      { passive: false },
    );
    this.document.addEventListener("touchmove", (event) => this.resize(event), {
      passive: false,
    });
    this.document.addEventListener("touchend", (event) => this.stopResize(event), {
      passive: false,
    });

    this.toggleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      this.toggle();
    });
  }

  initialize() {
    if (this.isMobileLayout()) {
      this.drawer.classList.add("collapsed");
    }
    this.updateCanvasReservationForState();
    this.updateToggleState();
  }

  syncLayout() {
    if (this.drawer.classList.contains("collapsed")) {
      this.syncCollapsedLayout();
      this.updateCanvasReservationForState();
      return;
    }

    if (this.isMobileLayout()) {
      this.setHeight(this.currentHeight);
    } else {
      this.setWidth(this.currentWidth);
    }
  }

  syncCollapsedLayout() {
    if (this.isMobileLayout()) {
      this.drawer.style.width = "";
      this.drawer.style.height = `${this.currentHeight}px`;
      return;
    }

    this.drawer.style.height = "";
    this.drawer.style.width = `${this.currentWidth}px`;
  }

  isMobileLayout() {
    return this.window.matchMedia("(max-width: 760px)").matches;
  }

  getCssPixelValue(propertyName, fallback) {
    const rawValue = this.window
      .getComputedStyle(this.dropZone)
      .getPropertyValue(propertyName)
      .trim();
    const parsedValue = parseFloat(rawValue);
    return Number.isFinite(parsedValue) ? parsedValue : fallback;
  }

  getCollapsedWidth() {
    return this.getCssPixelValue("--panel-collapsed-width", this.collapsedWidth);
  }

  getCollapsedHeight() {
    return this.getCssPixelValue(
      "--panel-collapsed-height",
      this.collapsedHeight,
    );
  }

  getSnapThreshold() {
    return this.getCssPixelValue("--panel-snap-threshold", this.snapThreshold);
  }

  getBottomCollapseThreshold() {
    return this.getCssPixelValue(
      "--panel-bottom-collapse-threshold",
      this.bottomCollapseThreshold,
    );
  }

  getMaxWidth() {
    const viewportLimit = Math.max(this.minWidth, this.window.innerWidth - 48);
    return Math.min(this.maxWidth, viewportLimit);
  }

  clampWidth(width) {
    if (!Number.isFinite(width)) {
      return this.currentWidth;
    }

    return Math.min(this.getMaxWidth(), Math.max(this.minWidth, width));
  }

  setWidth(width, { commitLayout = true } = {}) {
    const clampedWidth = this.clampWidth(width);
    this.dropZone.style.setProperty("--panel-overlay-width", `${clampedWidth}px`);
    if (commitLayout) {
      this.currentWidth = clampedWidth;
      this.pendingWidth = null;
      this.dropZone.style.setProperty("--panel-width", `${clampedWidth}px`);
      this.dropZone.style.setProperty(
        "--canvas-reserved-width",
        `${clampedWidth}px`,
      );
    } else {
      this.pendingWidth = clampedWidth;
    }
    this.drawer.style.height = "";
    this.drawer.style.width = `${clampedWidth}px`;
  }

  getMaxHeight() {
    const viewportLimit = Math.max(
      1,
      Math.floor(this.window.innerHeight * this.mobileMaxHeightRatio),
    );
    return Math.min(this.maxHeight, viewportLimit);
  }

  clampHeight(height) {
    if (!Number.isFinite(height)) {
      return this.currentHeight;
    }

    const maxHeight = this.getMaxHeight();
    const minHeight = Math.min(this.minHeight, maxHeight);
    return Math.min(maxHeight, Math.max(minHeight, height));
  }

  setHeight(height, { commitLayout = true } = {}) {
    const clampedHeight = this.clampHeight(height);
    this.dropZone.style.setProperty("--panel-overlay-height", `${clampedHeight}px`);
    if (commitLayout) {
      this.currentHeight = clampedHeight;
      this.pendingHeight = null;
      this.dropZone.style.setProperty("--panel-height", `${clampedHeight}px`);
      this.dropZone.style.setProperty(
        "--canvas-reserved-height",
        `${clampedHeight}px`,
      );
    } else {
      this.pendingHeight = clampedHeight;
    }
    this.drawer.style.width = "";
    this.drawer.style.height = `${clampedHeight}px`;
  }

  startResize(event) {
    event.preventDefault();
    this.isResizing = true;
    this.resizeViewState = this.captureViewState?.() ?? null;
    this.drawer.classList.add("resizing");
    this.document.body.style.userSelect = "none";
    this.document.body.style.cursor = this.isMobileLayout()
      ? "ns-resize"
      : "ew-resize";
  }

  resize(event) {
    if (!this.isResizing) return;

    event.preventDefault();

    if (this.isMobileLayout()) {
      const clientY = event.touches ? event.touches[0].clientY : event.clientY;
      this.previewResize(this.window.innerHeight - clientY, "height");
      return;
    }

    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    this.previewResize(this.window.innerWidth - clientX, "width");
  }

  previewResize(rawSize, axis) {
    const wasCollapsed = this.drawer.classList.contains("collapsed");
    const collapsedSize =
      axis === "height" ? this.getCollapsedHeight() : this.getCollapsedWidth();
    const collapseThreshold =
      axis === "height"
        ? this.getBottomCollapseThreshold()
        : collapsedSize + this.getSnapThreshold();

    if (rawSize <= collapseThreshold) {
      this.collapsePreview(axis, collapsedSize);
      if (!wasCollapsed) {
        this.updateToggleState();
      }
      return;
    }

    this.drawer.classList.remove("collapsed");
    if (axis === "height") {
      this.setHeight(rawSize, { commitLayout: false });
    } else {
      this.setWidth(rawSize, { commitLayout: false });
    }
    if (wasCollapsed) {
      this.updateToggleState();
    }
  }

  collapsePreview(axis, collapsedSize) {
    this.drawer.classList.add("collapsed");
    if (axis === "height") {
      this.pendingHeight = null;
      this.dropZone.style.setProperty(
        "--panel-overlay-height",
        `${collapsedSize}px`,
      );
      this.drawer.style.height = `${this.currentHeight}px`;
    } else {
      this.pendingWidth = null;
      this.dropZone.style.setProperty(
        "--panel-overlay-width",
        `${collapsedSize}px`,
      );
      this.drawer.style.width = `${this.currentWidth}px`;
    }
  }

  stopResize() {
    if (!this.isResizing) return;

    const viewState = this.resizeViewState ?? this.captureViewState?.() ?? null;

    if (this.drawer.classList.contains("collapsed")) {
      this.pendingHeight = null;
      this.pendingWidth = null;
    } else if (this.isMobileLayout()) {
      if (this.pendingHeight !== null) {
        this.setHeight(this.pendingHeight);
      }
    } else if (this.pendingWidth !== null) {
      this.setWidth(this.pendingWidth);
    }

    this.isResizing = false;
    this.resizeViewState = null;
    this.document.body.style.userSelect = "";
    this.document.body.style.cursor = "";
    this.window.requestAnimationFrame(() => {
      this.drawer.classList.remove("resizing");
    });
    this.updateCanvasReservationForState();
    this.onResizeEnd?.(viewState);
  }

  toggle(forceOpen = null) {
    const viewState = this.captureViewState?.() ?? null;
    const isCollapsed = this.drawer.classList.contains("collapsed");
    const shouldOpen = forceOpen === null ? isCollapsed : forceOpen;

    if (shouldOpen) {
      this.drawer.classList.remove("collapsed");
      if (this.isMobileLayout()) {
        this.setHeight(this.currentHeight);
      } else {
        this.setWidth(this.currentWidth);
      }
    } else {
      this.captureCurrentSize();
      this.drawer.classList.add("collapsed");
    }

    this.updateCanvasReservationForState();
    this.updateToggleState();
    this.window.requestAnimationFrame(() => {
      this.onResizeEnd?.(viewState);
    });
  }

  captureCurrentSize() {
    const drawerRect = this.drawer.getBoundingClientRect();
    if (this.isMobileLayout()) {
      this.currentHeight = this.clampHeight(
        drawerRect.height || this.currentHeight,
      );
    } else {
      this.currentWidth = this.clampWidth(drawerRect.width || this.currentWidth);
    }
  }

  updateToggleState() {
    const isCollapsed = this.drawer.classList.contains("collapsed");
    const label = isCollapsed ? "Show panel" : "Hide panel";
    const iconName = this.isMobileLayout()
      ? isCollapsed
        ? "chevron-up"
        : "chevron-down"
      : isCollapsed
        ? "panel-right-open"
        : "panel-right-close";

    this.toggleButton.setAttribute("aria-label", label);
    this.toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
    this.toggleButton.title = label;
    this.toggleButton.replaceChildren();
    const icon = this.document.createElement("i");
    icon.setAttribute("data-lucide", iconName);
    this.toggleButton.appendChild(icon);
    this.refreshIcons?.();
  }

  updateCanvasReservationForState() {
    const isCollapsed = this.drawer.classList.contains("collapsed");

    if (this.isMobileLayout()) {
      const reservedHeight = isCollapsed
        ? this.getCollapsedHeight()
        : this.currentHeight;
      this.dropZone.style.setProperty(
        "--canvas-reserved-height",
        `${reservedHeight}px`,
      );
      return;
    }

    const reservedWidth = isCollapsed
      ? this.getCollapsedWidth()
      : this.currentWidth;
    this.dropZone.style.setProperty(
      "--canvas-reserved-width",
      `${reservedWidth}px`,
    );
  }
}
