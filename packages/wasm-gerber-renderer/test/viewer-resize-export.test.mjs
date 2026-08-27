import assert from "node:assert/strict";
import test from "node:test";

import { GerberViewer } from "../../../js/core/viewer.js";
import { ScreenshotExporter } from "../../../js/rendering/screenshot-exporter.js";

function createResizeViewer({ width = 100, height = 50 } = {}) {
  const viewer = Object.create(GerberViewer.prototype);
  viewer.canvas = {
    width,
    height,
    getBoundingClientRect: () => ({ width, height }),
  };
  viewer.drawerController = { syncLayout() {} };
  viewer.flushLazyViewportRender = () => {};
  viewer.restoreCanvasViewState = () => {};
  viewer.requestRender = () => {};
  viewer.addDiagnostic = () => {};
  viewer.isWebGlContextLost = false;
  viewer.isRestoringWebGlContext = false;
  viewer.interactionProcessor = null;
  return viewer;
}

test("viewer resize keeps canvas dimensions atomic with renderer allocation", (context) => {
  context.mock.method(console, "error", () => {});
  const viewer = createResizeViewer();
  let resizeCalls = 0;
  viewer.wasmProcessor = {
    resize_to(nextWidth, nextHeight) {
      resizeCalls += 1;
      assert.deepEqual([nextWidth, nextHeight], [200, 120]);
      assert.deepEqual(
        [viewer.canvas.width, viewer.canvas.height],
        [100, 50],
        "the drawing buffer must not change before the transactional resize commits",
      );
      throw new Error("forced allocation failure");
    },
  };

  assert.equal(
    viewer.resizeCanvas({ targetSize: { width: 200, height: 120 } }),
    false,
  );
  assert.equal(resizeCalls, 1);
  assert.deepEqual([viewer.canvas.width, viewer.canvas.height], [100, 50]);
});

test("viewer skips redundant and already-restored processor resizes", () => {
  const viewer = createResizeViewer();
  let resizeCalls = 0;
  viewer.wasmProcessor = {
    resize_to() {
      resizeCalls += 1;
    },
  };

  assert.equal(
    viewer.resizeCanvas({ targetSize: { width: 100, height: 50 } }),
    true,
  );
  assert.equal(resizeCalls, 0, "an unchanged drawing buffer must preserve FBOs");

  assert.equal(
    viewer.resizeCanvas({
      targetSize: { width: 180, height: 90 },
      skipProcessorResize: true,
    }),
    true,
  );
  assert.equal(resizeCalls, 0, "context restore already allocated the target FBO size");
  assert.deepEqual([viewer.canvas.width, viewer.canvas.height], [180, 90]);
});

test("cached context restore reapplies authoritative composite bitsets", () => {
  const viewer = Object.create(GerberViewer.prototype);
  const calls = [];
  const bitset = new Uint8Array([0x96]);
  const processor = {
    set_composite_visible_bits(layerId, restoredBitset) {
      calls.push([layerId, restoredBitset]);
    },
  };
  viewer.synchronizeCompositeBitsetsAfterCachedRestore(
    [
      { kind: "gerber", layerId: 2 },
      { kind: "composite", layerId: 7, visibleBitset: bitset },
      { kind: "composite", layerId: null, visibleBitset: new Uint8Array([1]) },
    ],
    processor,
  );

  assert.deepEqual(calls, [[7, bitset]]);
  assert.throws(
    () => viewer.synchronizeCompositeBitsetsAfterCachedRestore(
      [{ kind: "composite", layerId: 7, visibleBitset: bitset }],
      {},
    ),
    /updated WASM module/,
  );
});

