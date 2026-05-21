mod aperture;
mod aperture_macro;
pub mod geometry;
mod state;

// Export only what's needed externally
pub use aperture::Aperture;
pub use state::{FormatSpec, ParserState, Polarity};

// Internal use only
use aperture::parse_aperture;
use aperture_macro::{parse_macro, ApertureMacro};
use state::{
    parse_format_spec, parse_if, parse_lm, parse_lp, parse_lr, parse_ls, parse_mo, parse_sr,
};

use self::geometry::{parse_graphic_command, Primitive, RegionContour};
use crate::shape::{
    Arcs, Boundary, Circles, GerberData, Lines, PathRegions, Thermals, TriangleTemplateInstances,
    Triangles,
};
use std::collections::HashMap;
use std::mem::size_of;
use std::mem::take;
use wasm_bindgen::prelude::*;

#[derive(Clone, Debug)]
pub struct PolarityLayer {
    pub(crate) polarity: Polarity,
    pub(crate) primitives: Vec<Primitive>,
    pub(crate) path_regions: PathRegions,
}

fn collect_lines(data: &str) -> Result<Vec<&str>, JsValue> {
    let line_count = data.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let mut lines = Vec::new();
    try_reserve_exact(&mut lines, line_count, "Gerber line index buffer")?;
    lines.extend(data.split('\n'));
    Ok(lines)
}

#[derive(Default)]
struct PrimitiveBufferCounts {
    triangles: usize,
    has_triangle_holes: bool,
    triangle_template_instance_counts: HashMap<usize, usize>,
    lines: usize,
    circles: usize,
    has_circle_holes: bool,
    arcs: usize,
    thermals: usize,
}

impl PrimitiveBufferCounts {
    fn include(&mut self, primitive: &Primitive) {
        if !primitive_is_renderable(primitive) {
            return;
        }

        match primitive {
            Primitive::Triangle { hole_radius, .. } => {
                self.triangles += 1;
                self.has_triangle_holes |= *hole_radius != 0.0;
            }
            Primitive::Circle { hole_radius, .. } => {
                self.circles += 1;
                self.has_circle_holes |= *hole_radius != 0.0;
            }
            Primitive::Arc { .. } => self.arcs += 1,
            Primitive::Thermal { .. } => self.thermals += 1,
            Primitive::Line { .. } => self.lines += 1,
            Primitive::TriangleTemplateFlash { template, .. } => {
                let key = std::rc::Rc::as_ptr(template) as usize;
                *self
                    .triangle_template_instance_counts
                    .entry(key)
                    .or_default() += 1;
            }
        }
    }
}

#[derive(Default)]
struct SplitPrimitiveBufferCounts {
    plain: PrimitiveBufferCounts,
    holed: PrimitiveBufferCounts,
}

impl SplitPrimitiveBufferCounts {
    fn from_primitives(primitives: &[Primitive]) -> Self {
        let mut counts = Self::default();

        for primitive in primitives {
            if primitive_has_hole(primitive) {
                counts.holed.include(primitive);
            } else {
                counts.plain.include(primitive);
            }
        }

        counts
    }
}

fn primitive_has_hole(primitive: &Primitive) -> bool {
    match primitive {
        Primitive::Triangle { hole_radius, .. } | Primitive::Circle { hole_radius, .. } => {
            *hole_radius != 0.0
        }
        Primitive::Arc { .. }
        | Primitive::Thermal { .. }
        | Primitive::Line { .. }
        | Primitive::TriangleTemplateFlash { .. } => false,
    }
}

const GEOMETRY_EPSILON: f32 = 1.0e-6;

fn finite_point(x: f32, y: f32) -> bool {
    x.is_finite() && y.is_finite()
}

fn has_positive_extent(value: f32) -> bool {
    value.is_finite() && value > GEOMETRY_EPSILON
}

fn points_are_distinct(start_x: f32, start_y: f32, end_x: f32, end_y: f32) -> bool {
    let dx = end_x - start_x;
    let dy = end_y - start_y;
    dx.is_finite() && dy.is_finite() && dx * dx + dy * dy > GEOMETRY_EPSILON * GEOMETRY_EPSILON
}

fn triangle_has_area(vertices: &[[f32; 2]; 3]) -> bool {
    if !vertices
        .iter()
        .all(|point| finite_point(point[0], point[1]))
    {
        return false;
    }

    let area2 = (vertices[1][0] - vertices[0][0]) * (vertices[2][1] - vertices[0][1])
        - (vertices[2][0] - vertices[0][0]) * (vertices[1][1] - vertices[0][1]);
    area2.is_finite() && area2.abs() > GEOMETRY_EPSILON * GEOMETRY_EPSILON
}

