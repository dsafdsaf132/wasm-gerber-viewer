mod drill;
mod geometry;
mod interaction;
mod parser;
mod renderer;
mod util;

use crate::drill::{
    parse_drill_with_offset, parse_drill_with_offset_and_interactions, DrillParseResult,
};
use crate::geometry::{gerber_data_layers_from_js, gerber_data_layers_to_js, Boundary, GerberData};
use crate::interaction::InteractionLayer;
use crate::parser::{parse_gerber_payload_with_options, GerberParser, ParsedGerberLayer};
use crate::renderer::Renderer;
use crate::util::format_bytes;
use js_sys::{Object, Reflect};
use wasm_bindgen::prelude::*;
use web_sys::WebGl2RenderingContext;

const DRILL_OUTLINE_WIDTH_MM: f32 = 0.0;

/// Initialize panic hook for better error messages in browser console
#[wasm_bindgen]
pub fn init_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[cfg(test)]
mod tests;

/// Preflight a large JS-to-WASM input copy with catchable allocation failure.
#[wasm_bindgen]
pub fn reserve_input_capacity(byte_count: usize) -> Result<(), JsValue> {
    let mut buffer = Vec::<u8>::new();
    buffer.try_reserve_exact(byte_count).map_err(|_| {
        JsValue::from_str(&format!(
            "Not enough WebAssembly memory to load file input ({})",
            format_bytes(byte_count)
        ))
    })?;
    Ok(())
}

fn parse_layer_data(
    content: &str,
    offset_x: f32,
    offset_y: f32,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
    preserve_region_source_contours: bool,
) -> Result<Vec<GerberData>, JsValue> {
    if !offset_x.is_finite() || !offset_y.is_finite() {
        return Err(JsValue::from_str("Layer offset must be finite"));
    }

    let mut parser = GerberParser::with_options(preserve_arc_regions, arc_tessellation_quality);
    parser.preserve_region_source_contours = preserve_region_source_contours;
    let mut gerber_data_layers = parser.parse(content)?;

    if offset_x != 0.0 || offset_y != 0.0 {
        for layer in &mut gerber_data_layers {
            layer.translate(offset_x, offset_y);
        }
    }

    let non_empty_layers: Vec<_> = gerber_data_layers
        .into_iter()
        .filter(|layer| layer.has_geometry())
        .collect();

    if non_empty_layers.is_empty() {
        return Err(JsValue::from_str(
            "File does not contain valid Gerber data (no geometry found)",
        ));
    }

    Ok(non_empty_layers)
}

fn parse_layer_payload_data(
    content: &str,
    offset_x: f32,
    offset_y: f32,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
) -> Result<ParsedGerberLayer, JsValue> {
    if !offset_x.is_finite() || !offset_y.is_finite() {
        return Err(JsValue::from_str("Layer offset must be finite"));
    }

    let mut payload =
        parse_gerber_payload_with_options(content, preserve_arc_regions, arc_tessellation_quality)?;

    if offset_x != 0.0 || offset_y != 0.0 {
        for layer in &mut payload.render_layers {
            layer.translate(offset_x, offset_y);
        }
        if let Some(interaction_layer) = &mut payload.interaction_layer {
            interaction_layer.translate(offset_x, offset_y);
        }
    }

    payload.render_layers.retain(|layer| layer.has_geometry());

    if payload.render_layers.is_empty() {
        return Err(JsValue::from_str(
            "File does not contain valid Gerber data (no geometry found)",
        ));
    }

    Ok(payload)
}

#[wasm_bindgen]
pub fn parse_gerber_layer(
    content: String,
    offset_x: f32,
    offset_y: f32,
) -> Result<JsValue, JsValue> {
    let gerber_data_layers = parse_layer_data(&content, offset_x, offset_y, true, 1, false)?;
    gerber_data_layers_to_js(&gerber_data_layers)
}

