use crate::geometry::{RegionContour, RegionSegment};
use crate::util::checked_u32_len;
use js_sys::{Array, Float32Array, Int32Array, Object, Reflect, Uint32Array};
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

fn typed_array_length(len: usize) -> Result<u32, JsValue> {
    checked_u32_len(len, "a parsed geometry array").map_err(|message| JsValue::from_str(&message))
}

fn f32_array_to_js(values: &[f32]) -> Result<JsValue, JsValue> {
    let array = Float32Array::new_with_length(typed_array_length(values.len())?);
    array.copy_from(values);
    Ok(array.into())
}

fn f32_array_from_js(value: &JsValue, key: &str) -> Result<Vec<f32>, JsValue> {
    Ok(Float32Array::new(&get_property(value, key)?).to_vec())
}

fn i32_array_to_js(values: &[i32]) -> Result<JsValue, JsValue> {
    let array = Int32Array::new_with_length(typed_array_length(values.len())?);
    array.copy_from(values);
    Ok(array.into())
}

fn i32_array_from_js(value: &JsValue, key: &str) -> Result<Vec<i32>, JsValue> {
    match get_property(value, key) {
        Ok(prop) if !prop.is_undefined() && !prop.is_null() => Ok(Int32Array::new(&prop).to_vec()),
        _ => Ok(Vec::new()),
    }
}

