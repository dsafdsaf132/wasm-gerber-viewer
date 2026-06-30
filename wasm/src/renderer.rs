mod buffer;
mod camera;
mod shader;

// Internal use only
use buffer::{BufferCache, Fbo, TriangleTemplateBufferCache};
use camera::Camera;
use shader::{
    compile_program, ShaderProgram, ShaderPrograms, ALWAYS, ARRAY_BUFFER, BLEND, COLOR_BUFFER_BIT,
    EQUAL, FLOAT, FUNC_ADD, HIGHLIGHT_FRAGMENT_SHADER, HIGHLIGHT_STENCIL_FRAGMENT_SHADER,
    HIGHLIGHT_VERTEX_SHADER, INVERT, KEEP, NOTEQUAL, ONE, ONE_MINUS_SRC_ALPHA, REPLACE, SRC_ALPHA,
    STATIC_DRAW, STENCIL_BUFFER_BIT, STENCIL_TEST, STREAM_DRAW, TRIANGLES, ZERO,
};

use crate::interaction::InteractionFeature;
use crate::parser::geometry::{arc_curve_bounds, build_path_regions};
use crate::parser::ParserState;
use crate::region::{RegionContour, RegionSegment};
use crate::shape::{
    Arcs, Boundary, Circles, GerberData, Lines, PathRegions, Thermals, TriangleTemplateInstances,
    Triangles,
};
use js_sys::{Array, Float32Array, Reflect, Uint32Array};
use wasm_bindgen::{prelude::*, JsCast};
use web_sys::{
    WebGl2RenderingContext, WebGlBuffer, WebGlFramebuffer, WebGlTexture, WebGlVertexArrayObject,
};

/// Metadata for a single user layer (may contain multiple polarity sublayers)
pub struct LayerMetadata {
    gerber_data: Vec<GerberData>,    // Polarity sublayers for this layer
    fbo: Fbo,                        // FBO for rendering this layer
    buffer_caches: Vec<BufferCache>, // Buffer cache per polarity sublayer
    boundary: Boundary,              // Combined boundary
    fbo_dirty: bool,
    fbo_transform: Option<[f32; 9]>,
    inner_outline_pixels: f32,
    inner_outline_world: f32,
    cpu_geometry_released: bool,
    has_path_regions: bool,
}

/// WebGL renderer for Gerber graphics with multi-layer support
pub struct Renderer {
    gl: WebGl2RenderingContext,
    explicit_size: Option<(u32, u32)>,
    layers: Vec<Option<LayerMetadata>>, // Sparse vec (None = deallocated slot)
    layer_count: usize,                 // Active layer count
    programs: ShaderPrograms,
    camera: Camera,
    quad_buffer: WebGlBuffer, // Shared quad buffer for all layers
    minimum_feature_pixels: f32,
    highlight_program: Option<ShaderProgram>,
    highlight_stencil_program: Option<ShaderProgram>,
    highlight_buffer: Option<WebGlBuffer>,
    highlight_vertex_array: Option<WebGlVertexArrayObject>,
}

struct BufferCacheBuildGuard {
    gl: WebGl2RenderingContext,
    cache: BufferCache,
    committed: bool,
}

#[derive(Clone)]
struct OutlineSegment {
    start: [f32; 2],
    end: [f32; 2],
    points: Vec<[f32; 2]>,
    segment: RegionSegment,
}

fn include_optional_boundary(boundary: &mut Option<Boundary>, next: Boundary) {
    if let Some(boundary) = boundary {
        boundary.include_boundary(&next);
    } else {
        *boundary = Some(next);
    }
}

fn fill_layers_boundary(fill_layers: &[GerberData]) -> Result<Boundary, JsValue> {
    let mut boundary = None;
    for layer in fill_layers {
        include_optional_boundary(&mut boundary, layer.boundary.clone());
    }
    boundary.ok_or_else(|| JsValue::from_str("Board outline region boundary is not finite"))
}

impl BufferCacheBuildGuard {
    fn new(gl: &WebGl2RenderingContext) -> Self {
        Self {
            gl: gl.clone(),
            cache: BufferCache::default(),
            committed: false,
        }
    }

    fn commit(mut self) -> BufferCache {
        self.committed = true;
        std::mem::take(&mut self.cache)
    }
}

impl Drop for BufferCacheBuildGuard {
    fn drop(&mut self) {
        if self.committed {
            return;
        }

        self.gl.bind_vertex_array(None);
        Renderer::delete_buffer_cache(&self.gl, std::mem::take(&mut self.cache));
    }
}

impl Renderer {
    /// Create a new renderer with WebGL context (no layers initially)
    pub fn new(gl: WebGl2RenderingContext) -> Result<Renderer, JsValue> {
        Self::new_with_size(gl, None)
    }

    /// Create a renderer with an explicit framebuffer size.
    pub fn new_headless(
        gl: WebGl2RenderingContext,
        width: u32,
        height: u32,
    ) -> Result<Renderer, JsValue> {
        Self::validate_framebuffer_size(width, height)?;
        Self::new_with_size(gl, Some((width, height)))
    }

    fn new_with_size(
        gl: WebGl2RenderingContext,
        explicit_size: Option<(u32, u32)>,
    ) -> Result<Renderer, JsValue> {
        // Compile shader programs
        let programs = ShaderPrograms::new(&gl)?;

        // Create quad buffer for instanced rendering (shared across all layers)
        let quad_buffer = Self::create_quad_buffer(&gl)?;

        Ok(Renderer {
            gl,
            explicit_size,
            layers: Vec::new(),
            layer_count: 0,
            programs,
            camera: Camera::new(),
            quad_buffer,
            minimum_feature_pixels: 0.0,
            highlight_program: None,
            highlight_stencil_program: None,
            highlight_buffer: None,
            highlight_vertex_array: None,
        })
    }

    /// Update explicit framebuffer dimensions used by headless renderers.
    pub fn set_framebuffer_size(&mut self, width: u32, height: u32) -> Result<(), JsValue> {
        Self::validate_framebuffer_size(width, height)?;
        self.explicit_size = Some((width, height));
        Ok(())
    }

    /// Configure a display-space minimum feature size in CSS/device pixels.
    ///
    /// This is applied in the WebGL shaders and only affects rendering. Parsed
    /// geometry and layer bounds remain unchanged.
    pub fn set_minimum_feature_pixels(&mut self, pixels: f32) {
        let next_pixels = if pixels.is_finite() {
            pixels.clamp(0.0, 8.0)
        } else {
            0.0
        };

        if (self.minimum_feature_pixels - next_pixels).abs() <= f32::EPSILON {
            return;
        }

        self.minimum_feature_pixels = next_pixels;
        self.mark_all_layers_dirty();
    }

