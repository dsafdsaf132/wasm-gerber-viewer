import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const wasmModuleUrl = new URL("../../../wasm/pkg/wasm_gerber_processor.js", import.meta.url);
const wasmBinaryUrl = new URL("../../../wasm/pkg/wasm_gerber_processor_bg.wasm", import.meta.url);
const hasDevWasm = existsSync(wasmModuleUrl) && existsSync(wasmBinaryUrl);

const ARC_REGION_CONTENT = `%FSLAX24Y24*%
%MOMM*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
M02*`;

test(
  "compact single-primitive import retains validation of types, templates and sparse refs",
  { skip: hasDevWasm ? false : "wasm/pkg has not been built" },
  async () => {
    const api = await import(wasmModuleUrl.href);
    api.initSync({ module: readFileSync(wasmBinaryUrl) });
    const payload = api.parse_gerber_layer_payload_with_options(
      "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1*%\nD10*\nX0Y0D03*\nM02*", 0, 0, true, 1,
    ).interactionPayload;
    const processor = new api.GerberProcessor();
    try {
      processor.set_interactions_enabled(true);
      processor.add_interaction_payload(0, payload);
      assert.equal(processor.pick_interaction_feature(new Uint32Array([0]), 0, 0, 0).aperture, "D10");
      assert.throws(() => processor.add_interaction_payload(0, {
        ...payload, primitiveTypes: Uint32Array.of(99),
      }), /Invalid compact primitive type/);
      assert.throws(() => processor.add_interaction_payload(0, {
        ...payload, primitiveTypes: Uint32Array.of(4), primitiveData: new Float32Array(10),
      }), /Compact template index is invalid/);
      assert.throws(() => processor.add_interaction_payload(0, {
        ...payload, pathRegionRefData: Uint32Array.of(0, 0, 1),
      }), /Invalid compact path region ref data/);
      // Failed imports must leave the already-valid layer intact.
      assert.equal(processor.pick_interaction_feature(new Uint32Array([0]), 0, 0, 0).aperture, "D10");
    } finally {
      processor.free();
    }
  },
);

test(
  "compact interaction payload preserves path-region refs across processor import",
  { skip: hasDevWasm ? false : "wasm/pkg has not been built" },
  async () => {
    const {
      GerberProcessor,
      initSync,
      parse_gerber_layer_payload_with_options: parseGerberLayerPayloadWithOptions,
    } = await import(wasmModuleUrl.href);
    initSync({ module: readFileSync(wasmBinaryUrl) });

    const payload = parseGerberLayerPayloadWithOptions(
      ARC_REGION_CONTENT,
      0,
      0,
      true,
      1,
    );
    const interactionPayload = payload.interactionPayload;

    assert.equal(interactionPayload.version, 3);
    assert.deepEqual(Array.from(interactionPayload.pathRegionRefFeatureIds), [0]);
    assert.deepEqual(Array.from(interactionPayload.pathRegionRefData), [0, 0, 1]);

    const processor = new GerberProcessor();
    try {
      processor.set_interactions_enabled(true);
      processor.add_interaction_payload(0, interactionPayload);

      assert.equal(processor.has_interaction_layer(0), true);
      const hit = processor.pick_interaction_feature(new Uint32Array([0]), 0, 0.5, 0);
      assert.equal(hit.layerId, 0);
      assert.equal(hit.featureId, 0);
      assert.equal(hit.featureType, "region");
      assert.equal(hit.hasHighlightGeometry, true);

      processor.clear_interaction_layers();
      assert.equal(processor.has_interaction_layer(0), false);
    } finally {
      processor.free();
    }
  },
);
