use crate::parser::geometry::{offset_primitive_by, Primitive};
use crate::parser::{Aperture, Polarity};
use crate::shape::{Boundary, PathRegions};
use js_sys::{Object, Reflect};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

const CIRCLE_SEGMENTS: usize = 48;
const ARC_SEGMENT_RADIANS: f32 = std::f32::consts::PI / 48.0;
const MAX_ARC_SEGMENTS: usize = 256;
const TWO_PI: f32 = std::f32::consts::PI * 2.0;

pub struct HighlightBatch {
    pub vertices: Vec<f32>,
    pub clear: bool,
}

#[derive(Clone, Debug, Default)]
pub struct InteractionLayer {
    pub features: Vec<InteractionFeature>,
    string_pool: HashSet<Rc<str>>,
    descriptor_pool: HashMap<FeatureDescriptorKey, Rc<FeatureDescriptor>>,
}

#[derive(Clone, Debug)]
pub struct InteractionFeature {
    pub descriptor: Rc<FeatureDescriptor>,
    pub primitives: FeaturePrimitives,
    pub path_regions: Option<Box<PathRegions>>,
    pub bounds: Boundary,
}

#[derive(Clone, Debug)]
pub struct FeaturePrimitives {
    storage: FeaturePrimitiveStorage,
}

#[derive(Clone, Debug)]
enum FeaturePrimitiveStorage {
    Empty,
    Triangle(Box<Primitive>),
    Circle {
        x: f32,
        y: f32,
        radius: f32,
        exposure: f32,
        hole_x: f32,
        hole_y: f32,
        hole_radius: f32,
    },
    Arc {
        x: f32,
        y: f32,
        radius: f32,
        start_angle: f32,
        end_angle: f32,
        thickness: f32,
        exposure: f32,
    },
    Thermal {
        x: f32,
        y: f32,
        outer_diameter: f32,
        inner_diameter: f32,
        gap_thickness: f32,
        rotation: f32,
        exposure: f32,
    },
    TriangleTemplateFlash {
        template: Rc<Vec<f32>>,
        x: f32,
        y: f32,
    },
    Line {
        start_x: f32,
        start_y: f32,
        end_x: f32,
        end_y: f32,
        width: f32,
        exposure: f32,
    },
    Multiple(Box<[Primitive]>),
}

