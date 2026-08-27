import { readFileSync } from "node:fs";

import init, {
  GerberProcessor,
} from "../../../../wasm/pkg/wasm_gerber_processor.js";

await init({
  module_or_path: readFileSync(
    new URL("../../../../wasm/pkg/wasm_gerber_processor_bg.wasm", import.meta.url),
  ),
});

const originalAddComposite =
  GerberProcessor.prototype.add_composite_layer_with_bounds;
let constructionCount = 0;
GerberProcessor.prototype.add_composite_layer_with_bounds =
  function addCompositeWithOneForcedFailure(...args) {
    constructionCount += 1;
    if (constructionCount === 1) {
      throw new Error("forced CLI composite construction failure");
    }
    return originalAddComposite.apply(this, args);
  };
