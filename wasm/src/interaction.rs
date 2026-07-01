use crate::parser::geometry::{offset_primitive_by, Primitive};
use crate::parser::{Aperture, Polarity};
use crate::shape::{Boundary, PathRegions, PATH_SECTOR_VERTEX_FLOATS};
use js_sys::{Array, Float32Array, Object, Reflect, Uint32Array};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

const CIRCLE_SEGMENTS: usize = 48;
const ARC_SEGMENT_RADIANS: f32 = std::f32::consts::PI / 48.0;
const MAX_ARC_SEGMENTS: usize = 256;
const TWO_PI: f32 = std::f32::consts::PI * 2.0;
const COMPACT_INTERACTION_VERSION: u32 = 3;
const COMPACT_NONE: u32 = u32::MAX;
const COMPACT_PRIMITIVE_STRIDE: usize = 10;
const COMPACT_PATH_REGION_REF_STRIDE: usize = 3;
const PROPERTY_DIAMETER: u32 = 1 << 0;
const PROPERTY_WIDTH: u32 = 1 << 1;
const PROPERTY_HEIGHT: u32 = 1 << 2;
const PROPERTY_ROTATION: u32 = 1 << 3;

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
    pub path_region_ref: Option<PathRegionRef>,
    pub bounds: Boundary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PathRegionRef {
    pub sublayer_idx: usize,
    pub region_start: usize,
    pub region_count: usize,
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

    pub(crate) fn remap_path_region_sublayers(
        &mut self,
        sublayer_map: &[usize],
    ) -> Result<(), JsValue> {
        for feature in &mut self.features {
            let Some(path_region_ref) = &mut feature.path_region_ref else {
                continue;
            };
            path_region_ref.sublayer_idx = *sublayer_map
                .get(path_region_ref.sublayer_idx)
                .ok_or_else(|| JsValue::from_str("Interaction path region sublayer is invalid"))?;
        }
        Ok(())
    }

    pub fn pick(&self, x: f32, y: f32, tolerance: f32) -> Option<(usize, &InteractionFeature)> {
        self.pick_after(x, y, tolerance, None).0
    }

    pub fn feature(&self, feature_id: usize) -> Option<&InteractionFeature> {
        self.features.get(feature_id)
    }

    pub fn following_clear_features_for_highlight(
        &self,
        feature_id: usize,
    ) -> Vec<&InteractionFeature> {
        let Some(feature) = self.features.get(feature_id) else {
            return Vec::new();
        };
        if feature.descriptor.polarity == Polarity::Negative {
            return Vec::new();
        }

        self.features
            .iter()
            .skip(feature_id.saturating_add(1))
            .filter(|candidate| {
                candidate.descriptor.polarity == Polarity::Negative
                    && feature.bounds.intersects(&candidate.bounds)
                    && candidate.has_highlight_geometry()
            })
            .collect()
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

    pub(crate) fn to_compact_js(&self) -> Result<JsValue, JsValue> {
        let mut strings = CompactStringTable::default();
        let mut descriptors = CompactDescriptorTable::default();
        let mut templates = CompactTemplateTable::default();
        let path_regions = Array::new();

        let mut feature_descriptors = Vec::with_capacity(self.features.len());
        let mut feature_bounds = Vec::with_capacity(self.features.len() * 4);
        let mut feature_primitive_ranges = Vec::with_capacity(self.features.len() * 2);
        let mut feature_path_region_ids = Vec::with_capacity(self.features.len());
        let mut path_region_ref_feature_ids = Vec::new();
        let mut path_region_ref_data = Vec::new();
        let mut primitive_types = Vec::new();
        let mut primitive_data = Vec::new();

        for feature in &self.features {
            feature_descriptors.push(descriptors.intern(&feature.descriptor, &mut strings));
            feature_bounds.extend_from_slice(&[
                feature.bounds.min_x(),
                feature.bounds.max_x(),
                feature.bounds.min_y(),
                feature.bounds.max_y(),
            ]);

            feature_primitive_ranges.push(primitive_types.len() as u32);
            feature.primitives.append_compact_primitives(
                &mut primitive_types,
                &mut primitive_data,
                &mut templates,
            );
            feature_primitive_ranges.push(
                (primitive_types.len() as u32)
                    .saturating_sub(*feature_primitive_ranges.last().unwrap_or(&0)),
            );

            if let Some(path_region) = feature.path_regions.as_deref() {
                let path_region_id = path_regions.length();
                path_regions.push(&path_region_to_compact_js(path_region)?);
                feature_path_region_ids.push(path_region_id);
            } else {
                feature_path_region_ids.push(COMPACT_NONE);
            }

            if let Some(path_region_ref) = feature.path_region_ref {
                path_region_ref_feature_ids.push(compact_usize(
                    feature_descriptors.len().saturating_sub(1),
                    "path region ref feature",
                )?);
                path_region_ref_data.push(compact_usize(
                    path_region_ref.sublayer_idx,
                    "path region sublayer",
                )?);
                path_region_ref_data.push(compact_usize(
                    path_region_ref.region_start,
                    "path region start",
                )?);
                path_region_ref_data.push(compact_usize(
                    path_region_ref.region_count,
                    "path region count",
                )?);
            }
        }

        let object = Object::new();
        set_property(
            &object,
            "version",
            JsValue::from_f64(COMPACT_INTERACTION_VERSION as f64),
        )?;
        set_property(&object, "strings", strings.to_js().into())?;
        set_property(
            &object,
            "descriptorFields",
            u32_array_to_js(&descriptors.fields),
        )?;
        set_property(
            &object,
            "descriptorProperties",
            f32_array_to_js(&descriptors.properties),
        )?;
        set_property(
            &object,
            "featureDescriptors",
            u32_array_to_js(&feature_descriptors),
        )?;
        set_property(&object, "featureBounds", f32_array_to_js(&feature_bounds))?;
        set_property(
            &object,
            "featurePrimitiveRanges",
            u32_array_to_js(&feature_primitive_ranges),
        )?;
        set_property(
            &object,
            "featurePathRegionIds",
            u32_array_to_js(&feature_path_region_ids),
        )?;
        set_property(
            &object,
            "pathRegionRefFeatureIds",
            u32_array_to_js(&path_region_ref_feature_ids),
        )?;
        set_property(
            &object,
            "pathRegionRefData",
            u32_array_to_js(&path_region_ref_data),
        )?;
        set_property(&object, "primitiveTypes", u32_array_to_js(&primitive_types))?;
        set_property(&object, "primitiveData", f32_array_to_js(&primitive_data))?;
        set_property(
            &object,
            "templateOffsets",
            u32_array_to_js(&templates.offsets),
        )?;
        set_property(&object, "templateData", f32_array_to_js(&templates.data))?;
        set_property(&object, "pathRegions", path_regions.into())?;
        Ok(object.into())
    }

    pub(crate) fn from_compact_js(value: &JsValue) -> Result<Self, JsValue> {
        let version = get_property(value, "version")?
            .as_f64()
            .ok_or_else(|| JsValue::from_str("Compact interaction version is missing"))?
            as u32;
        if version != COMPACT_INTERACTION_VERSION {
            return Err(JsValue::from_str(
                "Unsupported compact interaction payload version",
            ));
        }

        let strings = compact_strings_from_js(&get_property(value, "strings")?)?;
        let descriptor_fields = u32_array_from_js(value, "descriptorFields");
        let descriptor_properties = f32_array_from_js(value, "descriptorProperties");
        if !descriptor_fields.len().is_multiple_of(10) {
            return Err(JsValue::from_str("Invalid compact descriptor field data"));
        }
        let descriptor_count = descriptor_fields.len() / 10;
        if descriptor_properties.len() != descriptor_count * 4 {
            return Err(JsValue::from_str(
                "Invalid compact descriptor property data",
            ));
        }

        let mut descriptors = Vec::with_capacity(descriptor_count);
        let mut descriptor_pool = HashMap::with_capacity(descriptor_count);
        for descriptor_id in 0..descriptor_count {
            let descriptor = Rc::new(compact_descriptor_from_parts(
                &descriptor_fields[descriptor_id * 10..descriptor_id * 10 + 10],
                &descriptor_properties[descriptor_id * 4..descriptor_id * 4 + 4],
                &strings,
            )?);
            descriptor_pool.insert(
                FeatureDescriptorKey::from_descriptor(&descriptor),
                Rc::clone(&descriptor),
            );
            descriptors.push(descriptor);
        }

        let feature_descriptors = u32_array_from_js(value, "featureDescriptors");
        let feature_bounds = f32_array_from_js(value, "featureBounds");
        let feature_primitive_ranges = u32_array_from_js(value, "featurePrimitiveRanges");
        let feature_path_region_ids = u32_array_from_js(value, "featurePathRegionIds");
        let path_region_ref_feature_ids = u32_array_from_js(value, "pathRegionRefFeatureIds");
        let path_region_ref_data = u32_array_from_js(value, "pathRegionRefData");
        let primitive_types = u32_array_from_js(value, "primitiveTypes");
        let primitive_data = f32_array_from_js(value, "primitiveData");
        let templates = compact_templates_from_js(
            &u32_array_from_js(value, "templateOffsets"),
            &f32_array_from_js(value, "templateData"),
        )?;
        let mut path_regions = compact_path_regions_from_js(&get_property(value, "pathRegions")?)?;

        let feature_count = feature_descriptors.len();
        if feature_bounds.len() != feature_count * 4
            || feature_primitive_ranges.len() != feature_count * 2
            || feature_path_region_ids.len() != feature_count
        {
            return Err(JsValue::from_str("Invalid compact feature data"));
        }
        if primitive_data.len() != primitive_types.len() * COMPACT_PRIMITIVE_STRIDE {
            return Err(JsValue::from_str("Invalid compact primitive data"));
        }
        let path_region_refs = compact_path_region_refs_from_parts(
            &path_region_ref_feature_ids,
            &path_region_ref_data,
            feature_count,
        )?;

        let mut features = Vec::with_capacity(feature_count);
        for feature_id in 0..feature_count {
            let descriptor_id = feature_descriptors[feature_id] as usize;
            let descriptor = descriptors
                .get(descriptor_id)
                .cloned()
                .ok_or_else(|| JsValue::from_str("Compact feature descriptor index is invalid"))?;
            let primitive_start = feature_primitive_ranges[feature_id * 2] as usize;
            let primitive_count = feature_primitive_ranges[feature_id * 2 + 1] as usize;
            let primitive_end = primitive_start
                .checked_add(primitive_count)
                .ok_or_else(|| JsValue::from_str("Compact primitive range overflow"))?;
            if primitive_end > primitive_types.len() {
                return Err(JsValue::from_str("Compact primitive range is invalid"));
            }

            let path_region_id = feature_path_region_ids[feature_id];
            let path_regions = if path_region_id == COMPACT_NONE {
                None
            } else {
                path_regions
                    .get_mut(path_region_id as usize)
                    .and_then(Option::take)
                    .map(Box::new)
            };
            let path_region_ref = path_region_refs[feature_id];

            features.push(InteractionFeature {
                descriptor,
                primitives: FeaturePrimitives::from_vec(compact_primitives_from_parts(
                    &primitive_types[primitive_start..primitive_end],
                    &primitive_data[primitive_start * COMPACT_PRIMITIVE_STRIDE
                        ..primitive_end * COMPACT_PRIMITIVE_STRIDE],
                    &templates,
                )?),
                path_regions,
                path_region_ref,
                bounds: Boundary::new(
                    feature_bounds[feature_id * 4],
                    feature_bounds[feature_id * 4 + 1],
                    feature_bounds[feature_id * 4 + 2],
                    feature_bounds[feature_id * 4 + 3],
                ),
            });
        }

        Ok(Self {
            features,
            string_pool: strings.iter().cloned().collect(),
            descriptor_pool,
        })
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

    fn append_coverage_batches(&self, batches: &mut Vec<HighlightBatch>) {
        self.for_each(|primitive| append_primitive_coverage_batches(batches, primitive));
    }

    fn has_geometry(&self) -> bool {
        !matches!(self.storage, FeaturePrimitiveStorage::Empty)
    }

    fn append_compact_primitives(
        &self,
        primitive_types: &mut Vec<u32>,
        primitive_data: &mut Vec<f32>,
        templates: &mut CompactTemplateTable,
    ) {
        self.for_each(|primitive| {
            append_compact_primitive(primitive, primitive_types, primitive_data, templates)
        });
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

#[derive(Default)]
struct CompactStringTable {
    values: Vec<Rc<str>>,
    indexes: HashMap<Rc<str>, u32>,
}

impl CompactStringTable {
    fn intern_option(&mut self, value: &Option<Rc<str>>) -> u32 {
        value
            .as_ref()
            .map(|value| self.intern(value))
            .unwrap_or(COMPACT_NONE)
    }

    fn intern(&mut self, value: &Rc<str>) -> u32 {
        if let Some(index) = self.indexes.get(value) {
            return *index;
        }

        let index = self.values.len() as u32;
        self.values.push(Rc::clone(value));
        self.indexes.insert(Rc::clone(value), index);
        index
    }

    fn to_js(&self) -> Array {
        let array = Array::new();
        for value in &self.values {
            array.push(&JsValue::from_str(value.as_ref()));
        }
        array
    }
}

#[derive(Default)]
struct CompactDescriptorTable {
    indexes: HashMap<usize, u32>,
    fields: Vec<u32>,
    properties: Vec<f32>,
}

impl CompactDescriptorTable {
    fn intern(
        &mut self,
        descriptor: &Rc<FeatureDescriptor>,
        strings: &mut CompactStringTable,
    ) -> u32 {
        let key = Rc::as_ptr(descriptor) as usize;
        if let Some(index) = self.indexes.get(&key) {
            return *index;
        }

        let index = (self.fields.len() / 10) as u32;
        let mut property_mask = 0;
        let props = &descriptor.properties;
        if props.diameter.is_some() {
            property_mask |= PROPERTY_DIAMETER;
        }
        if props.width.is_some() {
            property_mask |= PROPERTY_WIDTH;
        }
        if props.height.is_some() {
            property_mask |= PROPERTY_HEIGHT;
        }
        if props.rotation.is_some() {
            property_mask |= PROPERTY_ROTATION;
        }

        self.fields.extend_from_slice(&[
            feature_kind_to_tag(&descriptor.kind),
            polarity_to_tag(descriptor.polarity),
            strings.intern_option(&descriptor.aperture),
            strings.intern_option(&descriptor.aperture_type),
            strings.intern_option(&descriptor.macro_name),
            property_mask,
            props.vertices.unwrap_or(COMPACT_NONE),
            props.tool_code.unwrap_or(COMPACT_NONE),
            props.primitive_count.unwrap_or(COMPACT_NONE),
            strings.intern_option(&props.arc_command),
        ]);
        self.properties.extend_from_slice(&[
            props.diameter.unwrap_or(0.0),
            props.width.unwrap_or(0.0),
            props.height.unwrap_or(0.0),
            props.rotation.unwrap_or(0.0),
        ]);
        self.indexes.insert(key, index);
        index
    }
}

#[derive(Default)]
struct CompactTemplateTable {
    indexes: HashMap<usize, u32>,
    offsets: Vec<u32>,
    data: Vec<f32>,
}

impl CompactTemplateTable {
    fn intern(&mut self, template: &Rc<Vec<f32>>) -> u32 {
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }

        let key = Rc::as_ptr(template) as usize;
        if let Some(index) = self.indexes.get(&key) {
            return *index;
        }

        let index = self.offsets.len().saturating_sub(1) as u32;
        self.data.extend_from_slice(template);
        self.offsets.push(self.data.len() as u32);
        self.indexes.insert(key, index);
        index
    }
}

fn feature_kind_to_tag(kind: &FeatureKind) -> u32 {
    match kind {
        FeatureKind::Flash => 0,
        FeatureKind::Draw => 1,
        FeatureKind::ArcDraw => 2,
        FeatureKind::Region => 3,
        FeatureKind::DrillHit => 4,
        FeatureKind::DrillSlot => 5,
    }
}

fn feature_kind_from_tag(tag: u32) -> Result<FeatureKind, JsValue> {
    match tag {
        0 => Ok(FeatureKind::Flash),
        1 => Ok(FeatureKind::Draw),
        2 => Ok(FeatureKind::ArcDraw),
        3 => Ok(FeatureKind::Region),
        4 => Ok(FeatureKind::DrillHit),
        5 => Ok(FeatureKind::DrillSlot),
        _ => Err(JsValue::from_str("Invalid compact feature kind")),
    }
}

fn polarity_to_tag(polarity: Polarity) -> u32 {
    match polarity {
        Polarity::Positive => 0,
        Polarity::Negative => 1,
    }
}

fn polarity_from_tag(tag: u32) -> Result<Polarity, JsValue> {
    match tag {
        0 => Ok(Polarity::Positive),
        1 => Ok(Polarity::Negative),
        _ => Err(JsValue::from_str("Invalid compact polarity")),
    }
}

fn compact_option_string(strings: &[Rc<str>], index: u32) -> Result<Option<Rc<str>>, JsValue> {
    if index == COMPACT_NONE {
        return Ok(None);
    }
    strings
        .get(index as usize)
        .cloned()
        .map(Some)
        .ok_or_else(|| JsValue::from_str("Compact string index is invalid"))
}

fn compact_descriptor_from_parts(
    fields: &[u32],
    properties: &[f32],
    strings: &[Rc<str>],
) -> Result<FeatureDescriptor, JsValue> {
    let property_mask = fields[5];
    Ok(FeatureDescriptor {
        kind: feature_kind_from_tag(fields[0])?,
        polarity: polarity_from_tag(fields[1])?,
        aperture: compact_option_string(strings, fields[2])?,
        aperture_type: compact_option_string(strings, fields[3])?,
        macro_name: compact_option_string(strings, fields[4])?,
        properties: FeatureProperties {
            diameter: ((property_mask & PROPERTY_DIAMETER) != 0).then_some(properties[0]),
            width: ((property_mask & PROPERTY_WIDTH) != 0).then_some(properties[1]),
            height: ((property_mask & PROPERTY_HEIGHT) != 0).then_some(properties[2]),
            rotation: ((property_mask & PROPERTY_ROTATION) != 0).then_some(properties[3]),
            vertices: (fields[6] != COMPACT_NONE).then_some(fields[6]),
            tool_code: (fields[7] != COMPACT_NONE).then_some(fields[7]),
            primitive_count: (fields[8] != COMPACT_NONE).then_some(fields[8]),
            arc_command: compact_option_string(strings, fields[9])?,
        },
    })
}

fn append_compact_primitive(
    primitive: &Primitive,
    primitive_types: &mut Vec<u32>,
    primitive_data: &mut Vec<f32>,
    templates: &mut CompactTemplateTable,
) {
    match primitive {
        Primitive::Triangle {
            vertices,
            exposure,
            hole_x,
            hole_y,
            hole_radius,
        } => {
            primitive_types.push(0);
            primitive_data.extend_from_slice(&[
                vertices[0][0],
                vertices[0][1],
                vertices[1][0],
                vertices[1][1],
                vertices[2][0],
                vertices[2][1],
                *exposure,
                *hole_x,
                *hole_y,
                *hole_radius,
            ]);
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
            primitive_types.push(1);
            primitive_data.extend_from_slice(&[
                *x,
                *y,
                *radius,
                *exposure,
                *hole_x,
                *hole_y,
                *hole_radius,
                0.0,
                0.0,
                0.0,
            ]);
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
            primitive_types.push(2);
            primitive_data.extend_from_slice(&[
                *x,
                *y,
                *radius,
                *start_angle,
                *end_angle,
                *thickness,
                *exposure,
                0.0,
                0.0,
                0.0,
            ]);
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
            primitive_types.push(3);
            primitive_data.extend_from_slice(&[
                *x,
                *y,
                *outer_diameter,
                *inner_diameter,
                *gap_thickness,
                *rotation,
                *exposure,
                0.0,
                0.0,
                0.0,
            ]);
        }
        Primitive::TriangleTemplateFlash { template, x, y } => {
            primitive_types.push(4);
            primitive_data.extend_from_slice(&[
                templates.intern(template) as f32,
                *x,
                *y,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
            ]);
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            exposure,
        } => {
            primitive_types.push(5);
            primitive_data.extend_from_slice(&[
                *start_x, *start_y, *end_x, *end_y, *width, *exposure, 0.0, 0.0, 0.0, 0.0,
            ]);
        }
    }
}

fn compact_primitives_from_parts(
    primitive_types: &[u32],
    primitive_data: &[f32],
    templates: &[Rc<Vec<f32>>],
) -> Result<Vec<Primitive>, JsValue> {
    let mut primitives = Vec::with_capacity(primitive_types.len());
    for (index, tag) in primitive_types.iter().enumerate() {
        let data = &primitive_data[index * COMPACT_PRIMITIVE_STRIDE
            ..index * COMPACT_PRIMITIVE_STRIDE + COMPACT_PRIMITIVE_STRIDE];
        primitives.push(match *tag {
            0 => Primitive::Triangle {
                vertices: [[data[0], data[1]], [data[2], data[3]], [data[4], data[5]]],
                exposure: data[6],
                hole_x: data[7],
                hole_y: data[8],
                hole_radius: data[9],
            },
            1 => Primitive::Circle {
                x: data[0],
                y: data[1],
                radius: data[2],
                exposure: data[3],
                hole_x: data[4],
                hole_y: data[5],
                hole_radius: data[6],
            },
            2 => Primitive::Arc {
                x: data[0],
                y: data[1],
                radius: data[2],
                start_angle: data[3],
                end_angle: data[4],
                thickness: data[5],
                exposure: data[6],
            },
            3 => Primitive::Thermal {
                x: data[0],
                y: data[1],
                outer_diameter: data[2],
                inner_diameter: data[3],
                gap_thickness: data[4],
                rotation: data[5],
                exposure: data[6],
            },
            4 => {
                let template_id = data[0] as usize;
                Primitive::TriangleTemplateFlash {
                    template: templates
                        .get(template_id)
                        .cloned()
                        .ok_or_else(|| JsValue::from_str("Compact template index is invalid"))?,
                    x: data[1],
                    y: data[2],
                }
            }
            5 => Primitive::Line {
                start_x: data[0],
                start_y: data[1],
                end_x: data[2],
                end_y: data[3],
                width: data[4],
                exposure: data[5],
            },
            _ => return Err(JsValue::from_str("Invalid compact primitive type")),
        });
    }
    Ok(primitives)
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
            None,
            bounds,
            properties,
        ))
    }

    pub fn from_geometry_with_bounds(
        kind: FeatureKind,
        aperture: Option<String>,
        aperture_type: Option<String>,
        macro_name: Option<String>,
        polarity: Polarity,
        primitives: Vec<Primitive>,
        path_regions: PathRegions,
        path_region_ref: Option<PathRegionRef>,
        bounds: Boundary,
        properties: FeatureProperties,
    ) -> Self {
        let mut path_regions =
            path_regions_has_interaction_geometry(&path_regions).then(|| Box::new(path_regions));
        if let Some(path_regions) = &mut path_regions {
            path_regions.cover_vertices = Vec::new();
        }
        Self::from_parts(
            kind,
            aperture,
            aperture_type,
            macro_name,
            polarity,
            FeaturePrimitives::from_vec(primitives),
            path_regions,
            path_region_ref,
            bounds,
            properties,
        )
    }

    pub fn bounds_for_geometry(
        primitives: &[Primitive],
        path_regions: &PathRegions,
    ) -> Option<Boundary> {
        combined_bounds(primitives, path_regions)
    }

    fn from_parts(
        kind: FeatureKind,
        aperture: Option<String>,
        aperture_type: Option<String>,
        macro_name: Option<String>,
        polarity: Polarity,
        primitives: FeaturePrimitives,
        path_regions: Option<Box<PathRegions>>,
        path_region_ref: Option<PathRegionRef>,
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
            path_region_ref,
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
        set_property(
            &object,
            "hasHighlightGeometry",
            JsValue::from_bool(self.has_highlight_geometry()),
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

    pub fn coverage_batches(&self) -> Vec<HighlightBatch> {
        let mut batches = Vec::new();
        self.primitives.append_coverage_batches(&mut batches);
        batches
    }

    pub fn has_highlight_geometry(&self) -> bool {
        self.primitives.has_geometry()
            || self.path_region_ref.is_some()
            || self
                .path_regions
                .as_deref()
                .is_some_and(PathRegions::has_geometry)
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
    for region in &path_regions.pick_contours {
        for contour in region {
            for point in contour {
                include_point_bounds(
                    point[0], point[1], &mut min_x, &mut max_x, &mut min_y, &mut max_y,
                );
            }
        }
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

    append_primitive_clear_sub_batches(batches, primitive);
}

fn append_primitive_coverage_batches(batches: &mut Vec<HighlightBatch>, primitive: &Primitive) {
    let mut vertices = Vec::new();
    append_primitive_triangles(&mut vertices, primitive);
    append_highlight_batch(batches, vertices, false);
    append_primitive_clear_sub_batches(batches, primitive);
}

fn append_primitive_clear_sub_batches(batches: &mut Vec<HighlightBatch>, primitive: &Primitive) {
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

fn f32_array_to_js(values: &[f32]) -> JsValue {
    let array = Float32Array::new_with_length(values.len() as u32);
    array.copy_from(values);
    array.into()
}

fn u32_array_to_js(values: &[u32]) -> JsValue {
    let array = Uint32Array::new_with_length(values.len() as u32);
    array.copy_from(values);
    array.into()
}

fn f32_array_from_js(value: &JsValue, key: &str) -> Vec<f32> {
    Float32Array::new(&get_property(value, key).unwrap_or(JsValue::UNDEFINED)).to_vec()
}

fn u32_array_from_js(value: &JsValue, key: &str) -> Vec<u32> {
    Uint32Array::new(&get_property(value, key).unwrap_or(JsValue::UNDEFINED)).to_vec()
}

fn usize_property_from_js(value: &JsValue, key: &str) -> Result<usize, JsValue> {
    let number = get_property(value, key)?
        .as_f64()
        .ok_or_else(|| JsValue::from_str(&format!("Interaction field `{key}` is not numeric")))?;
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 {
        return Err(JsValue::from_str(&format!(
            "Interaction field `{key}` must be a non-negative integer"
        )));
    }
    Ok(number as usize)
}

fn compact_strings_from_js(value: &JsValue) -> Result<Vec<Rc<str>>, JsValue> {
    let values = Array::from(value);
    let mut strings = Vec::with_capacity(values.length() as usize);
    for value in values.iter() {
        strings.push(Rc::<str>::from(
            value
                .as_string()
                .ok_or_else(|| JsValue::from_str("Compact string table contains a non-string"))?
                .as_str(),
        ));
    }
    Ok(strings)
}

fn compact_templates_from_js(offsets: &[u32], data: &[f32]) -> Result<Vec<Rc<Vec<f32>>>, JsValue> {
    if offsets.is_empty() {
        return Ok(Vec::new());
    }
    let mut templates = Vec::with_capacity(offsets.len().saturating_sub(1));
    for pair in offsets.windows(2) {
        let start = pair[0] as usize;
        let end = pair[1] as usize;
        if start > end || end > data.len() {
            return Err(JsValue::from_str("Compact template range is invalid"));
        }
        templates.push(Rc::new(data[start..end].to_vec()));
    }
    Ok(templates)
}

fn compact_usize(value: usize, label: &str) -> Result<u32, JsValue> {
    u32::try_from(value).map_err(|_| JsValue::from_str(&format!("{label} exceeds compact range")))
}

fn compact_path_region_refs_from_parts(
    feature_ids: &[u32],
    ref_data: &[u32],
    feature_count: usize,
) -> Result<Vec<Option<PathRegionRef>>, JsValue> {
    compact_path_region_refs_from_parts_invariant(feature_ids, ref_data, feature_count)
        .map_err(JsValue::from_str)
}

fn compact_path_region_refs_from_parts_invariant(
    feature_ids: &[u32],
    ref_data: &[u32],
    feature_count: usize,
) -> Result<Vec<Option<PathRegionRef>>, &'static str> {
    if ref_data.len() != feature_ids.len() * COMPACT_PATH_REGION_REF_STRIDE {
        return Err("Invalid compact path region ref data");
    }

    let mut refs = vec![None; feature_count];
    for (ref_idx, feature_id) in feature_ids.iter().copied().enumerate() {
        let feature_id = feature_id as usize;
        if feature_id >= feature_count || refs[feature_id].is_some() {
            return Err("Invalid compact path region ref feature");
        }

        refs[feature_id] = Some(compact_path_region_ref_from_parts(
            &ref_data[ref_idx * COMPACT_PATH_REGION_REF_STRIDE
                ..ref_idx * COMPACT_PATH_REGION_REF_STRIDE + COMPACT_PATH_REGION_REF_STRIDE],
        )?);
    }

    Ok(refs)
}

fn compact_path_region_ref_from_parts(parts: &[u32]) -> Result<PathRegionRef, &'static str> {
    let [sublayer_idx, region_start, region_count] = parts else {
        return Err("Invalid compact path region ref data");
    };
    if *sublayer_idx == COMPACT_NONE
        || *region_start == COMPACT_NONE
        || *region_count == COMPACT_NONE
        || *region_count == 0
    {
        return Err("Invalid compact path region ref");
    }

    Ok(PathRegionRef {
        sublayer_idx: *sublayer_idx as usize,
        region_start: *region_start as usize,
        region_count: *region_count as usize,
    })
}

fn path_region_to_compact_js(path_regions: &PathRegions) -> Result<JsValue, JsValue> {
    let mut pick_region_contour_offsets = Vec::with_capacity(path_regions.pick_contours.len() + 1);
    let mut pick_contour_point_offsets = Vec::new();
    let mut pick_contour_points = Vec::new();
    pick_region_contour_offsets.push(0);
    pick_contour_point_offsets.push(0);

    for region in &path_regions.pick_contours {
        for contour in region {
            for point in contour {
                pick_contour_points.extend_from_slice(point);
            }
            pick_contour_point_offsets.push((pick_contour_points.len() / 2) as u32);
        }
        pick_region_contour_offsets.push((pick_contour_point_offsets.len() - 1) as u32);
    }

    let object = Object::new();
    set_property(
        &object,
        "wedgeVertices",
        f32_array_to_js(&path_regions.wedge_vertices),
    )?;
    set_property(
        &object,
        "wedgeVertexOffsets",
        u32_array_to_js(&path_regions.wedge_vertex_offsets),
    )?;
    set_property(
        &object,
        "sectorVertices",
        f32_array_to_js(&path_regions.sector_vertices),
    )?;
    set_property(
        &object,
        "sectorVertexStride",
        JsValue::from_f64(PATH_SECTOR_VERTEX_FLOATS as f64),
    )?;
    set_property(
        &object,
        "sectorVertexOffsets",
        u32_array_to_js(&path_regions.sector_vertex_offsets),
    )?;
    set_property(
        &object,
        "coverVertices",
        f32_array_to_js(&path_regions.cover_vertices),
    )?;
    set_property(
        &object,
        "clearVertices",
        f32_array_to_js(&path_regions.clear_vertices),
    )?;
    set_property(
        &object,
        "pickRegionContourOffsets",
        u32_array_to_js(&pick_region_contour_offsets),
    )?;
    set_property(
        &object,
        "pickContourPointOffsets",
        u32_array_to_js(&pick_contour_point_offsets),
    )?;
    set_property(
        &object,
        "pickContourPoints",
        f32_array_to_js(&pick_contour_points),
    )?;
    Ok(object.into())
}

fn compact_path_regions_from_js(value: &JsValue) -> Result<Vec<Option<PathRegions>>, JsValue> {
    let values = Array::from(value);
    let mut path_regions = Vec::with_capacity(values.length() as usize);
    for value in values.iter() {
        path_regions.push(Some(path_region_from_compact_js(&value)?));
    }
    Ok(path_regions)
}

fn path_region_from_compact_js(value: &JsValue) -> Result<PathRegions, JsValue> {
    let sector_vertex_stride = usize_property_from_js(value, "sectorVertexStride")?;
    if sector_vertex_stride != PATH_SECTOR_VERTEX_FLOATS {
        return Err(JsValue::from_str(
            "Unsupported compact path sector vertex stride",
        ));
    }
    let mut path_regions = PathRegions::new(
        f32_array_from_js(value, "wedgeVertices"),
        u32_array_from_js(value, "wedgeVertexOffsets"),
        f32_array_from_js(value, "sectorVertices"),
        u32_array_from_js(value, "sectorVertexOffsets"),
        f32_array_from_js(value, "coverVertices"),
        f32_array_from_js(value, "clearVertices"),
    );
    validate_compact_path_region(&path_regions)?;

    let region_offsets = u32_array_from_js(value, "pickRegionContourOffsets");
    let contour_offsets = u32_array_from_js(value, "pickContourPointOffsets");
    let points = f32_array_from_js(value, "pickContourPoints");
    if region_offsets.is_empty() && contour_offsets.is_empty() && points.is_empty() {
        return Ok(path_regions);
    }
    if !points.len().is_multiple_of(2) {
        return Err(JsValue::from_str("Invalid compact pick contour point data"));
    }
    validate_compact_pick_offsets(&region_offsets, &contour_offsets, points.len() / 2)?;

    let mut pick_contours = Vec::with_capacity(region_offsets.len().saturating_sub(1));
    for pair in region_offsets.windows(2) {
        let contour_start = pair[0] as usize;
        let contour_end = pair[1] as usize;
        if contour_start > contour_end || contour_end >= contour_offsets.len() {
            return Err(JsValue::from_str(
                "Invalid compact pick region contour range",
            ));
        }

        let mut region = Vec::with_capacity(contour_end - contour_start);
        for contour_pair in contour_offsets[contour_start..=contour_end].windows(2) {
            let point_start = contour_pair[0] as usize;
            let point_end = contour_pair[1] as usize;
            if point_start > point_end || point_end * 2 > points.len() {
                return Err(JsValue::from_str(
                    "Invalid compact pick contour point range",
                ));
            }

            let mut contour = Vec::with_capacity(point_end - point_start);
            for point in points[point_start * 2..point_end * 2].chunks_exact(2) {
                contour.push([point[0], point[1]]);
            }
            region.push(contour);
        }
        pick_contours.push(region);
    }

    path_regions.pick_contours = pick_contours;
    Ok(path_regions)
}

fn validate_compact_pick_offsets(
    region_offsets: &[u32],
    contour_offsets: &[u32],
    point_count: usize,
) -> Result<(), JsValue> {
    validate_compact_pick_offsets_invariant(region_offsets, contour_offsets, point_count)
        .map_err(JsValue::from_str)
}

fn validate_compact_pick_offsets_invariant(
    region_offsets: &[u32],
    contour_offsets: &[u32],
    point_count: usize,
) -> Result<(), &'static str> {
    if region_offsets.is_empty()
        || contour_offsets.is_empty()
        || region_offsets.first().copied() != Some(0)
        || contour_offsets.first().copied() != Some(0)
        || region_offsets.last().copied() != Some(contour_offsets.len().saturating_sub(1) as u32)
        || contour_offsets.last().copied() != Some(point_count as u32)
    {
        return Err("Invalid compact pick contour offsets");
    }
    let contour_count = contour_offsets.len().saturating_sub(1);
    for pair in region_offsets.windows(2) {
        if pair[0] > pair[1] || pair[1] as usize > contour_count {
            return Err("Invalid compact pick region offsets");
        }
    }
    for pair in contour_offsets.windows(2) {
        if pair[0] > pair[1] || pair[1] as usize > point_count {
            return Err("Invalid compact pick point offsets");
        }
    }
    Ok(())
}

fn validate_compact_path_region(path_regions: &PathRegions) -> Result<(), JsValue> {
    validate_compact_path_region_invariant(path_regions)
        .map_err(|message| JsValue::from_str(message))
}

fn validate_compact_path_region_invariant(path_regions: &PathRegions) -> Result<(), &'static str> {
    if !path_regions.wedge_vertices.len().is_multiple_of(2) {
        return Err("Invalid compact path wedge vertex buffer length");
    }
    if !path_regions
        .sector_vertices
        .len()
        .is_multiple_of(PATH_SECTOR_VERTEX_FLOATS)
    {
        return Err("Invalid compact path sector vertex buffer length");
    }
    if !path_regions.cover_vertices.len().is_multiple_of(12)
        || !path_regions.clear_vertices.len().is_multiple_of(12)
    {
        return Err("Invalid compact path region quad data");
    }

    let region_count = path_regions.region_count();
    if region_count > 0 && path_regions.cover_vertices.len() != path_regions.clear_vertices.len() {
        return Err("Invalid compact path region quad data");
    }
    if region_count > 0 && path_regions.cover_vertices.len() / 12 != region_count {
        return Err("Invalid compact path region quad data");
    }
    if region_count > 0 && path_regions.clear_vertices.len() / 12 != region_count {
        return Err("Invalid compact path region quad data");
    }
    validate_compact_offsets(
        "compact path wedge offsets",
        &path_regions.wedge_vertex_offsets,
        path_regions.wedge_vertices.len() / 2,
        region_count,
    )?;
    validate_compact_offsets(
        "compact path sector offsets",
        &path_regions.sector_vertex_offsets,
        path_regions.sector_vertices.len() / PATH_SECTOR_VERTEX_FLOATS,
        region_count,
    )?;
    validate_finite_slice("compact path wedge vertices", &path_regions.wedge_vertices)?;
    validate_finite_slice(
        "compact path sector vertices",
        &path_regions.sector_vertices,
    )?;
    validate_finite_slice("compact path cover vertices", &path_regions.cover_vertices)?;
    validate_finite_slice("compact path clear vertices", &path_regions.clear_vertices)?;
    for vertex in path_regions
        .sector_vertices
        .chunks_exact(PATH_SECTOR_VERTEX_FLOATS)
    {
        if vertex[4] < 0.0 {
            return Err("compact path sector radius contains a negative value");
        }
    }
    Ok(())
}

fn validate_compact_offsets(
    label: &'static str,
    offsets: &[u32],
    vertex_count: usize,
    region_count: usize,
) -> Result<(), &'static str> {
    if offsets.len() != region_count + 1 || offsets.first().copied() != Some(0) {
        return Err(label);
    }
    let mut previous = 0usize;
    for &offset in offsets {
        let offset = offset as usize;
        if offset < previous || offset > vertex_count {
            return Err(label);
        }
        previous = offset;
    }
    if previous != vertex_count {
        return Err(label);
    }
    Ok(())
}