#[derive(Clone, Debug)]
pub struct FeatureDescriptor {
    pub kind: FeatureKind,
    pub aperture: Option<Rc<str>>,
    pub aperture_type: Option<Rc<str>>,
    pub macro_name: Option<Rc<str>>,
    pub polarity: Polarity,
    pub properties: FeatureProperties,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct FeatureDescriptorKey {
    kind: FeatureKind,
    polarity_negative: bool,
    aperture: Option<Rc<str>>,
    aperture_type: Option<Rc<str>>,
    macro_name: Option<Rc<str>>,
    diameter: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    rotation: Option<u32>,
    vertices: Option<u32>,
    tool_code: Option<u32>,
    primitive_count: Option<u32>,
    arc_command: Option<Rc<str>>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub enum FeatureKind {
    Flash,
    Draw,
    ArcDraw,
    Region,
    DrillHit,
    DrillSlot,
}

impl FeatureKind {
    fn as_str(&self) -> &'static str {
        match self {
            FeatureKind::Flash => "aperture-flash",
            FeatureKind::Draw => "aperture-draw",
            FeatureKind::ArcDraw => "arc-draw",
            FeatureKind::Region => "region",
            FeatureKind::DrillHit => "drill-hit",
            FeatureKind::DrillSlot => "drill-slot",
        }
    }

    fn to_u8(&self) -> u8 {
        match self {
            FeatureKind::Flash => 0,
            FeatureKind::Draw => 1,
            FeatureKind::ArcDraw => 2,
            FeatureKind::Region => 3,
            FeatureKind::DrillHit => 4,
            FeatureKind::DrillSlot => 5,
        }
    }

    fn from_u8(v: u8) -> Result<Self, String> {
        match v {
            0 => Ok(FeatureKind::Flash),
            1 => Ok(FeatureKind::Draw),
            2 => Ok(FeatureKind::ArcDraw),
            3 => Ok(FeatureKind::Region),
            4 => Ok(FeatureKind::DrillHit),
            5 => Ok(FeatureKind::DrillSlot),
            _ => Err(format!("Unknown FeatureKind byte: {v}")),
        }
    }
}

impl FeatureDescriptorKey {
    fn from_descriptor(descriptor: &FeatureDescriptor) -> Self {
        Self {
            kind: descriptor.kind.clone(),
            polarity_negative: descriptor.polarity == Polarity::Negative,
            aperture: descriptor.aperture.clone(),
            aperture_type: descriptor.aperture_type.clone(),
            macro_name: descriptor.macro_name.clone(),
            diameter: descriptor.properties.diameter.map(f32::to_bits),
            width: descriptor.properties.width.map(f32::to_bits),
            height: descriptor.properties.height.map(f32::to_bits),
            rotation: descriptor.properties.rotation.map(f32::to_bits),
            vertices: descriptor.properties.vertices,
            tool_code: descriptor.properties.tool_code,
            primitive_count: descriptor.properties.primitive_count,
            arc_command: descriptor.properties.arc_command.clone(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct FeatureProperties {
    pub diameter: Option<f32>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub rotation: Option<f32>,
    pub vertices: Option<u32>,
    pub tool_code: Option<u32>,
    pub primitive_count: Option<u32>,
    pub arc_command: Option<Rc<str>>,
}

impl InteractionLayer {
    pub fn new() -> Self {
        Self {
            features: Vec::new(),
            string_pool: HashSet::new(),
            descriptor_pool: HashMap::new(),
        }
    }

    pub fn push(&mut self, mut feature: InteractionFeature) {
        self.intern_feature_descriptor(&mut feature);
        self.features.push(feature);
    }

    fn intern_feature_descriptor(&mut self, feature: &mut InteractionFeature) {
        let descriptor = &feature.descriptor;
        let mut properties = descriptor.properties.clone();
        properties.arc_command = self.intern_option(properties.arc_command.take());
        let descriptor = FeatureDescriptor {
            kind: descriptor.kind.clone(),
            aperture: self.intern_option(descriptor.aperture.clone()),
            aperture_type: self.intern_option(descriptor.aperture_type.clone()),
            macro_name: self.intern_option(descriptor.macro_name.clone()),
            polarity: descriptor.polarity,
            properties,
        };
        let key = FeatureDescriptorKey::from_descriptor(&descriptor);

        if let Some(existing) = self.descriptor_pool.get(&key) {
            feature.descriptor = Rc::clone(existing);
            return;
        }

        let descriptor = Rc::new(descriptor);
        self.descriptor_pool.insert(key, Rc::clone(&descriptor));
        feature.descriptor = descriptor;
    }

    fn intern_option(&mut self, value: Option<Rc<str>>) -> Option<Rc<str>> {
        value.map(|value| self.intern(value.as_ref()))
    }

    fn intern(&mut self, value: &str) -> Rc<str> {
        if let Some(existing) = self.string_pool.get(value) {
            return Rc::clone(existing);
        }

        let shared = Rc::<str>::from(value);
        self.string_pool.insert(Rc::clone(&shared));
        shared
    }

    pub fn translate(&mut self, dx: f32, dy: f32) {
        if dx == 0.0 && dy == 0.0 {
            return;
        }

        for feature in &mut self.features {
            feature.bounds.translate(dx, dy);
            feature.primitives.translate(dx, dy);
            if let Some(path_regions) = &mut feature.path_regions {
                path_regions.translate(dx, dy);
            }
        }
    }

    pub fn pick(&self, x: f32, y: f32, tolerance: f32) -> Option<(usize, &InteractionFeature)> {
        self.pick_after(x, y, tolerance, None).0
    }

    /// Serialize to a compact binary format for cross-WASM-instance transfer.
    ///
    /// `Rc`-shared templates are deduplicated by pointer identity into a header table
    /// so that `from_bytes` can restore sharing via `Rc::clone` from that table.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = BinaryWriter::new();
        w.write_bytes(b"ILYR");
        w.write_u8(1); // version

        // Build template table, keyed by Rc pointer for deduplication
        let mut template_table: Vec<Rc<Vec<f32>>> = Vec::new();
        let mut template_map: HashMap<*const Vec<f32>, u32> = HashMap::new();
        for feature in &self.features {
            feature.primitives.for_each(|p| {
                if let Primitive::TriangleTemplateFlash { template, .. } = p {
                    let ptr = Rc::as_ptr(template);
                    if !template_map.contains_key(&ptr) {
                        let idx = template_table.len() as u32;
                        template_map.insert(ptr, idx);
                        template_table.push(Rc::clone(template));
                    }
                }
            });
        }

        w.write_u32(template_table.len() as u32);
        for template in &template_table {
            w.write_u32(template.len() as u32);
            for &v in template.iter() {
                w.write_f32(v);
            }
        }

        w.write_u32(self.features.len() as u32);
        for feature in &self.features {
            encode_feature_bytes(&mut w, feature, &template_map);
        }

        w.into_vec()
    }

    /// Deserialize from the binary format produced by `to_bytes()`.
    ///
    /// Templates are re-shared via `Rc::clone` from the restored table.
    /// Descriptor strings and keys are re-interned into fresh pools via `push()`.
    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        let mut r = BinaryReader::new(data);

        let magic = r.read_bytes(4)?;
        if magic != b"ILYR" {
            return Err(format!(
                "Invalid interaction data magic: expected ILYR, got {:?}",
                magic
            ));
        }
        let version = r.read_u8()?;
        if version != 1 {
            return Err(format!(
                "Unsupported interaction data version: {version}"
            ));
        }

        let template_count = r.read_u32()? as usize;
        let mut templates: Vec<Rc<Vec<f32>>> = Vec::with_capacity(template_count);
        for _ in 0..template_count {
            let len = r.read_u32()? as usize;
            let mut tpl = Vec::with_capacity(len);
            for _ in 0..len {
                tpl.push(r.read_f32()?);
            }
            templates.push(Rc::new(tpl));
        }

        let feature_count = r.read_u32()? as usize;
        let mut layer = InteractionLayer::new();
        for _ in 0..feature_count {
            let feature = decode_feature_bytes(&mut r, &templates)?;
            layer.push(feature);
        }

        Ok(layer)
    }

    pub fn pick_after(
        &self,
        x: f32,
        y: f32,
        tolerance: f32,
        after_feature_id: Option<usize>,
    ) -> (Option<(usize, &InteractionFeature)>, bool) {
        let point = [x, y];
        let tolerance = tolerance.max(0.0);
        let mut return_next_hit = after_feature_id.is_none();
        let mut saw_after_feature = false;

        for (feature_id, feature) in self.features.iter().enumerate().rev() {
            if !bounds_contains(&feature.bounds, point, tolerance) {
                continue;
            }
            if feature.hit(point, tolerance) {
                if feature.descriptor.polarity == Polarity::Negative {
                    return (None, saw_after_feature);
                }
                if return_next_hit {
                    return (Some((feature_id, feature)), saw_after_feature);
                }
                if Some(feature_id) == after_feature_id {
                    saw_after_feature = true;
                    return_next_hit = true;
                }
            }
        }

        (None, saw_after_feature)
    }
}

impl FeaturePrimitives {
    fn from_vec(mut primitives: Vec<Primitive>) -> Self {
        let storage = match primitives.len() {
            0 => FeaturePrimitiveStorage::Empty,
            1 => primitive_to_storage(
                primitives
                    .pop()
                    .expect("single primitive storage should contain one primitive"),
            ),
            _ => FeaturePrimitiveStorage::Multiple(primitives.into_boxed_slice()),
        };
        Self { storage }
    }

    fn from_slice(primitives: &[Primitive]) -> Self {
        let storage = match primitives {
            [] => FeaturePrimitiveStorage::Empty,
            [primitive] => primitive_to_storage(primitive.clone()),
            _ => FeaturePrimitiveStorage::Multiple(primitives.to_vec().into_boxed_slice()),
        };
        Self { storage }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        matches!(self.storage, FeaturePrimitiveStorage::Empty)
    }

    fn for_each(&self, mut visit: impl FnMut(&Primitive)) {
        match &self.storage {
            FeaturePrimitiveStorage::Empty => {}
            FeaturePrimitiveStorage::Triangle(primitive) => visit(primitive),
            FeaturePrimitiveStorage::Circle {
                x,
                y,
                radius,
                exposure,
                hole_x,
                hole_y,
                hole_radius,
            } => {
                let primitive = Primitive::Circle {
                    x: *x,
                    y: *y,
                    radius: *radius,
                    exposure: *exposure,
                    hole_x: *hole_x,
                    hole_y: *hole_y,
                    hole_radius: *hole_radius,
                };
                visit(&primitive);
            }
            FeaturePrimitiveStorage::Arc {
                x,
                y,
                radius,
                start_angle,
                end_angle,
                thickness,
                exposure,
            } => {
                let primitive = Primitive::Arc {
                    x: *x,
                    y: *y,
                    radius: *radius,
                    start_angle: *start_angle,
                    end_angle: *end_angle,
                    thickness: *thickness,
                    exposure: *exposure,
                };
                visit(&primitive);
            }
            FeaturePrimitiveStorage::Thermal {
                x,
                y,
                outer_diameter,
                inner_diameter,
                gap_thickness,
                rotation,
                exposure,
            } => {
                let primitive = Primitive::Thermal {
                    x: *x,
                    y: *y,
                    outer_diameter: *outer_diameter,
                    inner_diameter: *inner_diameter,
                    gap_thickness: *gap_thickness,
                    rotation: *rotation,
                    exposure: *exposure,
                };
                visit(&primitive);
            }
            FeaturePrimitiveStorage::TriangleTemplateFlash { template, x, y } => {
                let primitive = Primitive::TriangleTemplateFlash {
                    template: Rc::clone(template),
                    x: *x,
                    y: *y,
                };
                visit(&primitive);
            }
            FeaturePrimitiveStorage::Line {
                start_x,
                start_y,
                end_x,
                end_y,
                width,
                exposure,
            } => {
                let primitive = Primitive::Line {
                    start_x: *start_x,
                    start_y: *start_y,
                    end_x: *end_x,
                    end_y: *end_y,
                    width: *width,
                    exposure: *exposure,
                };
                visit(&primitive);
            }
            FeaturePrimitiveStorage::Multiple(primitives) => {
                for primitive in primitives.iter() {
                    visit(primitive);
                }
            }
        }
    }

    fn translate(&mut self, dx: f32, dy: f32) {
        match &mut self.storage {
            FeaturePrimitiveStorage::Empty => {}
            FeaturePrimitiveStorage::Triangle(primitive) => {
                **primitive = offset_primitive_by(primitive, dx, dy);
            }
            FeaturePrimitiveStorage::Circle {
                x,
                y,
                hole_x,
                hole_y,
                ..
            } => {
                *x += dx;
                *y += dy;
                *hole_x += dx;
                *hole_y += dy;
            }
            FeaturePrimitiveStorage::Thermal { x, y, .. }
            | FeaturePrimitiveStorage::TriangleTemplateFlash { x, y, .. }
            | FeaturePrimitiveStorage::Arc { x, y, .. } => {
                *x += dx;
                *y += dy;
            }
            FeaturePrimitiveStorage::Line {
                start_x,
                start_y,
                end_x,
                end_y,
                ..
            } => {
                *start_x += dx;
                *start_y += dy;
                *end_x += dx;
                *end_y += dy;
            }
            FeaturePrimitiveStorage::Multiple(primitives) => {
                for primitive in primitives.iter_mut() {
                    *primitive = offset_primitive_by(primitive, dx, dy);
                }
            }
        }
    }

    fn append_highlight_batches(&self, batches: &mut Vec<HighlightBatch>) {
        self.for_each(|primitive| append_primitive_highlight_batches(batches, primitive));
    }

    fn hit(&self, point: [f32; 2], tolerance: f32) -> bool {
        let mut is_hit = false;
        self.for_each(|primitive| {
            if primitive_hit(primitive, point, tolerance) {
                is_hit = primitive_exposure(primitive) >= 0.5;
            }
        });
        is_hit
    }
}

fn primitive_to_storage(primitive: Primitive) -> FeaturePrimitiveStorage {
    match primitive {
        Primitive::Triangle { .. } => FeaturePrimitiveStorage::Triangle(Box::new(primitive)),
        Primitive::Circle {
            x,
            y,
            radius,
            exposure,
            hole_x,
            hole_y,
            hole_radius,
        } => FeaturePrimitiveStorage::Circle {
            x,
            y,
            radius,
            exposure,
            hole_x,
            hole_y,
            hole_radius,
        },
        Primitive::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            thickness,
            exposure,
        } => FeaturePrimitiveStorage::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            thickness,
            exposure,
        },
        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
            exposure,
        } => FeaturePrimitiveStorage::Thermal {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
            exposure,
        },
        Primitive::TriangleTemplateFlash { template, x, y } => {
            FeaturePrimitiveStorage::TriangleTemplateFlash { template, x, y }
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            exposure,
        } => FeaturePrimitiveStorage::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            exposure,
        },
    }
}

impl InteractionFeature {
    pub fn from_primitives(
        kind: FeatureKind,
        aperture: Option<String>,
        aperture_type: Option<String>,
        macro_name: Option<String>,
        polarity: Polarity,
        primitives: Vec<Primitive>,
        properties: FeatureProperties,
    ) -> Option<Self> {
        let bounds = primitive_bounds(&primitives)?;
        Some(Self::from_parts(
            kind,
            aperture,
            aperture_type,
            macro_name,
            polarity,
            FeaturePrimitives::from_vec(primitives),
            None,
            bounds,
            properties,
        ))
    }