fn primitive_is_renderable(primitive: &Primitive) -> bool {
    match primitive {
        Primitive::Triangle { vertices, .. } => triangle_has_area(vertices),
        Primitive::Circle { x, y, radius, .. } => {
            finite_point(*x, *y) && has_positive_extent(*radius)
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
            finite_point(*x, *y)
                && has_positive_extent(*radius)
                && has_positive_extent(*thickness)
                && start_angle.is_finite()
                && end_angle.is_finite()
                && (*end_angle - *start_angle).abs() > GEOMETRY_EPSILON
        }
        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
            ..
        } => {
            finite_point(*x, *y)
                && has_positive_extent(*outer_diameter)
                && inner_diameter.is_finite()
                && *inner_diameter >= 0.0
                && *inner_diameter < *outer_diameter
                && gap_thickness.is_finite()
                && *gap_thickness >= 0.0
                && rotation.is_finite()
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            ..
        } => {
            finite_point(*start_x, *start_y)
                && finite_point(*end_x, *end_y)
                && has_positive_extent(*width)
                && points_are_distinct(*start_x, *start_y, *end_x, *end_y)
        }
        Primitive::TriangleTemplateFlash { template, x, y } => {
            finite_point(*x, *y) && template.len() >= 6 && template.len().is_multiple_of(6)
        }
    }
}

struct TriangleTemplateOutputBuffers {
    vertices: Vec<f32>,
    instance_x: Vec<f32>,
    instance_y: Vec<f32>,
}

struct PrimitiveOutputBuffers {
    has_triangle_holes: bool,
    triangle_vertices: Vec<f32>,
    triangle_hole_x: Vec<f32>,
    triangle_hole_y: Vec<f32>,
    triangle_hole_radius: Vec<f32>,
    triangle_templates: Vec<TriangleTemplateOutputBuffers>,
    triangle_template_indices: HashMap<usize, usize>,
    triangle_template_instance_counts: HashMap<usize, usize>,
    lines_start_x: Vec<f32>,
    lines_start_y: Vec<f32>,
    lines_end_x: Vec<f32>,
    lines_end_y: Vec<f32>,
    lines_width: Vec<f32>,
    has_circle_holes: bool,
    circles_x: Vec<f32>,
    circles_y: Vec<f32>,
    circles_radius: Vec<f32>,
    circles_hole_x: Vec<f32>,
    circles_hole_y: Vec<f32>,
    circles_hole_radius: Vec<f32>,
    arcs_x: Vec<f32>,
    arcs_y: Vec<f32>,
    arcs_radius: Vec<f32>,
    arcs_start_angle: Vec<f32>,
    arcs_sweep_angle: Vec<f32>,
    arcs_thickness: Vec<f32>,
    thermals_x: Vec<f32>,
    thermals_y: Vec<f32>,
    thermals_outer_diameter: Vec<f32>,
    thermals_inner_diameter: Vec<f32>,
    thermals_gap_thickness: Vec<f32>,
    thermals_rotation: Vec<f32>,
}