fn validate_finite_slice(label: &'static str, values: &[f32]) -> Result<(), &'static str> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(label);
    }
    Ok(())
}

fn set_property(object: &Object, key: &str, value: JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value)
        .map(|_| ())
        .map_err(|_| JsValue::from_str(&format!("Failed to set interaction field `{key}`")))
}

fn get_property(value: &JsValue, key: &str) -> Result<JsValue, JsValue> {
    Reflect::get(value, &JsValue::from_str(key))
        .map_err(|_| JsValue::from_str(&format!("Missing interaction field `{key}`")))
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
    fn highlight_clear_features_follow_selected_dark_feature() {
        let mut layer = InteractionLayer::new();
        layer.push(circle_feature(0.0, 1.0, Polarity::Negative));
        layer.push(circle_feature(0.0, 2.0, Polarity::Positive));
        layer.push(circle_feature(0.0, 0.5, Polarity::Negative));
        layer.push(circle_feature(10.0, 0.5, Polarity::Negative));
        layer.push(circle_feature(0.0, 0.5, Polarity::Positive));

        let clear_features = layer.following_clear_features_for_highlight(1);

        assert_eq!(clear_features.len(), 1);
        assert_eq!(clear_features[0].descriptor.polarity, Polarity::Negative);
        assert!((clear_features[0].bounds.max_x() - 0.5).abs() < 0.0001);
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

    #[test]
    fn negative_coverage_batches_preserve_aperture_holes() {
        let feature = InteractionFeature::from_primitives(
            FeatureKind::Flash,
            Some("D10".to_string()),
            Some("circle".to_string()),
            None,
            Polarity::Negative,
            vec![Primitive::Circle {
                x: 0.0,
                y: 0.0,
                radius: 2.0,
                exposure: 0.0,
                hole_x: 0.0,
                hole_y: 0.0,
                hole_radius: 0.5,
            }],
            FeatureProperties::default(),
        )
        .expect("negative circle feature should have bounds");

        let batches = feature.coverage_batches();

        assert_eq!(batches.len(), 2);
        assert!(!batches[0].clear);
        assert!(batches[1].clear);
    }

    #[test]
    fn path_region_feature_bounds_can_use_conservative_render_bounds() {
        let mut full_path_regions = PathRegions::new(
            vec![],
            vec![0, 0],
            vec![],
            vec![0, 0],
            vec![
                -1.0, 0.0, 1.0, 0.0, -1.0, 1.0, -1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
            ],
            vec![
                -1.0, 0.0, 1.0, 0.0, -1.0, 1.0, -1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
            ],
        );
        full_path_regions.pick_contours =
            vec![vec![vec![[-1.0, 0.0], [1.0, 0.0], [0.0, 0.8], [-1.0, 0.0]]]];
        let bounds = InteractionFeature::bounds_for_geometry(&[], &full_path_regions)
            .expect("full path region should have conservative bounds");

        let feature = InteractionFeature::from_geometry_with_bounds(
            FeatureKind::Region,
            None,
            None,
            None,
            Polarity::Positive,
            Vec::new(),
            full_path_regions.clone_for_interaction_pick(),
            Some(PathRegionRef {
                sublayer_idx: 0,
                region_start: 0,
                region_count: 1,
            }),
            bounds,
            FeatureProperties::default(),
        );

        assert_eq!(feature.bounds.max_y(), 1.0);
        let stored_path_regions = feature
            .path_regions
            .as_deref()
            .expect("pick contour should be retained");
        assert!(stored_path_regions.cover_vertices.is_empty());
        assert_eq!(stored_path_regions.pick_contours[0][0][2], [0.0, 0.8]);
    }

    #[test]
    fn compact_path_region_validation_rejects_negative_sector_radius() {
        let path_regions = PathRegions::new(
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 3],
            vec![1.0, 0.0, 0.0, 0.0, -1.0],
            vec![0, 1],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
        );

        assert!(validate_compact_path_region_invariant(&path_regions).is_err());
    }

    #[test]
    fn compact_pick_offsets_require_canonical_ranges() {
        assert!(validate_compact_pick_offsets_invariant(&[0, 1], &[0, 3], 3).is_ok());
        assert!(validate_compact_pick_offsets_invariant(&[1, 1], &[0, 3], 3).is_err());
        assert!(validate_compact_pick_offsets_invariant(&[0, 2], &[0, 3], 3).is_err());
        assert!(validate_compact_pick_offsets_invariant(&[0, 1], &[1, 3], 3).is_err());
        assert!(validate_compact_pick_offsets_invariant(&[0, 1], &[0, 4], 3).is_err());
    }

    #[test]
    fn compact_path_region_refs_are_sparse_and_reject_duplicates() {
        let refs = compact_path_region_refs_from_parts_invariant(&[2], &[4, 5, 6], 4)
            .expect("sparse path region refs should parse");

        assert_eq!(refs[0], None);
        assert_eq!(
            refs[2],
            Some(PathRegionRef {
                sublayer_idx: 4,
                region_start: 5,
                region_count: 6,
            })
        );
        assert!(
            compact_path_region_refs_from_parts_invariant(&[2, 2], &[4, 5, 6, 7, 8, 9], 4).is_err()
        );
        assert!(compact_path_region_refs_from_parts_invariant(&[4], &[4, 5, 6], 4).is_err());
        assert!(compact_path_region_refs_from_parts_invariant(&[1], &[4, 5], 4).is_err());
    }
}