    pub fn set_layer_inner_outline(
        &mut self,
        layer_id: usize,
        pixels: f32,
        world: f32,
    ) -> Result<(), JsValue> {
        let next_pixels = if pixels.is_finite() {
            pixels.clamp(0.0, 8.0)
        } else {
            0.0
        };
        let next_world = if world.is_finite() {
            world.max(0.0)
        } else {
            0.0
        };
        let layer = self.get_layer_mut(layer_id)?;
        if (layer.inner_outline_pixels - next_pixels).abs() <= f32::EPSILON
            && (layer.inner_outline_world - next_world).abs() <= f32::EPSILON
        {
            return Ok(());
        }

        layer.inner_outline_pixels = next_pixels;
        layer.inner_outline_world = next_world;
        layer.fbo_dirty = true;
        layer.fbo_transform = None;
        Ok(())
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

        // Create FBO for this layer. Arc-containing path regions need stencil fill.
        let needs_stencil = gerber_data
            .iter()
            .any(|data| data.path_regions.has_geometry());
        let fbo = Self::create_fbo(&self.gl, width, height, needs_stencil)?;

        // Create buffer caches for each polarity sublayer
        let buffer_caches = Self::create_buffer_caches(gerber_data.len())?;

        let layer_metadata = LayerMetadata {
            gerber_data,
            fbo,
            buffer_caches,
            boundary,
            fbo_dirty: true,
            fbo_transform: None,
            inner_outline_pixels: 0.0,
            inner_outline_world: 0.0,
            cpu_geometry_released: false,
            has_path_regions: needs_stencil,
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

    /// Add a display-only layer that fills the board outline, then clears the
    /// target layer geometry from it. This preserves the existing polarity
    /// sublayer renderer while supporting inverted solder mask style previews.
    pub fn add_inverted_layer_from_outline(
        &mut self,
        outline_data: &[GerberData],
        mut target_data: Vec<GerberData>,
    ) -> Result<usize, JsValue> {
        let (mut fill_layers, fill_contours) = Self::inverted_outline_fill_layers(outline_data)?;
        let clip_layer = Self::outside_clip_layer(
            &fill_contours,
            &fill_layers_boundary(&fill_layers)?,
            &target_data,
        )?;
        let mut inverted_data = Vec::with_capacity(
            fill_layers
                .len()
                .saturating_add(target_data.len())
                .saturating_add(1),
        );
        inverted_data.append(&mut fill_layers);

        for mut sublayer in target_data.drain(..) {
            sublayer.is_negative = !sublayer.is_negative;
            inverted_data.push(sublayer);
        }
        inverted_data.push(clip_layer);

        self.add_layer(inverted_data)
    }

    fn inverted_outline_fill_layers(
        outline_data: &[GerberData],
    ) -> Result<(Vec<GerberData>, Vec<RegionContour>), JsValue> {
        match Self::outline_fill_layer_with_contours(outline_data) {
            Ok((fill_layer, fill_contours)) => Ok((vec![fill_layer], fill_contours)),
            Err(outline_error) => match Self::region_outline_fill_layers(outline_data)? {
                Some(region_source) => Ok(region_source),
                None => Err(outline_error),
            },
        }
    }

    fn region_outline_fill_layers(
        outline_data: &[GerberData],
    ) -> Result<Option<(Vec<GerberData>, Vec<RegionContour>)>, JsValue> {
        let mut fill_layers = Vec::new();
        let mut all_contours = Vec::new();

        for data in outline_data {
            if !data.path_regions.has_source_contours() {
                continue;
            }

            let path_regions =
                Self::path_regions_from_source_groups(&data.path_regions.source_contours)?;
            if !path_regions.has_geometry() {
                continue;
            }

            let boundary = Self::region_groups_boundary(&data.path_regions.source_contours)
                .ok_or_else(|| JsValue::from_str("Board outline region boundary is not finite"))?;
            for group in &data.path_regions.source_contours {
                all_contours.try_reserve(group.len()).map_err(|_| {
                    JsValue::from_str("Not enough memory to collect board outline region contours")
                })?;
                all_contours.extend(group.iter().cloned());
            }
            fill_layers.push(Self::path_region_layer(
                path_regions,
                boundary,
                data.is_negative,
            ));
        }

        if fill_layers.is_empty() {
            return Ok(None);
        }
        if all_contours.is_empty() {
            return Err(JsValue::from_str(
                "Board outline region produced no fill contours",
            ));
        }
        Ok(Some((fill_layers, all_contours)))
    }

    fn path_regions_from_source_groups(
        region_groups: &[Vec<RegionContour>],
    ) -> Result<PathRegions, JsValue> {
        let mut path_regions = PathRegions::empty();
        for group in region_groups {
            let group_regions = build_path_regions(group, &ParserState::default(), 1, false, false)
                .map_err(|error| {
                    JsValue::from_str(&format!("Failed to build board outline region: {error}"))
                })?;
            path_regions.append(group_regions);
        }
        Ok(path_regions)
    }

    fn region_groups_boundary(region_groups: &[Vec<RegionContour>]) -> Option<Boundary> {
        let mut boundary = None;
        for group in region_groups {
            if let Some(group_boundary) = Self::outline_regions_boundary(group) {
                include_optional_boundary(&mut boundary, group_boundary);
            }
        }
        boundary
    }

    pub fn add_inverted_layer_from_bounds(
        &mut self,
        bounds: Boundary,
        mut target_data: Vec<GerberData>,
    ) -> Result<usize, JsValue> {
        let fill_contours = vec![Self::bounds_region_contour(&bounds)?];
        let fill_layer = Self::bounds_fill_layer(bounds)?;
        let clip_layer =
            Self::outside_clip_layer(&fill_contours, &fill_layer.boundary, &target_data)?;
        let mut inverted_data = Vec::with_capacity(target_data.len().saturating_add(2));
        inverted_data.push(fill_layer);

        for mut sublayer in target_data.drain(..) {
            sublayer.is_negative = !sublayer.is_negative;
            inverted_data.push(sublayer);
        }
        inverted_data.push(clip_layer);

        self.add_layer(inverted_data)
    }

    fn outline_fill_layer_with_contours(
        outline_data: &[GerberData],
    ) -> Result<(GerberData, Vec<RegionContour>), JsValue> {
        let segments = Self::outline_segments(outline_data)?;
        let contours = Self::closed_outline_regions(&segments);
        if contours.is_empty() {
            return Err(JsValue::from_str(
                "Board outline must contain a closed aperture draw contour",
            ));
        }
        let boundary = Self::outline_regions_boundary(&contours)
            .ok_or_else(|| JsValue::from_str("Board outline boundary is not finite"))?;
        let path_regions = build_path_regions(&contours, &ParserState::default(), 1, false, false)
            .map_err(|error| {
                JsValue::from_str(&format!("Failed to build board outline region: {error}"))
            })?;
        if !path_regions.has_geometry() {
            return Err(JsValue::from_str(
                "Board outline region produced no fill geometry",
            ));
        }

        let layer = Self::path_region_layer(path_regions, boundary, false);
        Ok((layer, contours))
    }

    fn bounds_fill_layer(bounds: Boundary) -> Result<GerberData, JsValue> {
        Self::validate_finite_value("inverted bounds min_x", bounds.min_x)?;
        Self::validate_finite_value("inverted bounds max_x", bounds.max_x)?;
        Self::validate_finite_value("inverted bounds min_y", bounds.min_y)?;
        Self::validate_finite_value("inverted bounds max_y", bounds.max_y)?;
        if bounds.min_x >= bounds.max_x || bounds.min_y >= bounds.max_y {
            return Err(JsValue::from_str(
                "Inverted layer fallback bounds must have positive area",
            ));
        }

        let vertices = vec![
            bounds.min_x,
            bounds.min_y,
            bounds.max_x,
            bounds.min_y,
            bounds.max_x,
            bounds.max_y,
            bounds.min_x,
            bounds.min_y,
            bounds.max_x,
            bounds.max_y,
            bounds.min_x,
            bounds.max_y,
        ];

        Ok(GerberData::new(
            Triangles::new(vertices, Vec::new(), Vec::new(), Vec::new()),
            Vec::new(),
            Lines::new(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()),
            Circles::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Arcs::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Thermals::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            PathRegions::empty(),
            bounds,
            false,
        ))
    }

    fn outside_clip_layer(
        fill_contours: &[RegionContour],
        fill_boundary: &Boundary,
        target_data: &[GerberData],
    ) -> Result<GerberData, JsValue> {
        let mut clip_boundary = fill_boundary.clone();
        for sublayer in target_data {
            clip_boundary.include_boundary(&sublayer.boundary);
        }
        Self::validate_finite_value("inverted clip min_x", clip_boundary.min_x)?;
        Self::validate_finite_value("inverted clip max_x", clip_boundary.max_x)?;
        Self::validate_finite_value("inverted clip min_y", clip_boundary.min_y)?;
        Self::validate_finite_value("inverted clip max_y", clip_boundary.max_y)?;
        if clip_boundary.min_x >= clip_boundary.max_x || clip_boundary.min_y >= clip_boundary.max_y
        {
            return Err(JsValue::from_str(
                "Inverted layer clip bounds must have positive area",
            ));
        }

        let mut clip_contours = Vec::with_capacity(fill_contours.len().saturating_add(1));
        clip_contours.push(Self::bounds_region_contour(&clip_boundary)?);
        clip_contours.extend(fill_contours.iter().cloned());
        let path_regions =
            build_path_regions(&clip_contours, &ParserState::default(), 1, false, false).map_err(
                |error| {
                    JsValue::from_str(&format!("Failed to build inverted clip region: {error}"))
                },
            )?;

        Ok(Self::path_region_layer(path_regions, clip_boundary, true))
    }

    fn path_region_layer(
        path_regions: PathRegions,
        boundary: Boundary,
        is_negative: bool,
    ) -> GerberData {
        GerberData::new(
            Triangles::new(Vec::new(), Vec::new(), Vec::new(), Vec::new()),
            Vec::new(),
            Lines::new(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()),
            Circles::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Arcs::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Thermals::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            path_regions,
            boundary,
            is_negative,
        )
    }

    fn bounds_region_contour(bounds: &Boundary) -> Result<RegionContour, JsValue> {
        Self::validate_finite_value("region bounds min_x", bounds.min_x)?;
        Self::validate_finite_value("region bounds max_x", bounds.max_x)?;
        Self::validate_finite_value("region bounds min_y", bounds.min_y)?;
        Self::validate_finite_value("region bounds max_y", bounds.max_y)?;
        if bounds.min_x >= bounds.max_x || bounds.min_y >= bounds.max_y {
            return Err(JsValue::from_str("Region bounds must have positive area"));
        }

        let min_x = bounds.min_x;
        let max_x = bounds.max_x;
        let min_y = bounds.min_y;
        let max_y = bounds.max_y;
        Ok(RegionContour {
            points: vec![
                [min_x, min_y],
                [max_x, min_y],
                [max_x, max_y],
                [min_x, max_y],
                [min_x, min_y],
            ],
            segments: vec![
                RegionSegment::Line {
                    start: [min_x, min_y],
                    end: [max_x, min_y],
                },
                RegionSegment::Line {
                    start: [max_x, min_y],
                    end: [max_x, max_y],
                },
                RegionSegment::Line {
                    start: [max_x, max_y],
                    end: [min_x, max_y],
                },
                RegionSegment::Line {
                    start: [min_x, max_y],
                    end: [min_x, min_y],
                },
            ],
            has_arc: false,
        })
    }

    fn outline_segments(outline_data: &[GerberData]) -> Result<Vec<OutlineSegment>, JsValue> {
        const MIN_OUTLINE_WIDTH: f32 = 0.000001;

        let mut segments = Vec::new();
        for data in outline_data {
            if data.is_negative {
                continue;
            }

            let line_count = data
                .lines
                .start_x
                .len()
                .min(data.lines.start_y.len())
                .min(data.lines.end_x.len())
                .min(data.lines.end_y.len())
                .min(data.lines.width.len());
            segments.try_reserve(line_count).map_err(|_| {
                JsValue::from_str("Not enough memory to collect board outline segments")
            })?;
            for idx in 0..line_count {
                let width = data.lines.width[idx];
                if !width.is_finite() || width < 0.0 {
                    continue;
                }

                let start = [data.lines.start_x[idx], data.lines.start_y[idx]];
                let end = [data.lines.end_x[idx], data.lines.end_y[idx]];
                if !Self::finite_outline_point(start) || !Self::finite_outline_point(end) {
                    continue;
                }
                if Self::outline_points_close(start, end, MIN_OUTLINE_WIDTH) {
                    continue;
                }

                segments.push(OutlineSegment {
                    start,
                    end,
                    points: vec![start, end],
                    segment: RegionSegment::Line { start, end },
                });
            }

            let arc_count = data
                .arcs
                .x
                .len()
                .min(data.arcs.y.len())
                .min(data.arcs.radius.len())
                .min(data.arcs.start_angle.len())
                .min(data.arcs.sweep_angle.len())
                .min(data.arcs.thickness.len());
            segments.try_reserve(arc_count).map_err(|_| {
                JsValue::from_str("Not enough memory to collect board outline arcs")
            })?;
            for idx in 0..arc_count {
                let thickness = data.arcs.thickness[idx];
                if !thickness.is_finite() || thickness < 0.0 {
                    continue;
                }
                let center = [data.arcs.x[idx], data.arcs.y[idx]];
                let radius = data.arcs.radius[idx];
                let start_angle = data.arcs.start_angle[idx];
                let sweep_angle = data.arcs.sweep_angle[idx];
                if !Self::valid_outline_arc(center, radius, start_angle, sweep_angle) {
                    continue;
                }
                let points = Self::outline_arc_points(center, radius, start_angle, sweep_angle);
                let start = points[0];
                let end = *points.last().unwrap_or(&start);
                segments.push(OutlineSegment {
                    start,
                    end,
                    points,
                    segment: RegionSegment::Arc {
                        start,
                        end,
                        center,
                        radius,
                        start_angle,
                        sweep_angle,
                    },
                });
            }
        }

        if segments.is_empty() {
            return Err(JsValue::from_str(
                "Board outline does not contain aperture line or arc geometry",
            ));
        }

        Ok(segments)
    }

    fn outline_arc_points(
        center: [f32; 2],
        radius: f32,
        start_angle: f32,
        sweep_angle: f32,
    ) -> Vec<[f32; 2]> {
        let quarter_turn = std::f32::consts::FRAC_PI_2;
        let steps = ((sweep_angle.abs() / quarter_turn).ceil() as usize).clamp(1, 32);
        let mut points = Vec::with_capacity(steps.saturating_add(1));
        for step in 0..=steps {
            let t = step as f32 / steps as f32;
            let angle = start_angle + sweep_angle * t;
            points.push([
                center[0] + radius * angle.cos(),
                center[1] + radius * angle.sin(),
            ]);
        }
        if sweep_angle.abs() >= std::f32::consts::PI * 2.0 - 0.00001 {
            let first = points[0];
            if let Some(last) = points.last_mut() {
                *last = first;
            }
        }
        points
    }

    fn valid_outline_arc(
        center: [f32; 2],
        radius: f32,
        start_angle: f32,
        sweep_angle: f32,
    ) -> bool {
        Self::finite_outline_point(center)
            && radius.is_finite()
            && radius > 0.0
            && start_angle.is_finite()
            && sweep_angle.is_finite()
            && sweep_angle.abs() > f32::EPSILON
    }

    fn closed_outline_regions(segments: &[OutlineSegment]) -> Vec<RegionContour> {
        if segments.is_empty() {
            return Vec::new();
        }

        let tolerance = Self::outline_close_tolerance(segments);
        let mut contours = Vec::new();
        let mut consumed = vec![false; segments.len()];

        for start_idx in 0..segments.len() {
            if consumed[start_idx] {
                continue;
            }

            let mut used = vec![false; segments.len()];
            used[start_idx] = true;
            let mut contour = Self::outline_segment_to_region_contour(&segments[start_idx], false);

            for _ in 0..segments.len() {
                if Self::outline_contour_is_closed(&contour.points, tolerance) {
                    if let Some(contour) =
                        Self::normalize_outline_region_contour(contour, tolerance)
                    {
                        for (idx, is_used) in used.iter().enumerate() {
                            if *is_used {
                                consumed[idx] = true;
                            }
                        }
                        contours.push(contour);
                    }
                    break;
                }

                let Some(last) = contour.points.last().copied() else {
                    break;
                };
                let mut next = None;
                for (idx, segment) in segments.iter().enumerate() {
                    if used[idx] {
                        continue;
                    }

                    if Self::outline_points_close(last, segment.start, tolerance) {
                        next = Some((idx, false));
                        break;
                    }
                    if Self::outline_points_close(last, segment.end, tolerance) {
                        next = Some((idx, true));
                        break;
                    }
                }

                let Some((next_idx, reverse)) = next else {
                    break;
                };
                used[next_idx] = true;
                Self::append_outline_segment_to_region(
                    &mut contour,
                    &segments[next_idx],
                    reverse,
                    tolerance,
                );
            }
        }

        contours
    }

    fn outline_segment_to_region_contour(segment: &OutlineSegment, reverse: bool) -> RegionContour {
        let mut points = segment.points.clone();
        let mut region_segment = segment.segment.clone();
        if reverse {
            points.reverse();
            region_segment = Self::reverse_region_segment(&region_segment);
        }
        let has_arc = matches!(region_segment, RegionSegment::Arc { .. });

        RegionContour {
            points,
            segments: vec![region_segment],
            has_arc,
        }
    }

    fn append_outline_segment_to_region(
        contour: &mut RegionContour,
        segment: &OutlineSegment,
        reverse: bool,
        tolerance: f32,
    ) {
        let mut points = segment.points.clone();
        let mut region_segment = segment.segment.clone();
        if reverse {
            points.reverse();
            region_segment = Self::reverse_region_segment(&region_segment);
        }

        for point in points.into_iter().skip(1) {
            if contour
                .points
                .last()
                .is_none_or(|last| !Self::outline_points_close(*last, point, tolerance))
            {
                contour.points.push(point);
            }
        }

        if matches!(region_segment, RegionSegment::Arc { .. }) {
            contour.has_arc = true;
        }
        contour.segments.push(region_segment);
    }

    fn reverse_region_segment(segment: &RegionSegment) -> RegionSegment {
        match *segment {
            RegionSegment::Line { start, end } => RegionSegment::Line {
                start: end,
                end: start,
            },
            RegionSegment::Arc {
                start,
                end,
                center,
                radius,
                start_angle,
                sweep_angle,
            } => RegionSegment::Arc {
                start: end,
                end: start,
                center,
                radius,
                start_angle: start_angle + sweep_angle,
                sweep_angle: -sweep_angle,
            },
        }
    }

    fn normalize_outline_region_contour(
        mut contour: RegionContour,
        tolerance: f32,
    ) -> Option<RegionContour> {
        let mut points = Vec::with_capacity(contour.points.len().saturating_add(1));
        for point in contour.points {
            if !Self::finite_outline_point(point) {
                return None;
            }
            if points
                .last()
                .is_none_or(|last| !Self::outline_points_close(*last, point, tolerance))
            {
                points.push(point);
            }
        }

        if points.len() < 3 {
            return None;
        }

        if Self::outline_points_close(*points.first()?, *points.last()?, tolerance) {
            let first = *points.first()?;
            if let Some(last) = points.last_mut() {
                *last = first;
            }
        } else {
            points.push(*points.first()?);
        }

        if points.len() < 4 {
            return None;
        }

        let area = Self::outline_area(&points);
        if area.abs() <= tolerance * tolerance {
            return None;
        }

        contour.points = points;
        if area < 0.0 {
            contour.points.reverse();
            contour.segments = contour
                .segments
                .iter()
                .rev()
                .map(Self::reverse_region_segment)
                .collect();
        }
        contour.has_arc = contour
            .segments
            .iter()
            .any(|segment| matches!(segment, RegionSegment::Arc { .. }));

        Some(contour)
    }

    fn outline_regions_boundary(contours: &[RegionContour]) -> Option<Boundary> {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        for contour in contours {
            Self::include_outline_contour_boundary(
                contour, &mut min_x, &mut max_x, &mut min_y, &mut max_y,
            )?;
        }

        if min_x.is_finite() && max_x.is_finite() && min_y.is_finite() && max_y.is_finite() {
            Some(Boundary::new(min_x, max_x, min_y, max_y))
        } else {
            None
        }
    }

    fn include_outline_contour_boundary(
        contour: &RegionContour,
        min_x: &mut f32,
        max_x: &mut f32,
        min_y: &mut f32,
        max_y: &mut f32,
    ) -> Option<()> {
        for point in &contour.points {
            if !Self::finite_outline_point(*point) {
                return None;
            }
            *min_x = min_x.min(point[0]);
            *max_x = max_x.max(point[0]);
            *min_y = min_y.min(point[1]);
            *max_y = max_y.max(point[1]);
        }

        for segment in &contour.segments {
            if let RegionSegment::Arc {
                center,
                radius,
                start_angle,
                sweep_angle,
                ..
            } = *segment
            {
                let (arc_min_x, arc_max_x, arc_min_y, arc_max_y) =
                    arc_curve_bounds(center, radius, start_angle, sweep_angle);
                *min_x = min_x.min(arc_min_x);
                *max_x = max_x.max(arc_max_x);
                *min_y = min_y.min(arc_min_y);
                *max_y = max_y.max(arc_max_y);
            }
        }

        Some(())
    }

    fn outline_contour_is_closed(points: &[[f32; 2]], tolerance: f32) -> bool {
        points.len() >= 4
            && points
                .first()
                .zip(points.last())
                .is_some_and(|(first, last)| Self::outline_points_close(*first, *last, tolerance))
    }

    fn outline_close_tolerance(segments: &[OutlineSegment]) -> f32 {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        for segment in segments {
            for point in [segment.start, segment.end] {
                min_x = min_x.min(point[0]);
                max_x = max_x.max(point[0]);
                min_y = min_y.min(point[1]);
                max_y = max_y.max(point[1]);
            }
        }

        let extent = (max_x - min_x).abs().max((max_y - min_y).abs());
        (extent * 0.00001).max(0.0001)
    }

    fn outline_points_close(a: [f32; 2], b: [f32; 2], tolerance: f32) -> bool {
        (a[0] - b[0]).abs() <= tolerance && (a[1] - b[1]).abs() <= tolerance
    }

    fn finite_outline_point(point: [f32; 2]) -> bool {
        point[0].is_finite() && point[1].is_finite()
    }

    fn outline_area(points: &[[f32; 2]]) -> f32 {
        let mut area = 0.0;
        for idx in 0..points.len() {
            let next_idx = (idx + 1) % points.len();
            area += points[idx][0] * points[next_idx][1] - points[next_idx][0] * points[idx][1];
        }
        area * 0.5
    }

    /// Add a layer from a worker-produced render payload without rebuilding
    /// CPU-side GerberData geometry in the main WASM instance.
    pub fn add_layer_from_render_payload(&mut self, payload: &JsValue) -> Result<usize, JsValue> {
        let (width, height) = self.get_canvas_size()?;
        let sublayers = Array::from(&Self::js_property(payload, "sublayers")?);
        if sublayers.length() == 0 {
            return Err(JsValue::from_str("Layer does not contain any sublayers"));
        }

        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let sublayer_count =
            Self::checked_u32_to_usize("render payload sublayer count", sublayers.length())?;
        let mut gerber_data = Self::reserved_vec("render payload sublayers", sublayer_count)?;
        let mut buffer_caches = Self::reserved_vec("render payload buffer caches", sublayer_count)?;
        let mut needs_stencil = false;

        for sublayer in sublayers.iter() {
            let path_regions = Self::decode_path_region_metadata(&sublayer)?;
            needs_stencil |= path_regions.region_count() > 0;
            let boundary = match Self::decode_render_payload_boundary(&sublayer) {
                Ok(boundary) => boundary,
                Err(error) => {
                    Self::delete_buffer_caches(&self.gl, &mut buffer_caches);
                    return Err(error);
                }
            };

            min_x = min_x.min(boundary.min_x);
            max_x = max_x.max(boundary.max_x);
            min_y = min_y.min(boundary.min_y);
            max_y = max_y.max(boundary.max_y);

            let mut buffer_cache = BufferCache::default();
            let template_count = match self
                .populate_buffer_cache_from_render_payload(&mut buffer_cache, &sublayer)
            {
                Ok(template_count) => template_count,
                Err(error) => {
                    Self::delete_buffer_cache(&self.gl, buffer_cache);
                    Self::delete_buffer_caches(&self.gl, &mut buffer_caches);
                    return Err(error);
                }
            };
            buffer_caches.push(buffer_cache);
            gerber_data.push(Self::placeholder_gerber_data(
                boundary,
                Self::js_bool_property(&sublayer, "isNegative"),
                template_count,
                path_regions,
            ));
        }

        if !min_x.is_finite() || !max_x.is_finite() || !min_y.is_finite() || !max_y.is_finite() {
            return Err(JsValue::from_str("Layer boundary is not finite"));
        }

        let fbo = match Self::create_fbo(&self.gl, width, height, needs_stencil) {
            Ok(fbo) => fbo,
            Err(error) => {
                Self::delete_buffer_caches(&self.gl, &mut buffer_caches);
                return Err(error);
            }
        };

        let layer_metadata = LayerMetadata {
            gerber_data,
            fbo,
            buffer_caches,
            boundary: Boundary::new(min_x, max_x, min_y, max_y),
            fbo_dirty: true,
            fbo_transform: None,
            inner_outline_pixels: 0.0,
            inner_outline_world: 0.0,
            cpu_geometry_released: true,
            has_path_regions: needs_stencil,
        };

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

    fn decode_render_payload_boundary(sublayer: &JsValue) -> Result<Boundary, JsValue> {
        let boundary_payload = Self::js_property(sublayer, "boundary")?;
        let boundary = Boundary::new(
            Self::js_f32_property(&boundary_payload, "minX")?,
            Self::js_f32_property(&boundary_payload, "maxX")?,
            Self::js_f32_property(&boundary_payload, "minY")?,
            Self::js_f32_property(&boundary_payload, "maxY")?,
        );
        Self::validate_finite_value("boundary.min_x", boundary.min_x)?;
        Self::validate_finite_value("boundary.max_x", boundary.max_x)?;
        Self::validate_finite_value("boundary.min_y", boundary.min_y)?;
        Self::validate_finite_value("boundary.max_y", boundary.max_y)?;
        Ok(boundary)
    }

    fn placeholder_gerber_data(
        boundary: Boundary,
        is_negative: bool,
        template_count: usize,
        path_regions: PathRegions,
    ) -> GerberData {
        GerberData::new(
            Triangles::new(Vec::new(), Vec::new(), Vec::new(), Vec::new()),
            (0..template_count)
                .map(|_| TriangleTemplateInstances::new(Vec::new(), Vec::new(), Vec::new()))
                .collect(),
            Lines::new(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()),
            Circles::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Arcs::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Thermals::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            path_regions,
            boundary,
            is_negative,
        )
    }

    fn populate_buffer_cache_from_render_payload(
        &self,
        buffer_cache: &mut BufferCache,
        sublayer: &JsValue,
    ) -> Result<usize, JsValue> {
        self.populate_triangle_cache_from_payload(buffer_cache, sublayer)?;
        let template_count =
            self.populate_triangle_template_cache_from_payload(buffer_cache, sublayer)?;
        self.populate_line_cache_from_payload(buffer_cache, sublayer)?;
        self.populate_circle_cache_from_payload(buffer_cache, sublayer)?;
        self.populate_arc_cache_from_payload(buffer_cache, sublayer)?;
        self.populate_thermal_cache_from_payload(buffer_cache, sublayer)?;
        self.populate_path_region_cache_from_payload(buffer_cache, sublayer)?;
        Ok(template_count)
    }

    fn populate_triangle_cache_from_payload(
        &self,
        buffer_cache: &mut BufferCache,
        sublayer: &JsValue,
    ) -> Result<(), JsValue> {
        let triangles = Self::js_property(sublayer, "triangles")?;
        let vertices = Self::js_f32_array(&triangles, "vertices")?;
        if vertices.length() == 0 {
            return Ok(());
        }

        let vertex_count = Self::validate_triangle_vertex_array("triangle vertices", &vertices)?;
        Self::validate_js_finite_array("triangle vertices", &vertices)?;
        let vao = self
            .gl
            .create_vertex_array()
            .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
        self.gl.bind_vertex_array(Some(&vao));
        buffer_cache.triangle_vao = Some(vao);
        buffer_cache.triangle_vertex_count = vertex_count;
        let vertex_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &vertices,
            &self.programs.triangle,
            "position",
            2,
            0,
        )?;
        buffer_cache.triangle_vertex_buffer = Some(vertex_buffer);

        let hole_radius = Self::js_f32_array(&triangles, "holeRadius")?;
        if hole_radius.length() == 0 {
            Self::use_constant_vertex_attrib_1f(
                &self.gl,
                &self.programs.triangle,
                "hole_x_instance",
                0.0,
            )?;
            Self::use_constant_vertex_attrib_1f(
                &self.gl,
                &self.programs.triangle,
                "hole_y_instance",
                0.0,
            )?;
            Self::use_constant_vertex_attrib_1f(
                &self.gl,
                &self.programs.triangle,
                "hole_radius_instance",
                0.0,
            )?;
        } else {
            let hole_x = Self::js_f32_array(&triangles, "holeX")?;
            let hole_y = Self::js_f32_array(&triangles, "holeY")?;
            Self::validate_js_array_len("triangle hole_x", &hole_x, vertex_count as u32)?;
            Self::validate_js_array_len("triangle hole_y", &hole_y, vertex_count as u32)?;
            Self::validate_js_array_len("triangle hole_radius", &hole_radius, vertex_count as u32)?;
            Self::validate_js_finite_array("triangle hole_x", &hole_x)?;
            Self::validate_js_finite_array("triangle hole_y", &hole_y)?;
            Self::validate_js_non_negative_array("triangle hole_radius", &hole_radius)?;
            buffer_cache.triangle_hole_x_buffer = Some(Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &hole_x,
                &self.programs.triangle,
                "hole_x_instance",
                1,
                0,
            )?);
            buffer_cache.triangle_hole_y_buffer = Some(Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &hole_y,
                &self.programs.triangle,
                "hole_y_instance",
                1,
                0,
            )?);
            buffer_cache.triangle_hole_radius_buffer =
                Some(Self::create_attrib_buffer_from_js_array(
                    &self.gl,
                    &hole_radius,
                    &self.programs.triangle,
                    "hole_radius_instance",
                    1,
                    0,
                )?);
        }

        self.gl.bind_vertex_array(None);
        Ok(())
    }