impl PrimitiveOutputBuffers {
    fn reserved_for(counts: &PrimitiveBufferCounts) -> Result<Self, JsValue> {
        let triangle_vertex_values =
            checked_capacity(counts.triangles, 6, "triangle vertex buffer")?;

        let mut buffers = Self {
            has_triangle_holes: counts.has_triangle_holes,
            triangle_vertices: Vec::new(),
            triangle_hole_x: Vec::new(),
            triangle_hole_y: Vec::new(),
            triangle_hole_radius: Vec::new(),
            triangle_templates: Vec::new(),
            triangle_template_indices: HashMap::new(),
            triangle_template_instance_counts: counts.triangle_template_instance_counts.clone(),
            lines_start_x: Vec::new(),
            lines_start_y: Vec::new(),
            lines_end_x: Vec::new(),
            lines_end_y: Vec::new(),
            lines_width: Vec::new(),
            has_circle_holes: counts.has_circle_holes,
            circles_x: Vec::new(),
            circles_y: Vec::new(),
            circles_radius: Vec::new(),
            circles_hole_x: Vec::new(),
            circles_hole_y: Vec::new(),
            circles_hole_radius: Vec::new(),
            arcs_x: Vec::new(),
            arcs_y: Vec::new(),
            arcs_radius: Vec::new(),
            arcs_start_angle: Vec::new(),
            arcs_sweep_angle: Vec::new(),
            arcs_thickness: Vec::new(),
            thermals_x: Vec::new(),
            thermals_y: Vec::new(),
            thermals_outer_diameter: Vec::new(),
            thermals_inner_diameter: Vec::new(),
            thermals_gap_thickness: Vec::new(),
            thermals_rotation: Vec::new(),
        };

        try_reserve_exact(
            &mut buffers.triangle_vertices,
            triangle_vertex_values,
            "triangle vertex buffer",
        )?;
        if counts.has_triangle_holes {
            let triangle_vertex_count =
                checked_capacity(counts.triangles, 3, "triangle hole buffer")?;
            try_reserve_exact(
                &mut buffers.triangle_hole_x,
                triangle_vertex_count,
                "triangle hole X buffer",
            )?;
            try_reserve_exact(
                &mut buffers.triangle_hole_y,
                triangle_vertex_count,
                "triangle hole Y buffer",
            )?;
            try_reserve_exact(
                &mut buffers.triangle_hole_radius,
                triangle_vertex_count,
                "triangle hole radius buffer",
            )?;
        }
        try_reserve_exact(
            &mut buffers.triangle_templates,
            counts.triangle_template_instance_counts.len(),
            "triangle template list",
        )?;
        buffers
            .triangle_template_indices
            .try_reserve(counts.triangle_template_instance_counts.len())
            .map_err(|_| {
                JsValue::from_str(
                    "Gerber layer is too large to render: not enough memory for triangle template index map",
                )
            })?;

        try_reserve_exact(
            &mut buffers.lines_start_x,
            counts.lines,
            "line start X buffer",
        )?;
        try_reserve_exact(
            &mut buffers.lines_start_y,
            counts.lines,
            "line start Y buffer",
        )?;
        try_reserve_exact(&mut buffers.lines_end_x, counts.lines, "line end X buffer")?;
        try_reserve_exact(&mut buffers.lines_end_y, counts.lines, "line end Y buffer")?;
        try_reserve_exact(&mut buffers.lines_width, counts.lines, "line width buffer")?;

        try_reserve_exact(&mut buffers.circles_x, counts.circles, "circle X buffer")?;
        try_reserve_exact(&mut buffers.circles_y, counts.circles, "circle Y buffer")?;
        try_reserve_exact(
            &mut buffers.circles_radius,
            counts.circles,
            "circle radius buffer",
        )?;
        if counts.has_circle_holes {
            try_reserve_exact(
                &mut buffers.circles_hole_x,
                counts.circles,
                "circle hole X buffer",
            )?;
            try_reserve_exact(
                &mut buffers.circles_hole_y,
                counts.circles,
                "circle hole Y buffer",
            )?;
            try_reserve_exact(
                &mut buffers.circles_hole_radius,
                counts.circles,
                "circle hole radius buffer",
            )?;
        }

        try_reserve_exact(&mut buffers.arcs_x, counts.arcs, "arc X buffer")?;
        try_reserve_exact(&mut buffers.arcs_y, counts.arcs, "arc Y buffer")?;
        try_reserve_exact(&mut buffers.arcs_radius, counts.arcs, "arc radius buffer")?;
        try_reserve_exact(
            &mut buffers.arcs_start_angle,
            counts.arcs,
            "arc start angle buffer",
        )?;
        try_reserve_exact(
            &mut buffers.arcs_sweep_angle,
            counts.arcs,
            "arc sweep angle buffer",
        )?;
        try_reserve_exact(
            &mut buffers.arcs_thickness,
            counts.arcs,
            "arc thickness buffer",
        )?;

        try_reserve_exact(&mut buffers.thermals_x, counts.thermals, "thermal X buffer")?;
        try_reserve_exact(&mut buffers.thermals_y, counts.thermals, "thermal Y buffer")?;
        try_reserve_exact(
            &mut buffers.thermals_outer_diameter,
            counts.thermals,
            "thermal outer diameter buffer",
        )?;
        try_reserve_exact(
            &mut buffers.thermals_inner_diameter,
            counts.thermals,
            "thermal inner diameter buffer",
        )?;
        try_reserve_exact(
            &mut buffers.thermals_gap_thickness,
            counts.thermals,
            "thermal gap thickness buffer",
        )?;
        try_reserve_exact(
            &mut buffers.thermals_rotation,
            counts.thermals,
            "thermal rotation buffer",
        )?;

        Ok(buffers)
    }