#[wasm_bindgen]
pub fn parse_gerber_layer_with_options(
    content: String,
    offset_x: f32,
    offset_y: f32,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
) -> Result<JsValue, JsValue> {
    let gerber_data_layers = parse_layer_data(
        &content,
        offset_x,
        offset_y,
        preserve_arc_regions,
        arc_tessellation_quality,
        false,
    )?;
    gerber_data_layers_to_js(&gerber_data_layers)
}

#[wasm_bindgen]
pub fn parse_gerber_layer_payload_with_options(
    content: String,
    offset_x: f32,
    offset_y: f32,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
) -> Result<JsValue, JsValue> {
    let payload = parse_layer_payload_data(
        &content,
        offset_x,
        offset_y,
        preserve_arc_regions,
        arc_tessellation_quality,
    )?;

    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("renderPayload"),
        &gerber_data_layers_to_js(&payload.render_layers)?,
    )?;
    Reflect::set(
        &object,
        &JsValue::from_str("interactionPayload"),
        &match payload.interaction_layer {
            Some(layer) => layer.to_compact_js()?,
            None => JsValue::NULL,
        },
    )?;
    Ok(object.into())
}

fn drill_parse_result_to_js(drill: DrillParseResult) -> Result<JsValue, JsValue> {
    let object = Object::new();
    Reflect::set(
        &object,
        &JsValue::from_str("outlineLayer"),
        &gerber_data_layers_to_js(&[drill.outline_layer])?,
    )?;
    Reflect::set(
        &object,
        &JsValue::from_str("fillLayer"),
        &gerber_data_layers_to_js(&[drill.fill_layer])?,
    )?;
    Reflect::set(
        &object,
        &JsValue::from_str("metadata"),
        &drill.metadata.to_js()?,
    )?;
    Ok(object.into())
}

#[wasm_bindgen]
pub fn parse_drill_layer(
    content: String,
    offset_x: f32,
    offset_y: f32,
) -> Result<JsValue, JsValue> {
    let drill = parse_drill_with_offset(&content, DRILL_OUTLINE_WIDTH_MM, offset_x, offset_y)?;
    drill_parse_result_to_js(drill)
}

/// Main Gerber processor with stateful WebGL renderer
#[wasm_bindgen]
pub struct GerberProcessor {
    renderer: Option<Renderer>,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
    minimum_feature_pixels: f32,
    drill_outline_pixels: f32,
    drill_outline_layer_ids: Vec<u32>,
    interaction_enabled: bool,
    interaction_layers: Vec<Option<InteractionLayer>>,
}

impl Default for GerberProcessor {
    fn default() -> Self {
        Self {
            renderer: None,
            preserve_arc_regions: true,
            arc_tessellation_quality: 1,
            minimum_feature_pixels: 0.0,
            drill_outline_pixels: 0.0,
            drill_outline_layer_ids: Vec::new(),
            interaction_enabled: false,
            interaction_layers: Vec::new(),
        }
    }
}