    fn populate_triangle_template_cache_from_payload(
        &self,
        buffer_cache: &mut BufferCache,
        sublayer: &JsValue,
    ) -> Result<usize, JsValue> {
        let templates = Array::from(&Self::js_property(sublayer, "triangleTemplates")?);
        let template_count = templates.length() as usize;
        buffer_cache
            .triangle_template_caches
            .resize_with(template_count, TriangleTemplateBufferCache::default);

        for (template_idx, template) in templates.iter().enumerate() {
            let vertices = Self::js_f32_array(&template, "vertices")?;
            let instance_x = Self::js_f32_array(&template, "instanceX")?;
            let instance_y = Self::js_f32_array(&template, "instanceY")?;
            if vertices.length() == 0 || instance_x.length() == 0 {
                continue;
            }

            let vertex_count =
                Self::validate_triangle_vertex_array("triangle template vertices", &vertices)?;
            let instance_count =
                Self::validate_instance_array("triangle template instances", &instance_x)?;
            Self::validate_js_array_len(
                "triangle template instance_y",
                &instance_y,
                instance_count as u32,
            )?;
            Self::validate_js_finite_array("triangle template vertices", &vertices)?;
            Self::validate_js_finite_array("triangle template instance_x", &instance_x)?;
            Self::validate_js_finite_array("triangle template instance_y", &instance_y)?;

            let vao = self
                .gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
            self.gl.bind_vertex_array(Some(&vao));
            let template_cache = &mut buffer_cache.triangle_template_caches[template_idx];
            template_cache.vao = Some(vao);
            template_cache.vertex_count = vertex_count;
            template_cache.instance_count = instance_count;
            let vertex_buffer = Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &vertices,
                &self.programs.triangle_template,
                "position",
                2,
                0,
            )?;
            template_cache.vertex_buffer = Some(vertex_buffer);
            let instance_x_buffer = Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &instance_x,
                &self.programs.triangle_template,
                "instance_x",
                1,
                1,
            )?;
            template_cache.instance_x_buffer = Some(instance_x_buffer);
            let instance_y_buffer = Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &instance_y,
                &self.programs.triangle_template,
                "instance_y",
                1,
                1,
            )?;
            template_cache.instance_y_buffer = Some(instance_y_buffer);
            self.gl.bind_vertex_array(None);
        }

        Ok(template_count)
    }

    fn populate_line_cache_from_payload(
        &self,
        buffer_cache: &mut BufferCache,
        sublayer: &JsValue,
    ) -> Result<(), JsValue> {
        let lines = Self::js_property(sublayer, "lines")?;
        let start_x = Self::js_f32_array(&lines, "startX")?;
        if start_x.length() == 0 {
            return Ok(());
        }

        let instance_count = Self::validate_instance_array("line instances", &start_x)?;
        let start_y = Self::js_f32_array(&lines, "startY")?;
        let end_x = Self::js_f32_array(&lines, "endX")?;
        let end_y = Self::js_f32_array(&lines, "endY")?;
        let width = Self::js_f32_array(&lines, "width")?;
        Self::validate_js_array_len("line start_y", &start_y, instance_count as u32)?;
        Self::validate_js_array_len("line end_x", &end_x, instance_count as u32)?;
        Self::validate_js_array_len("line end_y", &end_y, instance_count as u32)?;
        Self::validate_js_array_len("line width", &width, instance_count as u32)?;
        Self::validate_js_finite_array("line start_x", &start_x)?;
        Self::validate_js_finite_array("line start_y", &start_y)?;
        Self::validate_js_finite_array("line end_x", &end_x)?;
        Self::validate_js_finite_array("line end_y", &end_y)?;
        Self::validate_js_non_negative_array("line width", &width)?;

        let vao = self
            .gl
            .create_vertex_array()
            .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
        self.gl.bind_vertex_array(Some(&vao));
        buffer_cache.line_vao = Some(vao);
        buffer_cache.line_instance_count = instance_count;
        self.bind_quad_position(&self.programs.line)?;
        buffer_cache.line_start_x_buffer = Some(Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &start_x,
            &self.programs.line,
            "start_x_instance",
            1,
            1,
        )?);
        buffer_cache.line_start_y_buffer = Some(Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &start_y,
            &self.programs.line,
            "start_y_instance",
            1,
            1,
        )?);
        buffer_cache.line_end_x_buffer = Some(Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &end_x,
            &self.programs.line,
            "end_x_instance",
            1,
            1,
        )?);
        buffer_cache.line_end_y_buffer = Some(Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &end_y,
            &self.programs.line,
            "end_y_instance",
            1,
            1,
        )?);
        buffer_cache.line_width_buffer = Some(Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &width,
            &self.programs.line,
            "width_instance",
            1,
            1,
        )?);

        self.gl.bind_vertex_array(None);
        Ok(())
    }

    fn populate_circle_cache_from_payload(
        &self,
        buffer_cache: &mut BufferCache,
        sublayer: &JsValue,
    ) -> Result<(), JsValue> {
        let circles = Self::js_property(sublayer, "circles")?;
        let x = Self::js_f32_array(&circles, "x")?;
        if x.length() == 0 {
            return Ok(());
        }

        let y = Self::js_f32_array(&circles, "y")?;
        let radius = Self::js_f32_array(&circles, "radius")?;
        let instance_count = Self::validate_instance_array("circle", &x)?;
        Self::validate_js_array_len("circle y", &y, instance_count as u32)?;
        Self::validate_js_array_len("circle radius", &radius, instance_count as u32)?;
        Self::validate_js_finite_array("circle x", &x)?;
        Self::validate_js_finite_array("circle y", &y)?;
        Self::validate_js_non_negative_array("circle radius", &radius)?;
        let hole_radius = Self::js_f32_array(&circles, "holeRadius")?;
        let has_holes = hole_radius.length() > 0;
        let program = if has_holes {
            &self.programs.circle_holed
        } else {
            &self.programs.circle
        };

        let vao = self
            .gl
            .create_vertex_array()
            .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
        self.gl.bind_vertex_array(Some(&vao));
        buffer_cache.circle_vao = Some(vao);
        buffer_cache.circle_instance_count = instance_count;
        self.bind_quad_position(program)?;
        let center_x_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &x,
            program,
            "center_x_instance",
            1,
            1,
        )?;
        buffer_cache.circle_center_x_buffer = Some(center_x_buffer);
        let center_y_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &y,
            program,
            "center_y_instance",
            1,
            1,
        )?;
        buffer_cache.circle_center_y_buffer = Some(center_y_buffer);
        let radius_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &radius,
            program,
            "radius_instance",
            1,
            1,
        )?;
        buffer_cache.circle_radius_buffer = Some(radius_buffer);

        if has_holes {
            let hole_x = Self::js_f32_array(&circles, "holeX")?;
            let hole_y = Self::js_f32_array(&circles, "holeY")?;
            Self::validate_js_array_len("circle hole_x", &hole_x, instance_count as u32)?;
            Self::validate_js_array_len("circle hole_y", &hole_y, instance_count as u32)?;
            Self::validate_js_array_len("circle hole_radius", &hole_radius, instance_count as u32)?;
            Self::validate_js_finite_array("circle hole_x", &hole_x)?;
            Self::validate_js_finite_array("circle hole_y", &hole_y)?;
            Self::validate_js_non_negative_array("circle hole_radius", &hole_radius)?;
            buffer_cache.circle_hole_x_buffer = Some(Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &hole_x,
                program,
                "hole_x_instance",
                1,
                1,
            )?);
            buffer_cache.circle_hole_y_buffer = Some(Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &hole_y,
                program,
                "hole_y_instance",
                1,
                1,
            )?);
            buffer_cache.circle_hole_radius_buffer =
                Some(Self::create_attrib_buffer_from_js_array(
                    &self.gl,
                    &hole_radius,
                    program,
                    "hole_radius_instance",
                    1,
                    1,
                )?);
        }

        self.gl.bind_vertex_array(None);
        Ok(())
    }

    fn populate_arc_cache_from_payload(
        &self,
        buffer_cache: &mut BufferCache,
        sublayer: &JsValue,
    ) -> Result<(), JsValue> {
        let arcs = Self::js_property(sublayer, "arcs")?;
        let x = Self::js_f32_array(&arcs, "x")?;
        if x.length() == 0 {
            return Ok(());
        }

        let y = Self::js_f32_array(&arcs, "y")?;
        let radius = Self::js_f32_array(&arcs, "radius")?;
        let start_angle = Self::js_f32_array(&arcs, "startAngle")?;
        let sweep_angle = Self::js_f32_array(&arcs, "sweepAngle")?;
        let thickness = Self::js_f32_array(&arcs, "thickness")?;
        let instance_count = Self::validate_instance_array("arc", &x)?;
        Self::validate_js_array_len("arc y", &y, instance_count as u32)?;
        Self::validate_js_array_len("arc radius", &radius, instance_count as u32)?;
        Self::validate_js_array_len("arc start_angle", &start_angle, instance_count as u32)?;
        Self::validate_js_array_len("arc sweep_angle", &sweep_angle, instance_count as u32)?;
        Self::validate_js_array_len("arc thickness", &thickness, instance_count as u32)?;
        Self::validate_js_finite_array("arc x", &x)?;
        Self::validate_js_finite_array("arc y", &y)?;
        Self::validate_js_non_negative_array("arc radius", &radius)?;
        Self::validate_js_finite_array("arc start_angle", &start_angle)?;
        Self::validate_js_finite_array("arc sweep_angle", &sweep_angle)?;
        Self::validate_js_non_negative_array("arc thickness", &thickness)?;

        let vao = self
            .gl
            .create_vertex_array()
            .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
        self.gl.bind_vertex_array(Some(&vao));
        buffer_cache.arc_vao = Some(vao);
        buffer_cache.arc_instance_count = instance_count;
        self.bind_quad_position(&self.programs.arc)?;
        let center_x_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &x,
            &self.programs.arc,
            "center_x_instance",
            1,
            1,
        )?;
        buffer_cache.arc_center_x_buffer = Some(center_x_buffer);
        let center_y_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &y,
            &self.programs.arc,
            "center_y_instance",
            1,
            1,
        )?;
        buffer_cache.arc_center_y_buffer = Some(center_y_buffer);
        let radius_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &radius,
            &self.programs.arc,
            "radius_instance",
            1,
            1,
        )?;
        buffer_cache.arc_radius_buffer = Some(radius_buffer);
        let start_angle_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &start_angle,
            &self.programs.arc,
            "startAngle_instance",
            1,
            1,
        )?;
        buffer_cache.arc_start_angle_buffer = Some(start_angle_buffer);
        let sweep_angle_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &sweep_angle,
            &self.programs.arc,
            "sweepAngle_instance",
            1,
            1,
        )?;
        buffer_cache.arc_sweep_angle_buffer = Some(sweep_angle_buffer);
        let thickness_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &thickness,
            &self.programs.arc,
            "thickness_instance",
            1,
            1,
        )?;
        buffer_cache.arc_thickness_buffer = Some(thickness_buffer);

        self.gl.bind_vertex_array(None);
        Ok(())
    }

    fn populate_thermal_cache_from_payload(
        &self,
        buffer_cache: &mut BufferCache,
        sublayer: &JsValue,
    ) -> Result<(), JsValue> {
        let thermals = Self::js_property(sublayer, "thermals")?;
        let x = Self::js_f32_array(&thermals, "x")?;
        if x.length() == 0 {
            return Ok(());
        }

        let y = Self::js_f32_array(&thermals, "y")?;
        let outer_diameter = Self::js_f32_array(&thermals, "outerDiameter")?;
        let inner_diameter = Self::js_f32_array(&thermals, "innerDiameter")?;
        let gap_thickness = Self::js_f32_array(&thermals, "gapThickness")?;
        let rotation = Self::js_f32_array(&thermals, "rotation")?;
        let instance_count = Self::validate_instance_array("thermal", &x)?;
        Self::validate_js_array_len("thermal y", &y, instance_count as u32)?;
        Self::validate_js_array_len(
            "thermal outer_diameter",
            &outer_diameter,
            instance_count as u32,
        )?;
        Self::validate_js_array_len(
            "thermal inner_diameter",
            &inner_diameter,
            instance_count as u32,
        )?;
        Self::validate_js_array_len(
            "thermal gap_thickness",
            &gap_thickness,
            instance_count as u32,
        )?;
        Self::validate_js_array_len("thermal rotation", &rotation, instance_count as u32)?;
        Self::validate_js_finite_array("thermal x", &x)?;
        Self::validate_js_finite_array("thermal y", &y)?;
        Self::validate_js_non_negative_array("thermal outer_diameter", &outer_diameter)?;
        Self::validate_js_non_negative_array("thermal inner_diameter", &inner_diameter)?;
        Self::validate_js_non_negative_array("thermal gap_thickness", &gap_thickness)?;
        Self::validate_js_finite_array("thermal rotation", &rotation)?;

        let vao = self
            .gl
            .create_vertex_array()
            .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
        self.gl.bind_vertex_array(Some(&vao));
        buffer_cache.thermal_vao = Some(vao);
        buffer_cache.thermal_instance_count = instance_count;
        self.bind_quad_position(&self.programs.thermal)?;
        let center_x_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &x,
            &self.programs.thermal,
            "center_x_instance",
            1,
            1,
        )?;
        buffer_cache.thermal_center_x_buffer = Some(center_x_buffer);
        let center_y_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &y,
            &self.programs.thermal,
            "center_y_instance",
            1,
            1,
        )?;
        buffer_cache.thermal_center_y_buffer = Some(center_y_buffer);
        let outer_diameter_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &outer_diameter,
            &self.programs.thermal,
            "outer_diameter_instance",
            1,
            1,
        )?;
        buffer_cache.thermal_outer_diameter_buffer = Some(outer_diameter_buffer);
        let inner_diameter_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &inner_diameter,
            &self.programs.thermal,
            "inner_diameter_instance",
            1,
            1,
        )?;
        buffer_cache.thermal_inner_diameter_buffer = Some(inner_diameter_buffer);
        let gap_thickness_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &gap_thickness,
            &self.programs.thermal,
            "gap_thickness_instance",
            1,
            1,
        )?;
        buffer_cache.thermal_gap_thickness_buffer = Some(gap_thickness_buffer);
        let rotation_buffer = Self::create_attrib_buffer_from_js_array(
            &self.gl,
            &rotation,
            &self.programs.thermal,
            "rotation_instance",
            1,
            1,
        )?;
        buffer_cache.thermal_rotation_buffer = Some(rotation_buffer);

        self.gl.bind_vertex_array(None);
        Ok(())
    }

    fn decode_path_region_metadata(sublayer: &JsValue) -> Result<PathRegions, JsValue> {
        let path_regions = Self::js_property(sublayer, "pathRegions")?;
        let wedge_vertices = Self::js_f32_array(&path_regions, "wedgeVertices")?;
        let sector_vertices = Self::js_f32_array(&path_regions, "sectorVertices")?;
        let cover_vertices = Self::js_f32_array(&path_regions, "coverVertices")?;
        let clear_vertices = Self::js_f32_array(&path_regions, "clearVertices")?;
        if cover_vertices.length() % 12 != 0 {
            return Err(JsValue::from_str(
                "path region cover vertex buffer length must be a multiple of 12",
            ));
        }
        if clear_vertices.length() % 12 != 0 {
            return Err(JsValue::from_str(
                "path region clear vertex buffer length must be a multiple of 12",
            ));
        }
        let region_count = (cover_vertices.length() / 12) as usize;
        if clear_vertices.length() / 12 != cover_vertices.length() / 12 {
            return Err(JsValue::from_str(
                "path region clear vertex count must match cover vertex count",
            ));
        }
        let wedge_offsets = Self::js_u32_array(&path_regions, "wedgeVertexOffsets")?.to_vec();
        let sector_offsets = Self::js_u32_array(&path_regions, "sectorVertexOffsets")?.to_vec();
        Self::validate_len(
            "path wedge offsets",
            0,
            wedge_offsets.len(),
            region_count + 1,
        )?;
        Self::validate_len(
            "path sector offsets",
            0,
            sector_offsets.len(),
            region_count + 1,
        )?;
        Self::validate_offsets(
            "path wedge offsets",
            0,
            &wedge_offsets,
            (wedge_vertices.length() / 2) as usize,
        )?;
        Self::validate_offsets(
            "path sector offsets",
            0,
            &sector_offsets,
            (sector_vertices.length() / 7) as usize,
        )?;
        Ok(PathRegions::new(
            Vec::new(),
            wedge_offsets,
            Vec::new(),
            sector_offsets,
            Vec::new(),
            Vec::new(),
        ))
    }

    fn populate_path_region_cache_from_payload(
        &self,
        buffer_cache: &mut BufferCache,
        sublayer: &JsValue,
    ) -> Result<(), JsValue> {
        let path_regions = Self::js_property(sublayer, "pathRegions")?;
        let wedge_vertices = Self::js_f32_array(&path_regions, "wedgeVertices")?;
        let sector_vertices = Self::js_f32_array(&path_regions, "sectorVertices")?;
        let cover_vertices = Self::js_f32_array(&path_regions, "coverVertices")?;
        let clear_vertices = Self::js_f32_array(&path_regions, "clearVertices")?;

        if wedge_vertices.length() > 0 {
            if wedge_vertices.length() % 2 != 0 {
                return Err(JsValue::from_str(
                    "path region wedge vertex buffer has an odd coordinate count",
                ));
            }
            Self::validate_js_finite_array("path region wedge vertices", &wedge_vertices)?;
            let vao = self
                .gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create path wedge VAO"))?;
            self.gl.bind_vertex_array(Some(&vao));
            let buffer = Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &wedge_vertices,
                &self.programs.path_solid,
                "position",
                2,
                0,
            )?;
            buffer_cache.path_wedge_vao = Some(vao);
            buffer_cache.path_wedge_vertex_count = Self::checked_u32_to_i32(
                "path region wedge vertex count",
                wedge_vertices.length() / 2,
            )?;
            buffer_cache.path_wedge_vertex_buffer = Some(buffer);
            self.gl.bind_vertex_array(None);
        }

        if sector_vertices.length() > 0 {
            if sector_vertices.length() % 7 != 0 {
                return Err(JsValue::from_str(
                    "path region arc sector buffer length must be a multiple of 7",
                ));
            }
            Self::validate_js_finite_array("path region arc sector vertices", &sector_vertices)?;
            let vao = self
                .gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create path sector VAO"))?;
            self.gl.bind_vertex_array(Some(&vao));
            let buffer = self.create_path_sector_buffer(&sector_vertices)?;
            buffer_cache.path_sector_vao = Some(vao);
            buffer_cache.path_sector_vertex_count = Self::checked_u32_to_i32(
                "path region sector vertex count",
                sector_vertices.length() / 7,
            )?;
            buffer_cache.path_sector_vertex_buffer = Some(buffer);
            self.gl.bind_vertex_array(None);
        }

        if cover_vertices.length() > 0 {
            if cover_vertices.length() % 2 != 0 {
                return Err(JsValue::from_str(
                    "path region cover vertex buffer has an odd coordinate count",
                ));
            }
            Self::validate_js_finite_array("path region cover vertices", &cover_vertices)?;
            let vao = self
                .gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create path cover VAO"))?;
            self.gl.bind_vertex_array(Some(&vao));
            let buffer = Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &cover_vertices,
                &self.programs.path_solid,
                "position",
                2,
                0,
            )?;
            buffer_cache.path_cover_vao = Some(vao);
            buffer_cache.path_cover_vertex_count = Self::checked_u32_to_i32(
                "path region cover vertex count",
                cover_vertices.length() / 2,
            )?;
            buffer_cache.path_cover_vertex_buffer = Some(buffer);
            self.gl.bind_vertex_array(None);
        }

        if clear_vertices.length() > 0 {
            if clear_vertices.length() % 2 != 0 {
                return Err(JsValue::from_str(
                    "path region clear vertex buffer has an odd coordinate count",
                ));
            }
            Self::validate_js_finite_array("path region clear vertices", &clear_vertices)?;
            let vao = self
                .gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create path clear VAO"))?;
            self.gl.bind_vertex_array(Some(&vao));
            let buffer = Self::create_attrib_buffer_from_js_array(
                &self.gl,
                &clear_vertices,
                &self.programs.path_solid,
                "position",
                2,
                0,
            )?;
            buffer_cache.path_clear_vao = Some(vao);
            buffer_cache.path_clear_vertex_count = Self::checked_u32_to_i32(
                "path region clear vertex count",
                clear_vertices.length() / 2,
            )?;
            buffer_cache.path_clear_vertex_buffer = Some(buffer);
            self.gl.bind_vertex_array(None);
        }

        Ok(())
    }

    fn create_path_sector_buffer(&self, data: &Float32Array) -> Result<WebGlBuffer, JsValue> {
        let buffer = self
            .gl
            .create_buffer()
            .ok_or_else(|| JsValue::from_str("Failed to create path sector buffer"))?;
        self.gl.bind_buffer(ARRAY_BUFFER, Some(&buffer));
        Self::upload_float_array_to_bound_buffer(&self.gl, data);

        let stride = 7 * 4;
        self.enable_path_sector_attribute("position", 2, stride, 0)?;
        self.enable_path_sector_attribute("center", 2, stride, 2 * 4)?;
        self.enable_path_sector_attribute("radius", 1, stride, 4 * 4)?;
        self.enable_path_sector_attribute("startAngle", 1, stride, 5 * 4)?;
        self.enable_path_sector_attribute("sweepAngle", 1, stride, 6 * 4)?;
        Ok(buffer)
    }

    fn enable_path_sector_attribute(
        &self,
        attr_name: &str,
        components: i32,
        stride: i32,
        offset: i32,
    ) -> Result<(), JsValue> {
        let loc = Self::shader_attribute(&self.programs.path_sector, attr_name)?;
        self.gl.enable_vertex_attrib_array(loc);
        self.gl
            .vertex_attrib_pointer_with_i32(loc, components, FLOAT, false, stride, offset);
        Ok(())
    }

    fn create_attrib_buffer_from_js_array(
        gl: &WebGl2RenderingContext,
        data: &Float32Array,
        program: &ShaderProgram,
        attr_name: &str,
        components: i32,
        divisor: u32,
    ) -> Result<WebGlBuffer, JsValue> {
        let buffer = gl
            .create_buffer()
            .ok_or_else(|| JsValue::from_str("Failed to create buffer"))?;
        gl.bind_buffer(ARRAY_BUFFER, Some(&buffer));
        Self::upload_float_array_to_bound_buffer(gl, data);
        let loc = match Self::shader_attribute(program, attr_name) {
            Ok(loc) => loc,
            Err(error) => {
                gl.delete_buffer(Some(&buffer));
                return Err(error);
            }
        };
        gl.enable_vertex_attrib_array(loc);
        gl.vertex_attrib_pointer_with_i32(loc, components, FLOAT, false, 0, 0);
        gl.vertex_attrib_divisor(loc, divisor);
        Ok(buffer)
    }

    fn bind_quad_position(&self, program: &ShaderProgram) -> Result<(), JsValue> {
        self.gl.bind_buffer(ARRAY_BUFFER, Some(&self.quad_buffer));
        let position_loc = Self::shader_attribute(program, "position")?;
        self.gl.enable_vertex_attrib_array(position_loc);
        self.gl
            .vertex_attrib_pointer_with_i32(position_loc, 2, FLOAT, false, 0, 0);
        Ok(())
    }

    fn checked_usize_to_i32(label: &str, value: usize) -> Result<i32, JsValue> {
        i32::try_from(value)
            .map_err(|_| JsValue::from_str(&format!("{label} exceeds WebGL draw limits")))
    }

    fn checked_u32_to_i32(label: &str, value: u32) -> Result<i32, JsValue> {
        i32::try_from(value)
            .map_err(|_| JsValue::from_str(&format!("{label} exceeds WebGL draw limits")))
    }

    fn checked_u32_to_usize(label: &str, value: u32) -> Result<usize, JsValue> {
        usize::try_from(value)
            .map_err(|_| JsValue::from_str(&format!("{label} exceeds platform limits")))
    }

    fn reserved_vec<T>(label: &str, capacity: usize) -> Result<Vec<T>, JsValue> {
        let mut values = Vec::new();
        values
            .try_reserve(capacity)
            .map_err(|_| JsValue::from_str(&format!("Unable to reserve memory for {label}")))?;
        Ok(values)
    }

    fn checked_path_region_quad_start(region_idx: usize) -> Result<i32, JsValue> {
        let start = region_idx.checked_mul(6).ok_or_else(|| {
            JsValue::from_str("path region cover vertex start overflows WebGL draw limits")
        })?;
        Self::checked_usize_to_i32("path region cover vertex start", start)
    }

    fn validate_triangle_vertex_array(label: &str, values: &Float32Array) -> Result<i32, JsValue> {
        if !values.length().is_multiple_of(2) {
            return Err(JsValue::from_str(&format!(
                "{} buffer has an odd number of coordinates",
                label
            )));
        }
        let vertex_count = values.length() / 2;
        if !vertex_count.is_multiple_of(3) {
            return Err(JsValue::from_str(&format!(
                "{} count is not divisible by 3",
                label
            )));
        }
        if vertex_count > i32::MAX as u32 {
            return Err(JsValue::from_str(&format!(
                "{} count exceeds WebGL draw limits",
                label
            )));
        }
        Self::checked_u32_to_i32(label, vertex_count)
    }

    fn set_view_feature_uniforms(
        &self,
        program: &ShaderProgram,
        viewport_width: u32,
        viewport_height: u32,
        inner_outline_pixels: f32,
        inner_outline_world: f32,
    ) {
        if let Some(loc) = program.uniforms.get("viewport_size") {
            self.gl.uniform2f(
                Some(loc),
                viewport_width.max(1) as f32,
                viewport_height.max(1) as f32,
            );
        }
        if let Some(loc) = program.uniforms.get("minimum_feature_pixels") {
            self.gl.uniform1f(Some(loc), self.minimum_feature_pixels);
        }
        if let Some(loc) = program.uniforms.get("inner_outline_pixels") {
            self.gl.uniform1f(Some(loc), inner_outline_pixels);
        }
        if let Some(loc) = program.uniforms.get("inner_outline_world") {
            self.gl.uniform1f(Some(loc), inner_outline_world);
        }
    }

    fn validate_instance_array(label: &str, values: &Float32Array) -> Result<i32, JsValue> {
        if values.length() > i32::MAX as u32 {
            return Err(JsValue::from_str(&format!(
                "{} count exceeds WebGL draw limits",
                label
            )));
        }
        Self::checked_u32_to_i32(label, values.length())
    }

    fn validate_js_array_len(
        label: &str,
        values: &Float32Array,
        expected: u32,
    ) -> Result<(), JsValue> {
        if values.length() != expected {
            return Err(JsValue::from_str(&format!(
                "{} length mismatch: expected {}, got {}",
                label,
                expected,
                values.length()
            )));
        }
        Ok(())
    }

    fn js_property(value: &JsValue, key: &str) -> Result<JsValue, JsValue> {
        let property = Reflect::get(value, &JsValue::from_str(key))
            .map_err(|_| JsValue::from_str(&format!("Missing render payload field `{key}`")))?;
        if property.is_undefined() || property.is_null() {
            return Err(JsValue::from_str(&format!(
                "Missing render payload field `{key}`"
            )));
        }
        Ok(property)
    }

    fn js_f32_array(value: &JsValue, key: &str) -> Result<Float32Array, JsValue> {
        Self::js_property(value, key)?
            .dyn_into::<Float32Array>()
            .map_err(|_| {
                JsValue::from_str(&format!(
                    "Render payload field `{key}` must be a Float32Array"
                ))
            })
    }

    fn js_u32_array(value: &JsValue, key: &str) -> Result<Uint32Array, JsValue> {
        Self::js_property(value, key)?
            .dyn_into::<Uint32Array>()
            .map_err(|_| {
                JsValue::from_str(&format!(
                    "Render payload field `{key}` must be a Uint32Array"
                ))
            })
    }

    fn js_f32_property(value: &JsValue, key: &str) -> Result<f32, JsValue> {
        let number = Self::js_property(value, key)?.as_f64().ok_or_else(|| {
            JsValue::from_str(&format!("Render payload field `{key}` is not numeric"))
        })?;
        Ok(number as f32)
    }

    fn js_bool_property(value: &JsValue, key: &str) -> bool {
        Self::js_property(value, key)
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
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
        Self::validate_triangle_template_data(&data.triangle_templates, sublayer_idx)?;
        Self::validate_line_data(&data.lines, sublayer_idx)?;
        Self::validate_circle_data(&data.circles, sublayer_idx)?;
        Self::validate_arc_data(&data.arcs, sublayer_idx)?;
        Self::validate_thermal_data(&data.thermals, sublayer_idx)?;
        Self::validate_path_region_data(&data.path_regions, sublayer_idx)?;
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

    fn validate_triangle_template_data(
        templates: &[TriangleTemplateInstances],
        sublayer_idx: usize,
    ) -> Result<(), JsValue> {
        for (template_idx, template) in templates.iter().enumerate() {
            if !template.vertices.len().is_multiple_of(2) {
                return Err(JsValue::from_str(&format!(
                    "Sublayer {} triangle template {} vertex buffer has an odd number of coordinates",
                    sublayer_idx, template_idx
                )));
            }
            let vertex_count = template.vertices.len() / 2;
            if !vertex_count.is_multiple_of(3) {
                return Err(JsValue::from_str(&format!(
                    "Sublayer {} triangle template {} vertex count is not divisible by 3",
                    sublayer_idx, template_idx
                )));
            }
            let instance_count = template.instance_x.len();
            Self::validate_instance_count("triangle template", sublayer_idx, instance_count)?;
            Self::validate_len(
                "triangle template instance_y",
                sublayer_idx,
                template.instance_y.len(),
                instance_count,
            )?;
            Self::validate_finite_slice("triangle template vertices", &template.vertices)?;
            Self::validate_finite_slice("triangle template instance_x", &template.instance_x)?;
            Self::validate_finite_slice("triangle template instance_y", &template.instance_y)?;

            if vertex_count > i32::MAX as usize {
                return Err(JsValue::from_str(&format!(
                    "Sublayer {} triangle template {} vertex count exceeds WebGL draw limits",
                    sublayer_idx, template_idx
                )));
            }
        }

        Ok(())
    }

    fn validate_line_data(lines: &Lines, sublayer_idx: usize) -> Result<(), JsValue> {
        let count = lines.start_x.len();
        Self::validate_instance_count("line", sublayer_idx, count)?;
        Self::validate_len("line start_y", sublayer_idx, lines.start_y.len(), count)?;
        Self::validate_len("line end_x", sublayer_idx, lines.end_x.len(), count)?;
        Self::validate_len("line end_y", sublayer_idx, lines.end_y.len(), count)?;
        Self::validate_len("line width", sublayer_idx, lines.width.len(), count)?;
        Self::validate_finite_slice("line start_x", &lines.start_x)?;
        Self::validate_finite_slice("line start_y", &lines.start_y)?;
        Self::validate_finite_slice("line end_x", &lines.end_x)?;
        Self::validate_finite_slice("line end_y", &lines.end_y)?;
        Self::validate_non_negative_slice("line width", &lines.width)?;
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

    fn validate_path_region_data(
        path_regions: &PathRegions,
        sublayer_idx: usize,
    ) -> Result<(), JsValue> {
        if !path_regions.wedge_vertices.len().is_multiple_of(2) {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} path wedge vertex buffer has an odd number of coordinates",
                sublayer_idx
            )));
        }
        let wedge_vertex_count = path_regions.wedge_vertices.len() / 2;
        if !wedge_vertex_count.is_multiple_of(3) {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} path wedge vertex count is not divisible by 3",
                sublayer_idx
            )));
        }
        Self::checked_usize_to_i32(
            &format!("Sublayer {} path wedge vertex count", sublayer_idx),
            wedge_vertex_count,
        )?;
        if !path_regions.sector_vertices.len().is_multiple_of(7) {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} path sector vertex buffer length is not divisible by 7",
                sublayer_idx
            )));
        }
        let sector_vertex_count = path_regions.sector_vertices.len() / 7;
        Self::checked_usize_to_i32(
            &format!("Sublayer {} path sector vertex count", sublayer_idx),
            sector_vertex_count,
        )?;
        if !path_regions.cover_vertices.len().is_multiple_of(12) {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} path cover vertex buffer length is not divisible by 12",
                sublayer_idx
            )));
        }
        Self::checked_usize_to_i32(
            &format!("Sublayer {} path cover vertex count", sublayer_idx),
            path_regions.cover_vertices.len() / 2,
        )?;
        if !path_regions.clear_vertices.len().is_multiple_of(12) {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} path clear vertex buffer length is not divisible by 12",
                sublayer_idx
            )));
        }
        Self::checked_usize_to_i32(
            &format!("Sublayer {} path clear vertex count", sublayer_idx),
            path_regions.clear_vertices.len() / 2,
        )?;

        let region_count = path_regions.region_count();
        Self::checked_path_region_quad_start(region_count)?;
        let region_offset_count = region_count
            .checked_add(1)
            .ok_or_else(|| JsValue::from_str("path region offset count exceeds platform limits"))?;
        let cover_region_count = path_regions.cover_vertices.len() / 12;
        if cover_region_count != 0 && cover_region_count != region_count {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} path cover region count does not match path offsets",
                sublayer_idx
            )));
        }
        let clear_region_count = path_regions.clear_vertices.len() / 12;
        if clear_region_count != 0 && clear_region_count != region_count {
            return Err(JsValue::from_str(&format!(
                "Sublayer {} path clear region count does not match path offsets",
                sublayer_idx
            )));
        }
        Self::validate_len(
            "path wedge offsets",
            sublayer_idx,
            path_regions.wedge_vertex_offsets.len(),
            region_offset_count,
        )?;
        Self::validate_len(
            "path sector offsets",
            sublayer_idx,
            path_regions.sector_vertex_offsets.len(),
            region_offset_count,
        )?;
        Self::validate_offsets(
            "path wedge offsets",
            sublayer_idx,
            &path_regions.wedge_vertex_offsets,
            wedge_vertex_count,
        )?;
        Self::validate_offsets(
            "path sector offsets",
            sublayer_idx,
            &path_regions.sector_vertex_offsets,
            sector_vertex_count,
        )?;
        Self::validate_finite_slice("path wedge vertices", &path_regions.wedge_vertices)?;
        Self::validate_finite_slice("path sector vertices", &path_regions.sector_vertices)?;
        Self::validate_finite_slice("path cover vertices", &path_regions.cover_vertices)?;
        Self::validate_finite_slice("path clear vertices", &path_regions.clear_vertices)?;

        Ok(())
    }

    fn validate_offsets(
        label: &str,
        sublayer_idx: usize,
        offsets: &[u32],
        vertex_count: usize,
    ) -> Result<(), JsValue> {
        Self::validate_offsets_invariant(label, sublayer_idx, offsets, vertex_count)
            .map_err(|message| JsValue::from_str(&message))
    }

    fn validate_offsets_invariant(
        label: &str,
        sublayer_idx: usize,
        offsets: &[u32],
        vertex_count: usize,
    ) -> Result<(), String> {
        if offsets.first().copied() != Some(0) {
            return Err(format!(
                "Sublayer {} {} must start at 0",
                sublayer_idx, label
            ));
        }
        let mut previous = 0;
        for &offset in offsets {
            let offset = offset as usize;
            if offset < previous || offset > vertex_count {
                return Err(format!(
                    "Sublayer {} {} are not monotonically within the vertex buffer",
                    sublayer_idx, label
                ));
            }
            previous = offset;
        }
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

    fn validate_js_finite_array(label: &str, values: &Float32Array) -> Result<(), JsValue> {
        for index in 0..values.length() {
            Self::validate_finite_value(label, values.get_index(index))?;
        }
        Ok(())
    }

    fn validate_js_non_negative_array(label: &str, values: &Float32Array) -> Result<(), JsValue> {
        for index in 0..values.length() {
            let value = values.get_index(index);
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

    fn create_buffer_caches(count: usize) -> Result<Vec<BufferCache>, JsValue> {
        let mut caches = Self::reserved_vec("buffer caches", count)?;
        caches.resize_with(count, BufferCache::default);
        Ok(caches)
    }

    fn mark_all_layers_dirty(&mut self) {
        for layer in self.layers.iter_mut().flatten() {
            layer.fbo_dirty = true;
            layer.fbo_transform = None;
        }
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
        if let Some(stencil) = fbo.stencil {
            gl.delete_renderbuffer(Some(&stencil));
        }
    }

    fn delete_shader_programs(gl: &WebGl2RenderingContext, programs: &ShaderPrograms) {
        gl.delete_program(Some(&programs.triangle.program));
        gl.delete_program(Some(&programs.triangle_template.program));
        gl.delete_program(Some(&programs.line.program));
        gl.delete_program(Some(&programs.circle.program));
        gl.delete_program(Some(&programs.circle_holed.program));
        gl.delete_program(Some(&programs.arc.program));
        gl.delete_program(Some(&programs.thermal.program));
        gl.delete_program(Some(&programs.texture.program));
        gl.delete_program(Some(&programs.path_solid.program));
        gl.delete_program(Some(&programs.path_sector.program));
    }

    fn delete_buffer_caches(gl: &WebGl2RenderingContext, caches: &mut Vec<BufferCache>) {
        for cache in caches.drain(..) {
            Self::delete_buffer_cache(gl, cache);
        }
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
        for template_cache in cache.triangle_template_caches {
            if let Some(vao) = template_cache.vao {
                gl.delete_vertex_array(Some(&vao));
            }
            if let Some(buf) = template_cache.vertex_buffer {
                gl.delete_buffer(Some(&buf));
            }
            if let Some(buf) = template_cache.instance_x_buffer {
                gl.delete_buffer(Some(&buf));
            }
            if let Some(buf) = template_cache.instance_y_buffer {
                gl.delete_buffer(Some(&buf));
            }
        }

        if let Some(vao) = cache.line_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.line_start_x_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.line_start_y_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.line_end_x_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.line_end_y_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(buf) = cache.line_width_buffer {
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

        if let Some(vao) = cache.path_wedge_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.path_wedge_vertex_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(vao) = cache.path_sector_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.path_sector_vertex_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(vao) = cache.path_cover_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.path_cover_vertex_buffer {
            gl.delete_buffer(Some(&buf));
        }
        if let Some(vao) = cache.path_clear_vao {
            gl.delete_vertex_array(Some(&vao));
        }
        if let Some(buf) = cache.path_clear_vertex_buffer {
            gl.delete_buffer(Some(&buf));
        }
    }

    fn create_fbo(
        gl: &WebGl2RenderingContext,
        width: u32,
        height: u32,
        with_stencil: bool,
    ) -> Result<Fbo, JsValue> {
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
        let width_i32 = Self::checked_u32_to_i32("FBO width", width)?;
        let height_i32 = Self::checked_u32_to_i32("FBO height", height)?;

        let texture = gl.create_texture().ok_or("Failed to create texture")?;
        gl.bind_texture(WebGl2RenderingContext::TEXTURE_2D, Some(&texture));
        if let Err(error) = gl
            .tex_image_2d_with_i32_and_i32_and_i32_and_format_and_type_and_opt_u8_array(
                WebGl2RenderingContext::TEXTURE_2D,
                0,
                WebGl2RenderingContext::RGBA as i32,
                width_i32,
                height_i32,
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

        let stencil = if with_stencil {
            let stencil = gl
                .create_renderbuffer()
                .ok_or_else(|| JsValue::from_str("Failed to create stencil renderbuffer"))?;
            gl.bind_renderbuffer(WebGl2RenderingContext::RENDERBUFFER, Some(&stencil));
            gl.renderbuffer_storage(
                WebGl2RenderingContext::RENDERBUFFER,
                WebGl2RenderingContext::STENCIL_INDEX8,
                width_i32,
                height_i32,
            );
            gl.framebuffer_renderbuffer(
                WebGl2RenderingContext::FRAMEBUFFER,
                WebGl2RenderingContext::STENCIL_ATTACHMENT,
                WebGl2RenderingContext::RENDERBUFFER,
                Some(&stencil),
            );
            Some(stencil)
        } else {
            None
        };

        let status = gl.check_framebuffer_status(WebGl2RenderingContext::FRAMEBUFFER);
        if status != WebGl2RenderingContext::FRAMEBUFFER_COMPLETE {
            gl.bind_texture(WebGl2RenderingContext::TEXTURE_2D, None);
            gl.bind_renderbuffer(WebGl2RenderingContext::RENDERBUFFER, None);
            gl.bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, None);
            if let Some(stencil) = stencil {
                gl.delete_renderbuffer(Some(&stencil));
            }
            gl.delete_framebuffer(Some(&framebuffer));
            gl.delete_texture(Some(&texture));
            return Err(JsValue::from_str(&format!(
                "Framebuffer is incomplete: 0x{:x}",
                status
            )));
        }

        gl.bind_texture(WebGl2RenderingContext::TEXTURE_2D, None);
        gl.bind_renderbuffer(WebGl2RenderingContext::RENDERBUFFER, None);
        gl.bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, None);

        Ok(Fbo {
            framebuffer,
            texture,
            stencil,
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
        Self::upload_f32_slice_to_bound_buffer(gl, data);
        let loc = match program.attributes.get(attr_name) {
            Some(loc) => loc,
            None => {
                gl.delete_buffer(Some(&buffer));
                return Err(JsValue::from_str(&format!(
                    "Missing shader attribute: {}",
                    attr_name
                )));
            }
        };
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

        Self::upload_f32_slice_to_bound_buffer(gl, &vertices);

        Ok(buffer)
    }

    fn upload_float_array_to_bound_buffer(gl: &WebGl2RenderingContext, data: &Float32Array) {
        gl.buffer_data_with_f64(ARRAY_BUFFER, data.byte_length() as f64, STATIC_DRAW);
        gl.buffer_sub_data_with_i32_and_array_buffer_view(ARRAY_BUFFER, 0, data);
    }

    fn upload_f32_slice_to_bound_buffer_with_usage(
        gl: &WebGl2RenderingContext,
        data: &[f32],
        usage: u32,
    ) {
        unsafe {
            let array = Float32Array::view(data);
            gl.buffer_data_with_array_buffer_view(ARRAY_BUFFER, &array, usage);
        }
    }

    fn upload_f32_slice_to_bound_buffer(gl: &WebGl2RenderingContext, data: &[f32]) {
        // Avoid JS memory copy.
        unsafe {
            let array = Float32Array::view(data);
            Self::upload_float_array_to_bound_buffer(gl, &array);
        }
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
        if let Some(size) = self.explicit_size {
            return Ok(size);
        }
        Self::get_canvas_size_from_gl(&self.gl)
    }

    fn validate_framebuffer_size(width: u32, height: u32) -> Result<(), JsValue> {
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Framebuffer size must be non-zero"));
        }

        let max_i32 = i32::MAX as u32;
        if width > max_i32 || height > max_i32 {
            return Err(JsValue::from_str("Framebuffer size is too large"));
        }

        Ok(())
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

    fn get_layer_mut(&mut self, layer_id: usize) -> Result<&mut LayerMetadata, JsValue> {
        if layer_id >= self.layers.len() {
            return Err(JsValue::from_str("Invalid layer index"));
        }
        self.layers[layer_id]
            .as_mut()
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

    fn validate_blend_modes(active_layer_ids: &[u32], blend_modes: &[u8]) -> Result<(), JsValue> {
        if blend_modes.len() != active_layer_ids.len() {
            return Err(JsValue::from_str(&format!(
                "Blend mode data length mismatch: expected {}, got {}",
                active_layer_ids.len(),
                blend_modes.len()
            )));
        }
        if blend_modes.iter().any(|&mode| mode > 2) {
            return Err(JsValue::from_str("Blend mode must be 0, 1, or 2"));
        }
        Ok(())
    }

    fn blend_mode_at(blend_modes: Option<&[u8]>, index: usize) -> u8 {
        blend_modes
            .and_then(|modes| modes.get(index))
            .copied()
            .unwrap_or(0)
    }

    fn color_data_stride(active_layer_ids: &[u32], color_data: &[f32]) -> usize {
        let rgba_len = active_layer_ids.len().saturating_mul(4);
        if color_data.len() >= rgba_len {
            4
        } else {
            3
        }
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

    fn ensure_highlight_resources(&mut self) -> Result<(), JsValue> {
        if self.highlight_program.is_some()
            && self.highlight_stencil_program.is_some()
            && self.highlight_buffer.is_some()
            && self.highlight_vertex_array.is_some()
        {
            return Ok(());
        }

        self.delete_highlight_resources();

        let highlight_program = compile_program(
            &self.gl,
            HIGHLIGHT_VERTEX_SHADER,
            HIGHLIGHT_FRAGMENT_SHADER,
            &["position"],
            &["transform"],
        )?;
        let stencil_program = match compile_program(
            &self.gl,
            HIGHLIGHT_VERTEX_SHADER,
            HIGHLIGHT_STENCIL_FRAGMENT_SHADER,
            &["position"],
            &["transform"],
        ) {
            Ok(program) => program,
            Err(error) => {
                self.gl.delete_program(Some(&highlight_program.program));
                return Err(error);
            }
        };
        let buffer = match self.gl.create_buffer() {
            Some(buffer) => buffer,
            None => {
                self.gl.delete_program(Some(&highlight_program.program));
                self.gl.delete_program(Some(&stencil_program.program));
                return Err(JsValue::from_str("Failed to create highlight buffer"));
            }
        };
        let vertex_array = match self.gl.create_vertex_array() {
            Some(vertex_array) => vertex_array,
            None => {
                self.gl.delete_buffer(Some(&buffer));
                self.gl.delete_program(Some(&highlight_program.program));
                self.gl.delete_program(Some(&stencil_program.program));
                return Err(JsValue::from_str("Failed to create highlight VAO"));
            }
        };

        self.highlight_program = Some(highlight_program);
        self.highlight_stencil_program = Some(stencil_program);
        self.highlight_buffer = Some(buffer);
        self.highlight_vertex_array = Some(vertex_array);
        Ok(())
    }

    fn delete_highlight_resources(&mut self) {
        Self::delete_highlight_resources_from(
            &self.gl,
            &mut self.highlight_program,
            &mut self.highlight_stencil_program,
            &mut self.highlight_buffer,
            &mut self.highlight_vertex_array,
        );
    }

    fn delete_highlight_resources_from(
        gl: &WebGl2RenderingContext,
        highlight_program: &mut Option<ShaderProgram>,
        highlight_stencil_program: &mut Option<ShaderProgram>,
        highlight_buffer: &mut Option<WebGlBuffer>,
        highlight_vertex_array: &mut Option<WebGlVertexArrayObject>,
    ) {
        if let Some(program) = highlight_program.take() {
            gl.delete_program(Some(&program.program));
        }
        if let Some(program) = highlight_stencil_program.take() {
            gl.delete_program(Some(&program.program));
        }
        if let Some(buffer) = highlight_buffer.take() {
            gl.delete_buffer(Some(&buffer));
        }
        if let Some(vertex_array) = highlight_vertex_array.take() {
            gl.delete_vertex_array(Some(&vertex_array));
        }
    }

    fn draw_highlight_vertices(
        &self,
        program: &ShaderProgram,
        vertices: &[f32],
        transform: &[f32; 9],
    ) -> Result<(), JsValue> {
        if vertices.len() < 6 {
            return Ok(());
        }
        if !vertices.len().is_multiple_of(2) {
            return Err(JsValue::from_str(
                "Highlight vertex buffer has an odd coordinate count",
            ));
        }
        let vertex_count = vertices.len() / 2;
        if !vertex_count.is_multiple_of(3) {
            return Err(JsValue::from_str(
                "Highlight vertex count is not divisible by 3",
            ));
        }
        let vertex_count = Self::checked_usize_to_i32("highlight vertex count", vertex_count)?;

        self.gl.use_program(Some(&program.program));
        self.gl.uniform_matrix3fv_with_f32_array(
            program.uniforms.get("transform"),
            false,
            transform,
        );
        self.gl
            .bind_vertex_array(self.highlight_vertex_array.as_ref());
        self.gl
            .bind_buffer(ARRAY_BUFFER, self.highlight_buffer.as_ref());
        Self::upload_f32_slice_to_bound_buffer_with_usage(&self.gl, vertices, STREAM_DRAW);
        let position = Self::shader_attribute(program, "position")?;
        self.gl.enable_vertex_attrib_array(position);
        self.gl
            .vertex_attrib_pointer_with_i32(position, 2, FLOAT, false, 0, 0);
        self.gl.vertex_attrib_divisor(position, 0);
        self.gl.draw_arrays(TRIANGLES, 0, vertex_count);
        Ok(())
    }

    fn draw_highlight_path_regions(
        &self,
        path_regions: &PathRegions,
        transform: &[f32; 9],
        highlight_program: &ShaderProgram,
        stencil_program: &ShaderProgram,
    ) -> Result<(), JsValue> {
        let region_count = path_regions.region_count();
        if region_count == 0 {
            return Ok(());
        }

        Self::validate_path_region_data(path_regions, 0)?;
        let mut guard = BufferCacheBuildGuard::new(&self.gl);
        Self::create_path_region_gpu_cache(
            &self.gl,
            &self.programs,
            &mut guard.cache,
            path_regions,
        )?;
        let buffer_cache = guard.commit();
        let solid_color = [1.0, 1.0, 1.0, 1.0];

        let result = (|| -> Result<(), JsValue> {
            for region_idx in 0..region_count {
                self.gl.color_mask(false, false, false, false);
                self.gl.stencil_func(ALWAYS, 0, 0xff);
                self.gl.stencil_op(KEEP, KEEP, INVERT);

                let wedge_start = Self::checked_u32_to_i32(
                    "highlight path wedge vertex start",
                    path_regions.wedge_vertex_offsets[region_idx],
                )?;
                let wedge_end = Self::checked_u32_to_i32(
                    "highlight path wedge vertex end",
                    path_regions.wedge_vertex_offsets[region_idx + 1],
                )?;
                if wedge_end > wedge_start {
                    self.draw_path_solid_range(
                        transform,
                        &solid_color,
                        buffer_cache.path_wedge_vao.as_ref(),
                        wedge_start,
                        wedge_end - wedge_start,
                    )?;
                }

                let sector_start = Self::checked_u32_to_i32(
                    "highlight path sector vertex start",
                    path_regions.sector_vertex_offsets[region_idx],
                )?;
                let sector_end = Self::checked_u32_to_i32(
                    "highlight path sector vertex end",
                    path_regions.sector_vertex_offsets[region_idx + 1],
                )?;
                if sector_end > sector_start {
                    self.draw_path_sector_range(
                        transform,
                        &buffer_cache,
                        sector_start,
                        sector_end - sector_start,
                    )?;
                }

                self.gl.color_mask(true, true, true, true);
                self.gl.stencil_func(NOTEQUAL, 0, 0xff);
                self.gl.stencil_op(KEEP, KEEP, KEEP);
                let clear_start = region_idx.checked_mul(12).ok_or_else(|| {
                    JsValue::from_str("highlight path clear vertex start overflows")
                })?;
                let clear_end = clear_start + 12;
                self.draw_highlight_vertices(
                    highlight_program,
                    &path_regions.clear_vertices[clear_start..clear_end],
                    transform,
                )?;

                self.gl.color_mask(false, false, false, false);
                self.gl.stencil_func(ALWAYS, 0, 0xff);
                self.gl.stencil_op(ZERO, ZERO, ZERO);
                let cover_start = region_idx.checked_mul(12).ok_or_else(|| {
                    JsValue::from_str("highlight path cover vertex start overflows")
                })?;
                let cover_end = cover_start + 12;
                self.draw_highlight_vertices(
                    stencil_program,
                    &path_regions.cover_vertices[cover_start..cover_end],
                    transform,
                )?;
            }

            Ok(())
        })();

        Self::delete_buffer_cache(&self.gl, buffer_cache);
        result
    }

    fn bounds_rect_triangles(bounds: &Boundary) -> [f32; 12] {
        [
            bounds.min_x(),
            bounds.min_y(),
            bounds.max_x(),
            bounds.min_y(),
            bounds.min_x(),
            bounds.max_y(),
            bounds.min_x(),
            bounds.max_y(),
            bounds.max_x(),
            bounds.min_y(),
            bounds.max_x(),
            bounds.max_y(),
        ]
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_interaction_highlight(
        &mut self,
        feature: &InteractionFeature,
        zoom_x: f32,
        zoom_y: f32,
        offset_x: f32,
        offset_y: f32,
    ) -> Result<(), JsValue> {
        Self::validate_finite_value("highlight zoom_x", zoom_x)?;
        Self::validate_finite_value("highlight zoom_y", zoom_y)?;
        Self::validate_finite_value("highlight offset_x", offset_x)?;
        Self::validate_finite_value("highlight offset_y", offset_y)?;
        Self::validate_finite_value("highlight bounds.min_x", feature.bounds.min_x())?;
        Self::validate_finite_value("highlight bounds.max_x", feature.bounds.max_x())?;
        Self::validate_finite_value("highlight bounds.min_y", feature.bounds.min_y())?;
        Self::validate_finite_value("highlight bounds.max_y", feature.bounds.max_y())?;

        let batches = feature.highlight_batches();
        let has_primitive_batches = batches.iter().any(|batch| batch.vertices.len() >= 6);
        let path_regions = feature.path_regions.as_deref();
        let has_path_regions = path_regions.is_some_and(PathRegions::has_geometry);
        if !has_primitive_batches && !has_path_regions {
            return Ok(());
        }

        self.update_camera(zoom_x, zoom_y, offset_x, offset_y);
        let (width, height) = self.get_canvas_size()?;
        if width == 0 || height == 0 {
            return Err(JsValue::from_str(
                "Cannot render highlight to a zero-sized canvas",
            ));
        }
        let width_i32 = Self::checked_u32_to_i32("canvas width", width)?;
        let height_i32 = Self::checked_u32_to_i32("canvas height", height)?;
        let transform = self.camera.get_transform_matrix(width, height);
        let bounds_vertices = Self::bounds_rect_triangles(&feature.bounds);
        self.ensure_highlight_resources()?;

        let stencil_bits = self
            .gl
            .get_parameter(WebGl2RenderingContext::STENCIL_BITS)?
            .as_f64()
            .unwrap_or(0.0) as i32;

        self.gl
            .bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, None);
        self.gl.viewport(0, 0, width_i32, height_i32);
        self.gl.disable(WebGl2RenderingContext::DEPTH_TEST);
        self.gl.disable(WebGl2RenderingContext::CULL_FACE);
        self.gl.color_mask(true, true, true, true);

        let render_result = (|| -> Result<(), JsValue> {
            if stencil_bits <= 0 {
                // Accurate dark/clear clipping needs stencil. Without it, skip the
                // highlight instead of drawing cleared holes as selected.
                return Ok(());
            }

            let stencil_program = self
                .highlight_stencil_program
                .as_ref()
                .ok_or_else(|| JsValue::from_str("Highlight stencil program unavailable"))?;
            let highlight_program = self
                .highlight_program
                .as_ref()
                .ok_or_else(|| JsValue::from_str("Highlight program unavailable"))?;

            if has_primitive_batches {
                self.gl.clear_stencil(0);
                self.gl.stencil_mask(0xff);
                self.gl.clear(STENCIL_BUFFER_BIT);
                self.gl.enable(STENCIL_TEST);
                self.gl.disable(BLEND);
                self.gl.color_mask(false, false, false, false);
                self.gl.stencil_op(KEEP, KEEP, REPLACE);

                for batch in &batches {
                    let stencil_value = if batch.clear { 0 } else { 1 };
                    self.gl.stencil_func(ALWAYS, stencil_value, 0xff);
                    self.draw_highlight_vertices(stencil_program, &batch.vertices, &transform)?;
                }

                self.gl.color_mask(true, true, true, true);
                self.gl.enable(BLEND);
                self.gl.blend_equation(FUNC_ADD);
                self.gl.blend_func(SRC_ALPHA, ONE_MINUS_SRC_ALPHA);
                self.gl.stencil_func(EQUAL, 1, 0xff);
                self.gl.stencil_mask(0x00);
                self.gl.stencil_op(KEEP, KEEP, KEEP);
                self.draw_highlight_vertices(highlight_program, &bounds_vertices, &transform)?;
            }

            if let Some(path_regions) = path_regions {
                self.gl.clear_stencil(0);
                self.gl.stencil_mask(0xff);
                self.gl.clear(STENCIL_BUFFER_BIT);
                self.gl.enable(STENCIL_TEST);
                self.gl.enable(BLEND);
                self.gl.blend_equation(FUNC_ADD);
                self.gl.blend_func(SRC_ALPHA, ONE_MINUS_SRC_ALPHA);
                self.draw_highlight_path_regions(
                    path_regions,
                    &transform,
                    highlight_program,
                    stencil_program,
                )?;
            }
            Ok(())
        })();

        self.gl.disable(STENCIL_TEST);
        self.gl.disable(BLEND);
        self.gl.stencil_mask(0xff);
        self.gl.color_mask(true, true, true, true);
        self.gl.bind_buffer(ARRAY_BUFFER, None);
        self.gl.bind_vertex_array(None);
        self.gl.blend_equation(FUNC_ADD);
        self.gl.blend_func(SRC_ALPHA, ONE_MINUS_SRC_ALPHA);

        render_result
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
                let vertex_count = Self::checked_usize_to_i32(
                    "triangle vertex count",
                    triangles.vertices.len() / 2,
                )?;
                let mut pending_cache = BufferCacheBuildGuard::new(&self.gl);

                // Create VAO
                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));
                pending_cache.cache.triangle_vao = Some(vao);

                // Create and bind vertex buffer
                let vertex_buffer = self
                    .gl
                    .create_buffer()
                    .ok_or_else(|| JsValue::from_str("Failed to create vertex buffer"))?;
                self.gl.bind_buffer(ARRAY_BUFFER, Some(&vertex_buffer));
                pending_cache.cache.triangle_vertex_buffer = Some(vertex_buffer);
                Self::upload_f32_slice_to_bound_buffer(&self.gl, &triangles.vertices);

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
                    pending_cache.cache.triangle_hole_x_buffer = Some(hole_x_buffer);
                    let hole_y_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &triangles.hole_y,
                        program,
                        "hole_y_instance",
                        0,
                    )?;
                    pending_cache.cache.triangle_hole_y_buffer = Some(hole_y_buffer);
                    let hole_radius_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &triangles.hole_radius,
                        program,
                        "hole_radius_instance",
                        0,
                    )?;
                    pending_cache.cache.triangle_hole_radius_buffer = Some(hole_radius_buffer);
                }

                // Unbind VAO
                self.gl.bind_vertex_array(None);
                let mut built_cache = pending_cache.commit();

                // Cache VAO and buffers for this sublayer
                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.triangle_vao = built_cache.triangle_vao.take();
                buffer_cache.triangle_vertex_count = vertex_count;
                buffer_cache.triangle_vertex_buffer = built_cache.triangle_vertex_buffer.take();
                buffer_cache.triangle_hole_x_buffer = built_cache.triangle_hole_x_buffer.take();
                buffer_cache.triangle_hole_y_buffer = built_cache.triangle_hole_y_buffer.take();
                buffer_cache.triangle_hole_radius_buffer =
                    built_cache.triangle_hole_radius_buffer.take();
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

    /// Draw repeated triangle mesh templates.
    fn draw_instanced_triangle_templates(
        &mut self,
        transform: &[f32; 9],
        color: &[f32; 4],
        layer_id: usize,
        sublayer_idx: usize,
    ) -> Result<(), JsValue> {
        if layer_id >= self.layers.len() {
            return Err(JsValue::from_str("Invalid layer index"));
        }

        let program = &self.programs.triangle_template;
        self.gl.use_program(Some(&program.program));

        let template_count = self.get_layer(layer_id)?.gerber_data[sublayer_idx]
            .triangle_templates
            .len();

        for template_idx in 0..template_count {
            let (vertex_count, instance_count) = {
                let layer = if let Some(l) = &mut self.layers[layer_id] {
                    l
                } else {
                    return Err(JsValue::from_str("Layer deallocated"));
                };

                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                if buffer_cache.triangle_template_caches.len() < template_count {
                    buffer_cache
                        .triangle_template_caches
                        .resize_with(template_count, TriangleTemplateBufferCache::default);
                }

                if buffer_cache.triangle_template_caches[template_idx]
                    .vao
                    .is_none()
                {
                    let template =
                        &layer.gerber_data[sublayer_idx].triangle_templates[template_idx];
                    if template.vertices.is_empty() || template.instance_x.is_empty() {
                        continue;
                    }

                    let vertex_count = Self::checked_usize_to_i32(
                        "triangle template vertex count",
                        template.vertices.len() / 2,
                    )?;
                    let instance_count = Self::checked_usize_to_i32(
                        "triangle template instance count",
                        template.instance_x.len(),
                    )?;
                    let mut pending_cache = BufferCacheBuildGuard::new(&self.gl);
                    pending_cache
                        .cache
                        .triangle_template_caches
                        .resize_with(1, TriangleTemplateBufferCache::default);

                    let vao = self
                        .gl
                        .create_vertex_array()
                        .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                    self.gl.bind_vertex_array(Some(&vao));
                    pending_cache.cache.triangle_template_caches[0].vao = Some(vao);

                    let vertex_buffer = self
                        .gl
                        .create_buffer()
                        .ok_or_else(|| JsValue::from_str("Failed to create vertex buffer"))?;
                    self.gl.bind_buffer(ARRAY_BUFFER, Some(&vertex_buffer));
                    pending_cache.cache.triangle_template_caches[0].vertex_buffer =
                        Some(vertex_buffer);
                    Self::upload_f32_slice_to_bound_buffer(&self.gl, &template.vertices);

                    let position_loc = Self::shader_attribute(program, "position")?;
                    self.gl.enable_vertex_attrib_array(position_loc);
                    self.gl
                        .vertex_attrib_pointer_with_i32(position_loc, 2, FLOAT, false, 0, 0);

                    let instance_x_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &template.instance_x,
                        program,
                        "instance_x",
                        1,
                    )?;
                    pending_cache.cache.triangle_template_caches[0].instance_x_buffer =
                        Some(instance_x_buffer);
                    let instance_y_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &template.instance_y,
                        program,
                        "instance_y",
                        1,
                    )?;
                    pending_cache.cache.triangle_template_caches[0].instance_y_buffer =
                        Some(instance_y_buffer);

                    self.gl.bind_vertex_array(None);
                    let mut built_cache = pending_cache.commit();

                    let template_cache = &mut layer.buffer_caches[sublayer_idx]
                        .triangle_template_caches[template_idx];
                    let built_template_cache = &mut built_cache.triangle_template_caches[0];
                    template_cache.vao = built_template_cache.vao.take();
                    template_cache.vertex_count = vertex_count;
                    template_cache.instance_count = instance_count;
                    template_cache.vertex_buffer = built_template_cache.vertex_buffer.take();
                    template_cache.instance_x_buffer =
                        built_template_cache.instance_x_buffer.take();
                    template_cache.instance_y_buffer =
                        built_template_cache.instance_y_buffer.take();

                    layer.gerber_data[sublayer_idx].triangle_templates[template_idx]
                        .release_cpu_geometry();
                    layer.cpu_geometry_released = true;
                }

                let template_cache =
                    &layer.buffer_caches[sublayer_idx].triangle_template_caches[template_idx];
                (template_cache.vertex_count, template_cache.instance_count)
            };

            if vertex_count == 0 || instance_count == 0 {
                continue;
            }

            let layer = self.get_layer(layer_id)?;
            let template_cache =
                &layer.buffer_caches[sublayer_idx].triangle_template_caches[template_idx];

            self.gl.bind_vertex_array(template_cache.vao.as_ref());
            if let Some(loc) = program.uniforms.get("transform") {
                self.gl
                    .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
            }
            if let Some(loc) = program.uniforms.get("color") {
                self.gl.uniform4fv_with_f32_array(Some(loc), color);
            }

            self.gl
                .draw_arrays_instanced(TRIANGLES, 0, vertex_count, instance_count);
            self.gl.bind_vertex_array(None);
        }

        Ok(())
    }

    /// Draw instanced straight line bodies.
    fn draw_instanced_lines(
        &mut self,
        transform: &[f32; 9],
        color: &[f32; 4],
        layer_id: usize,
        sublayer_idx: usize,
        viewport_width: u32,
        viewport_height: u32,
    ) -> Result<(), JsValue> {
        let program = &self.programs.line;
        self.gl.use_program(Some(&program.program));

        let instance_count = {
            let layer = self.layers[layer_id]
                .as_mut()
                .ok_or_else(|| JsValue::from_str("Layer not found"))?;

            if layer.buffer_caches[sublayer_idx].line_vao.is_none() {
                let lines = &layer.gerber_data[sublayer_idx].lines;
                if lines.start_x.is_empty() {
                    return Ok(());
                }
                let instance_count =
                    Self::checked_usize_to_i32("line instance count", lines.start_x.len())?;
                let mut pending_cache = BufferCacheBuildGuard::new(&self.gl);

                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));
                pending_cache.cache.line_vao = Some(vao);
                self.gl.bind_buffer(ARRAY_BUFFER, Some(&self.quad_buffer));
                let position_loc = Self::shader_attribute(program, "position")?;
                self.gl.enable_vertex_attrib_array(position_loc);
                self.gl
                    .vertex_attrib_pointer_with_i32(position_loc, 2, FLOAT, false, 0, 0);

                let start_x_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &lines.start_x,
                    program,
                    "start_x_instance",
                    1,
                )?;
                pending_cache.cache.line_start_x_buffer = Some(start_x_buffer);
                let start_y_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &lines.start_y,
                    program,
                    "start_y_instance",
                    1,
                )?;
                pending_cache.cache.line_start_y_buffer = Some(start_y_buffer);
                let end_x_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &lines.end_x,
                    program,
                    "end_x_instance",
                    1,
                )?;
                pending_cache.cache.line_end_x_buffer = Some(end_x_buffer);
                let end_y_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &lines.end_y,
                    program,
                    "end_y_instance",
                    1,
                )?;
                pending_cache.cache.line_end_y_buffer = Some(end_y_buffer);
                let width_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &lines.width,
                    program,
                    "width_instance",
                    1,
                )?;
                pending_cache.cache.line_width_buffer = Some(width_buffer);

                self.gl.bind_vertex_array(None);
                let mut built_cache = pending_cache.commit();

                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.line_vao = built_cache.line_vao.take();
                buffer_cache.line_instance_count = instance_count;
                buffer_cache.line_start_x_buffer = built_cache.line_start_x_buffer.take();
                buffer_cache.line_start_y_buffer = built_cache.line_start_y_buffer.take();
                buffer_cache.line_end_x_buffer = built_cache.line_end_x_buffer.take();
                buffer_cache.line_end_y_buffer = built_cache.line_end_y_buffer.take();
                buffer_cache.line_width_buffer = built_cache.line_width_buffer.take();
                layer.gerber_data[sublayer_idx].lines.release_cpu_geometry();
                layer.cpu_geometry_released = true;
            }

            layer.buffer_caches[sublayer_idx].line_instance_count
        };
        if instance_count == 0 {
            return Ok(());
        }

        let layer = self.get_layer(layer_id)?;
        let buffer_cache = &layer.buffer_caches[sublayer_idx];
        self.gl.bind_vertex_array(buffer_cache.line_vao.as_ref());

        if let Some(loc) = program.uniforms.get("transform") {
            self.gl
                .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
        }
        if let Some(loc) = program.uniforms.get("color") {
            self.gl.uniform4fv_with_f32_array(Some(loc), color);
        }
        let layer = self.get_layer(layer_id)?;
        self.set_view_feature_uniforms(
            program,
            viewport_width,
            viewport_height,
            layer.inner_outline_pixels,
            layer.inner_outline_world,
        );

        self.gl
            .draw_arrays_instanced(TRIANGLES, 0, 6, instance_count);
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
        viewport_width: u32,
        viewport_height: u32,
    ) -> Result<(), JsValue> {
        let instance_count = {
            let layer = self.layers[layer_id]
                .as_mut()
                .ok_or_else(|| JsValue::from_str("Layer not found"))?;

            if layer.buffer_caches[sublayer_idx].circle_vao.is_none() {
                let circles = &layer.gerber_data[sublayer_idx].circles;
                if circles.x.is_empty() {
                    return Ok(());
                }
                let instance_count =
                    Self::checked_usize_to_i32("circle instance count", circles.x.len())?;
                let has_holes = !circles.hole_radius.is_empty();
                let program = if has_holes {
                    &self.programs.circle_holed
                } else {
                    &self.programs.circle
                };
                self.gl.use_program(Some(&program.program));
                let mut pending_cache = BufferCacheBuildGuard::new(&self.gl);

                // Create VAO
                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));
                pending_cache.cache.circle_vao = Some(vao);

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
                pending_cache.cache.circle_center_x_buffer = Some(center_x_buffer);
                let center_y_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &circles.y,
                    program,
                    "center_y_instance",
                    1,
                )?;
                pending_cache.cache.circle_center_y_buffer = Some(center_y_buffer);
                let radius_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &circles.radius,
                    program,
                    "radius_instance",
                    1,
                )?;
                pending_cache.cache.circle_radius_buffer = Some(radius_buffer);
                if has_holes {
                    let hole_x_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &circles.hole_x,
                        program,
                        "hole_x_instance",
                        1,
                    )?;
                    pending_cache.cache.circle_hole_x_buffer = Some(hole_x_buffer);
                    let hole_y_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &circles.hole_y,
                        program,
                        "hole_y_instance",
                        1,
                    )?;
                    pending_cache.cache.circle_hole_y_buffer = Some(hole_y_buffer);
                    let hole_radius_buffer = Self::create_instance_buffer(
                        &self.gl,
                        &circles.hole_radius,
                        program,
                        "hole_radius_instance",
                        1,
                    )?;
                    pending_cache.cache.circle_hole_radius_buffer = Some(hole_radius_buffer);
                }

                // Unbind VAO
                self.gl.bind_vertex_array(None);
                let mut built_cache = pending_cache.commit();

                // Cache VAO and buffers for this sublayer
                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.circle_vao = built_cache.circle_vao.take();
                buffer_cache.circle_instance_count = instance_count;
                buffer_cache.circle_center_x_buffer = built_cache.circle_center_x_buffer.take();
                buffer_cache.circle_center_y_buffer = built_cache.circle_center_y_buffer.take();
                buffer_cache.circle_radius_buffer = built_cache.circle_radius_buffer.take();
                buffer_cache.circle_hole_x_buffer = built_cache.circle_hole_x_buffer.take();
                buffer_cache.circle_hole_y_buffer = built_cache.circle_hole_y_buffer.take();
                buffer_cache.circle_hole_radius_buffer =
                    built_cache.circle_hole_radius_buffer.take();
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
        let program = if buffer_cache.circle_hole_radius_buffer.is_some() {
            &self.programs.circle_holed
        } else {
            &self.programs.circle
        };
        self.gl.use_program(Some(&program.program));

        // Bind cached VAO for this sublayer
        self.gl.bind_vertex_array(buffer_cache.circle_vao.as_ref());

        // Set uniforms (only these change per frame)
        if let Some(loc) = program.uniforms.get("transform") {
            self.gl
                .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
        }
        if let Some(loc) = program.uniforms.get("color") {
            self.gl.uniform4fv_with_f32_array(Some(loc), color);
        }
        let layer = self.get_layer(layer_id)?;
        self.set_view_feature_uniforms(
            program,
            viewport_width,
            viewport_height,
            layer.inner_outline_pixels,
            layer.inner_outline_world,
        );

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
        viewport_width: u32,
        viewport_height: u32,
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
                let instance_count =
                    Self::checked_usize_to_i32("arc instance count", arcs.x.len())?;
                let mut pending_cache = BufferCacheBuildGuard::new(&self.gl);

                // Create VAO
                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));
                pending_cache.cache.arc_vao = Some(vao);

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
                pending_cache.cache.arc_center_x_buffer = Some(center_x_buffer);
                let center_y_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.y,
                    program,
                    "center_y_instance",
                    1,
                )?;
                pending_cache.cache.arc_center_y_buffer = Some(center_y_buffer);
                let radius_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.radius,
                    program,
                    "radius_instance",
                    1,
                )?;
                pending_cache.cache.arc_radius_buffer = Some(radius_buffer);
                let start_angle_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.start_angle,
                    program,
                    "startAngle_instance",
                    1,
                )?;
                pending_cache.cache.arc_start_angle_buffer = Some(start_angle_buffer);
                let sweep_angle_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.sweep_angle,
                    program,
                    "sweepAngle_instance",
                    1,
                )?;
                pending_cache.cache.arc_sweep_angle_buffer = Some(sweep_angle_buffer);
                let thickness_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &arcs.thickness,
                    program,
                    "thickness_instance",
                    1,
                )?;
                pending_cache.cache.arc_thickness_buffer = Some(thickness_buffer);

                // Unbind VAO
                self.gl.bind_vertex_array(None);
                let mut built_cache = pending_cache.commit();

                // Cache VAO and buffers for this sublayer
                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.arc_vao = built_cache.arc_vao.take();
                buffer_cache.arc_instance_count = instance_count;
                buffer_cache.arc_center_x_buffer = built_cache.arc_center_x_buffer.take();
                buffer_cache.arc_center_y_buffer = built_cache.arc_center_y_buffer.take();
                buffer_cache.arc_radius_buffer = built_cache.arc_radius_buffer.take();
                buffer_cache.arc_start_angle_buffer = built_cache.arc_start_angle_buffer.take();
                buffer_cache.arc_sweep_angle_buffer = built_cache.arc_sweep_angle_buffer.take();
                buffer_cache.arc_thickness_buffer = built_cache.arc_thickness_buffer.take();
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
        let layer = self.get_layer(layer_id)?;
        self.set_view_feature_uniforms(
            program,
            viewport_width,
            viewport_height,
            layer.inner_outline_pixels,
            layer.inner_outline_world,
        );

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
                let instance_count =
                    Self::checked_usize_to_i32("thermal instance count", thermals.x.len())?;
                let mut pending_cache = BufferCacheBuildGuard::new(&self.gl);

                // Create VAO
                let vao = self
                    .gl
                    .create_vertex_array()
                    .ok_or_else(|| JsValue::from_str("Failed to create VAO"))?;
                self.gl.bind_vertex_array(Some(&vao));
                pending_cache.cache.thermal_vao = Some(vao);

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
                pending_cache.cache.thermal_center_x_buffer = Some(center_x_buffer);
                let center_y_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.y,
                    program,
                    "center_y_instance",
                    1,
                )?;
                pending_cache.cache.thermal_center_y_buffer = Some(center_y_buffer);
                let outer_diameter_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.outer_diameter,
                    program,
                    "outer_diameter_instance",
                    1,
                )?;
                pending_cache.cache.thermal_outer_diameter_buffer = Some(outer_diameter_buffer);
                let inner_diameter_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.inner_diameter,
                    program,
                    "inner_diameter_instance",
                    1,
                )?;
                pending_cache.cache.thermal_inner_diameter_buffer = Some(inner_diameter_buffer);
                let gap_thickness_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.gap_thickness,
                    program,
                    "gap_thickness_instance",
                    1,
                )?;
                pending_cache.cache.thermal_gap_thickness_buffer = Some(gap_thickness_buffer);
                let rotation_buffer = Self::create_instance_buffer(
                    &self.gl,
                    &thermals.rotation,
                    program,
                    "rotation_instance",
                    1,
                )?;
                pending_cache.cache.thermal_rotation_buffer = Some(rotation_buffer);

                // Unbind VAO
                self.gl.bind_vertex_array(None);
                let mut built_cache = pending_cache.commit();

                // Cache VAO and buffers for this sublayer
                let buffer_cache = &mut layer.buffer_caches[sublayer_idx];
                buffer_cache.thermal_vao = built_cache.thermal_vao.take();
                buffer_cache.thermal_instance_count = instance_count;
                buffer_cache.thermal_center_x_buffer = built_cache.thermal_center_x_buffer.take();
                buffer_cache.thermal_center_y_buffer = built_cache.thermal_center_y_buffer.take();
                buffer_cache.thermal_outer_diameter_buffer =
                    built_cache.thermal_outer_diameter_buffer.take();
                buffer_cache.thermal_inner_diameter_buffer =
                    built_cache.thermal_inner_diameter_buffer.take();
                buffer_cache.thermal_gap_thickness_buffer =
                    built_cache.thermal_gap_thickness_buffer.take();
                buffer_cache.thermal_rotation_buffer = built_cache.thermal_rotation_buffer.take();
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

    fn draw_path_regions(
        &mut self,
        transform: &[f32; 9],
        color: &[f32; 4],
        layer_id: usize,
        sublayer_idx: usize,
    ) -> Result<(), JsValue> {
        let region_count = {
            let layer = self.layers[layer_id]
                .as_mut()
                .ok_or_else(|| JsValue::from_str("Layer not found"))?;
            let path_regions = &layer.gerber_data[sublayer_idx].path_regions;
            let region_count = path_regions.region_count();
            if region_count == 0 {
                return Ok(());
            }

            if layer.buffer_caches[sublayer_idx].path_cover_vao.is_none() {
                Self::create_path_region_gpu_cache(
                    &self.gl,
                    &self.programs,
                    &mut layer.buffer_caches[sublayer_idx],
                    path_regions,
                )?;
                layer.gerber_data[sublayer_idx]
                    .path_regions
                    .release_cpu_geometry();
                layer.cpu_geometry_released = true;
            }

            region_count
        };

        let layer = self.get_layer(layer_id)?;
        let path_regions = &layer.gerber_data[sublayer_idx].path_regions;
        let buffer_cache = &layer.buffer_caches[sublayer_idx];

        self.gl.enable(STENCIL_TEST);
        self.gl.stencil_mask(0xff);
        self.gl.clear_stencil(0);
        self.gl.clear(STENCIL_BUFFER_BIT);

        let result = (|| {
            for region_idx in 0..region_count {
                self.gl.color_mask(false, false, false, false);
                self.gl.stencil_func(ALWAYS, 0, 0xff);
                self.gl.stencil_op(KEEP, KEEP, INVERT);

                let wedge_start = Self::checked_u32_to_i32(
                    "path wedge vertex start",
                    path_regions.wedge_vertex_offsets[region_idx],
                )?;
                let wedge_end = Self::checked_u32_to_i32(
                    "path wedge vertex end",
                    path_regions.wedge_vertex_offsets[region_idx + 1],
                )?;
                if wedge_end > wedge_start {
                    self.draw_path_solid_range(
                        transform,
                        color,
                        buffer_cache.path_wedge_vao.as_ref(),
                        wedge_start,
                        wedge_end - wedge_start,
                    )?;
                }

                let sector_start = Self::checked_u32_to_i32(
                    "path sector vertex start",
                    path_regions.sector_vertex_offsets[region_idx],
                )?;
                let sector_end = Self::checked_u32_to_i32(
                    "path sector vertex end",
                    path_regions.sector_vertex_offsets[region_idx + 1],
                )?;
                if sector_end > sector_start {
                    self.draw_path_sector_range(
                        transform,
                        buffer_cache,
                        sector_start,
                        sector_end - sector_start,
                    )?;
                }

                self.gl.color_mask(true, true, true, true);
                self.gl.stencil_func(NOTEQUAL, 0, 0xff);
                self.gl.stencil_op(KEEP, KEEP, KEEP);

                self.draw_path_solid_range(
                    transform,
                    color,
                    buffer_cache.path_clear_vao.as_ref(),
                    Self::checked_path_region_quad_start(region_idx)?,
                    6,
                )?;

                self.gl.color_mask(false, false, false, false);
                self.gl.stencil_func(ALWAYS, 0, 0xff);
                self.gl.stencil_op(ZERO, ZERO, ZERO);
                self.draw_path_solid_range(
                    transform,
                    color,
                    buffer_cache.path_cover_vao.as_ref(),
                    Self::checked_path_region_quad_start(region_idx)?,
                    6,
                )?;
            }

            Ok(())
        })();

        self.gl.disable(STENCIL_TEST);
        self.gl.color_mask(true, true, true, true);
        self.gl.bind_vertex_array(None);
        result
    }

    fn create_path_region_gpu_cache(
        gl: &WebGl2RenderingContext,
        programs: &ShaderPrograms,
        buffer_cache: &mut BufferCache,
        path_regions: &PathRegions,
    ) -> Result<(), JsValue> {
        if !path_regions.wedge_vertices.is_empty() {
            let vao = gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create path wedge VAO"))?;
            gl.bind_vertex_array(Some(&vao));
            let buffer = Self::create_vertex_buffer_from_slice(
                gl,
                &path_regions.wedge_vertices,
                &programs.path_solid,
                "position",
                2,
            )?;
            buffer_cache.path_wedge_vertex_count = Self::checked_usize_to_i32(
                "path region wedge vertex count",
                path_regions.wedge_vertices.len() / 2,
            )?;
            buffer_cache.path_wedge_vertex_buffer = Some(buffer);
            buffer_cache.path_wedge_vao = Some(vao);
        }

        if !path_regions.sector_vertices.is_empty() {
            let vao = gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create path sector VAO"))?;
            gl.bind_vertex_array(Some(&vao));
            let buffer = Self::create_path_sector_buffer_from_slice(
                gl,
                &programs.path_sector,
                &path_regions.sector_vertices,
            )?;
            buffer_cache.path_sector_vertex_count = Self::checked_usize_to_i32(
                "path region sector vertex count",
                path_regions.sector_vertices.len() / 7,
            )?;
            buffer_cache.path_sector_vertex_buffer = Some(buffer);
            buffer_cache.path_sector_vao = Some(vao);
        }

        if !path_regions.cover_vertices.is_empty() {
            let vao = gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create path cover VAO"))?;
            gl.bind_vertex_array(Some(&vao));
            let buffer = Self::create_vertex_buffer_from_slice(
                gl,
                &path_regions.cover_vertices,
                &programs.path_solid,
                "position",
                2,
            )?;
            buffer_cache.path_cover_vertex_count = Self::checked_usize_to_i32(
                "path region cover vertex count",
                path_regions.cover_vertices.len() / 2,
            )?;
            buffer_cache.path_cover_vertex_buffer = Some(buffer);
            buffer_cache.path_cover_vao = Some(vao);
        }

        if !path_regions.clear_vertices.is_empty() {
            let vao = gl
                .create_vertex_array()
                .ok_or_else(|| JsValue::from_str("Failed to create path clear VAO"))?;
            gl.bind_vertex_array(Some(&vao));
            let buffer = Self::create_vertex_buffer_from_slice(
                gl,
                &path_regions.clear_vertices,
                &programs.path_solid,
                "position",
                2,
            )?;
            buffer_cache.path_clear_vertex_count = Self::checked_usize_to_i32(
                "path region clear vertex count",
                path_regions.clear_vertices.len() / 2,
            )?;
            buffer_cache.path_clear_vertex_buffer = Some(buffer);
            buffer_cache.path_clear_vao = Some(vao);
        }

        gl.bind_vertex_array(None);
        Ok(())
    }

    fn create_vertex_buffer_from_slice(
        gl: &WebGl2RenderingContext,
        data: &[f32],
        program: &ShaderProgram,
        attr_name: &str,
        components: i32,
    ) -> Result<WebGlBuffer, JsValue> {
        let buffer = gl
            .create_buffer()
            .ok_or_else(|| JsValue::from_str("Failed to create vertex buffer"))?;
        gl.bind_buffer(ARRAY_BUFFER, Some(&buffer));
        Self::upload_f32_slice_to_bound_buffer(gl, data);
        let loc = Self::shader_attribute(program, attr_name)?;
        gl.enable_vertex_attrib_array(loc);
        gl.vertex_attrib_pointer_with_i32(loc, components, FLOAT, false, 0, 0);
        Ok(buffer)
    }

    fn create_path_sector_buffer_from_slice(
        gl: &WebGl2RenderingContext,
        program: &ShaderProgram,
        data: &[f32],
    ) -> Result<WebGlBuffer, JsValue> {
        let buffer = gl
            .create_buffer()
            .ok_or_else(|| JsValue::from_str("Failed to create path sector buffer"))?;
        gl.bind_buffer(ARRAY_BUFFER, Some(&buffer));
        Self::upload_f32_slice_to_bound_buffer(gl, data);

        let stride = 7 * 4;
        Self::enable_interleaved_attribute(gl, program, "position", 2, stride, 0)?;
        Self::enable_interleaved_attribute(gl, program, "center", 2, stride, 2 * 4)?;
        Self::enable_interleaved_attribute(gl, program, "radius", 1, stride, 4 * 4)?;
        Self::enable_interleaved_attribute(gl, program, "startAngle", 1, stride, 5 * 4)?;
        Self::enable_interleaved_attribute(gl, program, "sweepAngle", 1, stride, 6 * 4)?;
        Ok(buffer)
    }

    fn enable_interleaved_attribute(
        gl: &WebGl2RenderingContext,
        program: &ShaderProgram,
        attr_name: &str,
        components: i32,
        stride: i32,
        offset: i32,
    ) -> Result<(), JsValue> {
        let loc = Self::shader_attribute(program, attr_name)?;
        gl.enable_vertex_attrib_array(loc);
        gl.vertex_attrib_pointer_with_i32(loc, components, FLOAT, false, stride, offset);
        Ok(())
    }

    fn draw_path_solid_range(
        &self,
        transform: &[f32; 9],
        color: &[f32; 4],
        vao: Option<&web_sys::WebGlVertexArrayObject>,
        start: i32,
        count: i32,
    ) -> Result<(), JsValue> {
        if count <= 0 {
            return Ok(());
        }
        let Some(vao) = vao else {
            return Ok(());
        };
        let program = &self.programs.path_solid;
        self.gl.use_program(Some(&program.program));
        self.gl.bind_vertex_array(Some(vao));
        if let Some(loc) = program.uniforms.get("transform") {
            self.gl
                .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
        }
        if let Some(loc) = program.uniforms.get("color") {
            self.gl.uniform4fv_with_f32_array(Some(loc), color);
        }
        self.gl.draw_arrays(TRIANGLES, start, count);
        Ok(())
    }

    fn draw_path_sector_range(
        &self,
        transform: &[f32; 9],
        buffer_cache: &BufferCache,
        start: i32,
        count: i32,
    ) -> Result<(), JsValue> {
        if count <= 0 {
            return Ok(());
        }
        let Some(vao) = buffer_cache.path_sector_vao.as_ref() else {
            return Ok(());
        };
        let program = &self.programs.path_sector;
        self.gl.use_program(Some(&program.program));
        self.gl.bind_vertex_array(Some(vao));
        if let Some(loc) = program.uniforms.get("transform") {
            self.gl
                .uniform_matrix3fv_with_f32_array(Some(loc), false, transform);
        }
        self.gl.draw_arrays(TRIANGLES, start, count);
        Ok(())
    }

    /// Render all geometry from a specific user layer (with polarity sublayers)
    fn render_layer_geometry(
        &mut self,
        layer_id: usize,
        transform: &[f32; 9],
        viewport_width: u32,
        viewport_height: u32,
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
            self.draw_instanced_triangle_templates(
                transform,
                &white_color,
                layer_id,
                sublayer_idx,
            )?;
            self.draw_instanced_lines(
                transform,
                &white_color,
                layer_id,
                sublayer_idx,
                viewport_width,
                viewport_height,
            )?;
            self.draw_instanced_circles(
                transform,
                &white_color,
                layer_id,
                sublayer_idx,
                viewport_width,
                viewport_height,
            )?;
            self.draw_instanced_arcs(
                transform,
                &white_color,
                layer_id,
                sublayer_idx,
                viewport_width,
                viewport_height,
            )?;
            self.draw_instanced_thermals(transform, &white_color, layer_id, sublayer_idx)?;
            self.draw_path_regions(transform, &white_color, layer_id, sublayer_idx)?;
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

        self.render_with_transform(active_layer_ids, color_data, alpha, transform, true, None)
    }

    /// Render geometry and optionally preserve the existing canvas contents.
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

        self.update_camera(zoom_x, zoom_y, offset_x, offset_y);
        let (width, height) = self.get_canvas_size()?;
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Cannot render to a zero-sized canvas"));
        }

        let transform = self.camera.get_transform_matrix(width, height);

        self.render_with_transform(
            active_layer_ids,
            color_data,
            alpha,
            transform,
            clear_canvas,
            None,
        )
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
        Self::validate_blend_modes(active_layer_ids, blend_modes)?;

        self.update_camera(zoom_x, zoom_y, offset_x, offset_y);
        let (width, height) = self.get_canvas_size()?;
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Cannot render to a zero-sized canvas"));
        }

        let transform = self.camera.get_transform_matrix(width, height);

        self.render_with_transform(
            active_layer_ids,
            color_data,
            alpha,
            transform,
            clear_canvas,
            Some(blend_modes),
        )
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

        self.render_with_transform(active_layer_ids, color_data, alpha, transform, true, None)
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
        Self::validate_blend_modes(active_layer_ids, blend_modes)?;
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

        self.render_with_transform(
            active_layer_ids,
            color_data,
            alpha,
            transform,
            true,
            Some(blend_modes),
        )
    }

    /// Render to an offscreen framebuffer and return bottom-up RGBA pixels.
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
        Self::validate_render_inputs(
            active_layer_ids,
            color_data,
            zoom_x,
            zoom_y,
            offset_x,
            offset_y,
            alpha,
        )?;

        self.update_camera(zoom_x, zoom_y, offset_x, offset_y);
        let (width, height) = self.get_canvas_size()?;
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Cannot render to a zero-sized canvas"));
        }

        let transform = self.camera.get_transform_matrix(width, height);
        let width_i32 = Self::checked_u32_to_i32("canvas width", width)?;
        let height_i32 = Self::checked_u32_to_i32("canvas height", height)?;
        let pixel_count = Self::checked_u32_to_usize("render output width", width)?
            .checked_mul(Self::checked_u32_to_usize("render output height", height)?)
            .and_then(|value| value.checked_mul(4))
            .ok_or_else(|| JsValue::from_str("Render output size exceeds platform limits"))?;
        let mut pixels = Self::reserved_vec("render output pixels", pixel_count)?;
        pixels.resize(pixel_count, 0);

        let output_fbo = Self::create_fbo(&self.gl, width, height, false)?;
        let result = (|| {
            self.render_layer_fbos(active_layer_ids, transform, width, height)?;
            self.composite_layers_to_target(
                active_layer_ids,
                color_data,
                alpha,
                clear_canvas,
                None,
                Some(&output_fbo.framebuffer),
            )?;
            self.gl
                .read_pixels_with_opt_u8_array(
                    0,
                    0,
                    width_i32,
                    height_i32,
                    WebGl2RenderingContext::RGBA,
                    WebGl2RenderingContext::UNSIGNED_BYTE,
                    Some(&mut pixels),
                )
                .map_err(|error| {
                    if error.is_string() {
                        error
                    } else {
                        JsValue::from_str("Failed to read rendered pixels")
                    }
                })?;
            Ok(pixels)
        })();

        Self::delete_fbo(&self.gl, output_fbo);
        result
    }

    /// Render to an offscreen framebuffer with per-layer composite modes.
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
        Self::validate_render_inputs(
            active_layer_ids,
            color_data,
            zoom_x,
            zoom_y,
            offset_x,
            offset_y,
            alpha,
        )?;
        Self::validate_blend_modes(active_layer_ids, blend_modes)?;

        self.update_camera(zoom_x, zoom_y, offset_x, offset_y);
        let (width, height) = self.get_canvas_size()?;
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Cannot render to a zero-sized canvas"));
        }

        let transform = self.camera.get_transform_matrix(width, height);
        let width_i32 = Self::checked_u32_to_i32("canvas width", width)?;
        let height_i32 = Self::checked_u32_to_i32("canvas height", height)?;
        let pixel_count = Self::checked_u32_to_usize("render output width", width)?
            .checked_mul(Self::checked_u32_to_usize("render output height", height)?)
            .and_then(|value| value.checked_mul(4))
            .ok_or_else(|| JsValue::from_str("Render output size exceeds platform limits"))?;
        let mut pixels = Self::reserved_vec("render output pixels", pixel_count)?;
        pixels.resize(pixel_count, 0);

        let output_fbo = Self::create_fbo(&self.gl, width, height, false)?;
        let result = (|| {
            self.render_layer_fbos(active_layer_ids, transform, width, height)?;
            self.composite_layers_to_target(
                active_layer_ids,
                color_data,
                alpha,
                clear_canvas,
                Some(blend_modes),
                Some(&output_fbo.framebuffer),
            )?;
            self.gl
                .read_pixels_with_opt_u8_array(
                    0,
                    0,
                    width_i32,
                    height_i32,
                    WebGl2RenderingContext::RGBA,
                    WebGl2RenderingContext::UNSIGNED_BYTE,
                    Some(&mut pixels),
                )
                .map_err(|error| {
                    if error.is_string() {
                        error
                    } else {
                        JsValue::from_str("Failed to read rendered pixels")
                    }
                })?;
            Ok(pixels)
        })();

        Self::delete_fbo(&self.gl, output_fbo);
        result
    }

    fn render_with_transform(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        alpha: f32,
        transform: [f32; 9],
        clear_canvas: bool,
        blend_modes: Option<&[u8]>,
    ) -> Result<(), JsValue> {
        let (width, height) = self.get_canvas_size()?;
        if width == 0 || height == 0 {
            return Err(JsValue::from_str("Cannot render to a zero-sized canvas"));
        }

        // STEP 1: Render active layer geometry to FBOs only when geometry/camera state changed.
        self.render_layer_fbos(active_layer_ids, transform, width, height)?;

        // STEP 2: Composite FBOs to canvas
        self.composite_layers(
            active_layer_ids,
            color_data,
            alpha,
            clear_canvas,
            blend_modes,
        )?;

        Ok(())
    }

    fn render_layer_fbos(
        &mut self,
        active_layer_ids: &[u32],
        transform: [f32; 9],
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        let width_i32 = Self::checked_u32_to_i32("canvas width", width)?;
        let height_i32 = Self::checked_u32_to_i32("canvas height", height)?;

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
                self.gl.viewport(0, 0, width_i32, height_i32);

                // Clear layer FBO
                self.gl.clear_color(0.0, 0.0, 0.0, 0.0);
                self.gl.clear(COLOR_BUFFER_BIT);

                // Render layer geometry (with polarity blending handled internally)
                self.render_layer_geometry(layer_idx, &transform, width, height)?;

                if let Some(layer) = &mut self.layers[layer_idx] {
                    layer.fbo_dirty = false;
                    layer.fbo_transform = Some(transform);
                }
            }
        }

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
        clear_canvas: bool,
        blend_modes: Option<&[u8]>,
    ) -> Result<(), JsValue> {
        self.composite_layers_to_target(
            active_layer_ids,
            color_data,
            alpha,
            clear_canvas,
            blend_modes,
            None,
        )
    }

    fn composite_layers_to_target(
        &mut self,
        active_layer_ids: &[u32],
        color_data: &[f32],
        alpha: f32,
        clear_canvas: bool,
        blend_modes: Option<&[u8]>,
        target_framebuffer: Option<&WebGlFramebuffer>,
    ) -> Result<(), JsValue> {
        // Get canvas dimensions
        let (width, height) = self.get_canvas_size()?;
        let width_i32 = Self::checked_u32_to_i32("canvas width", width)?;
        let height_i32 = Self::checked_u32_to_i32("canvas height", height)?;

        // Bind output framebuffer
        self.gl
            .bind_framebuffer(WebGl2RenderingContext::FRAMEBUFFER, target_framebuffer);
        self.gl.viewport(0, 0, width_i32, height_i32);

        if clear_canvas {
            self.gl.clear_color(0.0, 0.0, 0.0, 0.0);
            self.gl.clear(COLOR_BUFFER_BIT);
        }

        self.gl.enable(BLEND);
        self.gl.blend_equation(FUNC_ADD);

        // Render each active layer's FBO to canvas with its color/alpha
        let color_stride = Self::color_data_stride(active_layer_ids, color_data);
        for (color_index, &layer_id) in active_layer_ids.iter().enumerate() {
            let layer_idx = layer_id as usize;

            if let Some(layer) = &self.layers[layer_idx] {
                let color_offset = color_index * color_stride;
                if color_offset + color_stride <= color_data.len() {
                    let layer_alpha = if color_stride == 4 {
                        color_data[color_offset + 3] * alpha
                    } else {
                        alpha
                    };
                    let color = [
                        color_data[color_offset],
                        color_data[color_offset + 1],
                        color_data[color_offset + 2],
                        layer_alpha,
                    ];
                    match Self::blend_mode_at(blend_modes, color_index) {
                        1 => {
                            self.gl.blend_func_separate(
                                ONE,
                                ONE_MINUS_SRC_ALPHA,
                                ONE,
                                ONE_MINUS_SRC_ALPHA,
                            );
                        }
                        2 => {
                            self.gl.blend_func_separate(
                                ZERO,
                                ONE_MINUS_SRC_ALPHA,
                                ZERO,
                                ONE_MINUS_SRC_ALPHA,
                            );
                        }
                        _ => self.gl.blend_func(ONE, ONE),
                    }
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
        self.resize_to(width, height)
    }

    /// Resize framebuffers to explicit dimensions.
    pub fn resize_to(&mut self, width: u32, height: u32) -> Result<(), JsValue> {
        Self::validate_framebuffer_size(width, height)?;
        if self.explicit_size.is_some() {
            self.explicit_size = Some((width, height));
        }

        // Recreate FBO for each active layer
        for layer in self.layers.iter_mut().flatten() {
            let old_fbo = std::mem::replace(
                &mut layer.fbo,
                Self::create_fbo(&self.gl, width, height, layer.has_path_regions)?,
            );
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
        let (width, height) = match self.explicit_size {
            Some(size) => size,
            None => Self::get_canvas_size_from_gl(&gl)?,
        };
        let mut new_fbos = Self::reserved_vec("restored framebuffers", self.layers.len())?;

        for layer in &self.layers {
            if layer.is_some() {
                let has_path_regions = layer.as_ref().is_some_and(|layer| layer.has_path_regions);
                let fbo = match Self::create_fbo(&gl, width, height, has_path_regions) {
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
                layer.buffer_caches = Self::create_buffer_caches(layer.gerber_data.len())?;
                layer.fbo_dirty = true;
                layer.fbo_transform = None;
            }
        }

        old_gl.delete_buffer(Some(&old_quad_buffer));
        Self::delete_shader_programs(&old_gl, &old_programs);
        Self::delete_highlight_resources_from(
            &old_gl,
            &mut self.highlight_program,
            &mut self.highlight_stencil_program,
            &mut self.highlight_buffer,
            &mut self.highlight_vertex_array,
        );
        self.gl = gl;

        Ok(())
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        self.clear_all();
        self.delete_highlight_resources();
        self.gl.delete_buffer(Some(&self.quad_buffer));
        Self::delete_shader_programs(&self.gl, &self.programs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::GerberParser;

    fn outline_line(start: [f32; 2], end: [f32; 2]) -> OutlineSegment {
        OutlineSegment {
            start,
            end,
            points: vec![start, end],
            segment: RegionSegment::Line { start, end },
        }
    }

    fn empty_gerber_data(boundary: Boundary, is_negative: bool) -> GerberData {
        GerberData::new(
            Triangles::new(Vec::new(), Vec::new(), Vec::new(), Vec::new()),
            Vec::new(),
            Lines::new(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()),
            Circles::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Arcs::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Thermals::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            PathRegions::empty(),
            boundary,
            is_negative,
        )
    }

    fn parse_gerber_with_source_contours(data: &str) -> Vec<GerberData> {
        let mut parser = GerberParser::with_options(true, 1);
        parser.preserve_region_source_contours = true;
        parser
            .parse(data)
            .expect("Gerber with source contours should parse")
    }

    #[test]
    fn validate_offsets_rejects_nonzero_initial_offset() {
        assert!(Renderer::validate_offsets_invariant("path wedge offsets", 0, &[0, 9], 9).is_ok());
        assert!(Renderer::validate_offsets_invariant("path wedge offsets", 0, &[1, 9], 9).is_err());
        assert!(
            Renderer::validate_offsets_invariant("path sector offsets", 0, &[2, 6], 6).is_err()
        );
    }

    #[test]
    fn validate_path_region_data_accepts_normalized_empty_offsets() {
        let path_regions = PathRegions::new(vec![], vec![], vec![], vec![], vec![], vec![]);
        assert_eq!(path_regions.wedge_vertex_offsets, vec![0]);
        assert_eq!(path_regions.sector_vertex_offsets, vec![0]);
        assert!(Renderer::validate_path_region_data(&path_regions, 0).is_ok());
    }

    #[test]
    fn closed_outline_regions_preserve_multiple_contours() {
        let segments = vec![
            outline_line([0.0, 0.0], [10.0, 0.0]),
            outline_line([10.0, 0.0], [10.0, 10.0]),
            outline_line([10.0, 10.0], [0.0, 10.0]),
            outline_line([0.0, 10.0], [0.0, 0.0]),
            outline_line([3.0, 3.0], [7.0, 3.0]),
            outline_line([7.0, 3.0], [7.0, 7.0]),
            outline_line([7.0, 7.0], [3.0, 7.0]),
            outline_line([3.0, 7.0], [3.0, 3.0]),
        ];

        let contours = Renderer::closed_outline_regions(&segments);
        assert_eq!(contours.len(), 2);
        let boundary = Renderer::outline_regions_boundary(&contours).expect("finite boundary");
        assert!((boundary.min_x() - 0.0).abs() < 0.0001);
        assert!((boundary.max_x() - 10.0).abs() < 0.0001);
        assert!((boundary.min_y() - 0.0).abs() < 0.0001);
        assert!((boundary.max_y() - 10.0).abs() < 0.0001);
    }

    #[test]
    fn closed_outline_regions_accept_arc_only_circle() {
        let center = [5.0, 5.0];
        let radius = 2.0;
        let start_angle = 0.0;
        let sweep_angle = std::f32::consts::PI * 2.0;
        let points = Renderer::outline_arc_points(center, radius, start_angle, sweep_angle);
        let start = points[0];
        let end = *points.last().expect("arc endpoint");
        let segments = vec![OutlineSegment {
            start,
            end,
            points,
            segment: RegionSegment::Arc {
                start,
                end,
                center,
                radius,
                start_angle,
                sweep_angle,
            },
        }];

        let contours = Renderer::closed_outline_regions(&segments);
        assert_eq!(contours.len(), 1);
        assert!(contours[0].has_arc);
        assert!(contours[0].points.len() >= 4);
        let boundary = Renderer::outline_regions_boundary(&contours).expect("finite boundary");
        assert!((boundary.min_x() - 3.0).abs() < 0.0001);
        assert!((boundary.max_x() - 7.0).abs() < 0.0001);
        assert!((boundary.min_y() - 3.0).abs() < 0.0001);
        assert!((boundary.max_y() - 7.0).abs() < 0.0001);
    }

    #[test]
    fn outside_clip_layer_covers_target_overflow() {
        let fill_bounds = Boundary::new(0.0, 10.0, 0.0, 10.0);
        let fill_contours = vec![Renderer::bounds_region_contour(&fill_bounds).unwrap()];
        let target = empty_gerber_data(Boundary::new(-2.0, 12.0, -3.0, 11.0), false);

        let clip = Renderer::outside_clip_layer(&fill_contours, &fill_bounds, &[target]).unwrap();

        assert!(clip.is_negative);
        assert!(clip.path_regions.has_geometry());
        assert_eq!(clip.path_regions.region_count(), 1);
        assert!((clip.boundary.min_x() + 2.0).abs() < 0.0001);
        assert!((clip.boundary.max_x() - 12.0).abs() < 0.0001);
        assert!((clip.boundary.min_y() + 3.0).abs() < 0.0001);
        assert!((clip.boundary.max_y() - 11.0).abs() < 0.0001);
    }

    #[test]
    fn region_outline_fill_uses_source_region_contours() {
        let outline_data = "\
%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X000000Y000000D02*
G01*
X010000Y000000D01*
X010000Y010000D01*
X000000Y010000D01*
G37*
M02*";
        let default_layers = GerberParser::with_options(true, 1)
            .parse(outline_data)
            .expect("default region outline should parse");
        assert!(!default_layers[0].path_regions.has_source_contours());

        let outline_layers = parse_gerber_with_source_contours(
            "\
%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X000000Y000000D02*
G01*
X010000Y000000D01*
X010000Y010000D01*
X000000Y010000D01*
G37*
M02*",
        );

        assert_eq!(outline_layers.len(), 1);
        assert!(!outline_layers[0].path_regions.has_geometry());
        assert!(outline_layers[0].path_regions.has_source_contours());

        let (fill_layers, fill_contours) = Renderer::region_outline_fill_layers(&outline_layers)
            .expect("region outline fill should build")
            .expect("region outline source should be used");

        assert_eq!(fill_layers.len(), 1);
        assert!(!fill_layers[0].is_negative);
        assert!(fill_layers[0].path_regions.has_geometry());
        assert_eq!(fill_layers[0].path_regions.region_count(), 1);
        assert_eq!(fill_contours.len(), 1);
    }

    #[test]
    fn region_outline_fill_preserves_source_sublayer_polarity() {
        let outline_layers = parse_gerber_with_source_contours(
            "\
%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X000000Y000000D02*
G01*
X020000Y000000D01*
X020000Y020000D01*
X000000Y020000D01*
G37*
%LPC*%
G36*
X005000Y005000D02*
G01*
X015000Y005000D01*
X015000Y015000D01*
X005000Y015000D01*
G37*
M02*",
        );

        assert_eq!(outline_layers.len(), 2);
        assert!(outline_layers
            .iter()
            .all(|layer| layer.path_regions.has_source_contours()));

        let (fill_layers, fill_contours) = Renderer::region_outline_fill_layers(&outline_layers)
            .expect("region outline fill should build")
            .expect("region outline source should be used");

        assert_eq!(fill_layers.len(), 2);
        assert!(!fill_layers[0].is_negative);
        assert!(fill_layers[1].is_negative);
        assert_eq!(fill_contours.len(), 2);

        let fill_boundary =
            fill_layers_boundary(&fill_layers).expect("fill layer boundary should be finite");
        let clip_layer = Renderer::outside_clip_layer(&fill_contours, &fill_boundary, &[])
            .expect("outside clip should be built from all source contours");
        assert!(clip_layer.is_negative);
        assert!(clip_layer.path_regions.has_geometry());
    }

    #[test]
    fn region_outline_fill_preserves_arc_source_contours() {
        let outline_layers = parse_gerber_with_source_contours(
            "\
%FSLAX24Y24*%
%MOMM*%
G75*
%LPD*%
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
X010000Y000000I010000J000000D01*
G37*
M02*",
        );

        assert_eq!(outline_layers.len(), 1);
        assert!(outline_layers[0].path_regions.has_geometry());
        assert!(outline_layers[0].path_regions.has_source_contours());

        let (fill_layers, fill_contours) = Renderer::region_outline_fill_layers(&outline_layers)
            .expect("arc region outline fill should build")
            .expect("arc region outline source should be used");

        assert_eq!(fill_layers.len(), 1);
        assert!(fill_contours.iter().any(|contour| contour.has_arc));
        assert!(!fill_layers[0].path_regions.sector_vertices.is_empty());
    }

    #[test]
    fn region_source_contours_survive_following_draw_geometry() {
        let layers = parse_gerber_with_source_contours(
            "\
%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X000000Y000000D02*
G01*
X010000Y000000D01*
X010000Y010000D01*
X000000Y010000D01*
G37*
%ADD10C,0.100*%
D10*
X020000Y000000D02*
X030000Y000000D01*
M02*",
        );

        assert_eq!(layers.len(), 1);
        assert!(layers[0].path_regions.has_source_contours());
        assert!(!layers[0].lines.start_x.is_empty());
    }

    #[test]
    fn inverted_outline_fill_prefers_closed_aperture_outline_over_region_source() {
        let outline_layers = parse_gerber_with_source_contours(
            "\
%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.100*%
D10*
X000000Y000000D02*
X040000Y000000D01*
X040000Y040000D01*
X000000Y040000D01*
X000000Y000000D01*
%LPD*%
G36*
X010000Y010000D02*
G01*
X020000Y010000D01*
X020000Y020000D01*
X010000Y020000D01*
G37*
M02*",
        );

        let (fill_layers, fill_contours) = Renderer::inverted_outline_fill_layers(&outline_layers)
            .expect("mixed outline source should build fill");

        assert_eq!(fill_layers.len(), 1);
        assert_eq!(fill_contours.len(), 1);
        assert!((fill_layers[0].boundary.min_x() - 0.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.max_x() - 4.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.min_y() - 0.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.max_y() - 4.0).abs() < 0.0001);
    }

    #[test]
    fn inverted_outline_fill_uses_zero_width_aperture_lines() {
        let outline_layers = parse_gerber_with_source_contours(
            "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,0.0*%
D10*
X0000000Y0000000D02*
X1000000Y0000000D01*
X1000000Y1000000D01*
X0000000Y1000000D01*
X0000000Y0000000D01*
M02*",
        );

        let (fill_layers, fill_contours) = Renderer::inverted_outline_fill_layers(&outline_layers)
            .expect("zero-width line outline should build fill");

        assert_eq!(fill_layers.len(), 1);
        assert_eq!(fill_contours.len(), 1);
        assert!((fill_layers[0].boundary.min_x() - 0.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.max_x() - 1.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.min_y() - 0.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.max_y() - 1.0).abs() < 0.0001);
    }

    #[test]
    fn inverted_outline_fill_uses_zero_width_aperture_arcs() {
        let outline_layers = parse_gerber_with_source_contours(
            "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,0.0*%
D10*
G03*
G75*
X1000000Y0000000D02*
X1000000Y0000000I-1000000J0000000D01*
M02*",
        );

        let (fill_layers, fill_contours) = Renderer::inverted_outline_fill_layers(&outline_layers)
            .expect("zero-width arc outline should build fill");

        assert_eq!(fill_layers.len(), 1);
        assert_eq!(fill_contours.len(), 1);
        assert!(fill_contours[0].has_arc);
        assert!((fill_layers[0].boundary.min_x() + 1.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.max_x() - 1.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.min_y() + 1.0).abs() < 0.0001);
        assert!((fill_layers[0].boundary.max_y() - 1.0).abs() < 0.0001);
    }
}
