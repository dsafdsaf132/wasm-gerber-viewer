mod buffer;
mod camera;
mod shader;

// Internal use only
use buffer::{BufferCache, Fbo};
use camera::Camera;
use shader::{
    ShaderProgram, ShaderPrograms, ARRAY_BUFFER, BLEND, COLOR_BUFFER_BIT, FLOAT, FUNC_ADD, ONE,
    ONE_MINUS_SRC_ALPHA, STATIC_DRAW, TRIANGLES, ZERO,
};

use crate::shape::{Arcs, Boundary, Circles, GerberData, Thermals, Triangles};
use js_sys::Float32Array;
use wasm_bindgen::prelude::*;
use web_sys::{WebGl2RenderingContext, WebGlBuffer, WebGlTexture};

/// Metadata for a single user layer (may contain multiple polarity sublayers)
pub struct LayerMetadata {
    gerber_data: Vec<GerberData>,    // Polarity sublayers for this layer
    fbo: Fbo,                        // FBO for rendering this layer
    buffer_caches: Vec<BufferCache>, // Buffer cache per polarity sublayer
    boundary: Boundary,              // Combined boundary
    fbo_dirty: bool,
    fbo_transform: Option<[f32; 9]>,
    cpu_geometry_released: bool,
}

/// WebGL renderer for Gerber graphics with multi-layer support
pub struct Renderer {
    gl: WebGl2RenderingContext,
    layers: Vec<Option<LayerMetadata>>, // Sparse vec (None = deallocated slot)
    layer_count: usize,                 // Active layer count
    programs: ShaderPrograms,
    camera: Camera,
    quad_buffer: WebGlBuffer, // Shared quad buffer for all layers
}

impl Renderer {
    /// Create a new renderer with WebGL context (no layers initially)
    pub fn new(gl: WebGl2RenderingContext) -> Result<Renderer, JsValue> {
        // Compile shader programs
        let programs = ShaderPrograms::new(&gl)?;

        // Create quad buffer for instanced rendering (shared across all layers)
        let quad_buffer = Self::create_quad_buffer(&gl)?;

        Ok(Renderer {
            gl,
            layers: Vec::new(),
            layer_count: 0,
            programs,
            camera: Camera::new(),
            quad_buffer,
        })
    }

    /// Add a new layer with parsed Gerber data
    /// Returns the layer index (layer_id)
    pub fn add_layer(&mut self, gerber_data: Vec<GerberData>) -> Result<usize, JsValue> {
        let (width, height) = self.get_canvas_size()?;
        Self::validate_gerber_data_layers(&gerber_data)?;

        // Calculate combined boundary from all polarity sublayers
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        for data in &gerber_data {
            let b = &data.boundary;
            min_x = min_x.min(b.min_x);
            max_x = max_x.max(b.max_x);
            min_y = min_y.min(b.min_y);
            max_y = max_y.max(b.max_y);
        }

        if !min_x.is_finite() || !max_x.is_finite() || !min_y.is_finite() || !max_y.is_finite() {
            return Err(JsValue::from_str("Layer boundary is not finite"));
        }

        let boundary = Boundary::new(min_x, max_x, min_y, max_y);

        // Create FBO for this layer
        let fbo = Self::create_fbo(&self.gl, width, height)?;

        // Create buffer caches for each polarity sublayer
        let buffer_caches = Self::create_buffer_caches(gerber_data.len());

        let layer_metadata = LayerMetadata {
            gerber_data,
            fbo,
            buffer_caches,
            boundary,
            fbo_dirty: true,
            fbo_transform: None,
            cpu_geometry_released: false,
        };

        // Find next free slot or extend vec
        if let Some(free_slot) = self.layers.iter().position(|layer| layer.is_none()) {
            self.layers[free_slot] = Some(layer_metadata);
            self.layer_count += 1;
            Ok(free_slot)
        } else {
            self.layers.push(Some(layer_metadata));
            self.layer_count += 1;
            Ok(self.layers.len() - 1)
        }
    }

    fn validate_gerber_data_layers(gerber_data: &[GerberData]) -> Result<(), JsValue> {
        if gerber_data.is_empty() {
            return Err(JsValue::from_str("Layer does not contain any sublayers"));
        }

        for (sublayer_idx, data) in gerber_data.iter().enumerate() {
            Self::validate_gerber_data(data, sublayer_idx)?;
        }

        Ok(())
    }

    fn validate_gerber_data(data: &GerberData, sublayer_idx: usize) -> Result<(), JsValue> {
        Self::validate_triangle_data(&data.triangles, sublayer_idx)?;
        Self::validate_circle_data(&data.circles, sublayer_idx)?;
        Self::validate_arc_data(&data.arcs, sublayer_idx)?;
        Self::validate_thermal_data(&data.thermals, sublayer_idx)?;
        Self::validate_finite_value("boundary.min_x", data.boundary.min_x)?;
        Self::validate_finite_value("boundary.max_x", data.boundary.max_x)?;
        Self::validate_finite_value("boundary.min_y", data.boundary.min_y)?;
        Self::validate_finite_value("boundary.max_y", data.boundary.max_y)?;
        Ok(())
    }