impl GerberProcessor {
    fn add_parsed_layers(&mut self, gerber_data_layers: Vec<GerberData>) -> Result<u32, JsValue> {
        let non_empty_layers: Vec<_> = gerber_data_layers
            .into_iter()
            .filter(|layer| layer.has_geometry())
            .collect();

        // If no non-empty layers found, reject the file as invalid Gerber
        if non_empty_layers.is_empty() {
            return Err(JsValue::from_str(
                "File does not contain valid Gerber data (no geometry found)",
            ));
        }

        // Add to renderer
        if let Some(renderer) = &mut self.renderer {
            let layer_index = renderer.add_layer(non_empty_layers)?;

            // For now, layer_id matches layer_index
            // In a more complex implementation, we could maintain a mapping
            Ok(layer_index as u32)
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    fn add_parsed_layer_payload(&mut self, payload: ParsedGerberLayer) -> Result<u32, JsValue> {
        let interaction_layer = payload.interaction_layer;
        let layer_id = self.add_parsed_layers(payload.render_layers)?;
        self.set_interaction_layer(layer_id as usize, interaction_layer);
        Ok(layer_id)
    }

    fn add_drill_parse_result(&mut self, drill: DrillParseResult) -> Result<JsValue, JsValue> {
        let DrillParseResult {
            outline_layer,
            fill_layer,
            metadata,
            interaction_layer,
        } = drill;

        if !fill_layer.has_geometry() {
            return Err(JsValue::from_str(
                "File does not contain valid drill data (no holes found)",
            ));
        }

        let (outline_layer_id, fill_layer_id) = {
            let Some(renderer) = &mut self.renderer else {
                return Err(JsValue::from_str(
                    "Renderer not initialized. Call init() first.",
                ));
            };

            let outline_layer_id = renderer.add_layer(vec![outline_layer])?;
            renderer.set_layer_inner_outline(outline_layer_id, self.drill_outline_pixels, 0.0)?;
            let fill_layer_id = match renderer.add_layer(vec![fill_layer]) {
                Ok(layer_id) => layer_id,
                Err(error) => {
                    let _ = renderer.remove_layer(outline_layer_id);
                    return Err(error);
                }
            };
            (outline_layer_id, fill_layer_id)
        };

        self.drill_outline_layer_ids.push(outline_layer_id as u32);
        self.set_interaction_layer(outline_layer_id, interaction_layer);
        self.set_interaction_layer(fill_layer_id, None);

        let object = Object::new();
        Reflect::set(
            &object,
            &JsValue::from_str("outlineLayerId"),
            &JsValue::from_f64(outline_layer_id as f64),
        )?;
        Reflect::set(
            &object,
            &JsValue::from_str("fillLayerId"),
            &JsValue::from_f64(fill_layer_id as f64),
        )?;
        Reflect::set(&object, &JsValue::from_str("metadata"), &metadata.to_js()?)?;

        Ok(object.into())
    }

    fn set_interaction_layer(
        &mut self,
        layer_id: usize,
        interaction_layer: Option<InteractionLayer>,
    ) {
        if !self.interaction_enabled {
            return;
        }

        if self.interaction_layers.len() <= layer_id {
            self.interaction_layers.resize_with(layer_id + 1, || None);
        }
        self.interaction_layers[layer_id] = interaction_layer;
    }

    fn remove_interaction_layer(&mut self, layer_id: usize) {
        if let Some(slot) = self.interaction_layers.get_mut(layer_id) {
            *slot = None;
        }
    }

    fn pick_interaction_feature_internal(
        &self,
        layer_ids: &[u32],
        x: f32,
        y: f32,
        tolerance: f32,
        after: Option<(u32, usize)>,
    ) -> Result<JsValue, JsValue> {
        if !self.interaction_enabled {
            return Ok(JsValue::NULL);
        }
        if !x.is_finite() || !y.is_finite() || !tolerance.is_finite() {
            return Err(JsValue::from_str("Pick coordinates must be finite"));
        }

        let mut first_hit = None;
        let mut found_after = after.is_none();

        for &layer_id in layer_ids.iter().rev() {
            let Some(Some(interaction_layer)) = self.interaction_layers.get(layer_id as usize)
            else {
                continue;
            };

            if let Some((after_layer_id, after_feature_id)) = after {
                if layer_id == after_layer_id && !found_after {
                    if first_hit.is_none() {
                        first_hit = interaction_layer
                            .pick(x, y, tolerance)
                            .map(|(feature_id, feature)| (layer_id, feature_id, feature));
                    }

                    let (hit, saw_after) =
                        interaction_layer.pick_after(x, y, tolerance, Some(after_feature_id));
                    if let Some((feature_id, feature)) = hit {
                        return feature.info_to_js(layer_id, feature_id);
                    }
                    if saw_after {
                        found_after = true;
                    }
                    continue;
                }
            }

            if let Some((feature_id, feature)) = interaction_layer.pick(x, y, tolerance) {
                if first_hit.is_none() {
                    first_hit = Some((layer_id, feature_id, feature));
                }
                if found_after {
                    return feature.info_to_js(layer_id, feature_id);
                }
            }
        }

        if let Some((layer_id, feature_id, feature)) = first_hit {
            return feature.info_to_js(layer_id, feature_id);
        }

        Ok(JsValue::NULL)
    }
}

#[wasm_bindgen]
impl GerberProcessor {
    /// Create a new GerberProcessor instance
    #[wasm_bindgen(constructor)]
    pub fn new() -> GerberProcessor {
        GerberProcessor::default()
    }

    /// Initialize with WebGL 2.0 context
    ///
    /// # Arguments
    /// * `gl` - WebGL 2.0 rendering context from canvas
    ///
    /// # Returns
    /// * `"init_done"` signal on success
    pub fn init(&mut self, gl: WebGl2RenderingContext) -> Result<String, JsValue> {
        // Create renderer with WebGL context (initially no layers)
        let mut renderer = Renderer::new(gl)?;
        renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
        self.renderer = Some(renderer);
        Ok("init_done".to_string())
    }

    /// Initialize with WebGL 2.0 context and explicit framebuffer size.
    ///
    /// This is intended for headless contexts that do not expose an HTML canvas.
    pub fn init_with_size(
        &mut self,
        gl: WebGl2RenderingContext,
        width: u32,
        height: u32,
    ) -> Result<String, JsValue> {
        let mut renderer = Renderer::new_headless(gl, width, height)?;
        renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
        self.renderer = Some(renderer);
        Ok("init_done".to_string())
    }

    /// Configure how regions containing arcs are parsed.
    ///
    /// When true, arc-containing regions are preserved for analytic WebGL rendering.
    /// When false, arcs are approximated into contour points before triangulation.
    pub fn set_preserve_arc_regions(&mut self, preserve_arc_regions: bool) {
        self.preserve_arc_regions = preserve_arc_regions;
    }

    /// Configure arc tessellation quality for legacy approximated region arcs.
    ///
    /// `0` = low, `1` = normal, `2` = high.
    pub fn set_arc_tessellation_quality(&mut self, arc_tessellation_quality: u32) {
        self.arc_tessellation_quality = arc_tessellation_quality.min(2);
    }

    /// Configure minimum display size for tiny rendered features.
    ///
    /// `0.0` disables the adjustment. Current implementation applies to
    /// analytic line and arc strokes in the WebGL renderer.
    pub fn set_minimum_feature_pixels(&mut self, pixels: f32) {
        self.minimum_feature_pixels = if pixels.is_finite() {
            pixels.clamp(0.0, 8.0)
        } else {
            0.0
        };

        if let Some(renderer) = &mut self.renderer {
            renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
        }
    }

    pub fn set_drill_outline_pixels(&mut self, pixels: f32) {
        self.drill_outline_pixels = if pixels.is_finite() {
            pixels.clamp(0.0, 8.0)
        } else {
            0.0
        };

        if let Some(renderer) = &mut self.renderer {
            self.drill_outline_layer_ids.retain(|&layer_id| {
                renderer
                    .set_layer_inner_outline(layer_id as usize, self.drill_outline_pixels, 0.0)
                    .is_ok()
            });
        }
    }

    pub fn set_interactions_enabled(&mut self, enabled: bool) {
        self.interaction_enabled = enabled;
        if !enabled {
            self.interaction_layers.clear();
        }
    }

    pub fn set_layer_inner_outline(
        &mut self,
        layer_id: u32,
        pixels: f32,
        world: f32,
    ) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.set_layer_inner_outline(layer_id as usize, pixels, world)?;
            Ok("layer_inner_outline_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    pub fn set_layer_feature_extra_pixels(
        &mut self,
        layer_id: u32,
        pixels: f32,
    ) -> Result<String, JsValue> {
        self.set_layer_inner_outline(layer_id, pixels, 0.0)
    }

    /// Recreate WebGL-owned resources after browser context restoration.
    ///
    /// This can recreate GPU resources only while parsed geometry is still retained.
    /// After geometry has been released to reduce WASM memory, JS should rebuild
    /// layers from the retained source file contents.
    pub fn restore_context(&mut self, gl: WebGl2RenderingContext) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.restore_context(gl)?;
        } else {
            let mut renderer = Renderer::new(gl)?;
            renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
            self.renderer = Some(renderer);
        }

        Ok("restore_done".to_string())
    }