    fn push_primitive(&mut self, primitive: Primitive) -> Result<(), JsValue> {
        if !primitive_is_renderable(&primitive) {
            return Ok(());
        }

        // Unit conversion: aperture.rs already converts to mm using unit_multiplier.
        const TO_MM: f32 = 1.0;

        match primitive {
            Primitive::Triangle {
                vertices,
                hole_x,
                hole_y,
                hole_radius,
                ..
            } => {
                for vertex in vertices {
                    self.triangle_vertices.push(vertex[0] * TO_MM);
                    self.triangle_vertices.push(vertex[1] * TO_MM);
                }

                if self.has_triangle_holes {
                    for _ in 0..3 {
                        self.triangle_hole_x.push(hole_x * TO_MM);
                        self.triangle_hole_y.push(hole_y * TO_MM);
                        self.triangle_hole_radius.push(hole_radius * TO_MM);
                    }
                }
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
                self.circles_x.push(x * TO_MM);
                self.circles_y.push(y * TO_MM);
                self.circles_radius.push(radius * TO_MM);
                if self.has_circle_holes {
                    self.circles_hole_x.push(hole_x * TO_MM);
                    self.circles_hole_y.push(hole_y * TO_MM);
                    self.circles_hole_radius.push(hole_radius * TO_MM);
                }
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
                self.arcs_x.push(x * TO_MM);
                self.arcs_y.push(y * TO_MM);
                self.arcs_radius.push(radius * TO_MM);
                self.arcs_start_angle.push(start_angle);
                self.arcs_sweep_angle.push(end_angle - start_angle);
                self.arcs_thickness.push(thickness * TO_MM);
            }
            Primitive::Line {
                start_x,
                start_y,
                end_x,
                end_y,
                width,
                ..
            } => {
                self.lines_start_x.push(start_x * TO_MM);
                self.lines_start_y.push(start_y * TO_MM);
                self.lines_end_x.push(end_x * TO_MM);
                self.lines_end_y.push(end_y * TO_MM);
                self.lines_width.push(width * TO_MM);
            }
            Primitive::Thermal {
                x,
                y,
                outer_diameter,
                inner_diameter,
                gap_thickness,
                rotation,
                ..
            } => {
                self.thermals_x.push(x * TO_MM);
                self.thermals_y.push(y * TO_MM);
                self.thermals_outer_diameter.push(outer_diameter * TO_MM);
                self.thermals_inner_diameter.push(inner_diameter * TO_MM);
                self.thermals_gap_thickness.push(gap_thickness * TO_MM);
                self.thermals_rotation.push(rotation);
            }
            Primitive::TriangleTemplateFlash { template, x, y } => {
                let key = std::rc::Rc::as_ptr(&template) as usize;
                let template_idx =
                    if let Some(index) = self.triangle_template_indices.get(&key).copied() {
                        index
                    } else {
                        let expected_instances = self
                            .triangle_template_instance_counts
                            .get(&key)
                            .copied()
                            .unwrap_or(1);
                        let mut vertices = Vec::new();
                        try_reserve_exact(
                            &mut vertices,
                            template.len(),
                            "triangle template vertex buffer",
                        )?;
                        vertices.extend(template.iter().copied());

                        let mut instance_x = Vec::new();
                        let mut instance_y = Vec::new();
                        try_reserve_exact(
                            &mut instance_x,
                            expected_instances,
                            "triangle template instance X buffer",
                        )?;
                        try_reserve_exact(
                            &mut instance_y,
                            expected_instances,
                            "triangle template instance Y buffer",
                        )?;

                        let index = self.triangle_templates.len();
                        self.triangle_templates.push(TriangleTemplateOutputBuffers {
                            vertices,
                            instance_x,
                            instance_y,
                        });
                        self.triangle_template_indices.insert(key, index);
                        index
                    };

                let template = &mut self.triangle_templates[template_idx];
                template.instance_x.push(x * TO_MM);
                template.instance_y.push(y * TO_MM);
            }
        }

        Ok(())
    }

    fn into_gerber_data(self, path_regions: PathRegions, is_negative: bool) -> GerberData {
        let boundary = combined_boundary(self.boundary(), self.has_geometry(), &path_regions);
        let triangle_templates = self
            .triangle_templates
            .into_iter()
            .map(|template| {
                TriangleTemplateInstances::new(
                    template.vertices,
                    template.instance_x,
                    template.instance_y,
                )
            })
            .collect();

        GerberData::new(
            Triangles::new(
                self.triangle_vertices,
                self.triangle_hole_x,
                self.triangle_hole_y,
                self.triangle_hole_radius,
            ),
            triangle_templates,
            Lines::new(
                self.lines_start_x,
                self.lines_start_y,
                self.lines_end_x,
                self.lines_end_y,
                self.lines_width,
            ),
            Circles::new(
                self.circles_x,
                self.circles_y,
                self.circles_radius,
                self.circles_hole_x,
                self.circles_hole_y,
                self.circles_hole_radius,
            ),
            Arcs::new(
                self.arcs_x,
                self.arcs_y,
                self.arcs_radius,
                self.arcs_start_angle,
                self.arcs_sweep_angle,
                self.arcs_thickness,
            ),
            Thermals::new(
                self.thermals_x,
                self.thermals_y,
                self.thermals_outer_diameter,
                self.thermals_inner_diameter,
                self.thermals_gap_thickness,
                self.thermals_rotation,
            ),
            path_regions,
            boundary,
            is_negative,
        )
    }

