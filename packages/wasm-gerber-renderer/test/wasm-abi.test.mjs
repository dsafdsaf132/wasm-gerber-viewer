import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const wasmModuleUrl = new URL(
  "../../../wasm/pkg/wasm_gerber_processor.js",
  import.meta.url,
);
const canInspectWasm = existsSync(wasmModuleUrl);

const LEGACY_TOP_LEVEL_ARITIES = {
  init_panic_hook: 0,
  reserve_input_capacity: 1,
  parse_gerber_layer: 3,
  parse_gerber_layer_with_options: 5,
  parse_gerber_layer_payload_with_options: 5,
  parse_drill_layer: 3,
  initSync: 1,
};

const LEGACY_PROCESSOR_ARITIES = {
  free: 0,
  render_tile: 13,
  get_boundary: 0,
  remove_layer: 1,
  init_with_size: 3,
  add_drill_layer: 1,
  restore_context: 1,
  add_parsed_layer: 1,
  render_with_clear: 8,
  add_render_payload: 1,
  get_layer_boundary: 1,
  add_layer_with_offset: 3,
  has_interaction_layer: 1,
  add_interaction_payload: 2,
  set_layer_inner_outline: 3,
  build_layer_interactions: 4,
  clear_interaction_layers: 0,
  pick_interaction_feature: 4,
  render_pixels_with_clear: 8,
  set_drill_outline_pixels: 1,
  set_interactions_enabled: 1,
  set_preserve_arc_regions: 1,
  restore_context_with_size: 3,
  set_minimum_feature_pixels: 1,
  add_drill_layer_with_offset: 3,
  render_interaction_highlight: 6,
  render_tile_with_blend_modes: 14,
  set_arc_tessellation_quality: 1,
  add_inverted_layer_with_bounds: 7,
  pick_interaction_feature_after: 6,
  set_layer_feature_extra_pixels: 2,
  add_inverted_layer_with_outline: 6,
  render_with_clear_and_blend_modes: 9,
  render_pixels_with_clear_and_blend_modes: 9,
  init: 1,
  clear: 0,
  parse: 1,
  render: 7,
  resize: 0,
  add_layer: 1,
  resize_to: 2,
};

const COMPOSITE_SCAN_PROCESSOR_ARITIES = {
  get_composite_area_codes_band: 3,
  begin_composite_area_scan: 1,
  scan_composite_area_band: 3,
  finish_composite_area_scan: 1,
  cancel_composite_area_scan: 1,
};

test(
  "release WASM preserves every pre-composite public symbol and JavaScript arity",
  { skip: !canInspectWasm && "release WASM is required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    for (const [name, arity] of Object.entries(LEGACY_TOP_LEVEL_ARITIES)) {
      assert.equal(typeof wasm[name], "function", `missing export ${name}`);
      assert.equal(wasm[name].length, arity, `${name} JavaScript arity`);
    }
    assert.equal(wasm.Boundary.length, 4);
    assert.equal(wasm.Boundary.prototype.free.length, 0);
    assert.equal(wasm.GerberProcessor.length, 0);
    for (const [name, arity] of Object.entries(LEGACY_PROCESSOR_ARITIES)) {
      const method = wasm.GerberProcessor.prototype[name];
      assert.equal(typeof method, "function", `missing GerberProcessor.${name}`);
      assert.equal(method.length, arity, `GerberProcessor.${name} JavaScript arity`);
    }
  },
);

test(
  "release WASM exposes the composite scan lifecycle with stable arities",
  { skip: !canInspectWasm && "release WASM is required" },
  async () => {
    const wasm = await import(wasmModuleUrl.href);
    for (const [name, arity] of Object.entries(COMPOSITE_SCAN_PROCESSOR_ARITIES)) {
      const method = wasm.GerberProcessor.prototype[name];
      assert.equal(typeof method, "function", `missing GerberProcessor.${name}`);
      assert.equal(method.length, arity, `GerberProcessor.${name} JavaScript arity`);
    }
  },
);
