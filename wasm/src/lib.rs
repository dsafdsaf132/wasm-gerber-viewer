mod parser;
mod renderer;
mod shape;

use crate::parser::parse_gerber;
use crate::renderer::Renderer;
use crate::shape::Boundary;
use wasm_bindgen::prelude::*;
use web_sys::WebGl2RenderingContext;

/// Initialize panic hook for better error messages in browser console
#[wasm_bindgen]
pub fn init_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Main Gerber processor with stateful WebGL renderer
#[wasm_bindgen]
#[derive(Default)]
pub struct GerberProcessor {
    gl: Option<WebGl2RenderingContext>,
    renderer: Option<Renderer>,
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
        self.renderer = Some(Renderer::new(gl.clone())?);
        self.gl = Some(gl);
        Ok("init_done".to_string())
    }

    /// Recreate WebGL-owned resources after browser context restoration.
    ///
    /// Parsed Gerber geometry is kept in Rust memory, so this does not require
    /// JS to retain or reparse the original uploaded file contents.
    pub fn restore_context(&mut self, gl: WebGl2RenderingContext) -> Result<String, JsValue> {
        if let Some(renderer) = &mut self.renderer {
            renderer.restore_context(gl.clone())?;
        } else {
            self.renderer = Some(Renderer::new(gl.clone())?);
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
        // Parse Gerber content to get Vec<GerberData> (one per polarity layer)
        let gerber_data_layers = parse_gerber(&content)?;

        // Filter out empty layers (layers with no geometry)
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
    /// * `color_data` - Flat array of [r, g, b] for each active layer (NO alpha)
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
}

// triangulate_polygon is accessed through parser module