    pub fn from_primitive_slice(
        kind: FeatureKind,
        aperture: Option<String>,
        aperture_type: Option<String>,
        macro_name: Option<String>,
        polarity: Polarity,
        primitives: &[Primitive],
        properties: FeatureProperties,
    ) -> Option<Self> {
        let bounds = primitive_bounds(primitives)?;
        Some(Self::from_parts(
            kind,
            aperture,
            aperture_type,
            macro_name,
            polarity,
            FeaturePrimitives::from_slice(primitives),
            None,
            bounds,
            properties,
        ))
    }

    pub fn from_geometry(
        kind: FeatureKind,
        aperture: Option<String>,
        aperture_type: Option<String>,
        macro_name: Option<String>,
        polarity: Polarity,
        primitives: Vec<Primitive>,
        path_regions: PathRegions,
        properties: FeatureProperties,
    ) -> Option<Self> {
        let bounds = combined_bounds(&primitives, &path_regions)?;
        let path_regions =
            path_regions_has_interaction_geometry(&path_regions).then(|| Box::new(path_regions));
        Some(Self::from_parts(
            kind,
            aperture,
            aperture_type,
            macro_name,
            polarity,
            FeaturePrimitives::from_vec(primitives),
            path_regions,
            bounds,
            properties,
        ))
    }

    fn from_parts(
        kind: FeatureKind,
        aperture: Option<String>,
        aperture_type: Option<String>,
        macro_name: Option<String>,
        polarity: Polarity,
        primitives: FeaturePrimitives,
        path_regions: Option<Box<PathRegions>>,
        bounds: Boundary,
        properties: FeatureProperties,
    ) -> Self {
        Self {
            descriptor: Rc::new(FeatureDescriptor {
                kind,
                aperture: shared_string_option(aperture),
                aperture_type: shared_string_option(aperture_type),
                macro_name: shared_string_option(macro_name),
                polarity,
                properties,
            }),
            primitives,
            path_regions,
            bounds,
        }
    }

    pub fn gerber_properties_with_transform(
        aperture: &Aperture,
        layer_scale: f32,
        mirror_x: bool,
        mirror_y: bool,
        layer_rotation: f32,
    ) -> FeatureProperties {
        let primitive_count = u32::try_from(aperture.primitives.len()).ok();
        let scale = layer_scale.abs();
        let width = aperture.width * scale;
        let height = aperture.height * scale;
        let rotation = if aperture_has_orientation(aperture) {
            normalize_rotation(transform_aperture_rotation(
                aperture.rotation,
                mirror_x,
                mirror_y,
                layer_rotation,
            ))
        } else {
            None
        };
        FeatureProperties {
            diameter: (aperture.kind.as_str() == "circle" && width > 0.0).then_some(width),
            width: (width > 0.0).then_some(width),
            height: (height > 0.0).then_some(height),
            rotation,
            vertices: (aperture.vertices > 0).then_some(aperture.vertices),
            tool_code: None,
            primitive_count,
            arc_command: None,
        }
    }

    pub fn drill_properties(tool_code: u32, diameter: f32) -> FeatureProperties {
        FeatureProperties {
            diameter: Some(diameter),
            width: Some(diameter),
            height: Some(diameter),
            tool_code: Some(tool_code),
            ..FeatureProperties::default()
        }
    }

    pub fn info_to_js(&self, layer_id: u32, feature_id: usize) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "layerId", JsValue::from_f64(layer_id as f64))?;
        set_property(&object, "featureId", JsValue::from_f64(feature_id as f64))?;
        set_property(
            &object,
            "featureType",
            JsValue::from_str(self.descriptor.kind.as_str()),
        )?;
        set_property(
            &object,
            "polarity",
            JsValue::from_str(if self.descriptor.polarity == Polarity::Negative {
                "clear"
            } else {
                "dark"
            }),
        )?;
        if let Some(aperture) = &self.descriptor.aperture {
            set_property(&object, "aperture", JsValue::from_str(aperture.as_ref()))?;
        }
        if let Some(aperture_type) = &self.descriptor.aperture_type {
            set_property(
                &object,
                "apertureType",
                JsValue::from_str(aperture_type.as_ref()),
            )?;
        }
        if let Some(macro_name) = &self.descriptor.macro_name {
            set_property(&object, "macroName", JsValue::from_str(macro_name.as_ref()))?;
        }
        set_property(&object, "bounds", self.bounds_to_js()?)?;
        set_property(&object, "properties", self.descriptor.properties.to_js()?)?;
        Ok(object.into())
    }

    pub fn highlight_batches(&self) -> Vec<HighlightBatch> {
        let mut batches = Vec::new();
        self.primitives.append_highlight_batches(&mut batches);
        batches
    }

    fn hit(&self, point: [f32; 2], tolerance: f32) -> bool {
        let mut is_hit = self.primitives.hit(point, tolerance);
        if let Some(path_regions) = &self.path_regions {
            if path_regions_hit(path_regions, point, tolerance) {
                is_hit = true;
            }
        }
        is_hit
    }

    fn bounds_to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(
            &object,
            "minX",
            JsValue::from_f64(self.bounds.min_x() as f64),
        )?;
        set_property(
            &object,
            "maxX",
            JsValue::from_f64(self.bounds.max_x() as f64),
        )?;
        set_property(
            &object,
            "minY",
            JsValue::from_f64(self.bounds.min_y() as f64),
        )?;
        set_property(
            &object,
            "maxY",
            JsValue::from_f64(self.bounds.max_y() as f64),
        )?;
        Ok(object.into())
    }
}

impl FeatureProperties {
    fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        if let Some(value) = self.diameter {
            set_property(&object, "diameter", JsValue::from_f64(value as f64))?;
        }
        if let Some(value) = self.width {
            set_property(&object, "width", JsValue::from_f64(value as f64))?;
        }
        if let Some(value) = self.height {
            set_property(&object, "height", JsValue::from_f64(value as f64))?;
        }
        if let Some(value) = self.rotation {
            set_property(&object, "rotation", JsValue::from_f64(value as f64))?;
        }
        if let Some(value) = self.vertices {
            set_property(&object, "vertices", JsValue::from_f64(value as f64))?;
        }
        if let Some(value) = self.tool_code {
            set_property(&object, "toolCode", JsValue::from_f64(value as f64))?;
        }
        if let Some(value) = self.primitive_count {
            set_property(&object, "primitiveCount", JsValue::from_f64(value as f64))?;
        }
        if let Some(value) = &self.arc_command {
            set_property(&object, "arcCommand", JsValue::from_str(value.as_ref()))?;
        }
        Ok(object.into())
    }
}

pub fn aperture_name(code: &str) -> Option<String> {
    (!code.is_empty()).then(|| format!("D{code}"))
}

pub fn aperture_type(aperture: &Aperture) -> String {
    aperture.kind.as_str().to_string()
}

fn shared_string_option(value: Option<String>) -> Option<Rc<str>> {
    value.map(|value| Rc::<str>::from(value.as_str()))
}

fn aperture_has_orientation(aperture: &Aperture) -> bool {
    matches!(
        aperture.kind.as_str(),
        "rectangle" | "obround" | "polygon" | "macro" | "block"
    )
}

fn transform_aperture_rotation(
    mut rotation: f32,
    mirror_x: bool,
    mirror_y: bool,
    layer_rotation: f32,
) -> f32 {
    if mirror_x {
        rotation = std::f32::consts::PI - rotation;
    }
    if mirror_y {
        rotation = -rotation;
    }
    rotation + layer_rotation
}

fn normalize_rotation(rotation: f32) -> Option<f32> {
    const EPSILON: f32 = 1.0e-6;
    let full_turn = std::f32::consts::PI * 2.0;
    let mut normalized = rotation % full_turn;
    if normalized <= -std::f32::consts::PI {
        normalized += full_turn;
    } else if normalized > std::f32::consts::PI {
        normalized -= full_turn;
    }
    (normalized.abs() > EPSILON).then_some(normalized)
}

pub fn feature_from_primitive_delta(
    kind: FeatureKind,
    aperture_code: &str,
    aperture: &Aperture,
    polarity: Polarity,
    primitives: &[Primitive],
    properties: FeatureProperties,
) -> Option<InteractionFeature> {
    InteractionFeature::from_primitive_slice(
        kind,
        aperture_name(aperture_code),
        Some(aperture_type(aperture)),
        aperture.macro_name.clone(),
        polarity,
        primitives,
        properties,
    )
}

pub fn drill_hit_feature(
    tool_code: u32,
    diameter: f32,
    x: f32,
    y: f32,
) -> Option<InteractionFeature> {
    let radius = diameter * 0.5;
    InteractionFeature::from_primitives(
        FeatureKind::DrillHit,
        Some(format!("T{tool_code:02}")),
        None,
        None,
        Polarity::Positive,
        vec![Primitive::Circle {
            x,
            y,
            radius,
            exposure: 1.0,
            hole_x: 0.0,
            hole_y: 0.0,
            hole_radius: 0.0,
        }],
        InteractionFeature::drill_properties(tool_code, diameter),
    )
}

