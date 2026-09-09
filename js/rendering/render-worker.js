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
  "resize", "resize_to", "set_framebuffer_size", "clear", "remove_layer",
  "add_render_payload", "add_interaction_payload", "add_drill_render_payload",
  "add_inverted_layer_with_outline", "add_inverted_layer_with_bounds",
  "get_layer_boundary", "get_boundary",
  "set_interactions_enabled", "set_preserve_arc_regions", "set_arc_tessellation_quality",
  "set_minimum_feature_pixels", "set_drill_outline_pixels",
  "set_layer_inner_outline", "set_layer_feature_extra_pixels",
  "clear_interaction_layers", "pick_interaction_feature",
  "pick_interaction_feature_after", "render_interaction_highlight",
  "profiling_counters", "reset_profiling_counters",
  "add_composite_layer_with_bounds", "add_composite_preset_with_bounds",
  "add_composite_layer_with_outline", "add_composite_layer_with_outline_content",
  "add_composite_layer_with_outline_content_options", "add_composite_preset_with_outline",
  "update_composite_sources", "set_composite_visible_bits", "set_composite_visible_byte",
  "set_composite_inverted", "set_composite_bounds", "release_composite_cache",
  "get_composite_error", "get_composite_diagnostics",
  "render_composite_selection", "pick_composite_area", "render_composite_area_highlight",
  "pick_composite_code", "get_composite_area_codes", "get_composite_area_codes_band",
  "begin_composite_area_scan", "scan_composite_area_band", "finish_composite_area_scan",
  "cancel_composite_area_scan", "end_composite_selection",
]);

let lastRenderedSequence = -1;

function serializeProcessorResult(result) {
  if (result && typeof result === "object") {
    if (typeof result.min_x === "number" && typeof result.max_x === "number") {
      const boundary = {
        minX: result.min_x,
        maxX: result.max_x,
        minY: result.min_y,
        maxY: result.max_y,
        min_x: result.min_x,
        max_x: result.max_x,
        min_y: result.min_y,
        max_y: result.max_y,
      };
      result.free?.();
      return boundary;
    }
  }
  return result;
}

function reply(id, result = null, error = null, transfer = []) {
  self.postMessage({ id, result, error }, transfer);
}

function readCamera() {
  if (!cameraWords) return null;
  for (let spin = 0; spin < 1000; spin++) {
    const before = Atomics.load(cameraWords, 0);
    if (before & 1) continue;
    const flipX = Atomics.load(cameraWords, 6) !== 0;
    const flipY = Atomics.load(cameraWords, 7) !== 0;
    const result = {
      sequence: before,
      zoomX: cameraFloats[2],
      zoomY: cameraFloats[3],
      offsetX: cameraFloats[4],
      offsetY: cameraFloats[5],
      flipX,
      flipY,
    };
    if (before === Atomics.load(cameraWords, 0)) return result;
  }
  return null;
}

