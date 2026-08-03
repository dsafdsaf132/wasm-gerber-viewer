import { RendererResourceBroker } from "./resource-broker.js";

let wasmModule = null;
let processor = null;
let canvas = null;
let gl = null;
let cameraWords = null;
let cameraFloats = null;
let renderState = null;
let rendering = false;
let renderQueued = false;
const resourceBroker = new RendererResourceBroker();

const PROCESSOR_COMMANDS = new Set([
  "resize", "clear", "remove_layer", "add_render_payload", "add_interaction_payload",
  "add_drill_render_payload", "add_inverted_layer_with_outline",
  "add_inverted_layer_with_bounds", "get_layer_boundary", "get_boundary",
  "set_interactions_enabled", "set_preserve_arc_regions", "set_arc_tessellation_quality",
  "set_minimum_feature_pixels", "set_layer_inner_outline",
  "clear_interaction_layers", "pick_interaction_feature",
  "pick_interaction_feature_after", "render_interaction_highlight",
  "profiling_counters", "reset_profiling_counters",
]);

function reply(id, result = null, error = null, transfer = []) {
  self.postMessage({ id, result, error }, transfer);
}

function readCamera() {
  if (!cameraWords) return null;
  for (;;) {
    const before = Atomics.load(cameraWords, 0);
    if (before & 1) continue;
    const result = { sequence: before, zoomX: cameraFloats[2], zoomY: cameraFloats[3],
      offsetX: cameraFloats[4], offsetY: cameraFloats[5] };
    if (before === Atomics.load(cameraWords, 0)) return result;
  }
}

async function renderLatestCamera() {
  if (rendering || !processor || !renderState) return;
  rendering = true;
  let renderedSequence = -1;
  try {
    for (;;) {
      const camera = readCamera();
      if (!camera || camera.sequence === renderedSequence) break;
      if (typeof processor.render_camera === "function") {
        processor.render_camera(camera.zoomX, camera.zoomY, camera.offsetX, camera.offsetY, true);
      } else {
        processor.render_with_clear_and_blend_modes(renderState.activeLayerIds, renderState.colorData,
          renderState.blendModes, camera.zoomX, camera.zoomY, camera.offsetX, camera.offsetY,
          renderState.alpha, true);
      }
      renderedSequence = camera.sequence;
      if (Atomics.load(cameraWords, 0) === renderedSequence) break;
      await Promise.resolve();
    }
  } finally {
    rendering = false;
    self.postMessage({ type: "render-idle", renderedSequence });
  }
}

async function initialize(message) {
  canvas = message.canvas;
  gl = canvas.getContext("webgl2", { alpha: true, antialias: false,
    preserveDrawingBuffer: false, stencil: true });
  if (!gl) throw new Error("OffscreenCanvas WebGL2 is unavailable");
  wasmModule = await import(message.threadedArtifactUrl);
  await wasmModule.default();
  wasmModule.init_panic_hook?.();
  if (message.helperCount > 0) await wasmModule.initThreadPool?.(message.helperCount);
  processor = new wasmModule.GerberProcessor();
  processor.init(gl);
  cameraWords = new Int32Array(message.cameraBuffer);
  cameraFloats = new Float32Array(message.cameraBuffer);
  canvas.addEventListener?.("webglcontextlost", (event) => {
    event.preventDefault?.();
    self.postMessage({ type: "context-lost" });
  });
  canvas.addEventListener?.("webglcontextrestored", () => {
    enqueueResource(async () => {
      try {
        processor.restore_context(gl);
        processor.resize();
        self.postMessage({ type: "context-restored" });
      } catch (error) {
        self.postMessage({ type: "context-restore-failed", error: String(error?.message ?? error) });
      }
    });
  });
}

function enqueueResource(task) {
  return resourceBroker.run(task);
}

async function handleMessage(message) {
  try {
    switch (message.type) {
      case "init":
        await initialize(message);
        reply(message.id, { ready: true });
        break;
      case "set-render-state":
        renderState = message.state;
        processor.set_retained_render_state?.(renderState.activeLayerIds, renderState.colorData,
          renderState.blendModes, renderState.alpha);
        reply(message.id, true);
        break;
      case "processor-command":
        if (!PROCESSOR_COMMANDS.has(message.method) || typeof processor?.[message.method] !== "function") {
          throw new Error(`Processor command is not allowed: ${message.method}`);
        }
        reply(message.id, processor[message.method](...(message.args ?? [])));
        break;
      case "read-tile": {
        const options = message.options;
        const pixels = processor.render_tile_pixels_with_blend_modes(renderState.activeLayerIds,
          renderState.colorData, renderState.blendModes, options.exportWidth, options.exportHeight,
          options.tileX, options.tileY, options.tileWidth, options.tileHeight,
          options.zoomX, options.zoomY, options.offsetX, options.offsetY, renderState.alpha);
        reply(message.id, pixels, null, pixels?.buffer ? [pixels.buffer] : []);
        break;
      }
      case "load-source-batch": {
        if (typeof wasmModule.parse_source_batch !== "function") {
          throw new Error("Threaded source batch API is unavailable");
        }
        const parsed = [...wasmModule.parse_source_batch(message.sources)]
          .sort((left, right) => left.sequence - right.sequence);
        const uploaded = [];
        for (const source of parsed) {
          if (source.kind === "drill") {
            const ids = processor.add_drill_render_payload(
              source.outlineLayer,
              source.fillLayer,
              source.interactionPayload,
            );
            uploaded.push({ sequence: source.sequence, kind: source.kind, ...ids, metadata: source.metadata });
          } else {
            const layerId = processor.add_render_payload(source.renderPayload);
            if (source.interactionPayload) {
              processor.add_interaction_payload?.(layerId, source.interactionPayload);
            }
            uploaded.push({ sequence: source.sequence, kind: source.kind, layerId });
          }
        }
        reply(message.id, uploaded);
        break;
      }
      case "dispose":
        processor?.free?.();
        processor = null;
        reply(message.id, true);
        self.close();
        break;
      default:
        if (message.id) throw new Error(`Unknown render worker command: ${message.type}`);
    }
  } catch (error) {
    reply(message.id, null, String(error?.message ?? error));
  }
}

self.addEventListener("message", (event) => {
  const message = event.data ?? {};
  if (message.type === "render-wake") {
    if (!renderQueued) {
      renderQueued = true;
      enqueueResource(async () => {
        renderQueued = false;
        await renderLatestCamera();
      });
    }
    return;
  }
  enqueueResource(() => handleMessage(message));
});