    fn validate_triangle_data(triangles: &Triangles, sublayer_idx: usize) -> Result<(), JsValue> {
        if !triangles.vertices.len().is_multiple_of(2) {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} triangle vertex buffer has an odd number of coordinates",
                sublayer_idx
            )));
        }
        let vertex_count = triangles.vertices.len() / 2;
        if !vertex_count.is_multiple_of(3) {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} triangle vertex count is not divisible by 3",
                sublayer_idx
            )));
        }

        Self::validate_finite_slice("triangle vertices", &triangles.vertices)?;
        if !triangles.hole_x.is_empty()
            || !triangles.hole_y.is_empty()
            || !triangles.hole_radius.is_empty()
        {
            Self::validate_len(
                "triangle hole_x",
                sublayer_idx,
                triangles.hole_x.len(),
                vertex_count,
            )?;
            Self::validate_len(
                "triangle hole_y",
                sublayer_idx,
                triangles.hole_y.len(),
                vertex_count,
            )?;
            Self::validate_len(
                "triangle hole_radius",
                sublayer_idx,
                triangles.hole_radius.len(),
                vertex_count,
            )?;
            Self::validate_finite_slice("triangle hole_x", &triangles.hole_x)?;
            Self::validate_finite_slice("triangle hole_y", &triangles.hole_y)?;
            Self::validate_non_negative_slice("triangle hole_radius", &triangles.hole_radius)?;
        }

        if vertex_count > i32::MAX as usize {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} triangle vertex count exceeds WebGL draw limits",
                sublayer_idx
            )));
        }

        Ok(())
    }

    fn validate_circle_data(circles: &Circles, sublayer_idx: usize) -> Result<(), JsValue> {
        let count = circles.x.len();
        Self::validate_instance_count("circle", sublayer_idx, count)?;
        Self::validate_len("circle y", sublayer_idx, circles.y.len(), count)?;
        Self::validate_len("circle radius", sublayer_idx, circles.radius.len(), count)?;
        Self::validate_finite_slice("circle x", &circles.x)?;
        Self::validate_finite_slice("circle y", &circles.y)?;
        Self::validate_non_negative_slice("circle radius", &circles.radius)?;
        if !circles.hole_x.is_empty()
            || !circles.hole_y.is_empty()
            || !circles.hole_radius.is_empty()
        {
            Self::validate_len("circle hole_x", sublayer_idx, circles.hole_x.len(), count)?;
            Self::validate_len("circle hole_y", sublayer_idx, circles.hole_y.len(), count)?;
            Self::validate_len(
                "circle hole_radius",
                sublayer_idx,
                circles.hole_radius.len(),
                count,
            )?;
            Self::validate_finite_slice("circle hole_x", &circles.hole_x)?;
            Self::validate_finite_slice("circle hole_y", &circles.hole_y)?;
            Self::validate_non_negative_slice("circle hole_radius", &circles.hole_radius)?;
        }
        Ok(())
    }

    fn validate_arc_data(arcs: &Arcs, sublayer_idx: usize) -> Result<(), JsValue> {
        let count = arcs.x.len();
        Self::validate_instance_count("arc", sublayer_idx, count)?;
        Self::validate_len("arc y", sublayer_idx, arcs.y.len(), count)?;
        Self::validate_len("arc radius", sublayer_idx, arcs.radius.len(), count)?;
        Self::validate_len(
            "arc start_angle",
            sublayer_idx,
            arcs.start_angle.len(),
            count,
        )?;
        Self::validate_len(
            "arc sweep_angle",
            sublayer_idx,
            arcs.sweep_angle.len(),
            count,
        )?;
        Self::validate_len("arc thickness", sublayer_idx, arcs.thickness.len(), count)?;
        Self::validate_finite_slice("arc x", &arcs.x)?;
        Self::validate_finite_slice("arc y", &arcs.y)?;
        Self::validate_non_negative_slice("arc radius", &arcs.radius)?;
        Self::validate_finite_slice("arc start_angle", &arcs.start_angle)?;
        Self::validate_finite_slice("arc sweep_angle", &arcs.sweep_angle)?;
        Self::validate_non_negative_slice("arc thickness", &arcs.thickness)?;
        Ok(())
    }

    fn validate_thermal_data(thermals: &Thermals, sublayer_idx: usize) -> Result<(), JsValue> {
        let count = thermals.x.len();
        Self::validate_instance_count("thermal", sublayer_idx, count)?;
        Self::validate_len("thermal y", sublayer_idx, thermals.y.len(), count)?;
        Self::validate_len(
            "thermal outer_diameter",
            sublayer_idx,
            thermals.outer_diameter.len(),
            count,
        )?;
        Self::validate_len(
            "thermal inner_diameter",
            sublayer_idx,
            thermals.inner_diameter.len(),
            count,
        )?;
        Self::validate_len(
            "thermal gap_thickness",
            sublayer_idx,
            thermals.gap_thickness.len(),
            count,
        )?;
        Self::validate_len(
            "thermal rotation",
            sublayer_idx,
            thermals.rotation.len(),
            count,
        )?;
        Self::validate_finite_slice("thermal x", &thermals.x)?;
        Self::validate_finite_slice("thermal y", &thermals.y)?;
        Self::validate_non_negative_slice("thermal outer_diameter", &thermals.outer_diameter)?;
        Self::validate_non_negative_slice("thermal inner_diameter", &thermals.inner_diameter)?;
        Self::validate_non_negative_slice("thermal gap_thickness", &thermals.gap_thickness)?;
        Self::validate_finite_slice("thermal rotation", &thermals.rotation)?;
        Ok(())
    }

    fn validate_len(
        label: &str,
        sublayer_idx: usize,
        actual: usize,
        expected: usize,
    ) -> Result<(), JsValue> {
        if actual != expected {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} {} length mismatch: expected {}, got {}",
                sublayer_idx, label, expected, actual
            )));
        }
        Ok(())
    }

    fn validate_instance_count(
        label: &str,
        sublayer_idx: usize,
        count: usize,
    ) -> Result<(), JsValue> {
        if count > i32::MAX as usize {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} {} instance count exceeds WebGL draw limits",
                sublayer_idx, label
            )));
        }
        Ok(())
    }

    fn validate_finite_slice(label: &str, values: &[f32]) -> Result<(), JsValue> {
        for &value in values {
            Self::validate_finite_value(label, value)?;
        }
        Ok(())
    }

    fn validate_non_negative_slice(label: &str, values: &[f32]) -> Result<(), JsValue> {
        for &value in values {
            Self::validate_finite_value(label, value)?;
            if value < 0.0 {
                return Err(JsValue::from_str(&format!(
                    "{} contains a negative value",
                    label
                )));
            }
        }
        Ok(())
    }

    fn validate_finite_value(label: &str, value: f32) -> Result<(), JsValue> {
        if !value.is_finite() {
            return Err(JsValue::from_str(&format!("{} is not finite", label)));
        }
        Ok(())
    }

    /// Remove a layer by index
    pub fn remove_layer(&mut self, layer_id: usize) -> Result<(), JsValue> {
        if layer_id >= self.layers.len() || self.layers[layer_id].is_none() {
            return Err(JsValue::from_str(&format!(
                "Invalid layer_id: {}",
                layer_id
            )));
        }

        // Remove layer metadata (which will drop cached WebGL resources)
        if let Some(layer) = self.layers[layer_id].take() {
            Self::delete_layer_gpu_resources(&self.gl, layer);
        }

        self.layer_count -= 1;
        Ok(())
    }

    /// Clear all layers and clean up WebGL resources
    pub fn clear_all(&mut self) {
        let layers: Vec<_> = self.layers.drain(..).flatten().collect();

        // Delete all cached resources for each layer
        for layer in layers {
            Self::delete_layer_gpu_resources(&self.gl, layer);
        }
        self.layer_count = 0;
    }

    fn create_buffer_caches(count: usize) -> Vec<BufferCache> {
        (0..count).map(|_| BufferCache::default()).collect()
    }

    fn delete_layer_gpu_resources(gl: &WebGl2RenderingContext, layer: LayerMetadata) {
        Self::delete_fbo(gl, layer.fbo);

        for cache in layer.buffer_caches {
            Self::delete_buffer_cache(gl, cache);
        }
    }

    fn delete_fbo(gl: &WebGl2RenderingContext, fbo: Fbo) {
        gl.delete_framebuffer(Some(&fbo.framebuffer));
        gl.delete_texture(Some(&fbo.texture));
    }

    fn delete_shader_programs(gl: &WebGl2RenderingContext, programs: &ShaderPrograms) {
        gl.delete_program(Some(&programs.triangle.program));
        gl.delete_program(Some(&programs.circle.program));
        gl.delete_program(Some(&programs.arc.program));
        gl.delete_program(Some(&programs.thermal.program));
        gl.delete_program(Some(&programs.texture.program));
    }

    fn delete_buffer_cache(gl: &WebGl2RenderingContext, cache: BufferCache) {
        if let Some(vao) = cache.triangle_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.triangle_vertex_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.triangle_hole_x_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.triangle_hole_y_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.triangle_hole_radius_buffer {
            gl.delete_buffer(Some(&buf));
        }

        if let Some(vao) = cache.circle_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.circle_center_x_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.circle_center_y_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.circle_radius_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.circle_hole_x_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.circle_hole_y_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.circle_hole_radius_buffer {
            gl.delete_buffer(Some(&buf));
        }

        if let Some(vao) = cache.arc_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.arc_center_x_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.arc_center_y_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.arc_radius_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.arc_start_angle_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.arc_sweep_angle_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.arc_thickness_buffer {
            gl.delete_buffer(Some(&buf));
        }

        if let Some(vao) = cache.thermal_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.thermal_center_x_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.thermal_center_y_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.thermal_outer_diameter_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.thermal_inner_diameter_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.thermal_gap_thickness_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.thermal_rotation_buffer {
            gl.delete_buffer(Some(&buf));
        }
    }

    fn create_fbo(gl: &WebGl2RenderingContext, width: u32, height: u32) -> Result<Fbo, JsValue> {
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Cannot create an FBO with zero size"));
        }

        let max_texture_size = gl
            .get_parameter(WebGl2RenderingContext::MAX_TEXTURE_SIZE)?
            .as_f64()
            .unwrap_or(0.0) as u32;
        if max_texture_size > 0 && (width > max_texture_size || height > max_texture_size) {
            return Err(JsValue::from_str(&format!(
                "Canvas size {}x{} exceeds MAX_TEXTURE_SIZE {}",
                width, height, max_texture_size
            )));
        }

        let texture = gl.create_texture().ok_or("Failed to create texture")?;
        gl.bind_texture(WebGl2RenderingContext::TEXTURE_2D, Some(&texture));
        if let Err(error) = gl
            .tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_u8_array(
                WebGl2RenderingContext::TEXTURE_2D,
                0,
                WebGl2RenderingContext::RGBA as i32,
                width as i32,
                height as i32,
                0,
                WebGl2RenderingContext::RGBA,
                WebGl2RenderingContext::UNSIGNED_BYTE,
                None,
            )
        {
            gl.bind_texture(WebGl2RenderingContext::TEXTURE_2D, None);
            gl.delete_texture(Some(&texture));
            return Err(error);
        }
        gl.tex_parameteri(
            WebGl2RenderingContext::TEXTURE_2D,
            WebGl2RenderingContext::TEXTURE_MIN_FILTER,
            WebGl2RenderingContext::LINEAR as i32,
        );
        gl.tex_parameteri(
            WebGl2RenderingContext::TEXTURE_2D,
            WebGl2RenderingContext::TEXTURE_MAG_FILTER,
            WebGl2RenderingContext::LINEAR as i32,
        );
        gl.tex_parameteri(
            WebGl2RenderingContext::TEXTURE_2D,
            WebGl2RenderingContext::TEXTURE_WRAP_S,
            WebGl2RenderingContext::CLAMP_TO_EDGE as i32,
        );
        gl.tex_parameteri(
            WebGl2RenderingContext::TEXTURE_2D,
            WebGl2RenderingContext::TEXTURE_WRAP_T,
            WebGl2RenderingContext::CLAMP_TO_EDGE as i32,
        );

        let framebuffer = gl.create_framebuffer().ok_or("Failed to create FBO")?;
        gl.bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, Some(&framebuffer));
        gl.framebuffer_texture_2d(
            WebGl2RenderingContext::FRAMEBUFFER,
            WebGl2RenderingContext::COLOR_ATTACHMENT0,
            WebGl2RenderingContext::TEXTURE_2D,
            Some(&texture),
            0,
        );

        let status = gl.check_framebuffer_status(WebGl2RenderingContext::FRAMEBUFFER);
        if status != WebGl2RenderingContext::FRAMEBUFFER_COMPLETE {
            gl.bind_texture(WebGl2RenderingContext::TEXTURE_2D, None);
            gl.bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, None);
            gl.delete_framebuffer(Some(&framebuffer));
            gl.delete_texture(Some(&texture));
            return Err(JsValue::from_str(&format!(
                "Framebuffer is incomplete: 0x{:x}",
                status
            )));
        }

        gl.bind_texture(WebGl2RenderingContext::TEXTURE_2D, None);
        gl.bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, None);

        Ok(Fbo {
            framebuffer,
            texture,
        })
    }

    /// Create and bind a single-channel instance buffer
    fn create_instance_buffer(
        gl: &WebGl2RenderingContext,
        data: &[f32],
        program: &ShaderProgram,
        attr_name: &str,
        divisor: u32,
    ) -> Result<WebGlBuffer, JsValue> {
        let buffer = gl
            .create_buffer()
            .ok_or_else(|| JsValue::from_str("Failed to create buffer"))?;
        gl.bind_buffer(ARRAY_BUFFER, Some(&buffer));
        unsafe {
            let array = Float32Array::view(data);
            gl.buffer_data_with_array_buffer_view(ARRAY_BUFFER, &array, STATIC_DRAW);
        }
        let loc = program.attributes.get(attr_name).ok_or_else(|| {
            JsValue::from_str(&format!("Missing shader attribute: {}", attr_name))
        })?;
        gl.enable_vertex_attrib_array(*loc);
        gl.vertex_attrib_pointer_with_i32(*loc, 1, FLOAT, false, 0, 0);
        gl.vertex_attrib_divisor(*loc, divisor);
        Ok(buffer)
    }

    fn use_constant_vertex_attrib_1f(
        gl: &WebGl2RenderingContext,
        program: &ShaderProgram,
        attr_name: &str,
        x: f32,
    ) -> Result<(), JsValue> {
        let loc = Self::shader_attribute(program, attr_name)?;
        gl.disable_vertex_attrib_array(loc);
        gl.vertex_attrib1f(loc, x);
        Ok(())
    }

    /// Create quad buffer for instanced rendering
    fn create_quad_buffer(gl: &WebGl2RenderingContext) -> Result<WebGlBuffer, JsValue> {
        let vertices: [f32; 12] = [
            -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
        ];

        let buffer = gl
            .create_buffer()
            .ok_or_else(|| JsValue::from_str("Failed to create quad buffer"))?;

        gl.bind_buffer(ARRAY_BUFFER, Some(&buffer));

        unsafe {
            let array = Float32Array::view(&vertices);
            gl.buffer_data_with_array_buffer_view(ARRAY_BUFFER, &array, STATIC_DRAW);
        }

        Ok(buffer)
    }

    fn get_canvas_size_from_gl(gl: &WebGl2RenderingContext) -> Result<(u32, u32), JsValue> {
        let canvas = gl
            .canvas()
            .ok_or_else(|| JsValue::from_str("No canvas"))?
            .dyn_into::<web_sys::HtmlCanvasElement>()?;
        Ok((canvas.width(), canvas.height()))
    }

    /// Get canvas dimensions
    fn get_canvas_size(&self) -> Result<(u32, u32), JsValue> {
        Self::get_canvas_size_from_gl(&self.gl)
    }

    /// Get layer reference with error handling
    fn get_layer(&self, layer_id: usize) -> Result<&LayerMetadata, JsValue> {
        if layer_id >= self.layers.len() {
            return Err(JsValue::from_str("Invalid layer index"));
        }
        self.layers[layer_id]
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Layer deallocated"))
    }

    fn shader_attribute(program: &ShaderProgram, attr_name: &str) -> Result<u32, JsValue> {
        program
            .attributes
            .get(attr_name)
            .copied()
            .ok_or_else(|| JsValue::from_str(&format!("Missing shader attribute: {}", attr_name)))
    }

    /// Update camera state
    fn update_camera(&mut self, zoom_x: f32, zoom_y: f32, offset_x: f32, offset_y: f32) {
        self.camera.zoom_x = zoom_x;
        self.camera.zoom_y = zoom_y;
        self.camera.offset_x = offset_x;
        self.camera.offset_y = offset_y;
    }

    fn validate_render_inputs(
        active_layer_ids: &[u32],
        color_data: &[f32],
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
        alpha: f32,
    ) -> Result<(), JsValue> {
        let required_color_len = active_layer_ids
            .len()
            .checked_mul(3)
            .ok_or_else(|| JsValue::from_str("Active layer count is too large"))?;
        if color_data.len() < required_color_len {
            return Err(JsValue::from_str(&format!(
                "Color data is too short: expected at least {}, got {}",
                required_color_len,
                color_data.len()
            )));
        }

        Self::validate_finite_value("zoom_x", zoom_x)?;
        Self::validate_finite_value("zoom_y", zoom_y)?;
        Self::validate_finite_value("offset_x", offset_x)?;
        Self::validate_finite_value("offset_y", offset_y)?;
        Self::validate_finite_value("alpha", alpha)?;

        if zoom_x.abs() <= f32::EPSILON || zoom_y.abs() <= f32::EPSILON {
            return Err(JsValue::from_str("Camera zoom must be non-zero"));
        }

        if !(0.0..=1.0).contains(&alpha) {
            return Err(JsValue::from_str("Alpha must be between 0.0 and 1.0"));
        }

        Self::validate_finite_slice("color data", color_data)?;

        Ok(())
    }

    /// Draw a specific FBO texture to the current framebuffer
    fn draw_fbo_texture(&self, texture: &WebGlTexture, color: &[f32; 4]) -> Result<(), JsValue> {
        let program = &self.programs.texture;
        self.gl.use_program(Some(&program.program));

        // Use the shared quad buffer
        self.gl.bind_buffer(ARRAY_BUFFER, Some(&self.quad_buffer));
        let pos_loc = Self::shader_attribute(program, "position")?;
        self.gl.enable_vertex_attrib_array(pos_loc);
        self.gl
            .vertex_attrib_pointer_with_i32(pos_loc, 2, FLOAT, false, 0, 0);

        self.gl.active_texture(WebGl2RenderingContext::TEXTURE0);
        self.gl
            .bind_texture(WebGl2RenderingContext::TEXTURE_2D, Some(texture));
        self.gl.uniform1i(program.uniforms.get("u_texture"), 0);
        self.gl
            .uniform4fv_with_f32_array(program.uniforms.get("u_color"), color);

        self.gl.draw_arrays(TRIANGLES, 0, 6);

        Ok(())
    }

    /// Draw instanced triangles
    fn draw_instanced_triangles(
        &mut self,
        transform: &[f32; 9],
        color: &[f32; 4],
        layer_id: usize,
        sublayer_idx: usize,
    ) -> Result<(), JsValue> {
        // Validate layer exists
        if layer_id >= self.layers.len() {
            return Err(JsValue::from_str("Invalid layer index"));
        }

        let program = &self.programs.triangle;
        self.gl.use_program(Some(&program.program));

        // Buffer creation/update phase (scoped to end borrow early)
        let vertex_count = {
            let layer = if let Some(l) = &mut self.layers[layer_id] {
                l
            } else {
                return Err(JsValue::from_str("Layer deallocated"));
            };

            // Check if VAO is cached for this sublayer
            if layer.buffer_caches[sublayer_idx].triangle_vao.is_none() {
                let triangles = &layer.gerber_data[sublayer_idx].triangles;
                if triangles.vertices.is_empty() {
                    return Ok(());
                }
                let vertex_count = (triangles.vertices.len() / 2) as i32;

                // Create VAO
                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));

                // Create and bind vertex buffer
                let vertex_buffer = self
                    .gl
                    .create_buffer()
                    .ok_or_else(|| JsValue::from_str("Failed to create vertex buffer"))?;
                self.gl.bind_buffer(ARRAY_BUFFER, Some(&vertex_buffer));
                unsafe {
                    let array = Float32Array::view(&triangles.vertices);
                    self.gl
                        .buffer_data_with_array_buffer_view(ARRAY_BUFFER, &array, STATIC_DRAW);
                }

                // Set up attributes
                let position_loc = Self::shader_attribute(program, "position")?;
                self.gl.enable_vertex_attrib_array(position_loc);
                self.gl
                    .vertex_attrib_pointer_with_i32(position_loc, 2, FLOAT, false, 0, 0);

                if triangles.hole_radius.is_empty() {
                    Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_x_instance", 0.0)?;
                    Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_y_instance", 0.0)?;
                    Self::use_constant_vertex_attrib_1f(
                        &self.gl,
                        program,
                        "hole_radius_instance",
                        0.0,
                    )?;
                } else {
                    let hole_x_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &triangles.hole_x,
                        program,
                        "hole_x_instance",
                        0,
                    )?;
                    let hole_y_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &triangles.hole_y,
                        program,
                        "hole_y_instance",
                        0,
                    )?;
                    let hole_radius_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &triangles.hole_radius,
                        program,
                        "hole_radius_instance",
                        0,
                    )?;

                    let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                    buffer_cache.triangle_hole_x_buffer = Some(hole_x_buffer);
                    buffer_cache.triangle_hole_y_buffer = Some(hole_y_buffer);
                    buffer_cache.triangle_hole_radius_buffer = Some(hole_radius_buffer);
                }

                // Unbind VAO
                self.gl.bind_vertex_array(None);

                // Cache VAO and buffers for this sublayer
                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.triangle_vao = Some(vao);
                buffer_cache.triangle_vertex_count = vertex_count;
                buffer_cache.triangle_vertex_buffer = Some(vertex_buffer);
                layer.gerber_data[sublayer_idx]
                    .triangles
                    .release_cpu_geometry();
                layer.cpu_geometry_released = true;
            }

            layer.buffer_caches[sublayer_idx].triangle_vertex_count
        }; // Borrow ends here
        if vertex_count == 0 {
            return Ok(());
        }

        // Rendering phase (new borrow)
        let layer = self.get_layer(layer_id)?;
        let buffer_cache = &layer.buffer_caches[sublayer_idx];

        // Bind cached VAO for this sublayer
        self.gl
            .bind_vertex_array(buffer_cache.triangle_vao.as_ref());
        if buffer_cache.triangle_hole_radius_buffer.is_none() {
            Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_x_instance", 0.0)?;
            Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_y_instance", 0.0)?;
            Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_radius_instance", 0.0)?;
        }

        // Set uniforms (only these change per frame)
        if let Some(loc) = program.uniforms.get("transform") {
            self.gl
                .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
        }
        if let Some(loc) = program.uniforms.get("color") {
            self.gl.uniform4fv_with_f32_array(Some(loc), color);
        }

        // Draw
        self.gl.draw_arrays(TRIANGLES, 0, vertex_count);

        // Unbind VAO to prevent state leakage
        self.gl.bind_vertex_array(None);

        Ok(())
    }

    /// Draw instanced circles
    fn draw_instanced_circles(
        &mut self,
        transform: &[f32; 9],
        color: &[f32; 4],
        layer_id: usize,
        sublayer_idx: usize,
    ) -> Result<(), JsValue> {
        let program = &self.programs.circle;
        self.gl.use_program(Some(&program.program));

        let instance_count = {
            let layer = self.layers[layer_id]
                .as_mut()
                .ok_or_else(|| JsValue::from_str("Layer not found"))?;

            if layer.buffer_caches[sublayer_idx].circle_vao.is_none() {
                let circles = &layer.gerber_data[sublayer_idx].circles;
                if circles.x.is_empty() {
                    return Ok(());
                }
                let instance_count = circles.x.len() as i32;

                // Create VAO
                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));

                // Bind shared quad buffer for position attribute
                self.gl.bind_buffer(ARRAY_BUFFER, Some(&self.quad_buffer));
                let position_loc = Self::shader_attribute(program, "position")?;
                self.gl.enable_vertex_attrib_array(position_loc);
                self.gl
                    .vertex_attrib_pointer_with_i32(position_loc, 2, FLOAT, false, 0, 0);

                let center_x_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &circles.x,
                    program,
                    "center_x_instance",
                    1,
                )?;
                let center_y_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &circles.y,
                    program,
                    "center_y_instance",
                    1,
                )?;
                let radius_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &circles.radius,
                    program,
                    "radius_instance",
                    1,
                )?;
                if circles.hole_radius.is_empty() {
                    Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_x_instance", 0.0)?;
                    Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_y_instance", 0.0)?;
                    Self::use_constant_vertex_attrib_1f(
                        &self.gl,
                        program,
                        "hole_radius_instance",
                        0.0,
                    )?;
                } else {
                    let hole_x_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &circles.hole_x,
                        program,
                        "hole_x_instance",
                        1,
                    )?;
                    let hole_y_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &circles.hole_y,
                        program,
                        "hole_y_instance",
                        1,
                    )?;
                    let hole_radius_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &circles.hole_radius,
                        program,
                        "hole_radius_instance",
                        1,
                    )?;

                    let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                    buffer_cache.circle_hole_x_buffer = Some(hole_x_buffer);
                    buffer_cache.circle_hole_y_buffer = Some(hole_y_buffer);
                    buffer_cache.circle_hole_radius_buffer = Some(hole_radius_buffer);
                }

                // Unbind VAO
                self.gl.bind_vertex_array(None);

                // Cache VAO and buffers for this sublayer
                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.circle_vao = Some(vao);
                buffer_cache.circle_instance_count = instance_count;
                buffer_cache.circle_center_x_buffer = Some(center_x_buffer);
                buffer_cache.circle_center_y_buffer = Some(center_y_buffer);
                buffer_cache.circle_radius_buffer = Some(radius_buffer);
                layer.gerber_data[sublayer_idx]
                    .circles
                    .release_cpu_geometry();
                layer.cpu_geometry_released = true;
            }

            layer.buffer_caches[sublayer_idx].circle_instance_count
        };
        if instance_count == 0 {
            return Ok(());
        }

        // Re-get immutable reference for rendering
        let layer = self.get_layer(layer_id)?;
        let buffer_cache = &layer.buffer_caches[sublayer_idx];

        // Bind cached VAO for this sublayer
        self.gl.bind_vertex_array(buffer_cache.circle_vao.as_ref());
        if buffer_cache.circle_hole_radius_buffer.is_none() {
            Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_x_instance", 0.0)?;
            Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_y_instance", 0.0)?;
            Self::use_constant_vertex_attrib_1f(&self.gl, program, "hole_radius_instance", 0.0)?;
        }

        // Set uniforms (only these change per frame)
        if let Some(loc) = program.uniforms.get("transform") {
            self.gl
                .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
        }
        if let Some(loc) = program.uniforms.get("color") {
            self.gl.uniform4fv_with_f32_array(Some(loc), color);
        }

        // Draw
        self.gl
            .draw_arrays_instanced(TRIANGLES, 0, 6, instance_count);

        // Unbind VAO to prevent state leakage
        self.gl.bind_vertex_array(None);

        Ok(())
    }

    /// Draw instanced arcs
    fn draw_instanced_arcs(
        &mut self,
        transform: &[f32; 9],
        color: &[f32; 4],
        layer_id: usize,
        sublayer_idx: usize,
    ) -> Result<(), JsValue> {
        let program = &self.programs.arc;
        self.gl.use_program(Some(&program.program));

        let instance_count = {
            let layer = self.layers[layer_id]
                .as_mut()
                .ok_or_else(|| JsValue::from_str("Layer not found"))?;

            if layer.buffer_caches[sublayer_idx].arc_vao.is_none() {
                let arcs = &layer.gerber_data[sublayer_idx].arcs;
                if arcs.x.is_empty() {
                    return Ok(());
                }
                let instance_count = arcs.x.len() as i32;

                // Create VAO
                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));

                // Bind shared quad buffer for position attribute
                self.gl.bind_buffer(ARRAY_BUFFER, Some(&self.quad_buffer));
                let position_loc = Self::shader_attribute(program, "position")?;
                self.gl.enable_vertex_attrib_array(position_loc);
                self.gl
                    .vertex_attrib_pointer_with_i32(position_loc, 2, FLOAT, false, 0, 0);

                let center_x_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.x,
                    program,
                    "center_x_instance",
                    1,
                )?;
                let center_y_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.y,
                    program,
                    "center_y_instance",
                    1,
                )?;
                let radius_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.radius,
                    program,
                    "radius_instance",
                    1,
                )?;
                let start_angle_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.start_angle,
                    program,
                    "startAngle_instance",
                    1,
                )?;
                let sweep_angle_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.sweep_angle,
                    program,
                    "sweepAngle_instance",
                    1,
                )?;
                let thickness_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.thickness,
                    program,
                    "thickness_instance",
                    1,
                )?;

                // Unbind VAO
                self.gl.bind_vertex_array(None);

                // Cache VAO and buffers for this sublayer
                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.arc_vao = Some(vao);
                buffer_cache.arc_instance_count = instance_count;
                buffer_cache.arc_center_x_buffer = Some(center_x_buffer);
                buffer_cache.arc_center_y_buffer = Some(center_y_buffer);
                buffer_cache.arc_radius_buffer = Some(radius_buffer);
                buffer_cache.arc_start_angle_buffer = Some(start_angle_buffer);
                buffer_cache.arc_sweep_angle_buffer = Some(sweep_angle_buffer);
                buffer_cache.arc_thickness_buffer = Some(thickness_buffer);
                layer.gerber_data[sublayer_idx].arcs.release_cpu_geometry();
                layer.cpu_geometry_released = true;
            }

            layer.buffer_caches[sublayer_idx].arc_instance_count
        };
        if instance_count == 0 {
            return Ok(());
        }

        // Re-get immutable reference for rendering
        let layer = self.get_layer(layer_id)?;
        let buffer_cache = &layer.buffer_caches[sublayer_idx];

        // Bind cached VAO for this sublayer
        self.gl.bind_vertex_array(buffer_cache.arc_vao.as_ref());

        // Set uniforms (only these change per frame)
        if let Some(loc) = program.uniforms.get("transform") {
            self.gl
                .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
        }
        if let Some(loc) = program.uniforms.get("color") {
            self.gl.uniform4fv_with_f32_array(Some(loc), color);
        }

        // Draw
        self.gl
            .draw_arrays_instanced(TRIANGLES, 0, 6, instance_count);

        // Unbind VAO to prevent state leakage
        self.gl.bind_vertex_array(None);

        Ok(())
    }

    /// Draw instanced thermals
    fn draw_instanced_thermals(
        &mut self,
        transform: &[f32; 9],
        color: &[f32; 4],
        layer_id: usize,
        sublayer_idx: usize,
    ) -> Result<(), JsValue> {
        let program = &self.programs.thermal;
        self.gl.use_program(Some(&program.program));

        let instance_count = {
            let layer = self.layers[layer_id]
                .as_mut()
                .ok_or_else(|| JsValue::from_str("Layer not found"))?;

            if layer.buffer_caches[sublayer_idx].thermal_vao.is_none() {
                let thermals = &layer.gerber_data[sublayer_idx].thermals;
                if thermals.x.is_empty() {
                    return Ok(());
                }
                let instance_count = thermals.x.len() as i32;

                // Create VAO
                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));

                // Bind shared quad buffer for position attribute
                self.gl.bind_buffer(ARRAY_BUFFER, Some(&self.quad_buffer));
                let position_loc = Self::shader_attribute(program, "position")?;
                self.gl.enable_vertex_attrib_array(position_loc);
                self.gl
                    .vertex_attrib_pointer_with_i32(position_loc, 2, FLOAT, false, 0, 0);

                let center_x_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.x,
                    program,
                    "center_x_instance",
                    1,
                )?;
                let center_y_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.y,
                    program,
                    "center_y_instance",
                    1,
                )?;
                let outer_diameter_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.outer_diameter,
                    program,
                    "outer_diameter_instance",
                    1,
                )?;
                let inner_diameter_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.inner_diameter,
                    program,
                    "inner_diameter_instance",
                    1,
                )?;
                let gap_thickness_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.gap_thickness,
                    program,
                    "gap_thickness_instance",
                    1,
                )?;
                let rotation_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.rotation,
                    program,
                    "rotation_instance",
                    1,
                )?;

                // Unbind VAO
                self.gl.bind_vertex_array(None);

                // Cache VAO and buffers for this sublayer
                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.thermal_vao = Some(vao);
                buffer_cache.thermal_instance_count = instance_count;
                buffer_cache.thermal_center_x_buffer = Some(center_x_buffer);
                buffer_cache.thermal_center_y_buffer = Some(center_y_buffer);
                buffer_cache.thermal_outer_diameter_buffer = Some(outer_diameter_buffer);
                buffer_cache.thermal_inner_diameter_buffer = Some(inner_diameter_buffer);
                buffer_cache.thermal_gap_thickness_buffer = Some(gap_thickness_buffer);
                buffer_cache.thermal_rotation_buffer = Some(rotation_buffer);
                layer.gerber_data[sublayer_idx]
                    .thermals
                    .release_cpu_geometry();
                layer.cpu_geometry_released = true;
            }

            layer.buffer_caches[sublayer_idx].thermal_instance_count
        };
        if instance_count == 0 {
            return Ok(());
        }

        // Re-get immutable reference for rendering
        let layer = self.get_layer(layer_id)?;
        let buffer_cache = &layer.buffer_caches[sublayer_idx];

        // Bind cached VAO for this sublayer
        self.gl.bind_vertex_array(buffer_cache.thermal_vao.as_ref());

        // Set uniforms (only transform and color)
        if let Some(loc) = program.uniforms.get("transform") {
            self.gl
                .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
        }
        if let Some(loc) = program.uniforms.get("color") {
            self.gl.uniform4fv_with_f32_array(Some(loc), color);
        }

        // Draw
        self.gl
            .draw_arrays_instanced(TRIANGLES, 0, 6, instance_count);

        // Unbind VAO to prevent state leakage
        self.gl.bind_vertex_array(None);

        Ok(())
    }

    /// Render all geometry from a specific user layer (with polarity sublayers)
    fn render_layer_geometry(
        &mut self,
        layer_id: usize,
        transform: &[f32; 9],
    ) -> Result<(), JsValue> {
        if layer_id >= self.layers.len() || self.layers[layer_id].is_none() {
            return Ok(());
        }

        let white_color = [1.0, 1.0, 1.0, 1.0];

        // Get sublayer count
        let sublayer_count = self.get_layer(layer_id)?.gerber_data.len();

        // Render each polarity sublayer with appropriate blending
        for sublayer_idx in 0..sublayer_count {
            let is_negative = self.get_layer(layer_id)?.gerber_data[sublayer_idx].is_negative;

            // Set polarity blending mode
            self.gl.enable(BLEND);
            if is_negative {
                // Negative polarity: erase alpha
                self.gl
                    .blend_func_separate(ZERO, ONE, ZERO, ONE_MINUS_SRC_ALPHA);
            } else {
                // Positive polarity: add alpha
                self.gl.blend_func_separate(ZERO, ONE, ONE, ONE);
            }
            self.gl.blend_equation(FUNC_ADD);

            // Render all shapes (empty checks done inside draw methods)
            self.draw_instanced_triangles(transform, &white_color, layer_id, sublayer_idx)?;
            self.draw_instanced_circles(transform, &white_color, layer_id, sublayer_idx)?;
            self.draw_instanced_arcs(transform, &white_color, layer_id, sublayer_idx)?;
            self.draw_instanced_thermals(transform, &white_color, layer_id, sublayer_idx)?;
        }

        self.gl.disable(BLEND);
        Ok(())
    }

    /// Set active layers and colors (stores state for FBO reuse)
    /// Render geometry to FBOs and composite to canvas
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
    ) -> Result<(), JsValue> {
        Self::validate_render_inputs(
            active_layer_ids,
            color_data,
            zoom_x,
            zoom_y,
            offset_x,
            offset_y,
            alpha,
        )?;

        // Update camera state
        self.update_camera(zoom_x, zoom_y, offset_x, offset_y);

        // Get canvas dimensions
        let (width, height) = self.get_canvas_size()?;
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Cannot render to a zero-sized canvas"));
        }

        // Get transform matrix
        let transform = self.camera.get_transform_matrix(width, height);

        self.render_with_transform(active_layer_ids, color_data, alpha, transform)
    }

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
    ) -> Result<(), JsValue> {
        Self::validate_render_inputs(
            active_layer_ids,
            color_data,
            zoom_x,
            zoom_y,
            offset_x,
            offset_y,
            alpha,
        )?;
        Self::validate_tile_inputs(
            export_width,
            export_height,
            tile_x,
            tile_y,
            tile_width,
            tile_height,
        )?;

        self.update_camera(zoom_x, zoom_y, offset_x, offset_y);
        let transform = Self::tile_transform_matrix(
            self.camera
                .get_transform_matrix(export_width, export_height),
            export_width,
            export_height,
            tile_x,
            tile_y,
            tile_width,
            tile_height,
        );

        self.render_with_transform(active_layer_ids, color_data, alpha, transform)
    }

    fn render_with_transform(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        alpha: f32,
        transform: [f32; 9],
    ) -> Result<(), JsValue> {
        let (width, height) = self.get_canvas_size()?;
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Cannot render to a zero-sized canvas"));
        }

        // STEP 1: Render active layer geometry to FBOs only when geometry/camera state changed.
        for &layer_id in active_layer_ids {
            let layer_idx = layer_id as usize;
            let should_redraw = {
                let layer = self.get_layer(layer_idx)?;
                layer.fbo_dirty || layer.fbo_transform.as_ref() != Some(&transform)
            };

            if should_redraw {
                // Validate layer exists and get FBO
                let layer = self.get_layer(layer_idx)?;
                let fbo = &layer.fbo;

                // Bind layer FBO
                self.gl
                    .bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, Some(&fbo.framebuffer));
                self.gl.viewport(0, 0, width as i32, height as i32);

                // Clear layer FBO
                self.gl.clear_color(0.0, 0.0, 0.0, 0.0);
                self.gl.clear(COLOR_BUFFER_BIT);

                // Render layer geometry (with polarity blending handled internally)
                self.render_layer_geometry(layer_idx, &transform)?;

                if let Some(layer) = &mut self.layers[layer_idx] {
                    layer.fbo_dirty = false;
                    layer.fbo_transform = Some(transform);
                }
            }
        }

        // STEP 2: Composite FBOs to canvas
        self.composite_layers(active_layer_ids, color_data, alpha)?;

        Ok(())
    }

    fn validate_tile_inputs(
        export_width: u32,
        export_height: u32,
        tile_x: u32,
        tile_y: u32,
        tile_width: u32,
        tile_height: u32,
    ) -> Result<(), JsValue> {
        if export_width == 0 || export_height == 0 || tile_width == 0 || tile_height == 0 {
            return Err(JsValue::from_str("Tile dimensions must be non-zero"));
        }

        let tile_right = tile_x
            .checked_add(tile_width)
            .ok_or_else(|| JsValue::from_str("Tile width overflows export bounds"))?;
        let tile_bottom = tile_y
            .checked_add(tile_height)
            .ok_or_else(|| JsValue::from_str("Tile height overflows export bounds"))?;

        if tile_right > export_width || tile_bottom > export_height {
            return Err(JsValue::from_str("Tile is outside export bounds"));
        }

        Ok(())
    }

    fn tile_transform_matrix(
        mut transform: [f32; 9],
        export_width: u32,
        export_height: u32,
        tile_x: u32,
        tile_y: u32,
        tile_width: u32,
        tile_height: u32,
    ) -> [f32; 9] {
        let export_width = export_width as f32;
        let export_height = export_height as f32;
        let tile_x = tile_x as f32;
        let tile_y = tile_y as f32;
        let tile_width = tile_width as f32;
        let tile_height = tile_height as f32;

        let scale_x = export_width / tile_width;
        let offset_x = (export_width - 2.0 * tile_x) / tile_width - 1.0;
        let scale_y = export_height / tile_height;
        let offset_y = 1.0 - export_height / tile_height + 2.0 * tile_y / tile_height;

        transform[0] *= scale_x;
        transform[3] *= scale_x;
        transform[6] = transform[6] * scale_x + offset_x;
        transform[1] *= scale_y;
        transform[4] *= scale_y;
        transform[7] = transform[7] * scale_y + offset_y;
        transform
    }

    fn composite_layers(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        alpha: f32,
    ) -> Result<(), JsValue> {
        // Get canvas dimensions
        let (width, height) = self.get_canvas_size()?;

        // Bind canvas framebuffer
        self.gl
            .bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, None);
        self.gl.viewport(0, 0, width as i32, height as i32);

        // Clear canvas
        self.gl.clear_color(0.0, 0.0, 0.0, 0.0);
        self.gl.clear(COLOR_BUFFER_BIT);

        // Setup additive blending for layer compositing (lighter blend mode)
        self.gl.enable(BLEND);
        self.gl.blend_func(ONE, ONE);
        self.gl.blend_equation(FUNC_ADD);

        // Render each active layer's FBO to canvas with its color/alpha
        for (color_index, &layer_id) in active_layer_ids.iter().enumerate() {
            let layer_idx = layer_id as usize;

            if let Some(layer) = &self.layers[layer_idx] {
                // Get RGB color from array (3 floats per layer)
                let color_offset = color_index * 3;
                if color_offset + 2 < color_data.len() {
                    let color = [
                        color_data[color_offset],
                        color_data[color_offset + 1],
                        color_data[color_offset + 2],
                        alpha, // Use provided alpha
                    ];
                    self.draw_fbo_texture(&layer.fbo.texture, &color)?;
                }
            }
        }

        self.gl.disable(BLEND);

        Ok(())
    }

    /// Get the combined boundary from all layers
    pub fn get_boundary(&self) -> Boundary {
        if self.layer_count == 0 {
            return Boundary::new(0.0, 0.0, 0.0, 0.0);
        }

        // Combine boundaries from all active layers
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        for layer in self.layers.iter().flatten() {
            let b = &layer.boundary;
            min_x = min_x.min(b.min_x);
            max_x = max_x.max(b.max_x);
            min_y = min_y.min(b.min_y);
            max_y = max_y.max(b.max_y);
        }

        Boundary::new(min_x, max_x, min_y, max_y)
    }

    /// Get the boundary for one active user layer.
    pub fn get_layer_boundary(&self, layer_id: usize) -> Result<Boundary, JsValue> {
        let boundary = &self.get_layer(layer_id)?.boundary;
        Ok(Boundary::new(
            boundary.min_x,
            boundary.max_x,
            boundary.min_y,
            boundary.max_y,
        ))
    }

    /// Resize framebuffers when canvas size changes
    pub fn resize(&mut self) -> Result<(), JsValue> {
        let (width, height) = self.get_canvas_size()?;

        // Recreate FBO for each active layer
        for layer in self.layers.iter_mut().flatten() {
            let old_fbo =
                std::mem::replace(&mut layer.fbo, Self::create_fbo(&self.gl, width, height)?);
            Self::delete_fbo(&self.gl, old_fbo);
            layer.fbo_dirty = true;
            layer.fbo_transform = None;
        }

        Ok(())
    }

    /// Recreate WebGL-owned resources after the browser restores a lost context.
    /// Parsed Gerber geometry and stable layer IDs are preserved.
    pub fn restore_context(&mut self, gl: WebGl2RenderingContext) -> Result<(), JsValue> {
        if self
            .layers
            .iter()
            .flatten()
            .any(|layer| layer.cpu_geometry_released)
        {
            return Err(JsValue::from_str(
                "Layer geometry has been released from WebAssembly memory; rebuild layers from source files to restore WebGL context",
            ));
        }

        let programs = ShaderPrograms::new(&gl)?;
        let quad_buffer = Self::create_quad_buffer(&gl)?;
        let (width, height) = Self::get_canvas_size_from_gl(&gl)?;
        let mut new_fbos = Vec::with_capacity(self.layers.len());

        for layer in &self.layers {
            if layer.is_some() {
                let fbo = match Self::create_fbo(&gl, width, height) {
                    Ok(fbo) => fbo,
                    Err(error) => {
                        for fbo in new_fbos.into_iter().flatten() {
                            Self::delete_fbo(&gl, fbo);
                        }
                        gl.delete_buffer(Some(&quad_buffer));
                        Self::delete_shader_programs(&gl, &programs);
                        return Err(error);
                    }
                };
                new_fbos.push(Some(fbo));
            } else {
                new_fbos.push(None);
            }
        }

        let old_gl = self.gl.clone();
        let old_programs = std::mem::replace(&mut self.programs, programs);
        let old_quad_buffer = std::mem::replace(&mut self.quad_buffer, quad_buffer);

        for (layer, new_fbo) in self.layers.iter_mut().zip(new_fbos) {
            if let (Some(layer), Some(new_fbo)) = (layer, new_fbo) {
                let old_fbo = std::mem::replace(&mut layer.fbo, new_fbo);
                Self::delete_fbo(&old_gl, old_fbo);

                for cache in std::mem::take(&mut layer.buffer_caches) {
                    Self::delete_buffer_cache(&old_gl, cache);
                }
                layer.buffer_caches = Self::create_buffer_caches(layer.gerber_data.len());
                layer.fbo_dirty = true;
                layer.fbo_transform = None;
            }
        }

        old_gl.delete_buffer(Some(&old_quad_buffer));
        Self::delete_shader_programs(&old_gl, &old_programs);
        self.gl = gl;

        Ok(())
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        self.clear_all();
        self.gl.delete_buffer(Some(&self.quad_buffer));
        Self::delete_shader_programs(&self.gl, &self.programs);
    }
}