pub fn drill_slot_feature(
    tool_code: u32,
    diameter: f32,
    primitives: Vec<Primitive>,
) -> Option<InteractionFeature> {
    InteractionFeature::from_primitives(
        FeatureKind::DrillSlot,
        Some(format!("T{tool_code:02}")),
        None,
        None,
        Polarity::Positive,
        primitives,
        InteractionFeature::drill_properties(tool_code, diameter),
    )
}

fn combined_bounds(primitives: &[Primitive], path_regions: &PathRegions) -> Option<Boundary> {
    match (
        primitive_bounds(primitives),
        path_regions_bounds(path_regions),
    ) {
        (Some(mut primitive_bounds), Some(path_bounds)) => {
            primitive_bounds.include_boundary(&path_bounds);
            Some(primitive_bounds)
        }
        (Some(bounds), None) | (None, Some(bounds)) => Some(bounds),
        (None, None) => None,
    }
}

fn primitive_bounds(primitives: &[Primitive]) -> Option<Boundary> {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for primitive in primitives {
        include_primitive_bounds(primitive, &mut min_x, &mut max_x, &mut min_y, &mut max_y);
    }

    min_x
        .is_finite()
        .then_some(Boundary::new(min_x, max_x, min_y, max_y))
}

fn path_regions_bounds(path_regions: &PathRegions) -> Option<Boundary> {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for point in path_regions.cover_vertices.chunks_exact(2) {
        include_point_bounds(
            point[0], point[1], &mut min_x, &mut max_x, &mut min_y, &mut max_y,
        );
    }

    min_x
        .is_finite()
        .then_some(Boundary::new(min_x, max_x, min_y, max_y))
}

fn path_regions_has_interaction_geometry(path_regions: &PathRegions) -> bool {
    path_regions.has_geometry() || !path_regions.pick_contours.is_empty()
}

fn include_primitive_bounds(
    primitive: &Primitive,
    min_x: &mut f32,
    max_x: &mut f32,
    min_y: &mut f32,
    max_y: &mut f32,
) {
    match primitive {
        Primitive::Triangle { vertices, .. } => {
            for vertex in vertices {
                include_point_bounds(vertex[0], vertex[1], min_x, max_x, min_y, max_y);
            }
        }
        Primitive::Circle { x, y, radius, .. } => {
            *min_x = min_x.min(*x - *radius);
            *max_x = max_x.max(*x + *radius);
            *min_y = min_y.min(*y - *radius);
            *max_y = max_y.max(*y + *radius);
        }
        Primitive::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            thickness,
            ..
        } => {
            let half_width = *thickness * 0.5;
            let sweep = *end_angle - *start_angle;
            for angle in arc_bounds_angles(*start_angle, sweep) {
                let px = *x + angle.cos() * *radius;
                let py = *y + angle.sin() * *radius;
                include_circle_bounds(px, py, half_width, min_x, max_x, min_y, max_y);
            }
        }
        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            ..
        } => {
            include_circle_bounds(*x, *y, *outer_diameter * 0.5, min_x, max_x, min_y, max_y);
        }
        Primitive::TriangleTemplateFlash { template, x, y } => {
            for point in template.chunks_exact(2) {
                include_point_bounds(point[0] + *x, point[1] + *y, min_x, max_x, min_y, max_y);
            }
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            ..
        } => {
            let radius = *width * 0.5;
            include_circle_bounds(*start_x, *start_y, radius, min_x, max_x, min_y, max_y);
            include_circle_bounds(*end_x, *end_y, radius, min_x, max_x, min_y, max_y);
        }
    }
}

fn include_circle_bounds(
    x: f32,
    y: f32,
    radius: f32,
    min_x: &mut f32,
    max_x: &mut f32,
    min_y: &mut f32,
    max_y: &mut f32,
) {
    *min_x = min_x.min(x - radius);
    *max_x = max_x.max(x + radius);
    *min_y = min_y.min(y - radius);
    *max_y = max_y.max(y + radius);
}

fn include_point_bounds(
    x: f32,
    y: f32,
    min_x: &mut f32,
    max_x: &mut f32,
    min_y: &mut f32,
    max_y: &mut f32,
) {
    *min_x = min_x.min(x);
    *max_x = max_x.max(x);
    *min_y = min_y.min(y);
    *max_y = max_y.max(y);
}

fn bounds_contains(bounds: &Boundary, point: [f32; 2], tolerance: f32) -> bool {
    point[0] >= bounds.min_x() - tolerance
        && point[0] <= bounds.max_x() + tolerance
        && point[1] >= bounds.min_y() - tolerance
        && point[1] <= bounds.max_y() + tolerance
}

fn primitive_hit(primitive: &Primitive, point: [f32; 2], tolerance: f32) -> bool {
    match primitive {
        Primitive::Triangle {
            vertices,
            hole_x,
            hole_y,
            hole_radius,
            ..
        } => {
            if *hole_radius > 0.0 {
                let dx = point[0] - *hole_x;
                let dy = point[1] - *hole_y;
                if dx * dx + dy * dy <= (*hole_radius + tolerance).powi(2) {
                    return false;
                }
            }
            point_in_triangle(point, vertices) || triangle_edges_hit(point, vertices, tolerance)
        }
        Primitive::Circle {
            x,
            y,
            radius,
            hole_x,
            hole_y,
            hole_radius,
            ..
        } => {
            let dx = point[0] - *x;
            let dy = point[1] - *y;
            if dx * dx + dy * dy > (*radius + tolerance).powi(2) {
                return false;
            }
            if *hole_radius > 0.0 {
                let hx = point[0] - *hole_x;
                let hy = point[1] - *hole_y;
                if hx * hx + hy * hy <= (*hole_radius + tolerance).powi(2) {
                    return false;
                }
            }
            true
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            ..
        } => {
            distance_to_segment(point, [*start_x, *start_y], [*end_x, *end_y])
                <= *width * 0.5 + tolerance
        }
        Primitive::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            thickness,
            ..
        } => {
            let angle = (point[1] - *y).atan2(point[0] - *x);
            let sweep = *end_angle - *start_angle;
            if !angle_in_sweep(angle, *start_angle, sweep) {
                return false;
            }
            let radial_distance =
                ((point[0] - *x).powi(2) + (point[1] - *y).powi(2)).sqrt() - *radius;
            radial_distance.abs() <= *thickness * 0.5 + tolerance
        }
        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
            ..
        } => thermal_hit(
            point,
            [*x, *y],
            *outer_diameter,
            *inner_diameter,
            *gap_thickness,
            *rotation,
            tolerance,
        ),
        Primitive::TriangleTemplateFlash { template, x, y } => {
            for triangle in template.chunks_exact(6) {
                let vertices = [
                    [triangle[0] + *x, triangle[1] + *y],
                    [triangle[2] + *x, triangle[3] + *y],
                    [triangle[4] + *x, triangle[5] + *y],
                ];
                if point_in_triangle(point, &vertices)
                    || triangle_edges_hit(point, &vertices, tolerance)
                {
                    return true;
                }
            }
            false
        }
    }
}

fn path_regions_hit(path_regions: &PathRegions, point: [f32; 2], tolerance: f32) -> bool {
    for region in &path_regions.pick_contours {
        if region.is_empty() {
            continue;
        }

        let mut inside = false;
        for contour in region {
            if contour.len() < 3 {
                continue;
            }
            if contour_edges_hit(point, contour, tolerance) {
                return true;
            }
            if point_in_contour(point, contour) {
                inside = !inside;
            }
        }

        if inside {
            return true;
        }
    }

    false
}

fn append_primitive_triangles(vertices: &mut Vec<f32>, primitive: &Primitive) {
    match primitive {
        Primitive::Triangle { vertices: tri, .. } => {
            push_triangle(vertices, tri[0], tri[1], tri[2]);
        }
        Primitive::Circle { x, y, radius, .. } => {
            append_circle(vertices, [*x, *y], *radius, CIRCLE_SEGMENTS);
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            ..
        } => {
            append_capsule(
                vertices,
                [*start_x, *start_y],
                [*end_x, *end_y],
                *width * 0.5,
            );
        }
        Primitive::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            thickness,
            ..
        } => {
            append_arc(
                vertices,
                [*x, *y],
                *radius,
                *start_angle,
                *end_angle,
                *thickness,
            );
        }
        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            ..
        } => {
            append_circle(vertices, [*x, *y], *outer_diameter * 0.5, CIRCLE_SEGMENTS);
        }
        Primitive::TriangleTemplateFlash { template, x, y } => {
            for triangle in template.chunks_exact(6) {
                vertices.extend_from_slice(&[
                    triangle[0] + *x,
                    triangle[1] + *y,
                    triangle[2] + *x,
                    triangle[3] + *y,
                    triangle[4] + *x,
                    triangle[5] + *y,
                ]);
            }
        }
    }
}