    fn has_geometry(&self) -> bool {
        !self.triangle_vertices.is_empty()
            || self
                .triangle_templates
                .iter()
                .any(|template| !template.vertices.is_empty() && !template.instance_x.is_empty())
            || !self.lines_start_x.is_empty()
            || !self.circles_x.is_empty()
            || !self.arcs_x.is_empty()
            || !self.thermals_x.is_empty()
    }

    fn boundary(&self) -> Boundary {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        for point in self.triangle_vertices.chunks_exact(2) {
            let x = point[0];
            let y = point[1];
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }

        for template in &self.triangle_templates {
            if template.vertices.is_empty() {
                continue;
            }

            let mut template_min_x = f32::INFINITY;
            let mut template_max_x = f32::NEG_INFINITY;
            let mut template_min_y = f32::INFINITY;
            let mut template_max_y = f32::NEG_INFINITY;
            for point in template.vertices.chunks_exact(2) {
                template_min_x = template_min_x.min(point[0]);
                template_max_x = template_max_x.max(point[0]);
                template_min_y = template_min_y.min(point[1]);
                template_max_y = template_max_y.max(point[1]);
            }

            for i in 0..template.instance_x.len() {
                let x = template.instance_x[i];
                let y = template.instance_y[i];
                min_x = min_x.min(template_min_x + x);
                max_x = max_x.max(template_max_x + x);
                min_y = min_y.min(template_min_y + y);
                max_y = max_y.max(template_max_y + y);
            }
        }

        for i in 0..self.lines_start_x.len() {
            let sx = self.lines_start_x[i];
            let sy = self.lines_start_y[i];
            let ex = self.lines_end_x[i];
            let ey = self.lines_end_y[i];
            let half_width = self.lines_width[i] * 0.5;
            min_x = min_x.min(sx.min(ex) - half_width);
            max_x = max_x.max(sx.max(ex) + half_width);
            min_y = min_y.min(sy.min(ey) - half_width);
            max_y = max_y.max(sy.max(ey) + half_width);
        }

        for i in 0..self.circles_x.len() {
            let x = self.circles_x[i];
            let y = self.circles_y[i];
            let r = self.circles_radius[i];
            min_x = min_x.min(x - r);
            max_x = max_x.max(x + r);
            min_y = min_y.min(y - r);
            max_y = max_y.max(y + r);
        }

        for i in 0..self.arcs_x.len() {
            let x = self.arcs_x[i];
            let y = self.arcs_y[i];
            let r = self.arcs_radius[i];
            let t = self.arcs_thickness[i];
            let outer = r + t / 2.0;
            min_x = min_x.min(x - outer);
            max_x = max_x.max(x + outer);
            min_y = min_y.min(y - outer);
            max_y = max_y.max(y + outer);
        }

        for i in 0..self.thermals_x.len() {
            let x = self.thermals_x[i];
            let y = self.thermals_y[i];
            let r = self.thermals_outer_diameter[i] / 2.0;
            min_x = min_x.min(x - r);
            max_x = max_x.max(x + r);
            min_y = min_y.min(y - r);
            max_y = max_y.max(y + r);
        }

        if min_x == f32::INFINITY {
            return Boundary::new(0.0, 0.0, 0.0, 0.0);
        }

        Boundary::new(min_x, max_x, min_y, max_y)
    }
}

fn combined_boundary(
    primitive_boundary: Boundary,
    has_primitives: bool,
    path_regions: &PathRegions,
) -> Boundary {
    let Some(path_boundary) = path_regions_boundary(path_regions) else {
        return primitive_boundary;
    };

    if !has_primitives {
        return path_boundary;
    }

    Boundary::new(
        primitive_boundary.min_x.min(path_boundary.min_x),
        primitive_boundary.max_x.max(path_boundary.max_x),
        primitive_boundary.min_y.min(path_boundary.min_y),
        primitive_boundary.max_y.max(path_boundary.max_y),
    )
}

fn path_regions_boundary(path_regions: &PathRegions) -> Option<Boundary> {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for point in path_regions.cover_vertices.chunks_exact(2) {
        min_x = min_x.min(point[0]);
        max_x = max_x.max(point[0]);
        min_y = min_y.min(point[1]);
        max_y = max_y.max(point[1]);
    }

    min_x
        .is_finite()
        .then_some(Boundary::new(min_x, max_x, min_y, max_y))
}

