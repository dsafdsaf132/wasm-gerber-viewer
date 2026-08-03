const CAMERA_WORDS = 8;

export function normalizeExecutionBackend(value = "auto") {
  if (value === "auto" || value === "serial" || value === "threaded") return value;
  throw new TypeError('executionBackend must be "auto", "serial", or "threaded"');
}

export function detectThreadedCapabilities(canvas = null, environment = globalThis) {
  const userAgent = String(environment.navigator?.userAgent ?? "");
  const browser = /Firefox\//.test(userAgent)
    ? "firefox"
    : /Edg\//.test(userAgent)
      ? "edge"
      : /Chrome\//.test(userAgent)
        ? "chrome"
        : /Safari\//.test(userAgent)
          ? "safari"
          : "unknown";
  const result = {
    browser,
    secureContext: environment.isSecureContext === true,
    crossOriginIsolated: environment.crossOriginIsolated === true,
    sharedArrayBuffer: typeof environment.SharedArrayBuffer === "function",
    atomics: typeof environment.Atomics === "object",
    sharedWasmMemory: false,
    worker: typeof environment.Worker === "function",
    offscreenCanvas: typeof environment.OffscreenCanvas === "function",
    offscreenWebGl2: false,
    canvasTransfer: typeof canvas?.transferControlToOffscreen === "function",
    hardwareConcurrency: Number(environment.navigator?.hardwareConcurrency ?? 0),
    deviceMemory: Number(environment.navigator?.deviceMemory ?? 0),
  };
  try {
    if (result.sharedArrayBuffer && typeof environment.WebAssembly?.Memory === "function") {
      const memory = new environment.WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      result.sharedWasmMemory = memory.buffer instanceof environment.SharedArrayBuffer;
    }
    if (result.offscreenCanvas) {
      const probe = new environment.OffscreenCanvas(1, 1);
      result.offscreenWebGl2 = Boolean(probe.getContext?.("webgl2"));
    }
  } catch {
    // Capability probing must be safe in headless and restricted environments.
  }
  result.threadedSupported = Boolean(
    result.secureContext && result.crossOriginIsolated && result.sharedArrayBuffer &&
      result.atomics && result.sharedWasmMemory && result.worker && result.offscreenCanvas &&
      result.offscreenWebGl2 && result.canvasTransfer,
  );
  return result;
}

export function createCameraMailbox(environment = globalThis) {
  if (typeof environment.SharedArrayBuffer !== "function") return null;
  const buffer = new environment.SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CAMERA_WORDS);
  const words = new Int32Array(buffer);
  const floats = new Float32Array(buffer);
  return {
    buffer,
    write(camera) {
      const sequence = (environment.Atomics.add(words, 0, 1) + 1) | 0;
      floats[2] = Number(camera.zoomX ?? camera.zoom ?? 1);
      floats[3] = Number(camera.zoomY ?? camera.zoom ?? 1);
      floats[4] = Number(camera.offsetX ?? 0);
      floats[5] = Number(camera.offsetY ?? 0);
      environment.Atomics.store(words, 6, camera.flipX ? 1 : 0);
      environment.Atomics.store(words, 7, camera.flipY ? 1 : 0);
      environment.Atomics.store(words, 0, sequence + 1);
      environment.Atomics.notify?.(words, 0, 1);
      return sequence + 1;
    },
    read() {
      for (;;) {
        const before = environment.Atomics.load(words, 0);
        if (before & 1) continue;
        const camera = {
          sequence: before,
          zoomX: floats[2], zoomY: floats[3], offsetX: floats[4], offsetY: floats[5],
          flipX: environment.Atomics.load(words, 6) !== 0,
          flipY: environment.Atomics.load(words, 7) !== 0,
        };
        if (before === environment.Atomics.load(words, 0)) return camera;
      }
    },
  };
}

export class SerialRenderBackend {
  constructor(processor) {
    this.processor = processor;
    this.state = null;
  }
  setRenderState(state) {
    this.state = state;
    this.processor.set_retained_render_state?.(state.activeLayerIds, state.colorData, state.blendModes, state.alpha);
  }
  renderCamera(camera) {
    if (!this.state) return;
    if (typeof this.processor.render_camera === "function") {
      return this.processor.render_camera(camera.zoomX, camera.zoomY, camera.offsetX, camera.offsetY, true);
    }
    const state = this.state;
    if (state.blendModes?.some?.((mode) => mode !== 0) && this.processor.render_with_clear_and_blend_modes) {
      return this.processor.render_with_clear_and_blend_modes(state.activeLayerIds, state.colorData, state.blendModes,
        camera.zoomX, camera.zoomY, camera.offsetX, camera.offsetY, state.alpha, true);
    }
    return this.processor.render(state.activeLayerIds, state.colorData,
      camera.zoomX, camera.zoomY, camera.offsetX, camera.offsetY, state.alpha);
  }
  callProcessor(method, args = []) {
    if (typeof this.processor?.[method] !== "function") throw new Error(`Unknown processor method: ${method}`);
    return this.processor[method](...args);
  }
  dispose() {}
}

