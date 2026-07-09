use crate::geometry::{RegionContour, RegionSegment};
use js_sys::{Array, Float32Array, Object, Reflect, Uint32Array};
use wasm_bindgen::prelude::*;

fn set_property(object: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), value)
        .map(|_| ())
        .map_err(|_| JsValue::from_str(&format!("Failed to set parsed layer field `{key}`")))
}

fn get_property(value: &JsValue, key: &str) -> Result<JsValue, JsValue> {
    Reflect::get(value, &JsValue::from_str(key))
        .map_err(|_| JsValue::from_str(&format!("Missing parsed layer field `{key}`")))
}

fn f32_array_to_js(values: &[f32]) -> JsValue {
    let array = Float32Array::new_with_length(values.len() as u32);
    array.copy_from(values);
    array.into()
}

fn f32_array_from_js(value: &JsValue, key: &str) -> Result<Vec<f32>, JsValue> {
    Ok(Float32Array::new(&get_property(value, key)?).to_vec())
}

fn u32_array_to_js(values: &[u32]) -> JsValue {
    let array = Uint32Array::new_with_length(values.len() as u32);
    array.copy_from(values);
    array.into()
}

fn u32_array_from_js(value: &JsValue, key: &str) -> Result<Vec<u32>, JsValue> {
    Ok(Uint32Array::new(&get_property(value, key)?).to_vec())
}

fn f32_property_from_js(value: &JsValue, key: &str) -> Result<f32, JsValue> {
    let number = get_property(value, key)?
        .as_f64()
        .ok_or_else(|| JsValue::from_str(&format!("Parsed layer field `{key}` is not numeric")))?;
    let value = number as f32;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(JsValue::from_str(&format!(
            "Parsed layer field `{key}` must be finite"
        )))
    }
}

fn usize_property_from_js(value: &JsValue, key: &str) -> Result<usize, JsValue> {
    let number = get_property(value, key)?
        .as_f64()
        .ok_or_else(|| JsValue::from_str(&format!("Parsed layer field `{key}` is not numeric")))?;
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 {
        return Err(JsValue::from_str(&format!(
            "Parsed layer field `{key}` must be a non-negative integer"
        )));
    }
    Ok(number as usize)
}

fn translate_point_pairs(values: &mut [f32], dx: f32, dy: f32) {
    for point in values.chunks_exact_mut(2) {
        point[0] += dx;
        point[1] += dy;
    }
}

fn translate_components(xs: &mut [f32], ys: &mut [f32], dx: f32, dy: f32) {
    for x in xs {
        *x += dx;
    }

    for y in ys {
        *y += dy;
    }
}

/// Triangle mesh data structure
pub struct Triangles {
    pub(crate) vertices: Vec<f32>,
    pub(crate) hole_x: Vec<f32>,
    pub(crate) hole_y: Vec<f32>,
    pub(crate) hole_radius: Vec<f32>,
}