fn checked_capacity(
    count: usize,
    values_per_primitive: usize,
    buffer_name: &str,
) -> Result<usize, JsValue> {
    count.checked_mul(values_per_primitive).ok_or_else(|| {
        JsValue::from_str(&format!(
            "Gerber layer is too large to render: {} size overflow",
            buffer_name
        ))
    })
}

fn format_count(value: usize) -> String {
    let digits = value.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3);
    let first_group_len = digits.len() % 3;

    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && index >= first_group_len && (index - first_group_len) % 3 == 0 {
            formatted.push(',');
        }
        formatted.push(ch);
    }

    formatted
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

fn format_value_allocation<T>(additional: usize) -> String {
    let values = format_count(additional);
    match additional.checked_mul(size_of::<T>()) {
        Some(bytes) => format!("{} values, {}", values, format_bytes(bytes)),
        None => format!("{} values", values),
    }
}

fn try_reserve_exact<T>(
    values: &mut Vec<T>,
    additional: usize,
    buffer_name: &str,
) -> Result<(), JsValue> {
    values.try_reserve_exact(additional).map_err(|_| {
        JsValue::from_str(&format!(
            "Gerber layer is too large to render: not enough memory for {} ({})",
            buffer_name,
            format_value_allocation::<T>(additional)
        ))
    })
}

fn try_reserve_string(
    value: &mut String,
    additional: usize,
    buffer_name: &str,
) -> Result<(), JsValue> {
    value.try_reserve(additional).map_err(|_| {
        JsValue::from_str(&format!(
            "Gerber layer is too large to render: not enough memory for {} ({})",
            buffer_name,
            format_value_allocation::<u8>(additional)
        ))
    })
}

/// Gerber parser with stateful aperture and macro storage
pub struct GerberParser {
    pub apertures: HashMap<String, Aperture>,
    pub macros: HashMap<String, ApertureMacro>,
    pub current_state: ParserState,
    pub preserve_arc_regions: bool,
    pub arc_tessellation_quality: u32,
    // Store primitive batches in object-stream polarity order.
    pub polarity_layers: Vec<PolarityLayer>,
    pub current_primitives: Vec<Primitive>, // Accumulating primitives for current polarity
    pub current_path_regions: PathRegions,
    pub region_contours: Vec<RegionContour>, // Contours collected in Region mode
}

impl GerberParser {
    pub fn with_options(preserve_arc_regions: bool, arc_tessellation_quality: u32) -> Self {
        GerberParser {
            apertures: HashMap::new(),
            macros: HashMap::new(),
            current_state: ParserState::default(),
            preserve_arc_regions,
            arc_tessellation_quality,
            polarity_layers: Vec::new(),
            current_primitives: Vec::new(),
            current_path_regions: PathRegions::empty(),
            region_contours: Vec::new(),
        }
    }

    /// Parse Gerber file content and return GerberData batches in object-stream polarity order.
    pub fn parse(&mut self, data: &str) -> Result<Vec<GerberData>, JsValue> {
        let lines = collect_lines(data)?;
        let length = lines.len();
        let mut i = 0;

        while i < length {
            let line_ref = lines[i].trim();

            if line_ref.is_empty() {
                i += 1;
                continue;
            }

            if line_ref.starts_with("M02") {
                break;
            } else if line_ref.starts_with('%') {
                parse_command(
                    line_ref,
                    &mut i,
                    length,
                    &lines,
                    &mut self.current_state,
                    &mut self.apertures,
                    &mut self.macros,
                    &mut self.current_primitives,
                    &mut self.current_path_regions,
                    &mut self.polarity_layers,
                    self.preserve_arc_regions,
                    self.arc_tessellation_quality,
                )?;
            } else if line_ref.starts_with("G04") {
                // Comment line, skip
            } else if line_ref.starts_with('G')
                || line_ref.starts_with('D')
                || line_ref.starts_with('X')
                || line_ref.starts_with('Y')
                || line_ref.starts_with('I')
                || line_ref.starts_with('J')
            {
                parse_graphic_command(
                    line_ref,
                    &mut self.current_state,
                    &self.apertures,
                    &mut self.current_primitives,
                    &mut self.region_contours,
                    &mut self.current_path_regions,
                    &mut self.polarity_layers,
                    self.preserve_arc_regions,
                    self.arc_tessellation_quality,
                )
                .map_err(|message| JsValue::from_str(&message))?;
            }

            i += 1;
        }

        // Save last accumulated primitives by polarity
        if !self.current_primitives.is_empty() || self.current_path_regions.has_geometry() {
            try_reserve_exact(&mut self.polarity_layers, 1, "polarity layer list")?;
            self.polarity_layers.push(PolarityLayer {
                polarity: self.current_state.polarity,
                primitives: take(&mut self.current_primitives),
                path_regions: take(&mut self.current_path_regions),
            });
        }

        // Convert each polarity layer one at a time so parsed Primitive buffers
        // can be dropped as soon as their render buffers are built.
        let polarity_layers = take(&mut self.polarity_layers);
        let mut gerber_data_layers: Vec<GerberData> = Vec::new();
        let gerber_data_layer_capacity =
            checked_capacity(polarity_layers.len(), 2, "Gerber data layer list")?;
        try_reserve_exact(
            &mut gerber_data_layers,
            gerber_data_layer_capacity,
            "Gerber data layer list",
        )?;

        for layer in polarity_layers {
            let mut gerber_data = Self::primitives_to_gerber_data(
                layer.primitives,
                layer.path_regions,
                layer.polarity == Polarity::Negative,
            )?;
            gerber_data_layers.append(&mut gerber_data);
        }

        Ok(gerber_data_layers)
    }

