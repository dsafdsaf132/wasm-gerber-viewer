use crate::parser::geometry::{offset_primitive_by, Primitive};
use crate::parser::{Aperture, Polarity};
use crate::shape::{Boundary, PathRegions};
use js_sys::{Object, Reflect};
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
}

#[derive(Clone, Debug)]
pub struct InteractionFeature {
    pub kind: FeatureKind,
    pub aperture: Option<String>,
    pub aperture_type: Option<String>,
    pub macro_name: Option<String>,
    pub polarity: Polarity,
    pub primitives: Vec<Primitive>,
    pub path_regions: PathRegions,
    pub bounds: Boundary,
    pub properties: FeatureProperties,
}

#[derive(Clone, Debug, PartialEq)]
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

#[derive(Clone, Debug, Default)]
pub struct FeatureProperties {
    pub diameter: Option<f32>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub rotation: Option<f32>,
    pub vertices: Option<u32>,
    pub tool_code: Option<u32>,
    pub primitive_count: Option<u32>,
    pub arc_command: Option<String>,
}

impl InteractionLayer {
    pub fn new() -> Self {
        Self {
            features: Vec::new(),
        }
    }

    pub fn push(&mut self, feature: InteractionFeature) {
        self.features.push(feature);
    }

    pub fn translate(&mut self, dx: f32, dy: f32) {
        if dx == 0.0 && dy == 0.0 {
            return;
        }

        for feature in &mut self.features {
            feature.bounds.translate(dx, dy);
            for primitive in &mut feature.primitives {
                *primitive = offset_primitive_by(primitive, dx, dy);
            }
            feature.path_regions.translate(dx, dy);
        }
    }

    pub fn pick(&self, x: f32, y: f32, tolerance: f32) -> Option<(usize, &InteractionFeature)> {
        self.pick_after(x, y, tolerance, None).0
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
                if feature.polarity == Polarity::Negative {
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
        Self::from_geometry(
            kind,
            aperture,
            aperture_type,
            macro_name,
            polarity,
            primitives,
            PathRegions::empty(),
            properties,
        )
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
        Some(Self {
            kind,
            aperture,
            aperture_type,
            macro_name,
            polarity,
            primitives,
            path_regions,
            bounds,
            properties,
        })
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
            JsValue::from_str(self.kind.as_str()),
        )?;
        set_property(
            &object,
            "polarity",
            JsValue::from_str(if self.polarity == Polarity::Negative {
                "clear"
            } else {
                "dark"
            }),
        )?;
        if let Some(aperture) = &self.aperture {
            set_property(&object, "aperture", JsValue::from_str(aperture))?;
        }
        if let Some(aperture_type) = &self.aperture_type {
            set_property(&object, "apertureType", JsValue::from_str(aperture_type))?;
        }
        if let Some(macro_name) = &self.macro_name {
            set_property(&object, "macroName", JsValue::from_str(macro_name))?;
        }
        set_property(&object, "bounds", self.bounds_to_js()?)?;
        set_property(&object, "properties", self.properties.to_js()?)?;
        Ok(object.into())
    }

    pub fn highlight_batches(&self) -> Vec<HighlightBatch> {
        let mut batches = Vec::new();
        for primitive in &self.primitives {
            append_primitive_highlight_batches(&mut batches, primitive);
        }
        batches
    }

    fn hit(&self, point: [f32; 2], tolerance: f32) -> bool {
        let mut is_hit = false;
        for primitive in &self.primitives {
            if primitive_hit(primitive, point, tolerance) {
                is_hit = primitive_exposure(primitive) >= 0.5;
            }
        }
        if path_regions_hit(&self.path_regions, point, tolerance) {
            is_hit = true;
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
            set_property(&object, "arcCommand", JsValue::from_str(value))?;
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
    InteractionFeature::from_primitives(
        kind,
        aperture_name(aperture_code),
        Some(aperture_type(aperture)),
        aperture.macro_name.clone(),
        polarity,
        primitives.to_vec(),
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

        assert!(region.aperture_type.is_none());
        assert!(drill.aperture_type.is_none());
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