async function renderLatestCamera(force = false) {
  if (rendering) return;
  if (!processor || !renderState) {
    self.postMessage({ type: "render-idle", renderedSequence: -1 });
    return;
  }
  rendering = true;
  try {
    const camera = readCamera();
    if (!camera || (!force && camera.sequence === lastRenderedSequence)) {
      return;
    }
    if (typeof processor.render_camera === "function") {
      processor.render_camera(camera.zoomX, camera.zoomY, camera.offsetX, camera.offsetY, true);
    } else {
      processor.render_with_clear_and_blend_modes(renderState.activeLayerIds, renderState.colorData,
        renderState.blendModes, camera.zoomX, camera.zoomY, camera.offsetX, camera.offsetY,
        renderState.alpha, true);
    }
    lastRenderedSequence = camera.sequence;
  } catch (err) {
    console.error("[RenderWorker] renderLatestCamera error:", err);
    const camera = readCamera();
    lastRenderedSequence = camera?.sequence ?? lastRenderedSequence;
  } finally {
    rendering = false;
    self.postMessage({ type: "render-idle", renderedSequence: lastRenderedSequence });
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
  if (message.helperCount > 0 && typeof wasmModule.initThreadPool === "function") {
    try {
      await wasmModule.initThreadPool(message.helperCount);
      wasmModule.mark_thread_pool_ready?.();
    } catch (poolError) {
      console.warn("[RenderWorker] initThreadPool failed, falling back to serial:", poolError);
    }
  }
  processor = new wasmModule.GerberProcessor();
  if (typeof processor.init_with_size === "function") {
    processor.init_with_size(gl, canvas.width, canvas.height);
  } else {
    processor.init(gl);
  }
  cameraWords = new Int32Array(message.cameraBuffer);
  cameraFloats = new Float32Array(message.cameraBuffer);
  canvas.addEventListener?.("webglcontextlost", (event) => {
    event.preventDefault?.();
    self.postMessage({ type: "context-lost" });
  });
  canvas.addEventListener?.("webglcontextrestored", () => {
    enqueueResource(async () => {
      try {
        if (typeof processor.restore_context_with_size === "function") {
          processor.restore_context_with_size(gl, canvas.width, canvas.height);
        } else {
          processor.restore_context(gl);
        }
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
        await renderLatestCamera(true);
        reply(message.id, true);
        break;
      case "processor-command":
        if (!PROCESSOR_COMMANDS.has(message.method) || typeof processor?.[message.method] !== "function") {
          throw new Error(`Processor command is not allowed: ${message.method}`);
        }
        if (message.method === "resize_to" && canvas && Array.isArray(message.args) && message.args.length >= 2) {
          canvas.width = message.args[0];
          canvas.height = message.args[1];
        }
        reply(message.id, serializeProcessorResult(processor[message.method](...(message.args ?? []))));
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
        if (typeof wasmModule?.parse_source_batch !== "function") {
          throw new Error("Threaded source batch API is unavailable");
        }
        const parsed = [...wasmModule.parse_source_batch(message.sources)]
          .sort((left, right) => left.sequence - right.sequence);
        const uploaded = [];
        for (const source of parsed) {
          if (source.ok === false) {
            uploaded.push({
              sequence: source.sequence,
              kind: source.kind,
              ok: false,
              error: source.error,
            });
            continue;
          }
          try {
            if (source.kind === "drill") {
              const ids = processor.add_drill_render_payload(
                source.outlineLayer,
                source.fillLayer,
                source.interactionPayload,
              );
              const boundary = processor.get_layer_boundary(ids.outlineLayerId);
              const bounds = boundary ? {
                minX: boundary.min_x,
                maxX: boundary.max_x,
                minY: boundary.min_y,
                maxY: boundary.max_y,
                min_x: boundary.min_x,
                max_x: boundary.max_x,
                min_y: boundary.min_y,
                max_y: boundary.max_y,
              } : null;
              boundary?.free?.();
              uploaded.push({
                sequence: source.sequence,
                kind: source.kind,
                ok: true,
                ...ids,
                metadata: source.metadata,
                bounds,
                interactionPayload: source.interactionPayload ?? null,
              });
            } else {
              const layerId = processor.add_render_payload(source.renderPayload);
              if (source.interactionPayload) {
                processor.add_interaction_payload?.(layerId, source.interactionPayload);
              }
              const boundary = processor.get_layer_boundary(layerId);
              const bounds = boundary ? {
                minX: boundary.min_x,
                maxX: boundary.max_x,
                minY: boundary.min_y,
                maxY: boundary.max_y,
                min_x: boundary.min_x,
                max_x: boundary.max_x,
                min_y: boundary.min_y,
                max_y: boundary.max_y,
              } : null;
              boundary?.free?.();
              uploaded.push({
                sequence: source.sequence,
                kind: source.kind,
                ok: true,
                layerId,
                bounds,
                interactionPayload: source.interactionPayload ?? null,
              });
            }
          } catch (uploadError) {
            uploaded.push({
              sequence: source.sequence,
              kind: source.kind,
              ok: false,
              error: String(uploadError?.message ?? uploadError),
            });
          }
        }
        reply(message.id, uploaded);
        break;
      }
      case "dispose":
        processor?.free?.();
        processor = null;
        reply(message.id, true);
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