impl Triangles {
    pub fn new(
        vertices: Vec<f32>,
        hole_x: Vec<f32>,
        hole_y: Vec<f32>,
        hole_radius: Vec<f32>,
    ) -> Triangles {
        Triangles {
            vertices,
            hole_x,
            hole_y,
            hole_radius,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.vertices = Vec::new();
        self.hole_x = Vec::new();
        self.hole_y = Vec::new();
        self.hole_radius = Vec::new();
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        translate_point_pairs(&mut self.vertices, dx, dy);
        translate_components(&mut self.hole_x, &mut self.hole_y, dx, dy);
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "vertices", &f32_array_to_js(&self.vertices))?;
        set_property(&object, "holeX", &f32_array_to_js(&self.hole_x))?;
        set_property(&object, "holeY", &f32_array_to_js(&self.hole_y))?;
        set_property(&object, "holeRadius", &f32_array_to_js(&self.hole_radius))?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Triangles, JsValue> {
        Ok(Triangles::new(
            f32_array_from_js(value, "vertices")?,
            f32_array_from_js(value, "holeX")?,
            f32_array_from_js(value, "holeY")?,
            f32_array_from_js(value, "holeRadius")?,
        ))
    }
}

/// Triangle mesh template rendered at many flash positions.
pub struct TriangleTemplateInstances {
    pub(crate) vertices: Vec<f32>,
    pub(crate) instance_x: Vec<f32>,
    pub(crate) instance_y: Vec<f32>,
}

impl TriangleTemplateInstances {
    pub fn new(
        vertices: Vec<f32>,
        instance_x: Vec<f32>,
        instance_y: Vec<f32>,
    ) -> TriangleTemplateInstances {
        TriangleTemplateInstances {
            vertices,
            instance_x,
            instance_y,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.vertices = Vec::new();
        self.instance_x = Vec::new();
        self.instance_y = Vec::new();
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        translate_components(&mut self.instance_x, &mut self.instance_y, dx, dy);
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "vertices", &f32_array_to_js(&self.vertices))?;
        set_property(&object, "instanceX", &f32_array_to_js(&self.instance_x))?;
        set_property(&object, "instanceY", &f32_array_to_js(&self.instance_y))?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<TriangleTemplateInstances, JsValue> {
        Ok(TriangleTemplateInstances::new(
            f32_array_from_js(value, "vertices")?,
            f32_array_from_js(value, "instanceX")?,
            f32_array_from_js(value, "instanceY")?,
        ))
    }
}

/// Instanced straight line body rendered between two round caps.
pub struct Lines {
    pub(crate) start_x: Vec<f32>,
    pub(crate) start_y: Vec<f32>,
    pub(crate) end_x: Vec<f32>,
    pub(crate) end_y: Vec<f32>,
    pub(crate) width: Vec<f32>,
}

impl Lines {
    pub fn new(
        start_x: Vec<f32>,
        start_y: Vec<f32>,
        end_x: Vec<f32>,
        end_y: Vec<f32>,
        width: Vec<f32>,
    ) -> Lines {
        Lines {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.start_x = Vec::new();
        self.start_y = Vec::new();
        self.end_x = Vec::new();
        self.end_y = Vec::new();
        self.width = Vec::new();
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        translate_components(&mut self.start_x, &mut self.start_y, dx, dy);
        translate_components(&mut self.end_x, &mut self.end_y, dx, dy);
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "startX", &f32_array_to_js(&self.start_x))?;
        set_property(&object, "startY", &f32_array_to_js(&self.start_y))?;
        set_property(&object, "endX", &f32_array_to_js(&self.end_x))?;
        set_property(&object, "endY", &f32_array_to_js(&self.end_y))?;
        set_property(&object, "width", &f32_array_to_js(&self.width))?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Lines, JsValue> {
        Ok(Lines::new(
            f32_array_from_js(value, "startX")?,
            f32_array_from_js(value, "startY")?,
            f32_array_from_js(value, "endX")?,
            f32_array_from_js(value, "endY")?,
            f32_array_from_js(value, "width")?,
        ))
    }
}

/// Circle primitive data structure
pub struct Circles {
    pub(crate) x: Vec<f32>,
    pub(crate) y: Vec<f32>,
    pub(crate) radius: Vec<f32>,
    pub(crate) hole_x: Vec<f32>,
    pub(crate) hole_y: Vec<f32>,
    pub(crate) hole_radius: Vec<f32>,
}

impl Circles {
    pub fn new(
        x: Vec<f32>,
        y: Vec<f32>,
        radius: Vec<f32>,
        hole_x: Vec<f32>,
        hole_y: Vec<f32>,
        hole_radius: Vec<f32>,
    ) -> Circles {
        Circles {
            x,
            y,
            radius,
            hole_x,
            hole_y,
            hole_radius,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x = Vec::new();
        self.y = Vec::new();
        self.radius = Vec::new();
        self.hole_x = Vec::new();
        self.hole_y = Vec::new();
        self.hole_radius = Vec::new();
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        translate_components(&mut self.x, &mut self.y, dx, dy);
        translate_components(&mut self.hole_x, &mut self.hole_y, dx, dy);
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "x", &f32_array_to_js(&self.x))?;
        set_property(&object, "y", &f32_array_to_js(&self.y))?;
        set_property(&object, "radius", &f32_array_to_js(&self.radius))?;
        set_property(&object, "holeX", &f32_array_to_js(&self.hole_x))?;
        set_property(&object, "holeY", &f32_array_to_js(&self.hole_y))?;
        set_property(&object, "holeRadius", &f32_array_to_js(&self.hole_radius))?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Circles, JsValue> {
        Ok(Circles::new(
            f32_array_from_js(value, "x")?,
            f32_array_from_js(value, "y")?,
            f32_array_from_js(value, "radius")?,
            f32_array_from_js(value, "holeX")?,
            f32_array_from_js(value, "holeY")?,
            f32_array_from_js(value, "holeRadius")?,
        ))
    }
}

/// Arc primitive data structure
pub struct Arcs {
    pub(crate) x: Vec<f32>,
    pub(crate) y: Vec<f32>,
    pub(crate) radius: Vec<f32>,
    pub(crate) start_angle: Vec<f32>,
    pub(crate) sweep_angle: Vec<f32>,
    pub(crate) thickness: Vec<f32>,
}

impl Arcs {
    pub fn new(
        x: Vec<f32>,
        y: Vec<f32>,
        radius: Vec<f32>,
        start_angle: Vec<f32>,
        sweep_angle: Vec<f32>,
        thickness: Vec<f32>,
    ) -> Arcs {
        Arcs {
            x,
            y,
            radius,
            start_angle,
            sweep_angle,
            thickness,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x = Vec::new();
        self.y = Vec::new();
        self.radius = Vec::new();
        self.start_angle = Vec::new();
        self.sweep_angle = Vec::new();
        self.thickness = Vec::new();
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        translate_components(&mut self.x, &mut self.y, dx, dy);
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "x", &f32_array_to_js(&self.x))?;
        set_property(&object, "y", &f32_array_to_js(&self.y))?;
        set_property(&object, "radius", &f32_array_to_js(&self.radius))?;
        set_property(&object, "startAngle", &f32_array_to_js(&self.start_angle))?;
        set_property(&object, "sweepAngle", &f32_array_to_js(&self.sweep_angle))?;
        set_property(&object, "thickness", &f32_array_to_js(&self.thickness))?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Arcs, JsValue> {
        Ok(Arcs::new(
            f32_array_from_js(value, "x")?,
            f32_array_from_js(value, "y")?,
            f32_array_from_js(value, "radius")?,
            f32_array_from_js(value, "startAngle")?,
            f32_array_from_js(value, "sweepAngle")?,
            f32_array_from_js(value, "thickness")?,
        ))
    }
}

/// Thermal primitive data structure
pub struct Thermals {
    pub(crate) x: Vec<f32>,
    pub(crate) y: Vec<f32>,
    pub(crate) outer_diameter: Vec<f32>,
    pub(crate) inner_diameter: Vec<f32>,
    pub(crate) gap_thickness: Vec<f32>,
    pub(crate) rotation: Vec<f32>,
}

impl Thermals {
    pub fn new(
        x: Vec<f32>,
        y: Vec<f32>,
        outer_diameter: Vec<f32>,
        inner_diameter: Vec<f32>,
        gap_thickness: Vec<f32>,
        rotation: Vec<f32>,
    ) -> Thermals {
        Thermals {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x = Vec::new();
        self.y = Vec::new();
        self.outer_diameter = Vec::new();
        self.inner_diameter = Vec::new();
        self.gap_thickness = Vec::new();
        self.rotation = Vec::new();
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        translate_components(&mut self.x, &mut self.y, dx, dy);
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "x", &f32_array_to_js(&self.x))?;
        set_property(&object, "y", &f32_array_to_js(&self.y))?;
        set_property(
            &object,
            "outerDiameter",
            &f32_array_to_js(&self.outer_diameter),
        )?;
        set_property(
            &object,
            "innerDiameter",
            &f32_array_to_js(&self.inner_diameter),
        )?;
        set_property(
            &object,
            "gapThickness",
            &f32_array_to_js(&self.gap_thickness),
        )?;
        set_property(&object, "rotation", &f32_array_to_js(&self.rotation))?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Thermals, JsValue> {
        Ok(Thermals::new(
            f32_array_from_js(value, "x")?,
            f32_array_from_js(value, "y")?,
            f32_array_from_js(value, "outerDiameter")?,
            f32_array_from_js(value, "innerDiameter")?,
            f32_array_from_js(value, "gapThickness")?,
            f32_array_from_js(value, "rotation")?,
        ))
    }
}

/// Arc-containing region path data rendered by the WebGL stencil path renderer.
///
/// Large regions are stored in flat buffers to avoid per-segment JS objects:
/// - `wedge_vertices`: one or two stencil fan triangles per path segment
/// - `sector_vertices`: analytic arc cap quads, 5 floats per vertex
/// - `cover_vertices`: one screen-coverable bounding quad per region
/// - `clear_vertices`: one quad covering all stencil writes per region
#[derive(Clone, Debug)]
pub struct PathRegions {
    pub(crate) wedge_vertices: Vec<f32>,
    pub(crate) wedge_vertex_offsets: Vec<u32>,
    pub(crate) sector_vertices: Vec<f32>,
    pub(crate) sector_vertex_offsets: Vec<u32>,
    pub(crate) cover_vertices: Vec<f32>,
    pub(crate) clear_vertices: Vec<f32>,
    pub(crate) pick_contours: Vec<Vec<Vec<[f32; 2]>>>,
    pub(crate) source_contours: Vec<Vec<RegionContour>>,
}

pub(crate) const PATH_SECTOR_VERTEX_FLOATS: usize = 5;

impl PathRegions {
    pub fn new(
        wedge_vertices: Vec<f32>,
        wedge_vertex_offsets: Vec<u32>,
        sector_vertices: Vec<f32>,
        sector_vertex_offsets: Vec<u32>,
        cover_vertices: Vec<f32>,
        clear_vertices: Vec<f32>,
    ) -> PathRegions {
        PathRegions {
            wedge_vertices,
            wedge_vertex_offsets: normalize_offsets(wedge_vertex_offsets),
            sector_vertices,
            sector_vertex_offsets: normalize_offsets(sector_vertex_offsets),
            cover_vertices,
            clear_vertices,
            pick_contours: Vec::new(),
            source_contours: Vec::new(),
        }
    }