fn u32_array_to_js(values: &[u32]) -> Result<JsValue, JsValue> {
    let array = Uint32Array::new_with_length(typed_array_length(values.len())?);
    array.copy_from(values);
    Ok(array.into())
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

/// Triangle mesh data structure
pub struct Triangles {
    pub(crate) vertices_nm: Vec<i32>,
    pub(crate) hole_x_nm: Vec<i32>,
    pub(crate) hole_y_nm: Vec<i32>,
    pub(crate) hole_radius_nm: Vec<i32>,
}

impl Triangles {
    pub fn new(
        vertices: Vec<f32>,
        hole_x: Vec<f32>,
        hole_y: Vec<f32>,
        hole_radius: Vec<f32>,
    ) -> Triangles {
        let to_nm = |vals: &[f32]| -> Vec<i32> {
            vals.iter()
                .map(|&v| (v as f64 * 1_000_000.0).round() as i32)
                .collect()
        };
        Triangles {
            vertices_nm: to_nm(&vertices),
            hole_x_nm: to_nm(&hole_x),
            hole_y_nm: to_nm(&hole_y),
            hole_radius_nm: to_nm(&hole_radius),
        }
    }

    pub fn new_with_nm(
        vertices_nm: Vec<i32>,
        hole_x_nm: Vec<i32>,
        hole_y_nm: Vec<i32>,
        hole_radius_nm: Vec<i32>,
    ) -> Triangles {
        Triangles {
            vertices_nm,
            hole_x_nm,
            hole_y_nm,
            hole_radius_nm,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.vertices_nm = Vec::new();
        self.hole_x_nm = Vec::new();
        self.hole_y_nm = Vec::new();
        self.hole_radius_nm = Vec::new();
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "vertices", &i32_array_to_js(&self.vertices_nm)?)?;
        set_property(&object, "holeX", &i32_array_to_js(&self.hole_x_nm)?)?;
        set_property(&object, "holeY", &i32_array_to_js(&self.hole_y_nm)?)?;
        set_property(
            &object,
            "holeRadius",
            &i32_array_to_js(&self.hole_radius_nm)?,
        )?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Triangles, JsValue> {
        Ok(Triangles::new_with_nm(
            i32_array_from_js(value, "vertices")?,
            i32_array_from_js(value, "holeX")?,
            i32_array_from_js(value, "holeY")?,
            i32_array_from_js(value, "holeRadius")?,
        ))
    }
}

/// Triangle mesh template rendered at many flash positions.
pub struct TriangleTemplateInstances {
    pub(crate) vertices: Vec<f32>,
    pub(crate) instance_x_nm: Vec<i32>,
    pub(crate) instance_y_nm: Vec<i32>,
}

impl TriangleTemplateInstances {
    pub fn new(
        vertices: Vec<f32>,
        instance_x: Vec<f32>,
        instance_y: Vec<f32>,
    ) -> TriangleTemplateInstances {
        let to_nm = |vals: &[f32]| -> Vec<i32> {
            vals.iter()
                .map(|&v| (v as f64 * 1_000_000.0).round() as i32)
                .collect()
        };
        TriangleTemplateInstances {
            vertices,
            instance_x_nm: to_nm(&instance_x),
            instance_y_nm: to_nm(&instance_y),
        }
    }

    pub fn new_with_nm(
        vertices: Vec<f32>,
        instance_x_nm: Vec<i32>,
        instance_y_nm: Vec<i32>,
    ) -> TriangleTemplateInstances {
        TriangleTemplateInstances {
            vertices,
            instance_x_nm,
            instance_y_nm,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.vertices = Vec::new();
        self.instance_x_nm = Vec::new();
        self.instance_y_nm = Vec::new();
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "vertices", &f32_array_to_js(&self.vertices)?)?;
        set_property(&object, "instanceX", &i32_array_to_js(&self.instance_x_nm)?)?;
        set_property(&object, "instanceY", &i32_array_to_js(&self.instance_y_nm)?)?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<TriangleTemplateInstances, JsValue> {
        Ok(TriangleTemplateInstances::new_with_nm(
            f32_array_from_js(value, "vertices")?,
            i32_array_from_js(value, "instanceX")?,
            i32_array_from_js(value, "instanceY")?,
        ))
    }
}

/// Instanced straight line body rendered between two round caps.
pub struct Lines {
    pub(crate) start_x_nm: Vec<i32>,
    pub(crate) start_y_nm: Vec<i32>,
    pub(crate) end_x_nm: Vec<i32>,
    pub(crate) end_y_nm: Vec<i32>,
    pub(crate) width_nm: Vec<i32>,
}

impl Lines {
    pub fn new(
        start_x: Vec<f32>,
        start_y: Vec<f32>,
        end_x: Vec<f32>,
        end_y: Vec<f32>,
        width: Vec<f32>,
    ) -> Lines {
        let to_nm = |vals: &[f32]| -> Vec<i32> {
            vals.iter()
                .map(|&v| (v as f64 * 1_000_000.0).round() as i32)
                .collect()
        };
        Lines {
            start_x_nm: to_nm(&start_x),
            start_y_nm: to_nm(&start_y),
            end_x_nm: to_nm(&end_x),
            end_y_nm: to_nm(&end_y),
            width_nm: to_nm(&width),
        }
    }

    pub fn new_with_nm(
        start_x_nm: Vec<i32>,
        start_y_nm: Vec<i32>,
        end_x_nm: Vec<i32>,
        end_y_nm: Vec<i32>,
        width_nm: Vec<i32>,
    ) -> Lines {
        Lines {
            start_x_nm,
            start_y_nm,
            end_x_nm,
            end_y_nm,
            width_nm,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.start_x_nm = Vec::new();
        self.start_y_nm = Vec::new();
        self.end_x_nm = Vec::new();
        self.end_y_nm = Vec::new();
        self.width_nm = Vec::new();
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "startX", &i32_array_to_js(&self.start_x_nm)?)?;
        set_property(&object, "startY", &i32_array_to_js(&self.start_y_nm)?)?;
        set_property(&object, "endX", &i32_array_to_js(&self.end_x_nm)?)?;
        set_property(&object, "endY", &i32_array_to_js(&self.end_y_nm)?)?;
        set_property(&object, "width", &i32_array_to_js(&self.width_nm)?)?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Lines, JsValue> {
        Ok(Lines::new_with_nm(
            i32_array_from_js(value, "startX")?,
            i32_array_from_js(value, "startY")?,
            i32_array_from_js(value, "endX")?,
            i32_array_from_js(value, "endY")?,
            i32_array_from_js(value, "width")?,
        ))
    }
}

/// Circle primitive data structure
pub struct Circles {
    pub(crate) x_nm: Vec<i32>,
    pub(crate) y_nm: Vec<i32>,
    pub(crate) radius_nm: Vec<i32>,
    pub(crate) hole_x_nm: Vec<i32>,
    pub(crate) hole_y_nm: Vec<i32>,
    pub(crate) hole_radius_nm: Vec<i32>,
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
        let to_nm = |vals: &[f32]| -> Vec<i32> {
            vals.iter()
                .map(|&v| (v as f64 * 1_000_000.0).round() as i32)
                .collect()
        };
        Circles {
            x_nm: to_nm(&x),
            y_nm: to_nm(&y),
            radius_nm: to_nm(&radius),
            hole_x_nm: to_nm(&hole_x),
            hole_y_nm: to_nm(&hole_y),
            hole_radius_nm: to_nm(&hole_radius),
        }
    }

    pub fn new_with_nm(
        x_nm: Vec<i32>,
        y_nm: Vec<i32>,
        radius_nm: Vec<i32>,
        hole_x_nm: Vec<i32>,
        hole_y_nm: Vec<i32>,
        hole_radius_nm: Vec<i32>,
    ) -> Circles {
        Circles {
            x_nm,
            y_nm,
            radius_nm,
            hole_x_nm,
            hole_y_nm,
            hole_radius_nm,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x_nm = Vec::new();
        self.y_nm = Vec::new();
        self.radius_nm = Vec::new();
        self.hole_x_nm = Vec::new();
        self.hole_y_nm = Vec::new();
        self.hole_radius_nm = Vec::new();
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "x", &i32_array_to_js(&self.x_nm)?)?;
        set_property(&object, "y", &i32_array_to_js(&self.y_nm)?)?;
        set_property(&object, "radius", &i32_array_to_js(&self.radius_nm)?)?;
        set_property(&object, "holeX", &i32_array_to_js(&self.hole_x_nm)?)?;
        set_property(&object, "holeY", &i32_array_to_js(&self.hole_y_nm)?)?;
        set_property(
            &object,
            "holeRadius",
            &i32_array_to_js(&self.hole_radius_nm)?,
        )?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Circles, JsValue> {
        Ok(Circles::new_with_nm(
            i32_array_from_js(value, "x")?,
            i32_array_from_js(value, "y")?,
            i32_array_from_js(value, "radius")?,
            i32_array_from_js(value, "holeX")?,
            i32_array_from_js(value, "holeY")?,
            i32_array_from_js(value, "holeRadius")?,
        ))
    }
}

/// Arc primitive data structure
pub struct Arcs {
    pub(crate) x_nm: Vec<i32>,
    pub(crate) y_nm: Vec<i32>,
    pub(crate) radius_nm: Vec<i32>,
    pub(crate) start_angle: Vec<f32>,
    pub(crate) sweep_angle: Vec<f32>,
    pub(crate) thickness_nm: Vec<i32>,
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
        let to_nm = |vals: &[f32]| -> Vec<i32> {
            vals.iter()
                .map(|&v| (v as f64 * 1_000_000.0).round() as i32)
                .collect()
        };
        Arcs {
            x_nm: to_nm(&x),
            y_nm: to_nm(&y),
            radius_nm: to_nm(&radius),
            start_angle,
            sweep_angle,
            thickness_nm: to_nm(&thickness),
        }
    }

    pub fn new_with_nm(
        x_nm: Vec<i32>,
        y_nm: Vec<i32>,
        radius_nm: Vec<i32>,
        start_angle: Vec<f32>,
        sweep_angle: Vec<f32>,
        thickness_nm: Vec<i32>,
    ) -> Arcs {
        Arcs {
            x_nm,
            y_nm,
            radius_nm,
            start_angle,
            sweep_angle,
            thickness_nm,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x_nm = Vec::new();
        self.y_nm = Vec::new();
        self.radius_nm = Vec::new();
        self.start_angle = Vec::new();
        self.sweep_angle = Vec::new();
        self.thickness_nm = Vec::new();
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "x", &i32_array_to_js(&self.x_nm)?)?;
        set_property(&object, "y", &i32_array_to_js(&self.y_nm)?)?;
        set_property(&object, "radius", &i32_array_to_js(&self.radius_nm)?)?;
        set_property(&object, "startAngle", &f32_array_to_js(&self.start_angle)?)?;
        set_property(&object, "sweepAngle", &f32_array_to_js(&self.sweep_angle)?)?;
        set_property(&object, "thickness", &i32_array_to_js(&self.thickness_nm)?)?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Arcs, JsValue> {
        Ok(Arcs::new_with_nm(
            i32_array_from_js(value, "x")?,
            i32_array_from_js(value, "y")?,
            i32_array_from_js(value, "radius")?,
            f32_array_from_js(value, "startAngle")?,
            f32_array_from_js(value, "sweepAngle")?,
            i32_array_from_js(value, "thickness")?,
        ))
    }
}

/// Thermal primitive data structure
pub struct Thermals {
    pub(crate) x_nm: Vec<i32>,
    pub(crate) y_nm: Vec<i32>,
    pub(crate) outer_diameter_nm: Vec<i32>,
    pub(crate) inner_diameter_nm: Vec<i32>,
    pub(crate) gap_thickness_nm: Vec<i32>,
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
        let to_nm = |vals: &[f32]| -> Vec<i32> {
            vals.iter()
                .map(|&v| (v as f64 * 1_000_000.0).round() as i32)
                .collect()
        };
        Thermals {
            x_nm: to_nm(&x),
            y_nm: to_nm(&y),
            outer_diameter_nm: to_nm(&outer_diameter),
            inner_diameter_nm: to_nm(&inner_diameter),
            gap_thickness_nm: to_nm(&gap_thickness),
            rotation,
        }
    }

    pub fn new_with_nm(
        x_nm: Vec<i32>,
        y_nm: Vec<i32>,
        outer_diameter_nm: Vec<i32>,
        inner_diameter_nm: Vec<i32>,
        gap_thickness_nm: Vec<i32>,
        rotation: Vec<f32>,
    ) -> Thermals {
        Thermals {
            x_nm,
            y_nm,
            outer_diameter_nm,
            inner_diameter_nm,
            gap_thickness_nm,
            rotation,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x_nm = Vec::new();
        self.y_nm = Vec::new();
        self.outer_diameter_nm = Vec::new();
        self.inner_diameter_nm = Vec::new();
        self.gap_thickness_nm = Vec::new();
        self.rotation = Vec::new();
    }

    pub(crate) fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "x", &i32_array_to_js(&self.x_nm)?)?;
        set_property(&object, "y", &i32_array_to_js(&self.y_nm)?)?;
        set_property(
            &object,
            "outerDiameter",
            &i32_array_to_js(&self.outer_diameter_nm)?,
        )?;
        set_property(
            &object,
            "innerDiameter",
            &i32_array_to_js(&self.inner_diameter_nm)?,
        )?;
        set_property(
            &object,
            "gapThickness",
            &i32_array_to_js(&self.gap_thickness_nm)?,
        )?;
        set_property(&object, "rotation", &f32_array_to_js(&self.rotation)?)?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<Thermals, JsValue> {
        Ok(Thermals::new_with_nm(
            i32_array_from_js(value, "x")?,
            i32_array_from_js(value, "y")?,
            i32_array_from_js(value, "outerDiameter")?,
            i32_array_from_js(value, "innerDiameter")?,
            i32_array_from_js(value, "gapThickness")?,
            f32_array_from_js(value, "rotation")?,
        ))
    }
}

/// Arc-containing region path data rendered by the WebGL stencil path renderer.
///
/// Large regions are stored in flat `i32` nanometer buffers relative to the layer `origin_nm`:
/// - `wedge_vertices_nm`: one or two stencil fan triangles per path segment
/// - `sector_vertices_nm`: analytic arc cap quads, 5 `i32` values per vertex
/// - `cover_vertices_nm`: one screen-coverable bounding quad per region
/// - `clear_vertices_nm`: one quad covering all stencil writes per region
#[derive(Clone, Debug)]
pub struct PathRegions {
    pub(crate) wedge_vertex_offsets: Vec<u32>,
    pub(crate) sector_vertex_offsets: Vec<u32>,
    pub(crate) wedge_vertices_nm: Vec<i32>,
    pub(crate) sector_vertices_nm: Vec<i32>,
    pub(crate) cover_vertices_nm: Vec<i32>,
    pub(crate) clear_vertices_nm: Vec<i32>,
    pub(crate) pick_contours: Vec<Vec<Vec<[f32; 2]>>>,
    pub(crate) source_contours: Vec<Vec<RegionContour>>,
}

/// Staging builder for `PathRegions` that accumulates world-space `i64` nanometer
/// coordinates before the layer-wide `origin_nm` and `4.29 m` span check are finalized.
#[derive(Clone, Debug)]
pub struct PathRegionsBuilder {
    pub(crate) wedge_vertex_offsets: Vec<u32>,
    pub(crate) sector_vertex_offsets: Vec<u32>,
    pub(crate) wedge_vertices_nm: Vec<i64>,
    pub(crate) sector_vertices_nm: Vec<i64>,
    pub(crate) cover_vertices_nm: Vec<i64>,
    pub(crate) clear_vertices_nm: Vec<i64>,
    pub(crate) pick_contours: Vec<Vec<Vec<[f32; 2]>>>,
    pub(crate) source_contours: Vec<Vec<RegionContour>>,
}

pub(crate) const PATH_SECTOR_VERTEX_FLOATS: usize = 5;

fn try_reserve_path_values<T>(
    values: &mut Vec<T>,
    additional: usize,
    context: &str,
) -> Result<(), String> {
    values.try_reserve(additional).map_err(|_| {
        format!(
            "Gerber region is too large to parse: not enough memory for {context} ({additional} values)"
        )
    })
}

/// Vertex count already in a buffer as the `u32` base for appended offsets,
/// checked so that the base plus the largest appended offset still fits.
fn rebase_start(existing_vertices: usize, offsets: &[u32], kind: &str) -> Result<u32, String> {
    let too_many = || {
        format!("Gerber region is too large to parse: path region {kind} vertex offsets exceed the u32 range")
    };
    let base = u32::try_from(existing_vertices).map_err(|_| too_many())?;
    let largest = offsets.iter().copied().max().unwrap_or(0);
    base.checked_add(largest).ok_or_else(too_many)?;
    Ok(base)
}

impl PathRegions {
    pub fn new(
        wedge_vertices: Vec<f32>,
        wedge_vertex_offsets: Vec<u32>,
        sector_vertices: Vec<f32>,
        sector_vertex_offsets: Vec<u32>,
        cover_vertices: Vec<f32>,
        clear_vertices: Vec<f32>,
    ) -> PathRegions {
        let to_i32 = |src: &[f32]| -> Vec<i32> {
            src.iter()
                .map(|&v| (v as f64 * 1_000_000.0).round() as i32)
                .collect()
        };
        PathRegions {
            wedge_vertex_offsets: normalize_offsets(wedge_vertex_offsets),
            sector_vertex_offsets: normalize_offsets(sector_vertex_offsets),
            wedge_vertices_nm: to_i32(&wedge_vertices),
            sector_vertices_nm: to_i32(&sector_vertices),
            cover_vertices_nm: to_i32(&cover_vertices),
            clear_vertices_nm: to_i32(&clear_vertices),
            pick_contours: Vec::new(),
            source_contours: Vec::new(),
        }
    }

    pub fn new_with_nm(
        wedge_vertices_nm: Vec<i32>,
        wedge_vertex_offsets: Vec<u32>,
        sector_vertices_nm: Vec<i32>,
        sector_vertex_offsets: Vec<u32>,
        cover_vertices_nm: Vec<i32>,
        clear_vertices_nm: Vec<i32>,
    ) -> PathRegions {
        PathRegions {
            wedge_vertex_offsets: normalize_offsets(wedge_vertex_offsets),
            sector_vertex_offsets: normalize_offsets(sector_vertex_offsets),
            wedge_vertices_nm,
            sector_vertices_nm,
            cover_vertices_nm,
            clear_vertices_nm,
            pick_contours: Vec::new(),
            source_contours: Vec::new(),
        }
    }

    pub fn empty() -> PathRegions {
        PathRegions {
            wedge_vertex_offsets: vec![0],
            sector_vertex_offsets: vec![0],
            wedge_vertices_nm: Vec::new(),
            sector_vertices_nm: Vec::new(),
            cover_vertices_nm: Vec::new(),
            clear_vertices_nm: Vec::new(),
            pick_contours: Vec::new(),
            source_contours: Vec::new(),
        }
    }

    pub(crate) fn region_count(&self) -> usize {
        self.wedge_vertex_offsets.len().saturating_sub(1)
    }

    pub(crate) fn has_geometry(&self) -> bool {
        self.region_count() > 0
            && (!self.wedge_vertices_nm.is_empty()
                || !self.sector_vertices_nm.is_empty()
                || !self.cover_vertices_nm.is_empty()
                || !self.clear_vertices_nm.is_empty())
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.wedge_vertices_nm = Vec::new();
        self.sector_vertices_nm = Vec::new();
        self.cover_vertices_nm = Vec::new();
        self.clear_vertices_nm = Vec::new();
        self.pick_contours = Vec::new();
        self.source_contours = Vec::new();
    }

    pub(crate) fn has_source_contours(&self) -> bool {
        !self.source_contours.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn clone_for_interaction_pick(&self) -> PathRegions {
        PathRegions {
            wedge_vertex_offsets: vec![0],
            sector_vertex_offsets: vec![0],
            wedge_vertices_nm: Vec::new(),
            sector_vertices_nm: Vec::new(),
            cover_vertices_nm: Vec::new(),
            clear_vertices_nm: Vec::new(),
            pick_contours: self.pick_contours.clone(),
            source_contours: Vec::new(),
        }
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
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

    pub(crate) fn transform_pick_for_flash(
        &mut self,
        scale: f32,
        mirror_x: bool,
        mirror_y: bool,
        rotation: f32,
        dx: f32,
        dy: f32,
    ) {
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
            &i32_array_to_js(&self.wedge_vertices_nm)?,
        )?;
        set_property(
            &object,
            "wedgeVertexOffsets",
            &u32_array_to_js(&self.wedge_vertex_offsets)?,
        )?;
        set_property(
            &object,
            "sectorVertices",
            &i32_array_to_js(&self.sector_vertices_nm)?,
        )?;
        set_property(
            &object,
            "sectorVertexStride",
            &JsValue::from_f64(PATH_SECTOR_VERTEX_FLOATS as f64),
        )?;
        set_property(
            &object,
            "sectorVertexOffsets",
            &u32_array_to_js(&self.sector_vertex_offsets)?,
        )?;
        set_property(
            &object,
            "coverVertices",
            &i32_array_to_js(&self.cover_vertices_nm)?,
        )?;
        set_property(
            &object,
            "clearVertices",
            &i32_array_to_js(&self.clear_vertices_nm)?,
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
        Ok(PathRegions::new_with_nm(
            i32_array_from_js(value, "wedgeVertices")?,
            u32_array_from_js(value, "wedgeVertexOffsets")?,
            i32_array_from_js(value, "sectorVertices")?,
            u32_array_from_js(value, "sectorVertexOffsets")?,
            i32_array_from_js(value, "coverVertices")?,
            i32_array_from_js(value, "clearVertices")?,
        ))
    }
}

impl Default for PathRegions {
    fn default() -> Self {
        PathRegions::empty()
    }
}

impl PathRegionsBuilder {
    pub fn empty() -> PathRegionsBuilder {
        PathRegionsBuilder {
            wedge_vertex_offsets: vec![0],
            sector_vertex_offsets: vec![0],
            wedge_vertices_nm: Vec::new(),
            sector_vertices_nm: Vec::new(),
            cover_vertices_nm: Vec::new(),
            clear_vertices_nm: Vec::new(),
            pick_contours: Vec::new(),
            source_contours: Vec::new(),
        }
    }

    pub(crate) fn region_count(&self) -> usize {
        self.wedge_vertex_offsets.len().saturating_sub(1)
    }

    pub(crate) fn work_item_count(&self) -> usize {
        self.wedge_vertices_nm
            .len()
            .saturating_add(self.sector_vertices_nm.len())
            .saturating_add(self.cover_vertices_nm.len())
            .saturating_add(self.clear_vertices_nm.len())
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
            && (!self.wedge_vertices_nm.is_empty()
                || !self.sector_vertices_nm.is_empty()
                || !self.cover_vertices_nm.is_empty()
                || !self.clear_vertices_nm.is_empty())
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

    pub(crate) fn append(&mut self, other: PathRegionsBuilder) -> Result<(), String> {
        if !other.has_geometry() && !other.has_source_contours() {
            return Ok(());
        }

        let wedge_base = rebase_start(
            self.wedge_vertices_nm.len() / 2,
            &other.wedge_vertex_offsets,
            "wedge",
        )?;
        let sector_base = rebase_start(
            self.sector_vertices_nm.len() / PATH_SECTOR_VERTEX_FLOATS,
            &other.sector_vertex_offsets,
            "sector",
        )?;
        let new_wedge_offsets = other.wedge_vertex_offsets.len().saturating_sub(1);
        let new_sector_offsets = other.sector_vertex_offsets.len().saturating_sub(1);
        try_reserve_path_values(
            &mut self.wedge_vertices_nm,
            other.wedge_vertices_nm.len(),
            "path region wedge vertices",
        )?;
        try_reserve_path_values(
            &mut self.sector_vertices_nm,
            other.sector_vertices_nm.len(),
            "path region sector vertices",
        )?;
        try_reserve_path_values(
            &mut self.cover_vertices_nm,
            other.cover_vertices_nm.len(),
            "path region cover vertices",
        )?;
        try_reserve_path_values(
            &mut self.clear_vertices_nm,
            other.clear_vertices_nm.len(),
            "path region clear vertices",
        )?;
        try_reserve_path_values(
            &mut self.pick_contours,
            other.pick_contours.len(),
            "path region pick contours",
        )?;
        try_reserve_path_values(
            &mut self.source_contours,
            other.source_contours.len(),
            "path region source contours",
        )?;
        try_reserve_path_values(
            &mut self.wedge_vertex_offsets,
            new_wedge_offsets,
            "path region wedge offsets",
        )?;
        try_reserve_path_values(
            &mut self.sector_vertex_offsets,
            new_sector_offsets,
            "path region sector offsets",
        )?;

        self.wedge_vertices_nm.extend(other.wedge_vertices_nm);
        self.sector_vertices_nm.extend(other.sector_vertices_nm);
        self.cover_vertices_nm.extend(other.cover_vertices_nm);
        self.clear_vertices_nm.extend(other.clear_vertices_nm);
        self.pick_contours.extend(other.pick_contours);
        self.source_contours.extend(other.source_contours);

        for offset in other.wedge_vertex_offsets.iter().skip(1) {
            self.wedge_vertex_offsets.push(wedge_base + offset);
        }
        for offset in other.sector_vertex_offsets.iter().skip(1) {
            self.sector_vertex_offsets.push(sector_base + offset);
        }
        Ok(())
    }

    pub(crate) fn clone_for_interaction_pick(&self) -> PathRegions {
        PathRegions {
            wedge_vertex_offsets: vec![0],
            sector_vertex_offsets: vec![0],
            wedge_vertices_nm: Vec::new(),
            sector_vertices_nm: Vec::new(),
            cover_vertices_nm: Vec::new(),
            clear_vertices_nm: Vec::new(),
            pick_contours: self.pick_contours.clone(),
            source_contours: Vec::new(),
        }
    }

    pub(crate) fn bounds(&self) -> Option<Boundary> {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        for point in self.cover_vertices_nm.chunks_exact(2) {
            let x = (point[0] as f64 * 1e-6) as f32;
            let y = (point[1] as f64 * 1e-6) as f32;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
        for region in &self.pick_contours {
            for contour in region {
                for point in contour {
                    min_x = min_x.min(point[0]);
                    max_x = max_x.max(point[0]);
                    min_y = min_y.min(point[1]);
                    max_y = max_y.max(point[1]);
                }
            }
        }
        min_x
            .is_finite()
            .then_some(Boundary::new(min_x, max_x, min_y, max_y))
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
        let transform_nm = |x_nm: i64, y_nm: i64| -> (i64, i64) {
            let (tx, ty) = transformed_point_for_flash(
                (x_nm as f64 * 1e-6) as f32,
                (y_nm as f64 * 1e-6) as f32,
                scale,
                mirror_x,
                mirror_y,
                rotation,
                dx,
                dy,
            );
            (
                (tx as f64 * 1_000_000.0).round() as i64,
                (ty as f64 * 1_000_000.0).round() as i64,
            )
        };

        for point in self.wedge_vertices_nm.chunks_exact_mut(2) {
            let (x, y) = transform_nm(point[0], point[1]);
            point[0] = x;
            point[1] = y;
        }
        for vertex in self
            .sector_vertices_nm
            .chunks_exact_mut(PATH_SECTOR_VERTEX_FLOATS)
        {
            let (px, py) = transform_nm(vertex[0], vertex[1]);
            vertex[0] = px;
            vertex[1] = py;
            let (cx, cy) = transform_nm(vertex[2], vertex[3]);
            vertex[2] = cx;
            vertex[3] = cy;
            vertex[4] = (vertex[4] as f64 * scale.abs() as f64).round() as i64;
        }
        for point in self.cover_vertices_nm.chunks_exact_mut(2) {
            let (x, y) = transform_nm(point[0], point[1]);
            point[0] = x;
            point[1] = y;
        }
        for point in self.clear_vertices_nm.chunks_exact_mut(2) {
            let (x, y) = transform_nm(point[0], point[1]);
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

    pub(crate) fn finalize_origin_nm(self, origin_nm: [i64; 2]) -> Result<PathRegions, String> {
        let to_rel_i32 = |nm: i64, origin: i64| -> Result<i32, String> {
            i32::try_from(nm - origin).map_err(|_| {
                "Layer dimensions exceed maximum supported span (4.29 m) for integer nanometer coordinates"
                    .to_string()
            })
        };
        let to_dim_i32 = |nm: i64| -> Result<i32, String> {
            i32::try_from(nm).map_err(|_| {
                "Feature dimension exceeds maximum supported size (2.14 m) for integer nanometer coordinates"
                    .to_string()
            })
        };
        let convert_pairs = |src: Vec<i64>| -> Result<Vec<i32>, String> {
            let mut out = Vec::with_capacity(src.len());
            for pair in src.chunks_exact(2) {
                out.push(to_rel_i32(pair[0], origin_nm[0])?);
                out.push(to_rel_i32(pair[1], origin_nm[1])?);
            }
            Ok(out)
        };

        let wedge_vertices_nm = convert_pairs(self.wedge_vertices_nm)?;
        let cover_vertices_nm = convert_pairs(self.cover_vertices_nm)?;
        let clear_vertices_nm = convert_pairs(self.clear_vertices_nm)?;
        let mut sector_vertices_nm = Vec::with_capacity(self.sector_vertices_nm.len());
        for vertex in self
            .sector_vertices_nm
            .chunks_exact(PATH_SECTOR_VERTEX_FLOATS)
        {
            sector_vertices_nm.push(to_rel_i32(vertex[0], origin_nm[0])?);
            sector_vertices_nm.push(to_rel_i32(vertex[1], origin_nm[1])?);
            sector_vertices_nm.push(to_rel_i32(vertex[2], origin_nm[0])?);
            sector_vertices_nm.push(to_rel_i32(vertex[3], origin_nm[1])?);
            sector_vertices_nm.push(to_dim_i32(vertex[4])?);
        }

        Ok(PathRegions {
            wedge_vertex_offsets: self.wedge_vertex_offsets,
            sector_vertex_offsets: self.sector_vertex_offsets,
            wedge_vertices_nm,
            sector_vertices_nm,
            cover_vertices_nm,
            clear_vertices_nm,
            pick_contours: self.pick_contours,
            source_contours: self.source_contours,
        })
    }
}

impl Default for PathRegionsBuilder {
    fn default() -> Self {
        PathRegionsBuilder::empty()
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
    pub(crate) origin_nm: [i64; 2],
}

impl GerberData {
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
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
        Self::new_with_origin(
            triangles,
            triangle_templates,
            lines,
            circles,
            arcs,
            thermals,
            path_regions,
            boundary,
            is_negative,
            [0, 0],
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new_with_origin(
        triangles: Triangles,
        triangle_templates: Vec<TriangleTemplateInstances>,
        lines: Lines,
        circles: Circles,
        arcs: Arcs,
        thermals: Thermals,
        path_regions: PathRegions,
        boundary: Boundary,
        is_negative: bool,
        origin_nm: [i64; 2],
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
            origin_nm,
        }
    }

    /// Check if this GerberData contains any geometry
    pub fn has_geometry(&self) -> bool {
        !self.triangles.vertices_nm.is_empty()
            || self
                .triangle_templates
                .iter()
                .any(|template| !template.vertices.is_empty() && !template.instance_x_nm.is_empty())
            || !self.lines.start_x_nm.is_empty()
            || !self.circles.x_nm.is_empty()
            || !self.arcs.x_nm.is_empty()
            || !self.thermals.x_nm.is_empty()
            || self.path_regions.has_geometry()
    }

    #[allow(dead_code)]
    pub fn translate(&mut self, dx: f32, dy: f32) {
        self.translate_f64(dx as f64, dy as f64);
    }

    pub fn translate_f64(&mut self, dx: f64, dy: f64) {
        let dx_nm = (dx * 1_000_000.0).round() as i64;
        let dy_nm = (dy * 1_000_000.0).round() as i64;
        self.origin_nm[0] = self.origin_nm[0].saturating_add(dx_nm);
        self.origin_nm[1] = self.origin_nm[1].saturating_add(dy_nm);
        self.path_regions.translate(dx as f32, dy as f32);
        self.boundary.translate(dx as f32, dy as f32);
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
        set_property(
            &object,
            "originNmX",
            &JsValue::from_f64(self.origin_nm[0] as f64),
        )?;
        set_property(
            &object,
            "originNmY",
            &JsValue::from_f64(self.origin_nm[1] as f64),
        )?;
        Ok(object.into())
    }

    pub(crate) fn from_js(value: &JsValue) -> Result<GerberData, JsValue> {
        let template_values = Array::from(&get_property(value, "triangleTemplates")?);
        let mut triangle_templates = Vec::with_capacity(template_values.length() as usize);
        for template_value in template_values.iter() {
            triangle_templates.push(TriangleTemplateInstances::from_js(&template_value)?);
        }

        let origin_nm_x = get_property(value, "originNmX")
            .ok()
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite())
            .map(|v| v.round() as i64)
            .unwrap_or(0);
        let origin_nm_y = get_property(value, "originNmY")
            .ok()
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite())
            .map(|v| v.round() as i64)
            .unwrap_or(0);

        Ok(GerberData::new_with_origin(
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
            [origin_nm_x, origin_nm_y],
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

#[cfg(test)]
mod path_region_append_tests {
    use super::{rebase_start, PathRegionsBuilder, PATH_SECTOR_VERTEX_FLOATS};

    fn one_region(sector_quads: usize) -> PathRegionsBuilder {
        PathRegionsBuilder {
            wedge_vertex_offsets: vec![0, 3],
            sector_vertex_offsets: vec![0, (sector_quads * 6) as u32],
            wedge_vertices_nm: vec![0; 6],
            sector_vertices_nm: vec![0; sector_quads * 6 * PATH_SECTOR_VERTEX_FLOATS],
            cover_vertices_nm: vec![0; 12],
            clear_vertices_nm: vec![0; 12],
            pick_contours: Vec::new(),
            source_contours: Vec::new(),
        }
    }

    #[test]
    fn append_rebases_offsets_onto_the_accumulated_buffers() {
        let mut regions = PathRegionsBuilder::empty();
        regions.append(one_region(0)).unwrap();
        regions.append(one_region(1)).unwrap();
        regions.append(one_region(2)).unwrap();

        assert_eq!(regions.region_count(), 3);
        assert_eq!(regions.wedge_vertex_offsets, vec![0, 3, 6, 9]);
        assert_eq!(regions.sector_vertex_offsets, vec![0, 0, 6, 18]);
        assert_eq!(regions.wedge_vertices_nm.len(), 18);
        assert_eq!(
            regions.sector_vertices_nm.len(),
            18 * PATH_SECTOR_VERTEX_FLOATS
        );
        assert_eq!(regions.cover_vertices_nm.len(), 36);

        // An empty region set is a no-op.
        regions.append(PathRegionsBuilder::empty()).unwrap();
        assert_eq!(regions.region_count(), 3);
    }

    #[test]
    fn offsets_past_u32_are_an_error_not_a_wrap() {
        assert_eq!(rebase_start(10, &[0, 3], "wedge"), Ok(10));
        assert!(rebase_start(u32::MAX as usize, &[0, 3], "wedge").is_err());
        assert!(rebase_start(u32::MAX as usize + 1, &[0], "sector").is_err());
        let message = rebase_start(u32::MAX as usize - 1, &[0, 2], "wedge").unwrap_err();
        assert!(message.contains("too large to parse"), "{message}");
    }
}