test("viewer area scan session accumulates bands and transfers one final code array", async () => {
  const viewer = Object.create(GerberViewer.prototype);
  const finalCodes = new Uint32Array([0, 7, 0xffffff]);
  const calls = [];
  viewer.canvas = { height: 256 };
  viewer.wasmProcessor = {
    begin_composite_area_scan(layerId) {
      calls.push(["begin", layerId]);
    },
    scan_composite_area_band(layerId, startY, rows) {
      calls.push(["band", layerId, startY, rows]);
    },
    finish_composite_area_scan(layerId) {
      calls.push(["finish", layerId]);
      return finalCodes;
    },
    cancel_composite_area_scan(layerId) {
      calls.push(["cancel", layerId]);
    },
  };
  viewer.getCompositeSelectionPreviewStateKey = () => "preview";
  viewer.renderCompositeAreaList = () => {};
  viewer.scheduleCompositeFatalRecovery = () => false;
  viewer.addDiagnostic = () => {};
  const selection = {
    layer: { layerId: 11, name: "Composite" },
    previewStateKey: "preview",
    areaScanKey: "preview",
    areaScanNextRow: 0,
    areaScanCodes: new Uint32Array(0),
    areaCodes: new Uint32Array([3]),
    areaCodesScanned: false,
    areaScanInProgress: true,
    areaScanSessionStarted: false,
    areaScanTimer: null,
  };
  viewer.compositeSelection = selection;

  assert.equal(viewer.scanCompositeSelectionAreas(selection), true);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls, [
    ["begin", 11],
    ["band", 11, 0, 128],
    ["band", 11, 128, 128],
    ["finish", 11],
  ]);
  assert.equal(selection.areaCodes, finalCodes);
  assert.equal(selection.areaScanCodes.length, 0);
  assert.equal(selection.areaScanSessionStarted, false);
});

