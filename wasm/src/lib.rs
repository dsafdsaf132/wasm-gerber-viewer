mod parser;
mod renderer;
mod shape;

use crate::parser::{parse_gerber, parse_gerber_with_options};
use crate::renderer::Renderer;
use crate::shape::{gerber_data_layers_from_js, gerber_data_layers_to_js, Boundary, GerberData};
use wasm_bindgen::prelude::*;
use web_sys::WebGl2RenderingContext;

/// Initialize panic hook for better error messages in browser console
#[wasm_bindgen]
pub fn init_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

fn format_bytes(bytes: usize) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let bytes = bytes as f64;

    if bytes >= GIB {
        format!("{:.1} GB", bytes / GIB)
    } else if bytes >= MIB {
        format!("{:.1} MB", bytes / MIB)
    } else if bytes >= KIB {
        format!("{:.1} KB", bytes / KIB)
    } else {
        format!("{} B", bytes as usize)
    }
}

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
) -> Result<Vec<GerberData>, JsValue> {
    if !offset_x.is_finite() || !offset_y.is_finite() {
        return Err(JsValue::from_str("Layer offset must be finite"));
    }

    let mut gerber_data_layers = if preserve_arc_regions {
        parse_gerber(content)?
    } else {
        parse_gerber_with_options(content, preserve_arc_regions, arc_tessellation_quality)?
    };

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

#[wasm_bindgen]
pub fn parse_gerber_layer(
    content: String,
    offset_x: f32,
    offset_y: f32,
) -> Result<JsValue, JsValue> {
    let gerber_data_layers = parse_layer_data(&content, offset_x, offset_y, true, 1)?;
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
    )?;
    gerber_data_layers_to_js(&gerber_data_layers)
}

/// Main Gerber processor with stateful WebGL renderer
#[wasm_bindgen]
pub struct GerberProcessor {
    gl: Option<WebGl2RenderingContext>,
    renderer: Option<Renderer>,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
    minimum_feature_pixels: f32,
}

impl Default for GerberProcessor {
    fn default() -> Self {
        Self {
            gl: None,
            renderer: None,
            preserve_arc_regions: true,
            arc_tessellation_quality: 1,
            minimum_feature_pixels: 0.0,
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
        let mut renderer = Renderer::new(gl.clone())?;
        renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
        self.renderer = Some(renderer);
        self.gl = Some(gl);
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
        let mut renderer = Renderer::new_headless(gl.clone(), width, height)?;
        renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
        self.renderer = Some(renderer);
        self.gl = Some(gl);
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

    /// Recreate WebGL-owned resources after browser context restoration.
    ///
    /// This can recreate GPU resources only while parsed geometry is still retained.
    /// After geometry has been released to reduce WASM memory, JS should rebuild
    /// layers from the retained source file contents.
    pub fn restore_context(&mut self, gl: WebGl2RenderingContext) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.restore_context(gl.clone())?;
        } else {
            let mut renderer = Renderer::new(gl.clone())?;
            renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
            self.renderer = Some(renderer);
        }

        self.gl = Some(gl);
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
            renderer.restore_context(gl.clone())?;
        } else {
            let mut renderer = Renderer::new_headless(gl.clone(), width, height)?;
            renderer.set_minimum_feature_pixels(self.minimum_feature_pixels);
            self.renderer = Some(renderer);
        }

        self.gl = Some(gl);
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
        let gerber_data_layers = parse_layer_data(
            &content,
            0.0,
            0.0,
            self.preserve_arc_regions,
            self.arc_tessellation_quality,
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
        let gerber_data_layers = parse_layer_data(
            &content,
            offset_x,
            offset_y,
            self.preserve_arc_regions,
            self.arc_tessellation_quality,
        )?;
        self.add_parsed_layers(gerber_data_layers)
    }

    /// Add a layer from geometry parsed in a worker or another WASM instance.
    pub fn add_parsed_layer(&mut self, parsed_layer: JsValue) -> Result<u32, JsValue> {
        let gerber_data_layers = gerber_data_layers_from_js(&parsed_layer)?;
        self.add_parsed_layers(gerber_data_layers)
    }

    /// Add a worker-produced render payload directly to WebGL buffers.
    pub fn add_render_payload(&mut self, render_payload: JsValue) -> Result<u32, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            Ok(renderer.add_layer_from_render_payload(&render_payload)? as u32)
        } else {
            Err(JsValue::from_str(
                "Renderer not initialized. Call init() first.",
            ))
        }
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
