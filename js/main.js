import "./build-info.js";

export { GerberViewer } from "./core/viewer.js";
export {
  RenderBackend,
  SerialRenderBackend,
  ThreadedWorkerBackend,
  createRenderBackend,
  createCameraMailbox,
  detectThreadedCapabilities,
  normalizeExecutionBackend,
} from "./rendering/render-backend.js";
export {
  THREADED_CAPABILITY_PROFILES,
  selectThreadedCapabilityProfile,
} from "./rendering/capability-profile.js";
export { RendererResourceBroker } from "./rendering/resource-broker.js";
