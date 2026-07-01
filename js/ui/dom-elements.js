function requireElement(documentRef, id) {
  const element = documentRef.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element #${id}`);
  }
  return element;
}

export function getViewerElements(documentRef = document) {
  const canvas = requireElement(documentRef, "gerber-canvas");
  const viewerSurface = canvas.closest(".viewer-surface");
  if (!viewerSurface) {
    throw new Error("Missing viewer surface");
  }

  const notification = requireElement(documentRef, "file-size-warning");
  const notificationCloseBtn = notification.querySelector(
    "[data-notification-close]",
  );
  if (!notificationCloseBtn) {
    throw new Error("Missing notification close button");
  }

  return {
    canvas,
    viewerSurface,
    fileInput: requireElement(documentRef, "file-input"),
    selectFilesBtn: requireElement(documentRef, "select-files-btn"),
    toolbarClearAllBtn: requireElement(documentRef, "toolbar-clear-all-btn"),
    emptyUploadBtn: requireElement(documentRef, "empty-upload-btn"),
    fitViewBtn: requireElement(documentRef, "fit-view-btn"),
    flipHorizontalBtn: requireElement(documentRef, "flip-horizontal-btn"),
    flipVerticalBtn: requireElement(documentRef, "flip-vertical-btn"),
    canvasThemeToggle: requireElement(documentRef, "canvas-theme-toggle"),
    screenshotBtn: requireElement(documentRef, "screenshot-btn"),
    screenshotDialog: requireElement(documentRef, "screenshot-dialog"),
    screenshotForm: requireElement(documentRef, "screenshot-form"),
    screenshotBackgroundToggle: requireElement(
      documentRef,
      "screenshot-background-toggle",
    ),
    screenshotScaleSelect: requireElement(documentRef, "screenshot-scale-select"),
    screenshotResolution: requireElement(documentRef, "screenshot-resolution"),
    screenshotProgressLabel: requireElement(
      documentRef,
      "screenshot-progress-label",
    ),
    screenshotProgressValue: requireElement(
      documentRef,
      "screenshot-progress-value",
    ),
    screenshotProgressBar: requireElement(documentRef, "screenshot-progress-bar"),
    screenshotCancelBtn: requireElement(documentRef, "screenshot-cancel-btn"),
    screenshotDismissBtn: requireElement(documentRef, "screenshot-dismiss-btn"),
    screenshotExportBtn: requireElement(documentRef, "screenshot-export-btn"),
    loadingModal: requireElement(documentRef, "loading-modal"),
    loadingTitle: requireElement(documentRef, "loading-title"),
    loadingStage: requireElement(documentRef, "loading-stage"),
    loadingFileName: requireElement(documentRef, "loading-file-name"),
    loadingProgressCount: requireElement(documentRef, "loading-progress-count"),
    loadingProgressValue: requireElement(documentRef, "loading-progress-value"),
    loadingProgressBar: requireElement(documentRef, "loading-progress-bar"),
    rulerToggleBtn: requireElement(documentRef, "ruler-toggle-btn"),
    rulerClearBtn: requireElement(documentRef, "ruler-clear-btn"),
    measurementUnitToggle: requireElement(
      documentRef,
      "measurement-unit-toggle",
    ),
    fullscreenBtn: requireElement(documentRef, "fullscreen-btn"),
    selectAllBtn: requireElement(documentRef, "select-all-btn"),
    selectTopBtn: requireElement(documentRef, "select-top-btn"),
    selectBottomBtn: requireElement(documentRef, "select-bottom-btn"),
    unselectAllBtn: requireElement(documentRef, "unselect-all-btn"),
    clearAllBtn: requireElement(documentRef, "clear-all-btn"),
    clearDiagnosticsBtn: requireElement(documentRef, "clear-diagnostics-btn"),
    alphaSlider: requireElement(documentRef, "alpha-slider"),
    alphaValue: requireElement(documentRef, "alpha-value"),
    boardOutlineSelect: requireElement(documentRef, "board-outline-select"),
    boardOutlineStatus: requireElement(documentRef, "board-outline-status"),
    layerList: requireElement(documentRef, "layer-list"),
    diagnosticList: requireElement(documentRef, "diagnostic-list"),
    notification,
    notificationTitle: requireElement(documentRef, "warning-title"),
    notificationMessage: requireElement(documentRef, "warning-message"),
    notificationCloseBtn,
    workspaceStatus: requireElement(documentRef, "workspace-status"),
    emptyState: requireElement(documentRef, "empty-state"),
    emptyFileSizeLimit: requireElement(documentRef, "empty-file-size-limit"),
    measurementOverlay: requireElement(documentRef, "measurement-overlay"),
    visibleLayerCount: requireElement(documentRef, "visible-layer-count"),
    zoomReadout: requireElement(documentRef, "zoom-readout"),
    cursorReadout: requireElement(documentRef, "cursor-readout"),
    boundsReadout: requireElement(documentRef, "bounds-readout"),
    diagnosticsCount: requireElement(documentRef, "diagnostics-count"),
    renderingModeLazyInput: requireElement(documentRef, "rendering-mode-lazy"),
    renderingModeRealtimeInput: requireElement(
      documentRef,
      "rendering-mode-realtime",
    ),
    compositeModeBlendInput: requireElement(
      documentRef,
      "composite-mode-blend",
    ),
    compositeModeStackInput: requireElement(
      documentRef,
      "composite-mode-stack",
    ),
    interactionModeOnInput: requireElement(documentRef, "interaction-mode-on"),
    interactionModeOffInput: requireElement(documentRef, "interaction-mode-off"),
    regionArcExactInput: requireElement(documentRef, "region-arc-exact"),
    regionArcApproximateInput: requireElement(
      documentRef,
      "region-arc-approximate",
    ),
    arcQualityLowInput: requireElement(documentRef, "arc-quality-low"),
    arcQualityNormalInput: requireElement(documentRef, "arc-quality-normal"),
    arcQualityHighInput: requireElement(documentRef, "arc-quality-high"),
    minimumVisibilityOffInput: requireElement(
      documentRef,
      "minimum-visibility-off",
    ),
    minimumVisibility1Input: requireElement(
      documentRef,
      "minimum-visibility-1",
    ),
    minimumVisibility2Input: requireElement(
      documentRef,
      "minimum-visibility-2",
    ),
    boardOutlineBoundsMarginInput: requireElement(
      documentRef,
      "board-outline-bounds-margin",
    ),
    boardOutlineBoundsMarginUnitMmInput: requireElement(
      documentRef,
      "board-outline-bounds-margin-unit-mm",
    ),
    boardOutlineBoundsMarginUnitInchInput: requireElement(
      documentRef,
      "board-outline-bounds-margin-unit-inch",
    ),
    drillOutlineOffInput: requireElement(documentRef, "drill-outline-off"),
    drillOutline1Input: requireElement(documentRef, "drill-outline-1"),
    drillOutline2Input: requireElement(documentRef, "drill-outline-2"),
    drillOutline3Input: requireElement(documentRef, "drill-outline-3"),
    pthPlating10Input: requireElement(documentRef, "pth-plating-10"),
    pthPlating20Input: requireElement(documentRef, "pth-plating-20"),
    pthPlating30Input: requireElement(documentRef, "pth-plating-30"),
    pthPlating40Input: requireElement(documentRef, "pth-plating-40"),
    pthPlating50Input: requireElement(documentRef, "pth-plating-50"),
    topFilterInput: requireElement(documentRef, "top-filter-input"),
    bottomFilterInput: requireElement(documentRef, "bottom-filter-input"),
    filterSaveBtn: requireElement(documentRef, "filter-save-btn"),
    filterDefaultBtn: requireElement(documentRef, "filter-default-btn"),
    filterRestoreBtn: requireElement(documentRef, "filter-restore-btn"),
    panelTabs: Array.from(documentRef.querySelectorAll("[data-panel-tab]")),
    panelSections: Array.from(documentRef.querySelectorAll("[data-panel]")),
    drawer: requireElement(documentRef, "drawer"),
    resizeHandle: requireElement(documentRef, "resize-handle"),
    drawerToggleBtn: requireElement(documentRef, "drawer-toggle"),
    dropZone: requireElement(documentRef, "drop-zone"),
  };
}