fn append_primitive_highlight_batches(batches: &mut Vec<HighlightBatch>, primitive: &Primitive) {
    let mut vertices = Vec::new();
    append_primitive_triangles(&mut vertices, primitive);
    append_highlight_batch(batches, vertices, primitive_exposure(primitive) < 0.5);

    if primitive_exposure(primitive) < 0.5 {
        return;
    }

    match primitive {
        Primitive::Circle {
            hole_x,
            hole_y,
            hole_radius,
            ..
        }
        | Primitive::Triangle {
            hole_x,
            hole_y,
            hole_radius,
            ..
        } if *hole_radius > 0.0 => {
            let mut clear_vertices = Vec::new();
            append_circle(
                &mut clear_vertices,
                [*hole_x, *hole_y],
                *hole_radius,
                CIRCLE_SEGMENTS,
            );
            append_highlight_batch(batches, clear_vertices, true);
        }
        _ => {}
    }

    if let Primitive::Thermal {
        x,
        y,
        outer_diameter,
        inner_diameter,
        gap_thickness,
        rotation,
        ..
    } = primitive
    {
        if *inner_diameter > 0.0 {
            let mut clear_vertices = Vec::new();
            append_circle(
                &mut clear_vertices,
                [*x, *y],
                *inner_diameter * 0.5,
                CIRCLE_SEGMENTS,
            );
            append_highlight_batch(batches, clear_vertices, true);
        }
        if *gap_thickness > 0.0 && *outer_diameter > 0.0 {
            let mut clear_vertices = Vec::new();
            append_thermal_gap_rectangles(
                &mut clear_vertices,
                [*x, *y],
                *outer_diameter,
                *gap_thickness,
                *rotation,
            );
            append_highlight_batch(batches, clear_vertices, true);
        }
    }
}

fn append_highlight_batch(batches: &mut Vec<HighlightBatch>, vertices: Vec<f32>, clear: bool) {
    if vertices.len() < 6 {
        return;
    }

    if let Some(last) = batches.last_mut() {
        if last.clear == clear {
            last.vertices.extend_from_slice(&vertices);
            return;
        }
    }

    batches.push(HighlightBatch { vertices, clear });
}

fn primitive_exposure(primitive: &Primitive) -> f32 {
    match primitive {
        Primitive::Triangle { exposure, .. }
        | Primitive::Circle { exposure, .. }
        | Primitive::Arc { exposure, .. }
        | Primitive::Thermal { exposure, .. }
        | Primitive::Line { exposure, .. } => *exposure,
        Primitive::TriangleTemplateFlash { .. } => 1.0,
    }
}

fn append_arc(
    vertices: &mut Vec<f32>,
    center: [f32; 2],
    radius: f32,
    start_angle: f32,
    end_angle: f32,
    thickness: f32,
) {
    let sweep = end_angle - start_angle;
    let half_width = thickness * 0.5;
    let outer_radius = radius + half_width;
    let inner_radius = (radius - half_width).max(0.0);
    let segment_count =
        ((sweep.abs() / ARC_SEGMENT_RADIANS).ceil() as usize).clamp(8, MAX_ARC_SEGMENTS);

    for index in 0..segment_count {
        let t0 = index as f32 / segment_count as f32;
        let t1 = (index + 1) as f32 / segment_count as f32;
        let a0 = start_angle + sweep * t0;
        let a1 = start_angle + sweep * t1;
        let outer0 = polar_point(center, outer_radius, a0);
        let outer1 = polar_point(center, outer_radius, a1);
        let inner0 = polar_point(center, inner_radius, a0);
        let inner1 = polar_point(center, inner_radius, a1);
        push_triangle(vertices, outer0, outer1, inner1);
        push_triangle(vertices, outer0, inner1, inner0);
    }

    append_circle(
        vertices,
        polar_point(center, radius, start_angle),
        half_width,
        24,
    );
    append_circle(
        vertices,
        polar_point(center, radius, end_angle),
        half_width,
        24,
    );
}

fn append_capsule(vertices: &mut Vec<f32>, start: [f32; 2], end: [f32; 2], radius: f32) {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    let length = (dx * dx + dy * dy).sqrt();
    if length <= f32::EPSILON {
        append_circle(vertices, start, radius, CIRCLE_SEGMENTS);
        return;
    }

    let nx = -dy / length * radius;
    let ny = dx / length * radius;
    push_triangle(
        vertices,
        [start[0] + nx, start[1] + ny],
        [start[0] - nx, start[1] - ny],
        [end[0] + nx, end[1] + ny],
    );
    push_triangle(
        vertices,
        [start[0] - nx, start[1] - ny],
        [end[0] - nx, end[1] - ny],
        [end[0] + nx, end[1] + ny],
    );
    append_circle(vertices, start, radius, 24);
    append_circle(vertices, end, radius, 24);
}

fn thermal_hit(
    point: [f32; 2],
    center: [f32; 2],
    outer_diameter: f32,
    inner_diameter: f32,
    gap_thickness: f32,
    rotation: f32,
    tolerance: f32,
) -> bool {
    if outer_diameter <= 0.0 {
        return false;
    }

    let dx = point[0] - center[0];
    let dy = point[1] - center[1];
    let distance = (dx * dx + dy * dy).sqrt();
    let outer_radius = outer_diameter * 0.5;
    let inner_radius = (inner_diameter * 0.5).max(0.0);
    if distance > outer_radius + tolerance || distance < (inner_radius - tolerance).max(0.0) {
        return false;
    }

    let half_gap = (gap_thickness * 0.5).max(0.0);
    if half_gap <= tolerance {
        return true;
    }

    let cos_r = rotation.cos();
    let sin_r = rotation.sin();
    let local_x = dx * cos_r + dy * sin_r;
    let local_y = -dx * sin_r + dy * cos_r;
    local_x.abs() >= half_gap - tolerance && local_y.abs() >= half_gap - tolerance
}

fn append_thermal_gap_rectangles(
    vertices: &mut Vec<f32>,
    center: [f32; 2],
    outer_diameter: f32,
    gap_thickness: f32,
    rotation: f32,
) {
    let outer_radius = outer_diameter * 0.5;
    let half_gap = gap_thickness * 0.5;
    if outer_radius <= 0.0 || half_gap <= 0.0 {
        return;
    }

    append_rotated_rect(vertices, center, half_gap, outer_radius, rotation);
    append_rotated_rect(vertices, center, outer_radius, half_gap, rotation);
}

fn append_rotated_rect(
    vertices: &mut Vec<f32>,
    center: [f32; 2],
    half_width: f32,
    half_height: f32,
    rotation: f32,
) {
    let local = [
        [-half_width, -half_height],
        [half_width, -half_height],
        [half_width, half_height],
        [-half_width, half_height],
    ];
    let cos_r = rotation.cos();
    let sin_r = rotation.sin();
    let mut points = [[0.0; 2]; 4];
    for (idx, point) in local.iter().enumerate() {
        points[idx] = [
            center[0] + point[0] * cos_r - point[1] * sin_r,
            center[1] + point[0] * sin_r + point[1] * cos_r,
        ];
    }

    push_triangle(vertices, points[0], points[1], points[2]);
    push_triangle(vertices, points[0], points[2], points[3]);
}

fn append_circle(vertices: &mut Vec<f32>, center: [f32; 2], radius: f32, segments: usize) {
    if radius <= 0.0 || !radius.is_finite() {
        return;
    }
    for index in 0..segments {
        let a0 = TWO_PI * index as f32 / segments as f32;
        let a1 = TWO_PI * (index + 1) as f32 / segments as f32;
        push_triangle(
            vertices,
            center,
            polar_point(center, radius, a0),
            polar_point(center, radius, a1),
        );
    }
}

fn push_triangle(vertices: &mut Vec<f32>, a: [f32; 2], b: [f32; 2], c: [f32; 2]) {
    vertices.extend_from_slice(&[a[0], a[1], b[0], b[1], c[0], c[1]]);
}

fn polar_point(center: [f32; 2], radius: f32, angle: f32) -> [f32; 2] {
    [
        center[0] + radius * angle.cos(),
        center[1] + radius * angle.sin(),
    ]
}