    pub fn empty() -> PathRegions {
        PathRegions {
            wedge_vertices: Vec::new(),
            wedge_vertex_offsets: vec![0],
            sector_vertices: Vec::new(),
            sector_vertex_offsets: vec![0],
            cover_vertices: Vec::new(),
            clear_vertices: Vec::new(),
            pick_contours: Vec::new(),
            source_contours: Vec::new(),
        }
    }

    pub(crate) fn region_count(&self) -> usize {
        self.wedge_vertex_offsets.len().saturating_sub(1)
    }

    pub(crate) fn work_item_count(&self) -> usize {
        self.wedge_vertices
            .len()
            .saturating_add(self.sector_vertices.len())
            .saturating_add(self.cover_vertices.len())
            .saturating_add(self.clear_vertices.len())
            .saturating_add(
                self.pick_contours
                    .iter()
                    .flat_map(|region| region.iter())
                    .map(Vec::len)
                    .sum::<usize>(),
            )
            .saturating_add(
                self.source_contours
                    .iter()
                    .flat_map(|region| region.iter())
                    .map(|contour| contour.points.len().saturating_add(contour.segments.len()))
                    .sum::<usize>(),
            )
    }

    pub(crate) fn has_geometry(&self) -> bool {
        self.region_count() > 0
            && (!self.wedge_vertices.is_empty()
                || !self.sector_vertices.is_empty()
                || !self.cover_vertices.is_empty()
                || !self.clear_vertices.is_empty())
    }

