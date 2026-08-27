import { readFileSync } from "node:fs";

import init, {
  GerberProcessor,
} from "../../../../wasm/pkg/wasm_gerber_processor.js";

await init({
  module_or_path: readFileSync(
    new URL("../../../../wasm/pkg/wasm_gerber_processor_bg.wasm", import.meta.url),
  ),
});

const originalGetCompositeError = GerberProcessor.prototype.get_composite_error;
GerberProcessor.prototype.get_composite_error = function getForcedCompositeError(layerId) {
  return (
    originalGetCompositeError.call(this, layerId) ||
    "forced CLI composite allocation failure"
  );
};