fn point_in_triangle(point: [f32; 2], vertices: &[[f32; 2]; 3]) -> bool {
    let [a, b, c] = *vertices;
    let d1 = sign(point, a, b);
    let d2 = sign(point, b, c);
    let d3 = sign(point, c, a);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

fn triangle_edges_hit(point: [f32; 2], vertices: &[[f32; 2]; 3], tolerance: f32) -> bool {
    if tolerance <= 0.0 {
        return false;
    }
    distance_to_segment(point, vertices[0], vertices[1]) <= tolerance
        || distance_to_segment(point, vertices[1], vertices[2]) <= tolerance
        || distance_to_segment(point, vertices[2], vertices[0]) <= tolerance
}

fn contour_edges_hit(point: [f32; 2], contour: &[[f32; 2]], tolerance: f32) -> bool {
    if tolerance <= 0.0 || contour.len() < 2 {
        return false;
    }

    for index in 0..contour.len() {
        let start = contour[index];
        let end = contour[(index + 1) % contour.len()];
        if distance_to_segment(point, start, end) <= tolerance {
            return true;
        }
    }

    false
}

fn point_in_contour(point: [f32; 2], contour: &[[f32; 2]]) -> bool {
    if contour.len() < 3 {
        return false;
    }

    let mut inside = false;
    let mut previous = contour[contour.len() - 1];
    for current in contour {
        let crosses_y = (current[1] > point[1]) != (previous[1] > point[1]);
        if crosses_y {
            let x_intersection = (previous[0] - current[0]) * (point[1] - current[1])
                / (previous[1] - current[1])
                + current[0];
            if point[0] < x_intersection {
                inside = !inside;
            }
        }
        previous = *current;
    }

    inside
}

fn sign(p1: [f32; 2], p2: [f32; 2], p3: [f32; 2]) -> f32 {
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
}

fn distance_to_segment(point: [f32; 2], start: [f32; 2], end: [f32; 2]) -> f32 {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    let length_sq = dx * dx + dy * dy;
    if length_sq <= f32::EPSILON {
        return ((point[0] - start[0]).powi(2) + (point[1] - start[1]).powi(2)).sqrt();
    }
    let t = (((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_sq).clamp(0.0, 1.0);
    let x = start[0] + t * dx;
    let y = start[1] + t * dy;
    ((point[0] - x).powi(2) + (point[1] - y).powi(2)).sqrt()
}

fn arc_bounds_angles(start_angle: f32, sweep_angle: f32) -> Vec<f32> {
    let mut angles = vec![start_angle, start_angle + sweep_angle];
    for angle in [
        0.0,
        std::f32::consts::FRAC_PI_2,
        std::f32::consts::PI,
        std::f32::consts::PI * 1.5,
    ] {
        if angle_in_sweep(angle, start_angle, sweep_angle) {
            angles.push(angle);
        }
    }
    angles
}

fn angle_in_sweep(angle: f32, start_angle: f32, sweep_angle: f32) -> bool {
    if sweep_angle.abs() >= TWO_PI - 0.00001 {
        return true;
    }
    let angle = normalize_angle(angle);
    let start = normalize_angle(start_angle);
    let delta = if sweep_angle >= 0.0 {
        normalize_angle(angle - start)
    } else {
        normalize_angle(start - angle)
    };
    delta <= sweep_angle.abs() + 1.0e-6
}

fn normalize_angle(angle: f32) -> f32 {
    let mut angle = angle % TWO_PI;
    if angle < 0.0 {
        angle += TWO_PI;
    }
    angle
}

fn set_property(object: &Object, key: &str, value: JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value)
        .map(|_| ())
        .map_err(|_| JsValue::from_str(&format!("Failed to set interaction field `{key}`")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circle_feature(x: f32, radius: f32, polarity: Polarity) -> InteractionFeature {
        InteractionFeature::from_primitives(
            FeatureKind::Flash,
            Some("D10".to_string()),
            Some("circle".to_string()),
            None,
            polarity,
            vec![Primitive::Circle {
                x,
                y: 0.0,
                radius,
                exposure: 1.0,
                hole_x: 0.0,
                hole_y: 0.0,
                hole_radius: 0.0,
            }],
            FeatureProperties::default(),
        )
        .expect("circle feature should have bounds")
    }

    fn thermal_feature(rotation: f32) -> InteractionFeature {
        InteractionFeature::from_primitives(
            FeatureKind::Flash,
            Some("D10".to_string()),
            Some("macro".to_string()),
            Some("THERM".to_string()),
            Polarity::Positive,
            vec![Primitive::Thermal {
                x: 0.0,
                y: 0.0,
                outer_diameter: 2.0,
                inner_diameter: 0.5,
                gap_thickness: 0.4,
                rotation,
                exposure: 1.0,
            }],
            FeatureProperties::default(),
        )
        .expect("thermal feature should have bounds")
    }

    #[test]
    fn pick_after_returns_next_hit_in_render_order() {
        let mut layer = InteractionLayer::new();
        layer.push(circle_feature(0.0, 2.0, Polarity::Positive));
        layer.push(circle_feature(0.0, 2.0, Polarity::Positive));
        layer.push(circle_feature(0.0, 2.0, Polarity::Positive));

        let (hit, saw_after) = layer.pick_after(0.0, 0.0, 0.0, None);
        assert_eq!(hit.map(|(feature_id, _)| feature_id), Some(2));
        assert!(!saw_after);

        let (hit, saw_after) = layer.pick_after(0.0, 0.0, 0.0, Some(2));
        assert_eq!(hit.map(|(feature_id, _)| feature_id), Some(1));
        assert!(saw_after);

        let (hit, saw_after) = layer.pick_after(0.0, 0.0, 0.0, Some(0));
        assert!(hit.is_none());
        assert!(saw_after);
    }

    #[test]
    fn pick_after_stops_at_hit_clear_feature() {
        let mut layer = InteractionLayer::new();
        layer.push(circle_feature(0.0, 2.0, Polarity::Positive));
        layer.push(circle_feature(0.0, 2.0, Polarity::Negative));

        let (hit, saw_after) = layer.pick_after(0.0, 0.0, 0.0, None);
        assert!(hit.is_none());
        assert!(!saw_after);
    }

    #[test]
    fn non_aperture_features_do_not_report_aperture_type() {
        let region = InteractionFeature::from_primitives(
            FeatureKind::Region,
            None,
            None,
            None,
            Polarity::Positive,
            vec![Primitive::Triangle {
                vertices: [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
                exposure: 1.0,
                hole_x: 0.0,
                hole_y: 0.0,
                hole_radius: 0.0,
            }],
            FeatureProperties::default(),
        )
        .expect("region feature should have bounds");
        let drill = drill_hit_feature(1, 0.5, 0.0, 0.0).expect("drill hit should have bounds");

        assert!(region.descriptor.aperture_type.is_none());
        assert!(drill.descriptor.aperture_type.is_none());
    }

    #[test]
    fn thermal_hit_respects_inner_hole_and_rotated_gaps() {
        let feature = thermal_feature(0.0);
        assert!(feature.hit([0.5, 0.5], 0.0));
        assert!(!feature.hit([0.0, 0.5], 0.0));
        assert!(!feature.hit([0.1, 0.1], 0.0));

        let rotated = thermal_feature(std::f32::consts::FRAC_PI_4);
        assert!(!rotated.hit([0.5, 0.5], 0.0));
        assert!(rotated.hit([0.7, 0.0], 0.0));
    }

    #[test]
    fn thermal_highlight_batches_clear_hole_and_gaps() {
        let batches = thermal_feature(0.0).highlight_batches();
        assert_eq!(batches.len(), 2);
        assert!(!batches[0].clear);
        assert!(batches[1].clear);
        assert!(batches[1].vertices.len() > CIRCLE_SEGMENTS * 6);
    }
}

// ===== Binary encoding helpers (worker→main transfer) =====

struct BinaryWriter {
    buf: Vec<u8>,
}

impl BinaryWriter {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    #[inline]
    fn write_u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    #[inline]
    fn write_u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    fn write_f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    fn write_bytes(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    fn write_opt_str(&mut self, s: &Option<Rc<str>>) {
        match s {
            None => self.write_u32(u32::MAX),
            Some(s) => {
                let b = s.as_bytes();
                self.write_u32(b.len() as u32);
                self.write_bytes(b);
            }
        }
    }

    fn write_f32_slice(&mut self, values: &[f32]) {
        self.write_u32(values.len() as u32);
        for &v in values {
            self.write_f32(v);
        }
    }

    fn write_u32_slice(&mut self, values: &[u32]) {
        self.write_u32(values.len() as u32);
        for &v in values {
            self.write_u32(v);
        }
    }

    fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}

struct BinaryReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BinaryReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        self.data
            .get(self.pos)
            .copied()
            .map(|v| {
                self.pos += 1;
                v
            })
            .ok_or_else(|| "Truncated interaction data (u8)".to_string())
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.data.len() {
            return Err("Truncated interaction data (u32)".to_string());
        }
        let b: [u8; 4] = self.data[self.pos..self.pos + 4].try_into().unwrap();
        self.pos += 4;
        Ok(u32::from_le_bytes(b))
    }

    fn read_f32(&mut self) -> Result<f32, String> {
        if self.pos + 4 > self.data.len() {
            return Err("Truncated interaction data (f32)".to_string());
        }
        let b: [u8; 4] = self.data[self.pos..self.pos + 4].try_into().unwrap();
        self.pos += 4;
        Ok(f32::from_le_bytes(b))
    }

    fn read_f32_vec(&mut self) -> Result<Vec<f32>, String> {
        let len = self.read_u32()? as usize;
        let mut v = Vec::with_capacity(len);
        for _ in 0..len {
            v.push(self.read_f32()?);
        }
        Ok(v)
    }

    fn read_u32_vec(&mut self) -> Result<Vec<u32>, String> {
        let len = self.read_u32()? as usize;
        let mut v = Vec::with_capacity(len);
        for _ in 0..len {
            v.push(self.read_u32()?);
        }
        Ok(v)
    }

    fn read_opt_str(&mut self) -> Result<Option<Rc<str>>, String> {
        let len = self.read_u32()?;
        if len == u32::MAX {
            return Ok(None);
        }
        let len = len as usize;
        if self.pos + len > self.data.len() {
            return Err("Truncated interaction data (string)".to_string());
        }
        let s = std::str::from_utf8(&self.data[self.pos..self.pos + len])
            .map_err(|_| "Invalid UTF-8 in interaction data string".to_string())?;
        self.pos += len;
        Ok(Some(Rc::from(s)))
    }

    fn read_bytes(&mut self, len: usize) -> Result<&[u8], String> {
        if self.pos + len > self.data.len() {
            return Err("Truncated interaction data (bytes)".to_string());
        }
        let slice = &self.data[self.pos..self.pos + len];
        self.pos += len;
        Ok(slice)
    }
}

fn encode_feature_bytes(
    w: &mut BinaryWriter,
    feature: &InteractionFeature,
    template_map: &HashMap<*const Vec<f32>, u32>,
) {
    let d = &feature.descriptor;
    w.write_u8(d.kind.to_u8());
    w.write_u8(if d.polarity == Polarity::Negative { 1 } else { 0 });
    w.write_opt_str(&d.aperture);
    w.write_opt_str(&d.aperture_type);
    w.write_opt_str(&d.macro_name);

    let p = &d.properties;
    let flags: u8 = (p.diameter.is_some() as u8)
        | ((p.width.is_some() as u8) << 1)
        | ((p.height.is_some() as u8) << 2)
        | ((p.rotation.is_some() as u8) << 3)
        | ((p.vertices.is_some() as u8) << 4)
        | ((p.tool_code.is_some() as u8) << 5)
        | ((p.primitive_count.is_some() as u8) << 6)
        | ((p.arc_command.is_some() as u8) << 7);
    w.write_u8(flags);
    if let Some(v) = p.diameter {
        w.write_f32(v);
    }
    if let Some(v) = p.width {
        w.write_f32(v);
    }
    if let Some(v) = p.height {
        w.write_f32(v);
    }
    if let Some(v) = p.rotation {
        w.write_f32(v);
    }
    if let Some(v) = p.vertices {
        w.write_u32(v);
    }
    if let Some(v) = p.tool_code {
        w.write_u32(v);
    }
    if let Some(v) = p.primitive_count {
        w.write_u32(v);
    }
    if let Some(ref s) = p.arc_command {
        let b = s.as_bytes();
        w.write_u32(b.len() as u32);
        w.write_bytes(b);
    }

    w.write_f32(feature.bounds.min_x());
    w.write_f32(feature.bounds.min_y());
    w.write_f32(feature.bounds.max_x());
    w.write_f32(feature.bounds.max_y());

    encode_storage_bytes(w, &feature.primitives.storage, template_map);

    match &feature.path_regions {
        None => w.write_u8(0),
        Some(pr) => {
            w.write_u8(1);
            encode_path_regions_bytes(w, pr);
        }
    }
}

fn encode_storage_bytes(
    w: &mut BinaryWriter,
    storage: &FeaturePrimitiveStorage,
    template_map: &HashMap<*const Vec<f32>, u32>,
) {
    match storage {
        FeaturePrimitiveStorage::Empty => w.write_u8(0),
        FeaturePrimitiveStorage::Triangle(p) => {
            w.write_u8(1);
            if let Primitive::Triangle {
                vertices,
                exposure,
                hole_x,
                hole_y,
                hole_radius,
            } = p.as_ref()
            {
                for [vx, vy] in vertices {
                    w.write_f32(*vx);
                    w.write_f32(*vy);
                }
                w.write_f32(*exposure);
                w.write_f32(*hole_x);
                w.write_f32(*hole_y);
                w.write_f32(*hole_radius);
            }
        }
        FeaturePrimitiveStorage::Circle {
            x,
            y,
            radius,
            exposure,
            hole_x,
            hole_y,
            hole_radius,
        } => {
            w.write_u8(2);
            w.write_f32(*x);
            w.write_f32(*y);
            w.write_f32(*radius);
            w.write_f32(*exposure);
            w.write_f32(*hole_x);
            w.write_f32(*hole_y);
            w.write_f32(*hole_radius);
        }
        FeaturePrimitiveStorage::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            thickness,
            exposure,
        } => {
            w.write_u8(3);
            w.write_f32(*x);
            w.write_f32(*y);
            w.write_f32(*radius);
            w.write_f32(*start_angle);
            w.write_f32(*end_angle);
            w.write_f32(*thickness);
            w.write_f32(*exposure);
        }
        FeaturePrimitiveStorage::Thermal {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
            exposure,
        } => {
            w.write_u8(4);
            w.write_f32(*x);
            w.write_f32(*y);
            w.write_f32(*outer_diameter);
            w.write_f32(*inner_diameter);
            w.write_f32(*gap_thickness);
            w.write_f32(*rotation);
            w.write_f32(*exposure);
        }
        FeaturePrimitiveStorage::TriangleTemplateFlash { template, x, y } => {
            w.write_u8(5);
            let idx = template_map[&Rc::as_ptr(template)];
            w.write_u32(idx);
            w.write_f32(*x);
            w.write_f32(*y);
        }
        FeaturePrimitiveStorage::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            exposure,
        } => {
            w.write_u8(6);
            w.write_f32(*start_x);
            w.write_f32(*start_y);
            w.write_f32(*end_x);
            w.write_f32(*end_y);
            w.write_f32(*width);
            w.write_f32(*exposure);
        }
        FeaturePrimitiveStorage::Multiple(primitives) => {
            w.write_u8(7);
            w.write_u32(primitives.len() as u32);
            for p in primitives.iter() {
                encode_primitive_bytes(w, p, template_map);
            }
        }
    }
}

fn encode_primitive_bytes(
    w: &mut BinaryWriter,
    primitive: &Primitive,
    template_map: &HashMap<*const Vec<f32>, u32>,
) {
    match primitive {
        Primitive::Triangle {
            vertices,
            exposure,
            hole_x,
            hole_y,
            hole_radius,
        } => {
            w.write_u8(1);
            for [vx, vy] in vertices {
                w.write_f32(*vx);
                w.write_f32(*vy);
            }
            w.write_f32(*exposure);
            w.write_f32(*hole_x);
            w.write_f32(*hole_y);
            w.write_f32(*hole_radius);
        }
        Primitive::Circle {
            x,
            y,
            radius,
            exposure,
            hole_x,
            hole_y,
            hole_radius,
        } => {
            w.write_u8(2);
            w.write_f32(*x);
            w.write_f32(*y);
            w.write_f32(*radius);
            w.write_f32(*exposure);
            w.write_f32(*hole_x);
            w.write_f32(*hole_y);
            w.write_f32(*hole_radius);
        }
        Primitive::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            thickness,
            exposure,
        } => {
            w.write_u8(3);
            w.write_f32(*x);
            w.write_f32(*y);
            w.write_f32(*radius);
            w.write_f32(*start_angle);
            w.write_f32(*end_angle);
            w.write_f32(*thickness);
            w.write_f32(*exposure);
        }
        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
            exposure,
        } => {
            w.write_u8(4);
            w.write_f32(*x);
            w.write_f32(*y);
            w.write_f32(*outer_diameter);
            w.write_f32(*inner_diameter);
            w.write_f32(*gap_thickness);
            w.write_f32(*rotation);
            w.write_f32(*exposure);
        }
        Primitive::TriangleTemplateFlash { template, x, y } => {
            w.write_u8(5);
            let idx = template_map[&Rc::as_ptr(template)];
            w.write_u32(idx);
            w.write_f32(*x);
            w.write_f32(*y);
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            exposure,
        } => {
            w.write_u8(6);
            w.write_f32(*start_x);
            w.write_f32(*start_y);
            w.write_f32(*end_x);
            w.write_f32(*end_y);
            w.write_f32(*width);
            w.write_f32(*exposure);
        }
    }
}