    /// Recreate WebGL-owned resources with an explicit framebuffer size.
    pub fn restore_context_with_size(
        &mut self,
        gl: WebGl2RenderingContext,
        width: u32,
        height: u32,
    ) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.set_framebuffer_size(width, height)?;
            renderer.restore_context(gl)?;
        } else {
            let mut renderer = Renderer::new_headless(gl, width, height)?;
            renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
            self.renderer = Some(renderer);
        }

        Ok("restore_done".to_string())
    }

    /// Add a new layer to the renderer
    ///
    /// # Arguments
    /// * `content` - Gerber file content as string
    ///
    /// # Returns
    /// * Layer ID (u32) for tracking this layer
    pub fn add_layer(&mut self, content: String) -> Result<u32, JsValue> {
        if self.interaction_enabled {
            let payload = parse_layer_payload_data(
                &content,
                0.0,
                0.0,
                self.preserve_arc_regions,
                self.arc_tessellation_quality,
            )?;
            return self.add_parsed_layer_payload(payload);
        }

        let gerber_data_layers = parse_layer_data(
            &content,
            0.0,
            0.0,
            self.preserve_arc_regions,
            self.arc_tessellation_quality,
            false,
        )?;
        self.add_parsed_layers(gerber_data_layers)
    }

    /// Add a new layer after translating its parsed geometry.
    ///
    /// # Arguments
    /// * `content` - Gerber file content as string
    /// * `offset_x` - Horizontal offset in parsed Gerber world units
    /// * `offset_y` - Vertical offset in parsed Gerber world units
    ///
    /// # Returns
    /// * Layer ID (u32) for tracking this layer
    pub fn add_layer_with_offset(
        &mut self,
        content: String,
        offset_x: f32,
        offset_y: f32,
    ) -> Result<u32, JsValue> {
        if self.interaction_enabled {
            let payload = parse_layer_payload_data(
                &content,
                offset_x,
                offset_y,
                self.preserve_arc_regions,
                self.arc_tessellation_quality,
            )?;
            return self.add_parsed_layer_payload(payload);
        }

        let gerber_data_layers = parse_layer_data(
            &content,
            offset_x,
            offset_y,
            self.preserve_arc_regions,
            self.arc_tessellation_quality,
            false,
        )?;
        self.add_parsed_layers(gerber_data_layers)
    }

    /// Add an inverted display layer by filling a board outline and clearing
    /// the target layer geometry from it.
    #[allow(clippy::too_many_arguments)]
    pub fn add_inverted_layer_with_outline(
        &mut self,
        target_content: String,
        outline_content: String,
        target_offset_x: f32,
        target_offset_y: f32,
        outline_offset_x: f32,
        outline_offset_y: f32,
    ) -> Result<u32, JsValue> {
        let target_layers = parse_layer_data(
            &target_content,
            target_offset_x,
            target_offset_y,
            self.preserve_arc_regions,
            self.arc_tessellation_quality,
            false,
        )?;
        let outline_layers = parse_layer_data(
            &outline_content,
            outline_offset_x,
            outline_offset_y,
            self.preserve_arc_regions,
            self.arc_tessellation_quality,
            true,
        )?;

        if let Some(renderer) = &mut self.renderer {
            let layer_id =
                renderer.add_inverted_layer_from_outline(&outline_layers, target_layers)?;
            Ok(layer_id as u32)
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    pub fn add_inverted_layer_with_bounds(
        &mut self,
        target_content: String,
        target_offset_x: f32,
        target_offset_y: f32,
        min_x: f32,
        max_x: f32,
        min_y: f32,
        max_y: f32,
    ) -> Result<u32, JsValue> {
        let target_layers = parse_layer_data(
            &target_content,
            target_offset_x,
            target_offset_y,
            self.preserve_arc_regions,
            self.arc_tessellation_quality,
            false,
        )?;

        if let Some(renderer) = &mut self.renderer {
            let layer_id = renderer.add_inverted_layer_from_bounds(
                Boundary::new(min_x, max_x, min_y, max_y),
                target_layers,
            )?;
            Ok(layer_id as u32)
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    /// Add an Excellon / NC Drill file as a drill overlay.
    pub fn add_drill_layer(&mut self, content: String) -> Result<JsValue, JsValue> {
        let drill = if self.interaction_enabled {
            parse_drill_with_offset_and_interactions(&content, DRILL_OUTLINE_WIDTH_MM, 0.0, 0.0)?
        } else {
            parse_drill_with_offset(&content, DRILL_OUTLINE_WIDTH_MM, 0.0, 0.0)?
        };
        self.add_drill_parse_result(drill)
    }

    pub fn add_drill_layer_with_offset(
        &mut self,
        content: String,
        offset_x: f32,
        offset_y: f32,
    ) -> Result<JsValue, JsValue> {
        let drill = if self.interaction_enabled {
            parse_drill_with_offset_and_interactions(
                &content,
                DRILL_OUTLINE_WIDTH_MM,
                offset_x,
                offset_y,
            )?
        } else {
            parse_drill_with_offset(&content, DRILL_OUTLINE_WIDTH_MM, offset_x, offset_y)?
        };
        self.add_drill_parse_result(drill)
    }

    /// Add a layer from geometry parsed in a worker or another WASM instance.
    pub fn add_parsed_layer(&mut self, parsed_layer: JsValue) -> Result<u32, JsValue> {
        let gerber_data_layers = gerber_data_layers_from_js(&parsed_layer)?;
        self.add_parsed_layers(gerber_data_layers)
    }

    /// Add a worker-produced render payload directly to WebGL buffers.
    pub fn add_render_payload(&mut self, render_payload: JsValue) -> Result<u32, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            let layer_id = renderer.add_layer_from_render_payload(&render_payload)?;
            Ok(layer_id as u32)
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    pub fn add_interaction_payload(
        &mut self,
        layer_id: u32,
        interaction_payload: JsValue,
    ) -> Result<(), JsValue> {
        if !self.interaction_enabled
            || interaction_payload.is_null()
            || interaction_payload.is_undefined()
        {
            return Ok(());
        }
        let interaction_layer = InteractionLayer::from_compact_js(&interaction_payload)?;
        self.set_interaction_layer(layer_id as usize, Some(interaction_layer));
        Ok(())
    }

    /// Build and store the interaction layer for an already-loaded render layer.
    ///
    /// Call this after `add_render_payload` to attach interaction data without
    /// re-uploading render geometry. The gerber content is parsed a second time
    /// but no GPU buffers are allocated.
    pub fn build_layer_interactions(
        &mut self,
        layer_id: u32,
        content: String,
        offset_x: f32,
        offset_y: f32,
    ) -> Result<(), JsValue> {
        if !self.interaction_enabled {
            return Ok(());
        }
        let payload = parse_layer_payload_data(
            &content,
            offset_x,
            offset_y,
            self.preserve_arc_regions,
            self.arc_tessellation_quality,
        )?;
        self.set_interaction_layer(layer_id as usize, payload.interaction_layer);
        Ok(())
    }

    /// Return true if an interaction layer is already stored for this layer id.
    pub fn has_interaction_layer(&self, layer_id: u32) -> bool {
        self.interaction_layers
            .get(layer_id as usize)
            .and_then(Option::as_ref)
            .is_some()
    }

    pub fn clear_interaction_layers(&mut self) {
        self.interaction_layers.clear();
    }

    /// Remove a layer from the renderer
    ///
    /// # Arguments
    /// * `layer_id` - Layer ID returned from add_layer()
    ///
    /// # Returns
    /// * `"remove_done"` signal on success
    pub fn remove_layer(&mut self, layer_id: u32) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.remove_layer(layer_id as usize)?;
            self.drill_outline_layer_ids
                .retain(|&outline_layer_id| outline_layer_id != layer_id);
            self.remove_interaction_layer(layer_id as usize);
            Ok("remove_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    /// Clear all layers
    ///
    /// # Returns
    /// * `"clear_done"` signal on success
    pub fn clear(&mut self) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.clear_all();
            self.drill_outline_layer_ids.clear();
            self.interaction_layers.clear();
            Ok("clear_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    /// DEPRECATED: Use add_layer() instead
    /// Parse Gerber file data and create renderer
    ///
    /// # Arguments
    /// * `content` - Gerber file content as string
    ///
    /// # Returns
    /// * `"parse_done"` signal on success
    pub fn parse(&mut self, content: String) -> Result<String, JsValue> {
        // Backward compatibility: just call add_layer
        self.add_layer(content)?;
        Ok("parse_done".to_string())
    }

    /// Render geometry to FBOs and composite to canvas
    ///
    /// # Arguments
    /// * `active_layer_ids` - Array of layer IDs to render (in order)
    /// * `color_data` - Flat array of [r, g, b] or [r, g, b, a] for each active layer
    /// * `zoom_x` - Horizontal zoom factor
    /// * `zoom_y` - Vertical zoom factor
    /// * `offset_x` - Horizontal pan offset
    /// * `offset_y` - Vertical pan offset
    /// * `alpha` - Global alpha for all layers
    ///
    /// # Returns
    /// * `"render_done"` signal on success
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
        alpha: f32,
    ) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.render(
                active_layer_ids,
                color_data,
                zoom_x,
                zoom_y,
                offset_x,
                offset_y,
                alpha,
            )?;
            Ok("render_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    /// Render geometry to the canvas, optionally preserving existing canvas contents.
    #[allow(clippy::too_many_arguments)]
    pub fn render_with_clear(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
        alpha: f32,
        clear_canvas: bool,
    ) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.render_with_clear(
                active_layer_ids,
                color_data,
                zoom_x,
                zoom_y,
                offset_x,
                offset_y,
                alpha,
                clear_canvas,
            )?;
            Ok("render_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_with_clear_and_blend_modes(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        blend_modes: &[u8],
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
        alpha: f32,
        clear_canvas: bool,
    ) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.render_with_clear_and_blend_modes(
                active_layer_ids,
                color_data,
                blend_modes,
                zoom_x,
                zoom_y,
                offset_x,
                offset_y,
                alpha,
                clear_canvas,
            )?;
            Ok("render_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    pub fn pick_interaction_feature(
        &self,
        layer_ids: &[u32],
        x: f32,
        y: f32,
        tolerance: f32,
    ) -> Result<JsValue, JsValue> {
        self.pick_interaction_feature_internal(layer_ids, x, y, tolerance, None)
    }

    pub fn pick_interaction_feature_after(
        &self,
        layer_ids: &[u32],
        x: f32,
        y: f32,
        tolerance: f32,
        after_layer_id: u32,
        after_feature_id: u32,
    ) -> Result<JsValue, JsValue> {
        self.pick_interaction_feature_internal(
            layer_ids,
            x,
            y,
            tolerance,
            Some((after_layer_id, after_feature_id as usize)),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_interaction_highlight(
        &mut self,
        layer_id: u32,
        feature_id: u32,
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
    ) -> Result<String, JsValue> {
        if !self.interaction_enabled {
            return Ok("highlight_skipped".to_string());
        }

        let interaction_layer = self
            .interaction_layers
            .get(layer_id as usize)
            .and_then(Option::as_ref)
            .ok_or_else(|| JsValue::from_str("Interaction layer not found"))?;
        let feature = interaction_layer
            .feature(feature_id as usize)
            .ok_or_else(|| JsValue::from_str("Interaction feature not found"))?;
        let clear_features =
            interaction_layer.following_clear_features_for_highlight(feature_id as usize);

        if let Some(renderer) = &mut self.renderer {
            renderer.render_interaction_highlight(
                layer_id as usize,
                feature,
                &clear_features,
                zoom_x,
                zoom_y,
                offset_x,
                offset_y,
            )?;
            Ok("highlight_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    /// Render into an offscreen framebuffer and return bottom-up RGBA pixels.
    #[allow(clippy::too_many_arguments)]
    pub fn render_pixels_with_clear(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
        alpha: f32,
        clear_canvas: bool,
    ) -> Result<Vec<u8>, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.render_pixels_with_clear(
                active_layer_ids,
                color_data,
                zoom_x,
                zoom_y,
                offset_x,
                offset_y,
                alpha,
                clear_canvas,
            )
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_pixels_with_clear_and_blend_modes(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        blend_modes: &[u8],
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
        alpha: f32,
        clear_canvas: bool,
    ) -> Result<Vec<u8>, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.render_pixels_with_clear_and_blend_modes(
                active_layer_ids,
                color_data,
                blend_modes,
                zoom_x,
                zoom_y,
                offset_x,
                offset_y,
                alpha,
                clear_canvas,
            )
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    /// Render one tile of a larger virtual canvas to the current WebGL canvas.
    ///
    /// The caller is expected to resize the WebGL canvas to `tile_width` x
    /// `tile_height` before calling this method, then copy the result into the
    /// final image at `tile_x`, `tile_y`.
    #[allow(clippy::too_many_arguments)]
    pub fn render_tile(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        export_width: u32,
        export_height: u32,
        tile_x: u32,
        tile_y: u32,
        tile_width: u32,
        tile_height: u32,
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
        alpha: f32,
    ) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.render_tile(
                active_layer_ids,
                color_data,
                export_width,
                export_height,
                tile_x,
                tile_y,
                tile_width,
                tile_height,
                zoom_x,
                zoom_y,
                offset_x,
                offset_y,
                alpha,
            )?;
            Ok("render_tile_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_tile_with_blend_modes(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        blend_modes: &[u8],
        export_width: u32,
        export_height: u32,
        tile_x: u32,
        tile_y: u32,
        tile_width: u32,
        tile_height: u32,
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
        alpha: f32,
    ) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.render_tile_with_blend_modes(
                active_layer_ids,
                color_data,
                blend_modes,
                export_width,
                export_height,
                tile_x,
                tile_y,
                tile_width,
                tile_height,
                zoom_x,
                zoom_y,
                offset_x,
                offset_y,
                alpha,
            )?;
            Ok("render_tile_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
    }

    /// Get the boundary of the parsed Gerber data for fitToView
    ///
    /// # Returns
    /// * `Boundary` containing min/max x/y coordinates
    ///
    /// # Errors
    /// * Returns error if parse() has not been called yet
    pub fn get_boundary(&self) -> Result<Boundary, JsValue> {
        if let Some(renderer) = &self.renderer {
            Ok(renderer.get_boundary())
        } else {
            Err(JsValue::from_str(
                "No data available. Call parse() first to parse Gerber content.",
            ))
        }
    }

    /// Get the boundary of one parsed user layer.
    pub fn get_layer_boundary(&self, layer_id: u32) -> Result<Boundary, JsValue> {
        if let Some(renderer) = &self.renderer {
            renderer.get_layer_boundary(layer_id as usize)
        } else {
            Err(JsValue::from_str(
                "No data available. Call add_layer() first to parse Gerber content.",
            ))
        }
    }

    /// Resize framebuffers when canvas dimensions change (e.g., fullscreen)
    ///
    /// # Returns
    /// * `"resize_done"` signal on success
    ///
    /// # Errors
    /// * Returns error if renderer is not initialized
    pub fn resize(&mut self) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.resize()?;
            Ok("resize_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() and parse() first.",
            ))
        }
    }

    /// Resize framebuffers to explicit dimensions.
    pub fn resize_to(&mut self, width: u32, height: u32) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.resize_to(width, height)?;
            Ok("resize_done".to_string())
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() and parse() first.",
            ))
        }
    }
}

// triangulate_polygon is accessed through parser module