export class ThreadedWorkerBackend {
  constructor(worker, mailbox, { timeoutMs = 30000, onWorkerEvent = null } = {}) {
    this.worker = worker;
    this.mailbox = mailbox;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.wakePending = false;
    this.latestCameraSequence = 0;
    this.onWorkerEvent = onWorkerEvent;
    worker.addEventListener("message", (event) => this.#handleMessage(event.data));
  }
  #handleMessage(message) {
    if (message?.type === "context-lost" || message?.type === "context-restored" ||
      message?.type === "context-restore-failed") {
      this.onWorkerEvent?.(message);
      return;
    }
    if (message?.type === "render-idle") {
      if (message.renderedSequence !== this.latestCameraSequence) {
        this.worker.postMessage({ type: "render-wake", sequence: this.latestCameraSequence });
      } else {
        this.wakePending = false;
      }
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    (message.error ? pending.reject : pending.resolve)(message.error ? new Error(message.error) : message.result);
  }
  command(type, payload = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }
  setRenderState(state) { return this.command("set-render-state", { state }); }
  renderCamera(camera) {
    const sequence = this.mailbox.write(camera);
    this.latestCameraSequence = sequence;
    if (!this.wakePending) {
      this.wakePending = true;
      this.worker.postMessage({ type: "render-wake", sequence });
    }
  }
  callProcessor(method, args = []) { return this.command("processor-command", { method, args }); }
  readTile(options) { return this.command("read-tile", { options }); }
  loadSourceBatch(sources) { return this.command("load-source-batch", { sources }); }
  async dispose() {
    try { await this.command("dispose"); } finally { this.worker.terminate(); }
  }
}

export class RenderBackend {
  constructor(implementation, name, diagnostics = {}) {
    this.implementation = implementation;
    this.name = name;
    this.diagnostics = diagnostics;
  }
  setRenderState(state) { return this.implementation.setRenderState(state); }
  renderCamera(camera) { return this.implementation.renderCamera(camera); }
  callProcessor(method, args) { return this.implementation.callProcessor(method, args); }
  dispose() { return this.implementation.dispose(); }
}

export async function createRenderBackend({ executionBackend = "auto", processor, canvas,
  workerUrl, threadedArtifactUrl, helperCount = 0, profile = null, environment = globalThis,
  createSerialProcessor = null, onCanvasReplaced = null, onWorkerEvent = null } = {}) {
  const requested = normalizeExecutionBackend(executionBackend);
  const capabilities = detectThreadedCapabilities(canvas, environment);
  const shouldThread = capabilities.threadedSupported &&
    (requested === "threaded" || (requested === "auto" && profile?.enabled));
  if (!shouldThread) {
    return new RenderBackend(new SerialRenderBackend(processor), "serial", {
      requested,
      capabilities,
      fallbackReason: requested === "serial"
        ? null
        : capabilities.threadedSupported
          ? "no-qualified-capability-profile"
          : "threaded-capabilities-unavailable",
    });
  }
  let worker;
  let canvasTransferred = false;
  try {
    const offscreen = canvas.transferControlToOffscreen();
    canvasTransferred = true;
    const mailbox = createCameraMailbox(environment);
    worker = new environment.Worker(workerUrl, { type: "module" });
    const backend = new ThreadedWorkerBackend(worker, mailbox, { onWorkerEvent });
    await backend.command("init", { canvas: offscreen, cameraBuffer: mailbox.buffer,
      threadedArtifactUrl,
      helperCount: helperCount || profile?.helperCount ||
        Math.max(1, Math.min(4, capabilities.hardwareConcurrency - 1 || 1)),
    }, [offscreen]);
    return new RenderBackend(backend, "threaded", { requested, capabilities });
  } catch (error) {
    worker?.terminate();
    let fallbackCanvas = canvas;
    let fallbackProcessor = processor;
    if (canvasTransferred) {
      const replacement = canvas.cloneNode?.(false);
      if (replacement) {
        replacement.width = canvas.width;
        replacement.height = canvas.height;
        canvas.parentNode?.replaceChild?.(replacement, canvas);
        fallbackCanvas = replacement;
        fallbackProcessor = createSerialProcessor
          ? await createSerialProcessor(replacement)
          : processor;
        onCanvasReplaced?.(replacement);
      }
    }
    return new RenderBackend(new SerialRenderBackend(fallbackProcessor), "serial", {
      requested, capabilities, fallbackReason: String(error?.message ?? error),
      canvasTransferred, fallbackCanvas,
    });
  }
}