fn encode_path_regions_bytes(w: &mut BinaryWriter, pr: &PathRegions) {
    w.write_f32_slice(&pr.wedge_vertices);
    w.write_u32_slice(&pr.wedge_vertex_offsets);
    w.write_f32_slice(&pr.sector_vertices);
    w.write_u32_slice(&pr.sector_vertex_offsets);
    w.write_f32_slice(&pr.cover_vertices);
    w.write_f32_slice(&pr.clear_vertices);
    w.write_u32(pr.pick_contours.len() as u32);
    for region in &pr.pick_contours {
        w.write_u32(region.len() as u32);
        for contour in region {
            w.write_u32(contour.len() as u32);
            for [x, y] in contour {
                w.write_f32(*x);
                w.write_f32(*y);
            }
        }
    }
}

fn decode_feature_bytes(
    r: &mut BinaryReader<'_>,
    templates: &[Rc<Vec<f32>>],
) -> Result<InteractionFeature, String> {
    let kind = FeatureKind::from_u8(r.read_u8()?)?;
    let polarity = if r.read_u8()? != 0 {
        Polarity::Negative
    } else {
        Polarity::Positive
    };
    let aperture = r.read_opt_str()?;
    let aperture_type = r.read_opt_str()?;
    let macro_name = r.read_opt_str()?;

    let flags = r.read_u8()?;
    let diameter = (flags & 1 != 0).then(|| r.read_f32()).transpose()?;
    let width = (flags & 2 != 0).then(|| r.read_f32()).transpose()?;
    let height = (flags & 4 != 0).then(|| r.read_f32()).transpose()?;
    let rotation = (flags & 8 != 0).then(|| r.read_f32()).transpose()?;
    let vertices = (flags & 16 != 0).then(|| r.read_u32()).transpose()?;
    let tool_code = (flags & 32 != 0).then(|| r.read_u32()).transpose()?;
    let primitive_count = (flags & 64 != 0).then(|| r.read_u32()).transpose()?;
    let arc_command = if flags & 128 != 0 {
        let len = r.read_u32()? as usize;
        let b = r.read_bytes(len)?;
        let s = std::str::from_utf8(b)
            .map_err(|_| "Invalid UTF-8 in arc_command".to_string())?;
        Some(Rc::from(s))
    } else {
        None
    };

    let min_x = r.read_f32()?;
    let min_y = r.read_f32()?;
    let max_x = r.read_f32()?;
    let max_y = r.read_f32()?;
    let bounds = Boundary::new(min_x, max_x, min_y, max_y);

    let primitives = decode_storage_bytes(r, templates)?;

    let path_regions = if r.read_u8()? != 0 {
        Some(Box::new(decode_path_regions_bytes(r)?))
    } else {
        None
    };

    Ok(InteractionFeature {
        descriptor: Rc::new(FeatureDescriptor {
            kind,
            aperture,
            aperture_type,
            macro_name,
            polarity,
            properties: FeatureProperties {
                diameter,
                width,
                height,
                rotation,
                vertices,
                tool_code,
                primitive_count,
                arc_command,
            },
        }),
        primitives,
        path_regions,
        bounds,
    })
}

