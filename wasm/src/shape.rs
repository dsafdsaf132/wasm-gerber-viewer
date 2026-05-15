use js_sys::{Array, Float32Array, Object, Reflect};
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

/// Boundary information for the entire Gerber layer
#[wasm_bindgen]
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
    pub(crate) circles: Circles,
    pub(crate) arcs: Arcs,
    pub(crate) thermals: Thermals,
    pub(crate) boundary: Boundary,
    pub(crate) is_negative: bool,
}

impl GerberData {
    pub fn new(
        triangles: Triangles,
        triangle_templates: Vec<TriangleTemplateInstances>,
        circles: Circles,
        arcs: Arcs,
        thermals: Thermals,
        boundary: Boundary,
        is_negative: bool,
    ) -> GerberData {
        GerberData {
            triangles,
            triangle_templates,
            circles,
            arcs,
            thermals,
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
            || !self.circles.x.is_empty()
            || !self.arcs.x.is_empty()
            || !self.thermals.x.is_empty()
    }

    pub fn translate(&mut self, dx: f32, dy: f32) {
        self.triangles.translate(dx, dy);
        for template in &mut self.triangle_templates {
            template.translate(dx, dy);
        }
        self.circles.translate(dx, dy);
        self.arcs.translate(dx, dy);
        self.thermals.translate(dx, dy);
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
        set_property(&object, "circles", &self.circles.to_js()?)?;
        set_property(&object, "arcs", &self.arcs.to_js()?)?;
        set_property(&object, "thermals", &self.thermals.to_js()?)?;
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
            Circles::from_js(&get_property(value, "circles")?)?,
            Arcs::from_js(&get_property(value, "arcs")?)?,
            Thermals::from_js(&get_property(value, "thermals")?)?,
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