    /// Convert a vector of primitives to GerberData
    fn primitives_to_gerber_data(
        primitives: Vec<Primitive>,
        path_regions: PathRegions,
        is_negative: bool,
    ) -> Result<Vec<GerberData>, JsValue> {
        let counts = SplitPrimitiveBufferCounts::from_primitives(&primitives);
        let mut plain_buffers = PrimitiveOutputBuffers::reserved_for(&counts.plain)?;
        let mut holed_buffers = PrimitiveOutputBuffers::reserved_for(&counts.holed)?;

        for primitive in primitives {
            if primitive_has_hole(&primitive) {
                holed_buffers.push_primitive(primitive)?;
            } else {
                plain_buffers.push_primitive(primitive)?;
            }
        }

        let mut gerber_data_layers = Vec::new();
        let layer_count = usize::from(plain_buffers.has_geometry() || path_regions.has_geometry())
            + usize::from(holed_buffers.has_geometry());
        try_reserve_exact(
            &mut gerber_data_layers,
            layer_count,
            "Gerber data layer list",
        )?;

        if plain_buffers.has_geometry() || path_regions.has_geometry() {
            gerber_data_layers.push(plain_buffers.into_gerber_data(path_regions, is_negative));
        }
        if holed_buffers.has_geometry() {
            gerber_data_layers
                .push(holed_buffers.into_gerber_data(PathRegions::empty(), is_negative));
        }

        Ok(gerber_data_layers)
    }
}

fn parse_command(
    line_ref: &str,
    i: &mut usize,
    length: usize,
    lines: &[&str],
    state: &mut ParserState,
    apertures: &mut HashMap<String, Aperture>,
    macros: &mut HashMap<String, ApertureMacro>,
    current_primitives: &mut Vec<Primitive>,
    current_path_regions: &mut PathRegions,
    polarity_layers: &mut Vec<PolarityLayer>,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
) -> Result<(), JsValue> {
    let line = if !line_ref.ends_with('%') {
        let mut buffer = String::new();
        try_reserve_string(&mut buffer, line_ref.len(), "extended command buffer")?;
        buffer.push_str(line_ref);
        *i += 1;

        while *i < length {
            let next_line = lines[*i].trim();
            try_reserve_string(&mut buffer, next_line.len(), "extended command buffer")?;
            buffer.push_str(next_line);

            if next_line.ends_with('%') {
                break;
            }
            *i += 1;
        }

        buffer
    } else {
        line_ref.to_string()
    };

    if line.starts_with("%AM") {
        parse_macro(&line, macros);
    } else if line.starts_with("%ADD") {
        parse_aperture(&line, apertures, macros, state.unit_multiplier);
    } else if line.starts_with("%MO") {
        // Unit mode: %MOMM* or %MOIN*
        parse_mo(&line, state);
    } else if line.starts_with("%FS") {
        // Format spec: %FSLAX24Y24*%
        parse_format_spec(&line, state);
    } else if line.starts_with("%LP") {
        // Polarity: %LPD* (dark/positive) or %LPC* (clear/negative)
        parse_lp(
            &line,
            state,
            current_primitives,
            current_path_regions,
            polarity_layers,
        )
        .map_err(|message| JsValue::from_str(&message))?;
    } else if line.starts_with("%SR") {
        // Step and repeat: %SRX3Y2I10J20*%
        parse_sr(&line, state);
    } else if line.starts_with("%IF") {
        // Image polarity: %IFPOS*% or %IFNEG*%
        parse_if(&line, state);
    } else if line.starts_with("%AB") {
        // Block Aperture: %ABD##*% ... %AB*%
        parse_aperture_block(
            &line,
            i,
            length,
            lines,
            state,
            apertures,
            macros,
            current_primitives,
            current_path_regions,
            polarity_layers,
            preserve_arc_regions,
            arc_tessellation_quality,
        )?;
    } else if line.starts_with("%LM") {
        // Layer mirroring: %LMN*, %LMX*, %LMY*, %LMXY*
        parse_lm(&line, state);
    } else if line.starts_with("%LR") {
        // Layer rotation: %LR45.0*
        parse_lr(&line, state);
    } else if line.starts_with("%LS") {
        // Layer scaling: %LS0.8*
        parse_ls(&line, state);
    } else {
        // Unknown or unsupported command
    }

    Ok(())
}