fn decode_storage_bytes(
    r: &mut BinaryReader<'_>,
    templates: &[Rc<Vec<f32>>],
) -> Result<FeaturePrimitives, String> {
    let tag = r.read_u8()?;
    let storage = match tag {
        0 => FeaturePrimitiveStorage::Empty,
        1 => {
            let v0 = [r.read_f32()?, r.read_f32()?];
            let v1 = [r.read_f32()?, r.read_f32()?];
            let v2 = [r.read_f32()?, r.read_f32()?];
            FeaturePrimitiveStorage::Triangle(Box::new(Primitive::Triangle {
                vertices: [v0, v1, v2],
                exposure: r.read_f32()?,
                hole_x: r.read_f32()?,
                hole_y: r.read_f32()?,
                hole_radius: r.read_f32()?,
            }))
        }
        2 => FeaturePrimitiveStorage::Circle {
            x: r.read_f32()?,
            y: r.read_f32()?,
            radius: r.read_f32()?,
            exposure: r.read_f32()?,
            hole_x: r.read_f32()?,
            hole_y: r.read_f32()?,
            hole_radius: r.read_f32()?,
        },
        3 => FeaturePrimitiveStorage::Arc {
            x: r.read_f32()?,
            y: r.read_f32()?,
            radius: r.read_f32()?,
            start_angle: r.read_f32()?,
            end_angle: r.read_f32()?,
            thickness: r.read_f32()?,
            exposure: r.read_f32()?,
        },
        4 => FeaturePrimitiveStorage::Thermal {
            x: r.read_f32()?,
            y: r.read_f32()?,
            outer_diameter: r.read_f32()?,
            inner_diameter: r.read_f32()?,
            gap_thickness: r.read_f32()?,
            rotation: r.read_f32()?,
            exposure: r.read_f32()?,
        },
        5 => {
            let idx = r.read_u32()? as usize;
            let template = templates
                .get(idx)
                .ok_or_else(|| format!("Template index {idx} out of range ({} templates)", templates.len()))?;
            FeaturePrimitiveStorage::TriangleTemplateFlash {
                template: Rc::clone(template),
                x: r.read_f32()?,
                y: r.read_f32()?,
            }
        }
        6 => FeaturePrimitiveStorage::Line {
            start_x: r.read_f32()?,
            start_y: r.read_f32()?,
            end_x: r.read_f32()?,
            end_y: r.read_f32()?,
            width: r.read_f32()?,
            exposure: r.read_f32()?,
        },
        7 => {
            let count = r.read_u32()? as usize;
            let mut primitives = Vec::with_capacity(count);
            for _ in 0..count {
                primitives.push(decode_primitive_bytes(r, templates)?);
            }
            FeaturePrimitiveStorage::Multiple(primitives.into_boxed_slice())
        }
        _ => return Err(format!("Unknown primitive storage tag: {tag}")),
    };
    Ok(FeaturePrimitives { storage })
}

fn decode_primitive_bytes(
    r: &mut BinaryReader<'_>,
    templates: &[Rc<Vec<f32>>],
) -> Result<Primitive, String> {
    let tag = r.read_u8()?;
    match tag {
        1 => {
            let v0 = [r.read_f32()?, r.read_f32()?];
            let v1 = [r.read_f32()?, r.read_f32()?];
            let v2 = [r.read_f32()?, r.read_f32()?];
            Ok(Primitive::Triangle {
                vertices: [v0, v1, v2],
                exposure: r.read_f32()?,
                hole_x: r.read_f32()?,
                hole_y: r.read_f32()?,
                hole_radius: r.read_f32()?,
            })
        }
        2 => Ok(Primitive::Circle {
            x: r.read_f32()?,
            y: r.read_f32()?,
            radius: r.read_f32()?,
            exposure: r.read_f32()?,
            hole_x: r.read_f32()?,
            hole_y: r.read_f32()?,
            hole_radius: r.read_f32()?,
        }),
        3 => Ok(Primitive::Arc {
            x: r.read_f32()?,
            y: r.read_f32()?,
            radius: r.read_f32()?,
            start_angle: r.read_f32()?,
            end_angle: r.read_f32()?,
            thickness: r.read_f32()?,
            exposure: r.read_f32()?,
        }),
        4 => Ok(Primitive::Thermal {
            x: r.read_f32()?,
            y: r.read_f32()?,
            outer_diameter: r.read_f32()?,
            inner_diameter: r.read_f32()?,
            gap_thickness: r.read_f32()?,
            rotation: r.read_f32()?,
            exposure: r.read_f32()?,
        }),
        5 => {
            let idx = r.read_u32()? as usize;
            let template = templates
                .get(idx)
                .ok_or_else(|| format!("Template index {idx} out of range"))?;
            Ok(Primitive::TriangleTemplateFlash {
                template: Rc::clone(template),
                x: r.read_f32()?,
                y: r.read_f32()?,
            })
        }
        6 => Ok(Primitive::Line {
            start_x: r.read_f32()?,
            start_y: r.read_f32()?,
            end_x: r.read_f32()?,
            end_y: r.read_f32()?,
            width: r.read_f32()?,
            exposure: r.read_f32()?,
        }),
        _ => Err(format!("Unknown primitive tag: {tag}")),
    }
}

fn decode_path_regions_bytes(r: &mut BinaryReader<'_>) -> Result<PathRegions, String> {
    let wedge_vertices = r.read_f32_vec()?;
    let wedge_vertex_offsets = r.read_u32_vec()?;
    let sector_vertices = r.read_f32_vec()?;
    let sector_vertex_offsets = r.read_u32_vec()?;
    let cover_vertices = r.read_f32_vec()?;
    let clear_vertices = r.read_f32_vec()?;

    let region_count = r.read_u32()? as usize;
    let mut pick_contours: Vec<Vec<Vec<[f32; 2]>>> = Vec::with_capacity(region_count);
    for _ in 0..region_count {
        let contour_count = r.read_u32()? as usize;
        let mut region = Vec::with_capacity(contour_count);
        for _ in 0..contour_count {
            let point_count = r.read_u32()? as usize;
            let mut contour = Vec::with_capacity(point_count);
            for _ in 0..point_count {
                contour.push([r.read_f32()?, r.read_f32()?]);
            }
            region.push(contour);
        }
        pick_contours.push(region);
    }

    // Offsets are already normalized from the original parse; construct directly
    // to avoid double-normalization from PathRegions::new().
    Ok(PathRegions {
        wedge_vertices,
        wedge_vertex_offsets,
        sector_vertices,
        sector_vertex_offsets,
        cover_vertices,
        clear_vertices,
        pick_contours,
    })
}