    pub(crate) fn append(&mut self, other: PathRegions) {
        if !other.has_geometry() && !other.has_source_contours() {
            return;
        }

        let wedge_base = (self.wedge_vertices.len() / 2) as u32;
        let sector_base = (self.sector_vertices.len() / PATH_SECTOR_VERTEX_FLOATS) as u32;
        self.wedge_vertices.extend(other.wedge_vertices);
        self.sector_vertices.extend(other.sector_vertices);
        self.cover_vertices.extend(other.cover_vertices);
        self.clear_vertices.extend(other.clear_vertices);
        self.pick_contours.extend(other.pick_contours);
        self.source_contours.extend(other.source_contours);

        for offset in other.wedge_vertex_offsets.iter().skip(1) {
            self.wedge_vertex_offsets.push(wedge_base + offset);
        }
        for offset in other.sector_vertex_offsets.iter().skip(1) {
            self.sector_vertex_offsets.push(sector_base + offset);
        }
    }

    pub(crate) fn clone_for_interaction_pick(&self) -> PathRegions {
        PathRegions {
            wedge_vertices: Vec::new(),
            wedge_vertex_offsets: vec![0],
            sector_vertices: Vec::new(),
            sector_vertex_offsets: vec![0],
            cover_vertices: Vec::new(),
            clear_vertices: Vec::new(),
            pick_contours: self.pick_contours.clone(),
            source_contours: Vec::new(),
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.wedge_vertices = Vec::new();
        self.sector_vertices = Vec::new();
        self.cover_vertices = Vec::new();
        self.clear_vertices = Vec::new();
        self.pick_contours = Vec::new();
        self.source_contours = Vec::new();
    }

    pub(crate) fn has_source_contours(&self) -> bool {
        !self.source_contours.is_empty()
    }

    pub(crate) fn has_geometry_or_source_contours(&self) -> bool {
        self.has_geometry() || self.has_source_contours()
    }

    pub(crate) fn append_source_contours(&mut self, contours: Vec<RegionContour>) {
        if !contours.is_empty() {
            self.source_contours.push(contours);
        }
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        translate_point_pairs(&mut self.wedge_vertices, dx, dy);

        for vertex in self
            .sector_vertices
            .chunks_exact_mut(PATH_SECTOR_VERTEX_FLOATS)
        {
            vertex[0] += dx;
            vertex[1] += dy;
            vertex[2] += dx;
            vertex[3] += dy;
        }

        translate_point_pairs(&mut self.cover_vertices, dx, dy);
        translate_point_pairs(&mut self.clear_vertices, dx, dy);
        for region in &mut self.pick_contours {
            for contour in region {
                for point in contour {
                    point[0] += dx;
                    point[1] += dy;
                }
            }
        }
        translate_region_contours(&mut self.source_contours, dx, dy);
    }

    pub(crate) fn transform_for_flash(
        &mut self,
        scale: f32,
        mirror_x: bool,
        mirror_y: bool,
        rotation: f32,
        dx: f32,
        dy: f32,
    ) {
        for point in self.wedge_vertices.chunks_exact_mut(2) {
            let (x, y) = transformed_point_for_flash(
                point[0], point[1], scale, mirror_x, mirror_y, rotation, dx, dy,
            );
            point[0] = x;
            point[1] = y;
        }

        for vertex in self
            .sector_vertices
            .chunks_exact_mut(PATH_SECTOR_VERTEX_FLOATS)
        {
            let (position_x, position_y) = transformed_point_for_flash(
                vertex[0], vertex[1], scale, mirror_x, mirror_y, rotation, dx, dy,
            );
            vertex[0] = position_x;
            vertex[1] = position_y;

            let (center_x, center_y) = transformed_point_for_flash(
                vertex[2], vertex[3], scale, mirror_x, mirror_y, rotation, dx, dy,
            );
            vertex[2] = center_x;
            vertex[3] = center_y;

            vertex[4] *= scale.abs();
        }

        for point in self.cover_vertices.chunks_exact_mut(2) {
            let (x, y) = transformed_point_for_flash(
                point[0], point[1], scale, mirror_x, mirror_y, rotation, dx, dy,
            );
            point[0] = x;
            point[1] = y;
        }

        for point in self.clear_vertices.chunks_exact_mut(2) {
            let (x, y) = transformed_point_for_flash(
                point[0], point[1], scale, mirror_x, mirror_y, rotation, dx, dy,
            );
            point[0] = x;
            point[1] = y;
        }

        for region in &mut self.pick_contours {
            for contour in region {
                for point in contour {
                    let (x, y) = transformed_point_for_flash(
                        point[0], point[1], scale, mirror_x, mirror_y, rotation, dx, dy,
                    );
                    point[0] = x;
                    point[1] = y;
                }
            }
        }
        transform_region_contours_for_flash(
            &mut self.source_contours,
            scale,
            mirror_x,
            mirror_y,
            rotation,
            dx,
            dy,
        );
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(
            &object,
            "wedgeVertices",
            &f32_array_to_js(&self.wedge_vertices),
        )?;
        set_property(
            &object,
            "wedgeVertexOffsets",
            &u32_array_to_js(&self.wedge_vertex_offsets),
        )?;
        set_property(
            &object,
            "sectorVertices",
            &f32_array_to_js(&self.sector_vertices),
        )?;
        set_property(
            &object,
            "sectorVertexStride",
            &JsValue::from_f64(PATH_SECTOR_VERTEX_FLOATS as f64),
        )?;
        set_property(
            &object,
            "sectorVertexOffsets",
            &u32_array_to_js(&self.sector_vertex_offsets),
        )?;
        set_property(
            &object,
            "coverVertices",
            &f32_array_to_js(&self.cover_vertices),
        )?;
        set_property(
            &object,
            "clearVertices",
            &f32_array_to_js(&self.clear_vertices),
        )?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<PathRegions, JsValue> {
        let sector_vertex_stride = usize_property_from_js(value, "sectorVertexStride")?;
        if sector_vertex_stride != PATH_SECTOR_VERTEX_FLOATS {
            return Err(JsValue::from_str(
                "Parsed layer path sector vertex stride is unsupported",
            ));
        }
        Ok(PathRegions::new(
            f32_array_from_js(value, "wedgeVertices")?,
            u32_array_from_js(value, "wedgeVertexOffsets")?,
            f32_array_from_js(value, "sectorVertices")?,
            u32_array_from_js(value, "sectorVertexOffsets")?,
            f32_array_from_js(value, "coverVertices")?,
            f32_array_from_js(value, "clearVertices")?,
        ))
    }
}

impl Default for PathRegions {
    fn default() -> Self {
        PathRegions::empty()
    }
}

fn normalize_offsets(mut offsets: Vec<u32>) -> Vec<u32> {
    if offsets.is_empty() {
        offsets.push(0);
    }
    offsets
}

fn transformed_point_for_flash(
    x: f32,
    y: f32,
    scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    rotation: f32,
    dx: f32,
    dy: f32,
) -> (f32, f32) {
    let mut tx = x * scale;
    let mut ty = y * scale;

    if mirror_x {
        tx = -tx;
    }
    if mirror_y {
        ty = -ty;
    }

    let cos_r = rotation.cos();
    let sin_r = rotation.sin();
    let rotated_x = tx * cos_r - ty * sin_r;
    let rotated_y = tx * sin_r + ty * cos_r;

    (rotated_x + dx, rotated_y + dy)
}

fn transform_arc_angles(
    start_angle: f32,
    sweep_angle: f32,
    scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    rotation: f32,
) -> (f32, f32) {
    let mut start = start_angle;
    let mut end = start_angle + sweep_angle;

    if scale < 0.0 {
        start += std::f32::consts::PI;
        end += std::f32::consts::PI;
    }
    if mirror_x {
        start = std::f32::consts::PI - start;
        end = std::f32::consts::PI - end;
    }
    if mirror_y {
        start = -start;
        end = -end;
    }

    start += rotation;
    end += rotation;
    (start, end - start)
}

fn translate_region_contours(region_groups: &mut [Vec<RegionContour>], dx: f32, dy: f32) {
    for contours in region_groups {
        for contour in contours {
            for point in &mut contour.points {
                point[0] += dx;
                point[1] += dy;
            }
            for segment in &mut contour.segments {
                match segment {
                    RegionSegment::Line { start, end } => {
                        start[0] += dx;
                        start[1] += dy;
                        end[0] += dx;
                        end[1] += dy;
                    }
                    RegionSegment::Arc {
                        start, end, center, ..
                    } => {
                        start[0] += dx;
                        start[1] += dy;
                        end[0] += dx;
                        end[1] += dy;
                        center[0] += dx;
                        center[1] += dy;
                    }
                }
            }
        }
    }
}

fn transform_region_contours_for_flash(
    region_groups: &mut [Vec<RegionContour>],
    scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    rotation: f32,
    dx: f32,
    dy: f32,
) {
    for contours in region_groups {
        for contour in contours {
            for point in &mut contour.points {
                let (x, y) = transformed_point_for_flash(
                    point[0], point[1], scale, mirror_x, mirror_y, rotation, dx, dy,
                );
                point[0] = x;
                point[1] = y;
            }
            for segment in &mut contour.segments {
                match segment {
                    RegionSegment::Line { start, end } => {
                        *start = transformed_array_point_for_flash(
                            *start, scale, mirror_x, mirror_y, rotation, dx, dy,
                        );
                        *end = transformed_array_point_for_flash(
                            *end, scale, mirror_x, mirror_y, rotation, dx, dy,
                        );
                    }
                    RegionSegment::Arc {
                        start,
                        end,
                        center,
                        radius,
                        start_angle,
                        sweep_angle,
                        ..
                    } => {
                        *start = transformed_array_point_for_flash(
                            *start, scale, mirror_x, mirror_y, rotation, dx, dy,
                        );
                        *end = transformed_array_point_for_flash(
                            *end, scale, mirror_x, mirror_y, rotation, dx, dy,
                        );
                        *center = transformed_array_point_for_flash(
                            *center, scale, mirror_x, mirror_y, rotation, dx, dy,
                        );
                        *radius *= scale.abs();
                        let (next_start, next_sweep) = transform_arc_angles(
                            *start_angle,
                            *sweep_angle,
                            scale,
                            mirror_x,
                            mirror_y,
                            rotation,
                        );
                        *start_angle = next_start;
                        *sweep_angle = next_sweep;
                    }
                }
            }
        }
    }
}

fn transformed_array_point_for_flash(
    point: [f32; 2],
    scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    rotation: f32,
    dx: f32,
    dy: f32,
) -> [f32; 2] {
    let (x, y) = transformed_point_for_flash(
        point[0], point[1], scale, mirror_x, mirror_y, rotation, dx, dy,
    );
    [x, y]
}

/// Boundary information for the entire Gerber layer
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct Boundary {
    pub(crate) min_x: f32,
    pub(crate) max_x: f32,
    pub(crate) min_y: f32,
    pub(crate) max_y: f32,
}

#[wasm_bindgen]
impl Boundary {
    #[wasm_bindgen(constructor)]
    pub fn new(min_x: f32, max_x: f32, min_y: f32, max_y: f32) -> Boundary {
        Boundary {
            min_x,
            max_x,
            min_y,
            max_y,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn min_x(&self) -> f32 {
        self.min_x
    }

    #[wasm_bindgen(getter)]
    pub fn max_x(&self) -> f32 {
        self.max_x
    }

    #[wasm_bindgen(getter)]
    pub fn min_y(&self) -> f32 {
        self.min_y
    }

    #[wasm_bindgen(getter)]
    pub fn max_y(&self) -> f32 {
        self.max_y
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        self.min_x += dx;
        self.max_x += dx;
        self.min_y += dy;
        self.max_y += dy;
    }

    pub(crate) fn include_boundary(&mut self, other: &Boundary) {
        self.min_x = self.min_x.min(other.min_x);
        self.max_x = self.max_x.max(other.max_x);
        self.min_y = self.min_y.min(other.min_y);
        self.max_y = self.max_y.max(other.max_y);
    }

    pub(crate) fn intersects(&self, other: &Boundary) -> bool {
        self.min_x <= other.max_x
            && self.max_x >= other.min_x
            && self.min_y <= other.max_y
            && self.max_y >= other.min_y
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "minX", &JsValue::from_f64(self.min_x as f64))?;
        set_property(&object, "maxX", &JsValue::from_f64(self.max_x as f64))?;
        set_property(&object, "minY", &JsValue::from_f64(self.min_y as f64))?;
        set_property(&object, "maxY", &JsValue::from_f64(self.max_y as f64))?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Boundary, JsValue> {
        Ok(Boundary::new(
            f32_property_from_js(value, "minX")?,
            f32_property_from_js(value, "maxX")?,
            f32_property_from_js(value, "minY")?,
            f32_property_from_js(value, "maxY")?,
        ))
    }
}

/// Container for all parsed Gerber data
pub struct GerberData {
    pub(crate) triangles: Triangles,
    pub(crate) triangle_templates: Vec<TriangleTemplateInstances>,
    pub(crate) lines: Lines,
    pub(crate) circles: Circles,
    pub(crate) arcs: Arcs,
    pub(crate) thermals: Thermals,
    pub(crate) path_regions: PathRegions,
    pub(crate) boundary: Boundary,
    pub(crate) is_negative: bool,
}

impl GerberData {
    pub fn new(
        triangles: Triangles,
        triangle_templates: Vec<TriangleTemplateInstances>,
        lines: Lines,
        circles: Circles,
        arcs: Arcs,
        thermals: Thermals,
        path_regions: PathRegions,
        boundary: Boundary,
        is_negative: bool,
    ) -> GerberData {
        GerberData {
            triangles,
            triangle_templates,
            lines,
            circles,
            arcs,
            thermals,
            path_regions,
            boundary,
            is_negative,
        }
    }

    /// Check if this GerberData contains any geometry
    pub fn has_geometry(&self) -> bool {
        !self.triangles.vertices.is_empty()
            || self
                .triangle_templates
                .iter()
                .any(|template| !template.vertices.is_empty() && !template.instance_x.is_empty())
            || !self.lines.start_x.is_empty()
            || !self.circles.x.is_empty()
            || !self.arcs.x.is_empty()
            || !self.thermals.x.is_empty()
            || self.path_regions.has_geometry()
    }

    pub fn translate(&mut self, dx: f32, dy: f32) {
        self.triangles.translate(dx, dy);
        for template in &mut self.triangle_templates {
            template.translate(dx, dy);
        }
        self.lines.translate(dx, dy);
        self.circles.translate(dx, dy);
        self.arcs.translate(dx, dy);
        self.thermals.translate(dx, dy);
        self.path_regions.translate(dx, dy);
        self.boundary.translate(dx, dy);
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        let templates = Array::new();
        for template in &self.triangle_templates {
            templates.push(&template.to_js()?);
        }

        set_property(&object, "triangles", &self.triangles.to_js()?)?;
        set_property(&object, "triangleTemplates", &templates.into())?;
        set_property(&object, "lines", &self.lines.to_js()?)?;
        set_property(&object, "circles", &self.circles.to_js()?)?;
        set_property(&object, "arcs", &self.arcs.to_js()?)?;
        set_property(&object, "thermals", &self.thermals.to_js()?)?;
        set_property(&object, "pathRegions", &self.path_regions.to_js()?)?;
        set_property(&object, "boundary", &self.boundary.to_js()?)?;
        set_property(&object, "isNegative", &JsValue::from_bool(self.is_negative))?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<GerberData, JsValue> {
        let template_values = Array::from(&get_property(value, "triangleTemplates")?);
        let mut triangle_templates = Vec::with_capacity(template_values.length() as usize);
        for template_value in template_values.iter() {
            triangle_templates.push(TriangleTemplateInstances::from_js(&template_value)?);
        }

        Ok(GerberData::new(
            Triangles::from_js(&get_property(value, "triangles")?)?,
            triangle_templates,
            Lines::from_js(&get_property(value, "lines")?)?,
            Circles::from_js(&get_property(value, "circles")?)?,
            Arcs::from_js(&get_property(value, "arcs")?)?,
            Thermals::from_js(&get_property(value, "thermals")?)?,
            PathRegions::from_js(&get_property(value, "pathRegions")?)?,
            Boundary::from_js(&get_property(value, "boundary")?)?,
            get_property(value, "isNegative")?
                .as_bool()
                .unwrap_or(false),
        ))
    }
}

pub(crate) fn gerber_data_layers_to_js(layers: &[GerberData]) -> Result<JsValue, JsValue> {
    let object = Object::new();
    let sublayers = Array::new();
    for layer in layers {
        sublayers.push(&layer.to_js()?);
    }

    set_property(&object, "sublayers", &sublayers.into())?;
    Ok(object.into())
}

pub(crate) fn gerber_data_layers_from_js(value: &JsValue) -> Result<Vec<GerberData>, JsValue> {
    let sublayer_values = Array::from(&get_property(value, "sublayers")?);
    let mut layers = Vec::with_capacity(sublayer_values.length() as usize);
    for sublayer_value in sublayer_values.iter() {
        layers.push(GerberData::from_js(&sublayer_value)?);
    }

    Ok(layers)
}