fn flush_primitives(
    current_primitives: &mut Vec<Primitive>,
    current_path_regions: &mut PathRegions,
    polarity_layers: &mut Vec<PolarityLayer>,
    polarity: Polarity,
) -> Result<(), JsValue> {
    if !current_primitives.is_empty() || current_path_regions.has_geometry() {
        try_reserve_exact(polarity_layers, 1, "polarity layer list")?;
        polarity_layers.push(PolarityLayer {
            polarity,
            primitives: take(current_primitives),
            path_regions: take(current_path_regions),
        });
    }

    Ok(())
}

fn parse_aperture_block_code(line: &str) -> Option<String> {
    let content = line
        .trim()
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    let aperture_id = content.strip_prefix("ABD")?;
    if aperture_id.is_empty() || !aperture_id.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }

    aperture_id.parse::<u32>().ok().map(|code| code.to_string())
}

fn is_aperture_block_close(line: &str) -> bool {
    let content = line
        .trim()
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    content == "AB"
}

fn parse_aperture_block(
    line: &str,
    i: &mut usize,
    length: usize,
    lines: &[&str],
    state: &mut ParserState,
    apertures: &mut HashMap<String, Aperture>,
    macros: &mut HashMap<String, ApertureMacro>,
    current_primitives: &mut Vec<Primitive>,
    current_path_regions: &mut PathRegions,
    polarity_layers: &mut Vec<PolarityLayer>,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
) -> Result<(), JsValue> {
    let Some(block_code) = parse_aperture_block_code(line) else {
        return Ok(());
    };

    flush_primitives(
        current_primitives,
        current_path_regions,
        polarity_layers,
        state.polarity,
    )?;

    let mut block_primitives: Vec<Primitive> = Vec::new();
    let mut block_path_regions = PathRegions::empty();
    let mut block_layers: Vec<PolarityLayer> = Vec::new();
    let mut block_region_contours: Vec<RegionContour> = Vec::new();

    while *i + 1 < length {
        *i += 1;
        let block_line = lines[*i].trim();

        if block_line.is_empty() || block_line.starts_with("G04") {
            continue;
        }

        if block_line.starts_with('%') {
            if is_aperture_block_close(block_line) {
                break;
            }

            let nested_block_state = parse_aperture_block_code(block_line).map(|_| state.clone());
            parse_command(
                block_line,
                i,
                length,
                lines,
                state,
                apertures,
                macros,
                &mut block_primitives,
                &mut block_path_regions,
                &mut block_layers,
                preserve_arc_regions,
                arc_tessellation_quality,
            )?;
            if let Some(enclosing_state) = nested_block_state {
                *state = enclosing_state;
            }
        } else if block_line.starts_with('G')
            || block_line.starts_with('D')
            || block_line.starts_with('X')
            || block_line.starts_with('Y')
            || block_line.starts_with('I')
            || block_line.starts_with('J')
        {
            parse_graphic_command(
                block_line,
                state,
                apertures,
                &mut block_primitives,
                &mut block_region_contours,
                &mut block_path_regions,
                &mut block_layers,
                preserve_arc_regions,
                arc_tessellation_quality,
            )
            .map_err(|message| JsValue::from_str(&message))?;
        }
    }

    flush_primitives(
        &mut block_primitives,
        &mut block_path_regions,
        &mut block_layers,
        state.polarity,
    )?;

    state.x = 0.0;
    state.y = 0.0;
    state.pen_state = "up".to_string();

    apertures.insert(block_code, Aperture::new_block(block_layers));

    Ok(())
}

pub fn parse_gerber(data: &str) -> Result<Vec<GerberData>, JsValue> {
    parse_gerber_with_options(data, true, 1)
}

pub fn parse_gerber_with_options(
    data: &str,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
) -> Result<Vec<GerberData>, JsValue> {
    let mut parser = GerberParser::with_options(preserve_arc_regions, arc_tessellation_quality);
    parser.parse(data)
}

#[cfg(test)]
mod tests;