test("browser stream tiles keep one renderer target and crop right-bottom edges", () => {
  const rendererExporter = Object.create(ScreenshotExporter.prototype);
  rendererExporter.handleCompositeRenderErrors = () => 0;
  const renderCalls = [];
  let rendererResizeCalls = 0;
  const fixedRenderer = {
    canvas: { width: 1, height: 1 },
    processor: {
      resize() {
        rendererResizeCalls += 1;
      },
      render_tile(...args) {
        renderCalls.push(args.slice(3, 9));
      },
    },
    gl: { finish() {} },
    blendModes: new Uint8Array([0]),
    activeLayerIds: new Uint32Array([1]),
    colorData: new Float32Array([1, 0, 0, 1]),
    compositeEntries: [],
  };
  const renderState = {
    viewScaleX: 1,
    viewScaleY: 1,
    offsetX: 0,
    offsetY: 0,
  };
  rendererExporter.renderSingleTile(
    fixedRenderer, 100, 70, 0, 0, 64, 32, renderState, false,
  );
  rendererExporter.renderSingleTile(
    fixedRenderer, 100, 70, 36, 38, 64, 32, renderState, false,
  );
  assert.equal(rendererResizeCalls, 1);
  assert.equal(renderCalls.length, 2);

  const exporter = Object.create(ScreenshotExporter.prototype);
  const rendered = [];
  const drawCalls = [];
  let resizeCalls = 0;
  const context = {
    clearRect() {},
    drawImage(...args) {
      drawCalls.push(args);
    },
    save() {},
    scale() {},
    translate() {},
    restore() {},
    getImageData(_x, _y, width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
  };
  exporter.getTileContext = () => context;
  exporter.drawMeasurements = () => {};
  exporter.renderSingleTile = (
    _renderer,
    _exportWidth,
    _exportHeight,
    tileX,
    tileY,
    width,
    height,
  ) => rendered.push([tileX, tileY, width, height]);

  const screenshotRenderer = {
    canvas: { width: 64, height: 32 },
    processor: { resize: () => { resizeCalls += 1; } },
  };
  exporter.renderTileToImageData(
    screenshotRenderer,
    100,
    70,
    1,
    64,
    64,
    36,
    6,
    64,
    32,
    false,
    { backgroundColor: "#000" },
    false,
  );

  assert.deepEqual(rendered, [[36, 38, 64, 32]]);
  assert.deepEqual(
    drawCalls[0].slice(1),
    [28, 26, 36, 6, 0, 0, 36, 6],
    "the edge tile must crop the shifted fixed-size render target",
  );
  assert.equal(resizeCalls, 0);
});

test("composite stream preflight reports progress and honors cancellation between bands", async () => {
  const exporter = Object.create(ScreenshotExporter.prototype);
  exporter.exportCancellation = { cancelled: false };
  const progress = [];
  exporter.setProgress = (value, label = null) => progress.push([value, label]);
  let renderCalls = 0;
  exporter.renderSingleTile = () => {
    renderCalls += 1;
  };
  exporter.yieldToBrowser = async () => {
    exporter.exportCancellation.cancelled = true;
  };

  await assert.rejects(
    exporter.preflightStreamingTiles(
      { compositeEntries: [{ layerId: 1 }] },
      10,
      10,
      { width: 5, height: 5 },
      {},
      0.5,
    ),
    /cancelled/,
  );
  assert.equal(renderCalls, 2, "cancellation is observed before the next band");
  assert.deepEqual(progress[0], [0, "Checking composites"]);
  assert.deepEqual(progress.at(-1), [0.25, null]);
});

test("screenshot Cancel turns the active export token into an abort request", () => {
  const exporter = Object.create(ScreenshotExporter.prototype);
  exporter.isExporting = true;
  exporter.exportCancellation = { cancelled: false };
  exporter.cancelButton = { disabled: false };
  exporter.progressBar = { value: 37 };
  let update = null;
  exporter.setProgress = (value, label) => {
    update = [value, label];
  };

  assert.equal(exporter.cancelExport(), true);
  assert.equal(exporter.exportCancellation.cancelled, true);
  assert.equal(exporter.cancelButton.disabled, true);
  assert.deepEqual(update, [0.37, "Cancelling"]);
});

test("abortable streamed encoding is preferred at every scale when available", () => {
  const exporter = Object.create(ScreenshotExporter.prototype);
  exporter.supportsStreaming = () => true;
  assert.equal(exporter.shouldStream(0.5), true);
  assert.equal(exporter.shouldStream(1), true);
  assert.equal(exporter.shouldStream(2), true);
  exporter.supportsStreaming = () => false;
  assert.equal(exporter.shouldStream(4), false);
});

test("stack screenshot layers inherit opaque alpha", () => {
  const exporter = Object.create(ScreenshotExporter.prototype);
  exporter.getParseOptions = () => ({});
  exporter.getRenderOptions = () => ({
    compositeMode: "stack",
    minimumFeaturePixels: 1,
    boardOutlineBoundsMarginMm: 0,
  });
  exporter.getBoardOutlineSelection = () => "bounds";
  exporter.getLayers = () => [{
    id: "gerber-1",
    kind: "gerber",
    name: "Top",
    visible: true,
    inverted: false,
    sourceContent: "gerber",
    color: [1, 0, 0],
    bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
  }];
  const processor = {
    init() {},
    add_layer: () => 0,
  };
  const renderer = exporter.initializeRenderer(
    {},
    {},
    processor,
    { globalAlpha: 0.2, backgroundColor: "#000000" },
    false,
    {
      initialized: false,
      excludedCompositeClientIds: new Set(),
      reportedCompositeErrors: new Set(),
    },
  );
  assert.equal(renderer.colorData[3], 1);
});

test("screenshot construction failure rebuilds survivor dependency bounds", () => {
  const bounds = (minX, maxX) => ({ minX, maxX, minY: -1, maxY: 1 });
  const gerber = (id, range, options = {}) => ({
    id,
    kind: "gerber",
    name: id,
    visible: false,
    inverted: false,
    sourceContent: id,
    color: [1, 0, 0],
    bounds: bounds(...range),
    renderBounds: bounds(...range),
    ...options,
  });
  const composite = (id, sourceIds) => ({
    id,
    kind: "composite",
    name: id,
    visible: true,
    inverted: false,
    slotSourceIds: sourceIds,
    visibleBitset: new Uint8Array([0xfe]),
    color: [0, 1, 0],
  });
  const layers = [
    gerber("anchor", [-1, 1], { visible: true }),
    gerber("remote-inverted", [1000, 1001], { inverted: true }),
    gerber("remote-other", [1004, 1005]),
    composite("remote-failure", ["remote-inverted", "remote-other"]),
    gerber("healthy-inverted", [-1, 1], { inverted: true }),
    gerber("healthy-other", [4, 5]),
    composite("healthy", ["healthy-inverted", "healthy-other"]),
  ];
  const exporter = Object.create(ScreenshotExporter.prototype);
  exporter.getParseOptions = () => ({});
  exporter.getRenderOptions = () => ({
    compositeMode: "blend",
    minimumFeaturePixels: 1,
    boardOutlineBoundsMarginMm: 0,
  });
  exporter.getBoardOutlineSelection = () => "bounds";
  exporter.getLayers = () => layers;
  exporter.reportCompositeError = () => {};

  let generation = 0;
  let nextId = 0;
  let failFirstComposite = true;
  const invertedBounds = [];
  const compositeBounds = [];
  const processor = {
    init() {},
    clear() {
      generation += 1;
      nextId = 0;
    },
    add_layer() {
      return nextId++;
    },
    add_inverted_layer_with_bounds(
      source,
      _offsetX,
      _offsetY,
      minX,
      maxX,
      minY,
      maxY,
    ) {
      invertedBounds.push({ generation, source, minX, maxX, minY, maxY });
      return nextId++;
    },
    add_composite_layer_with_bounds(
      _sources,
      _bits,
      _inverted,
      minX,
      maxX,
      minY,
      maxY,
    ) {
      if (failFirstComposite) {
        failFirstComposite = false;
        throw new Error("forced screenshot composite failure");
      }
      compositeBounds.push({ generation, minX, maxX, minY, maxY });
      return nextId++;
    },
  };

  const renderer = exporter.initializeRenderer(
    {},
    {},
    processor,
    { globalAlpha: 1, backgroundColor: "#000000" },
    false,
    {
      initialized: false,
      excludedCompositeClientIds: new Set(),
      reportedCompositeErrors: new Set(),
    },
  );
  assert.equal(generation, 1);
  assert.deepEqual(
    invertedBounds.filter((entry) => entry.generation === 1),
    [{
      generation: 1,
      source: "healthy-inverted",
      minX: -1,
      maxX: 5,
      minY: -1,
      maxY: 1,
    }],
  );
  assert.deepEqual(compositeBounds.at(-1), {
    generation: 1,
    minX: -1,
    maxX: 5,
    minY: -1,
    maxY: 1,
  });
  assert.equal(renderer.compositeEntries.length, 1);
  assert.equal(renderer.compositeEntries[0].clientId, "healthy");
});

test("screenshot lazy composite failure rebuilds instead of filtering stale dependencies", () => {
  const exporter = Object.create(ScreenshotExporter.prototype);
  let reported = 0;
  exporter.reportCompositeError = () => {
    reported += 1;
  };
  exporter.initializeRenderer = (
    canvas,
    gl,
    processor,
    renderState,
    includeBackground,
    buildState,
  ) => {
    assert.equal(buildState.excludedCompositeClientIds.has("failed"), true);
    return {
      canvas,
      gl,
      processor,
      renderState,
      includeBackground,
      buildState,
      reportedCompositeErrors: buildState.reportedCompositeErrors,
      compositeEntries: [{ layerId: 9, clientId: "healthy", name: "Healthy" }],
      rebuilt: true,
    };
  };
  let clearCalls = 0;
  const buildState = {
    initialized: true,
    excludedCompositeClientIds: new Set(),
    reportedCompositeErrors: new Set(),
  };
  const renderer = {
    canvas: {},
    gl: {},
    processor: {
      get_composite_error(layerId) {
        return layerId === 7 ? "forced lazy failure" : "";
      },
      clear() {
        clearCalls += 1;
      },
    },
    renderState: {},
    includeBackground: false,
    buildState,
    reportedCompositeErrors: buildState.reportedCompositeErrors,
    compositeEntries: [
      { layerId: 7, clientId: "failed", name: "Failed" },
      { layerId: 9, clientId: "healthy", name: "Healthy" },
    ],
  };

  assert.equal(exporter.handleCompositeRenderErrors(renderer), 1);
  assert.equal(clearCalls, 1);
  assert.equal(reported, 1);
  assert.equal(renderer.rebuilt, true);
  assert.deepEqual(renderer.compositeEntries, [
    { layerId: 9, clientId: "healthy", name: "Healthy" },
  ]);
});
