mod aperture;
mod aperture_macro;
pub(crate) mod common;
pub mod geometry;
pub(crate) mod simd_scan;
mod state;

// Export only what's needed externally
pub use aperture::Aperture;
pub(crate) use aperture::{finalize_aperture, ApertureKind};
pub use state::{FormatSpec, ParserState, Polarity};

// Internal use only
use aperture::parse_aperture;
use aperture_macro::{parse_macro, ApertureMacro};
use state::{
    parse_format_spec, parse_if, parse_lm, parse_lp, parse_lr, parse_ls, parse_mo, parse_sr,
};

use self::geometry::{arc_curve_bounds, parse_graphic_command, Primitive};
use crate::geometry::RegionContour;
use crate::geometry::{
    Arcs, Boundary, Circles, GerberData, Lines, PathRegions, PathRegionsBuilder, Thermals,
    TriangleTemplateInstances, Triangles,
};
use crate::interaction::InteractionLayer;
use crate::util::{format_bytes, format_count};
use std::collections::HashMap;
use std::mem::size_of;
use std::mem::take;
use wasm_bindgen::prelude::*;

#[derive(Clone, Debug)]
pub struct PolarityLayer {
    pub(crate) polarity: Polarity,
    pub(crate) primitives: Vec<Primitive>,
    pub(crate) path_regions: PathRegionsBuilder,
}

pub struct ParsedGerberLayer {
    pub render_layers: Vec<GerberData>,
    pub interaction_layer: Option<InteractionLayer>,
}

/// Part of a parse that a progress callback hears about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseStage {
    /// Running the file's commands; the counts are bytes of the file read.
    Commands,
    /// Building render buffers from the parsed shapes; the counts are shapes,
    /// reported between polarity layers.
    Geometry,
}

impl ParseStage {
    pub fn as_str(self) -> &'static str {
        match self {
            ParseStage::Commands => "commands",
            ParseStage::Geometry => "geometry",
        }
    }
}

/// Called with a stage, the work of that stage done so far, and its total.
pub type ParseProgress = Box<dyn FnMut(ParseStage, usize, usize)>;

// A parse reports after reading this many bytes, or sooner once the commands
// since the last report produced this many shapes: a flash inside a
// step-and-repeat block can turn one command into thousands. Either way a
// report costs little next to the work between two of them.
const PROGRESS_BYTE_STEP: usize = 1 << 20;
const PROGRESS_SHAPE_STEP: usize = 1 << 18;

fn report_progress(
    progress: &mut Option<ParseProgress>,
    stage: ParseStage,
    done: usize,
    total: usize,
) {
    if let Some(progress) = progress {
        progress(stage, done, total);
    }
}

/// Iterator over the commands of a Gerber file.
///
/// The Gerber format delimits commands with `*`; line breaks carry no meaning,
/// so a file may put every command on its own line or pack thousands of them
/// onto a single line. Each item is one `*`-terminated command. Extended
/// commands (`%...%`) are yielded as a unit, and the body lines of a multi-line
/// extended command such as an aperture macro are passed through untouched so
/// `parse_command` can accumulate them exactly as before.
struct CommandSplitter<'a> {
    lines: std::str::Split<'a, char>,
    rest: &'a str,
    in_extended_command: bool,
}

fn split_commands(data: &str) -> CommandSplitter<'_> {
    CommandSplitter {
        lines: data.split('\n'),
        rest: "",
        in_extended_command: false,
    }
}

impl<'a> Iterator for CommandSplitter<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<&'a str> {
        loop {
            if self.in_extended_command {
                // Inside a multi-line `%...%` block: yield the raw text up to and
                // including the closing `%`, then keep scanning after it.
                // Whitespace-only lines carry nothing and are not yielded.
                if self.rest.trim().is_empty() {
                    self.rest = self.lines.next()?;
                    continue;
                }
                return Some(match self.rest.find('%') {
                    Some(close) => {
                        let command = &self.rest[..=close];
                        self.rest = &self.rest[close + 1..];
                        self.in_extended_command = false;
                        command
                    }
                    None => take(&mut self.rest),
                });
            }

            let segment = self.rest.trim_start();
            if segment.is_empty() {
                self.rest = self.lines.next()?;
                continue;
            }

            if let Some(after_open) = segment.strip_prefix('%') {
                return Some(match after_open.find('%') {
                    Some(close) => {
                        let end = close + 2;
                        self.rest = &segment[end..];
                        &segment[..end]
                    }
                    None => {
                        self.rest = "";
                        self.in_extended_command = true;
                        segment
                    }
                });
            }

            return Some(match simd_scan::find_star_simd(segment.as_bytes()) {
                Some(star) => {
                    self.rest = &segment[star + 1..];
                    &segment[..=star]
                }
                None => {
                    self.rest = "";
                    segment
                }
            });
        }
    }
}

/// Estimate how many commands `split_commands` will yield, in a single pass
/// over the bytes.
///
/// This mirrors the splitter's rules without running it: every `*` ends one
/// command, and a line holding nothing but `%` (the terminator of a multi-line
/// extended command such as an aperture macro) is one more command that has no
/// `*`. A final unterminated command is counted as well. For well-formed input
/// the estimate equals the real count; it may exceed it when a raw line inside
/// an extended command holds several `*` (harmless over-reservation), and it
/// falls short only for malformed input such as an empty `%%` command or a
/// macro body line without `*`, which `push_command` absorbs.
#[cfg(test)]
fn count_commands(data: &str) -> usize {
    let bytes = data.as_bytes();
    let last_percent = simd_scan::rfind_byte_simd(bytes, b'%');

    let (head, tail) = match last_percent {
        None => (&bytes[..0], bytes),
        Some(pos) => {
            // Find the newline after the last '%', or the end of the file, so any trailing
            // percent_only_line is resolved before the SIMD chunk scan.
            let split_at = match bytes[pos + 1..].iter().position(|&b| b == b'\n') {
                Some(nl) => (pos + 1 + nl + 1).min(bytes.len()),
                None => bytes.len(),
            };
            (&bytes[..split_at], &bytes[split_at..])
        }
    };

    let mut count = 0usize;
    let mut at_line_start = true;
    let mut percent_only_line = false;
    let mut last_significant = None;

    for &byte in head {
        match byte {
            b'*' => {
                count += 1;
                percent_only_line = false;
                at_line_start = false;
            }
            b'\n' => {
                if percent_only_line {
                    count += 1;
                }
                percent_only_line = false;
                at_line_start = true;
                continue;
            }
            b'%' => {
                percent_only_line = at_line_start;
                at_line_start = false;
            }
            b' ' | b'\t' | b'\r' => continue,
            _ => {
                percent_only_line = false;
                at_line_start = false;
            }
        }
        // Only `*`, `%` and command text count as significant; line breaks and
        // other whitespace do not decide whether a trailing command is open.
        last_significant = Some(byte);
    }

    if !tail.is_empty() {
        count += simd_scan::count_stars_simd(tail);
        if let Some(&byte) = tail
            .iter()
            .rev()
            .find(|&&b| !matches!(b, b'\n' | b' ' | b'\t' | b'\r'))
        {
            last_significant = Some(byte);
        }
    }

    if percent_only_line {
        count += 1;
    } else if matches!(last_significant, Some(byte) if byte != b'*' && byte != b'%') {
        // Trailing command without its `*` terminator.
        count += 1;
    }

    count
}

#[cfg(test)]
/// Index every command of the file, reserving the index buffer once up front
/// from the single-pass estimate of `count_commands`.
fn collect_commands(data: &str) -> Result<Vec<&str>, JsValue> {
    let command_count = count_commands(data);
    let mut commands = Vec::new();
    try_reserve_exact(&mut commands, command_count, "Gerber command index buffer")?;

    for command in split_commands(data) {
        push_command(&mut commands, command)?;
    }

    Ok(commands)
}

#[cfg(test)]
fn push_command<'a>(commands: &mut Vec<&'a str>, command: &'a str) -> Result<(), JsValue> {
    // For well-formed input the up-front reservation already holds every
    // command and this never allocates. It only grows for malformed input that
    // `count_commands` under-estimates, using amortized growth so the total
    // copying stays linear rather than copying the whole index per command.
    commands.try_reserve(1).map_err(|_| {
        JsValue::from_str(&format!(
            "Gerber layer is too large to render: not enough memory for Gerber command index buffer ({})",
            format_value_allocation::<&str>(commands.len().saturating_add(1))
        ))
    })?;
    commands.push(command);
    Ok(())
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

fn has_non_negative_extent(value: f32) -> bool {
    value.is_finite() && value >= 0.0
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
                && has_non_negative_extent(*thickness)
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
                && has_non_negative_extent(*width)
                && points_are_distinct(*start_x, *start_y, *end_x, *end_y)
        }
        Primitive::TriangleTemplateFlash { template, x, y, .. } => {
            finite_point(*x, *y) && template.len() >= 6 && template.len().is_multiple_of(6)
        }
    }
}

struct TriangleTemplateOutputBuffers {
    vertices: Vec<f32>,
    instance_x_nm: Vec<i32>,
    instance_y_nm: Vec<i32>,
}

struct PrimitiveOutputBuffers {
    has_triangle_holes: bool,
    triangle_vertices_nm: Vec<i32>,
    triangle_hole_x_nm: Vec<i32>,
    triangle_hole_y_nm: Vec<i32>,
    triangle_hole_radius_nm: Vec<i32>,
    triangle_templates: Vec<TriangleTemplateOutputBuffers>,
    triangle_template_indices: HashMap<usize, usize>,
    triangle_template_instance_counts: HashMap<usize, usize>,
    lines_start_x_nm: Vec<i32>,
    lines_start_y_nm: Vec<i32>,
    lines_end_x_nm: Vec<i32>,
    lines_end_y_nm: Vec<i32>,
    lines_width_nm: Vec<i32>,
    has_circle_holes: bool,
    circles_x_nm: Vec<i32>,
    circles_y_nm: Vec<i32>,
    circles_radius_nm: Vec<i32>,
    circles_hole_x_nm: Vec<i32>,
    circles_hole_y_nm: Vec<i32>,
    circles_hole_radius_nm: Vec<i32>,
    arcs_x_nm: Vec<i32>,
    arcs_y_nm: Vec<i32>,
    arcs_radius_nm: Vec<i32>,
    arcs_start_angle: Vec<f32>,
    arcs_sweep_angle: Vec<f32>,
    arcs_thickness_nm: Vec<i32>,
    thermals_x_nm: Vec<i32>,
    thermals_y_nm: Vec<i32>,
    thermals_outer_diameter_nm: Vec<i32>,
    thermals_inner_diameter_nm: Vec<i32>,
    thermals_gap_thickness_nm: Vec<i32>,
    thermals_rotation: Vec<f32>,
}

impl PrimitiveOutputBuffers {
    fn reserved_for(counts: &PrimitiveBufferCounts) -> Result<Self, JsValue> {
        let triangle_vertex_values =
            checked_capacity(counts.triangles, 6, "triangle vertex buffer")?;

        let mut buffers = Self {
            has_triangle_holes: counts.has_triangle_holes,
            triangle_vertices_nm: Vec::new(),
            triangle_hole_x_nm: Vec::new(),
            triangle_hole_y_nm: Vec::new(),
            triangle_hole_radius_nm: Vec::new(),
            triangle_templates: Vec::new(),
            triangle_template_indices: HashMap::new(),
            triangle_template_instance_counts: counts.triangle_template_instance_counts.clone(),
            lines_start_x_nm: Vec::new(),
            lines_start_y_nm: Vec::new(),
            lines_end_x_nm: Vec::new(),
            lines_end_y_nm: Vec::new(),
            lines_width_nm: Vec::new(),
            has_circle_holes: counts.has_circle_holes,
            circles_x_nm: Vec::new(),
            circles_y_nm: Vec::new(),
            circles_radius_nm: Vec::new(),
            circles_hole_x_nm: Vec::new(),
            circles_hole_y_nm: Vec::new(),
            circles_hole_radius_nm: Vec::new(),
            arcs_x_nm: Vec::new(),
            arcs_y_nm: Vec::new(),
            arcs_radius_nm: Vec::new(),
            arcs_start_angle: Vec::new(),
            arcs_sweep_angle: Vec::new(),
            arcs_thickness_nm: Vec::new(),
            thermals_x_nm: Vec::new(),
            thermals_y_nm: Vec::new(),
            thermals_outer_diameter_nm: Vec::new(),
            thermals_inner_diameter_nm: Vec::new(),
            thermals_gap_thickness_nm: Vec::new(),
            thermals_rotation: Vec::new(),
        };

        try_reserve_exact(
            &mut buffers.triangle_vertices_nm,
            triangle_vertex_values,
            "triangle vertex nm buffer",
        )?;
        if counts.has_triangle_holes {
            let triangle_vertex_count =
                checked_capacity(counts.triangles, 3, "triangle hole buffer")?;
            try_reserve_exact(
                &mut buffers.triangle_hole_x_nm,
                triangle_vertex_count,
                "triangle hole X nm buffer",
            )?;
            try_reserve_exact(
                &mut buffers.triangle_hole_y_nm,
                triangle_vertex_count,
                "triangle hole Y nm buffer",
            )?;
            try_reserve_exact(
                &mut buffers.triangle_hole_radius_nm,
                triangle_vertex_count,
                "triangle hole radius nm buffer",
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
            &mut buffers.lines_start_x_nm,
            counts.lines,
            "line start X nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.lines_start_y_nm,
            counts.lines,
            "line start Y nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.lines_end_x_nm,
            counts.lines,
            "line end X nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.lines_end_y_nm,
            counts.lines,
            "line end Y nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.lines_width_nm,
            counts.lines,
            "line width nm buffer",
        )?;

        try_reserve_exact(
            &mut buffers.circles_x_nm,
            counts.circles,
            "circle X nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.circles_y_nm,
            counts.circles,
            "circle Y nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.circles_radius_nm,
            counts.circles,
            "circle radius nm buffer",
        )?;
        if counts.has_circle_holes {
            try_reserve_exact(
                &mut buffers.circles_hole_x_nm,
                counts.circles,
                "circle hole X nm buffer",
            )?;
            try_reserve_exact(
                &mut buffers.circles_hole_y_nm,
                counts.circles,
                "circle hole Y nm buffer",
            )?;
            try_reserve_exact(
                &mut buffers.circles_hole_radius_nm,
                counts.circles,
                "circle hole radius nm buffer",
            )?;
        }

        try_reserve_exact(&mut buffers.arcs_x_nm, counts.arcs, "arc X nm buffer")?;
        try_reserve_exact(&mut buffers.arcs_y_nm, counts.arcs, "arc Y nm buffer")?;
        try_reserve_exact(
            &mut buffers.arcs_radius_nm,
            counts.arcs,
            "arc radius nm buffer",
        )?;
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
            &mut buffers.arcs_thickness_nm,
            counts.arcs,
            "arc thickness nm buffer",
        )?;

        try_reserve_exact(
            &mut buffers.thermals_x_nm,
            counts.thermals,
            "thermal X nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.thermals_y_nm,
            counts.thermals,
            "thermal Y nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.thermals_outer_diameter_nm,
            counts.thermals,
            "thermal outer diameter nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.thermals_inner_diameter_nm,
            counts.thermals,
            "thermal inner diameter nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.thermals_gap_thickness_nm,
            counts.thermals,
            "thermal gap thickness nm buffer",
        )?;
        try_reserve_exact(
            &mut buffers.thermals_rotation,
            counts.thermals,
            "thermal rotation buffer",
        )?;

        Ok(buffers)
    }

    fn push_primitive(&mut self, primitive: Primitive, origin_nm: [i64; 2]) -> Result<(), JsValue> {
        if !primitive_is_renderable(&primitive) {
            return Ok(());
        }

        let to_rel_i32 = |coord_nm: i64, origin: i64| -> Result<i32, JsValue> {
            i32::try_from(coord_nm - origin).map_err(|_| {
                JsValue::from_str(
                    "Layer dimensions exceed maximum supported span (4.29 m) for integer nanometer coordinates",
                )
            })
        };
        let to_dim_i32 = |dim_nm: i64| -> Result<i32, JsValue> {
            i32::try_from(dim_nm).map_err(|_| {
                JsValue::from_str(
                    "Feature dimension exceeds maximum supported size (2.14 m) for integer nanometer coordinates",
                )
            })
        };

        match primitive {
            Primitive::Triangle {
                vertices_nm,
                hole_x_nm,
                hole_y_nm,
                hole_radius_nm,
                ..
            } => {
                for vertex_nm in vertices_nm {
                    self.triangle_vertices_nm
                        .push(to_rel_i32(vertex_nm[0], origin_nm[0])?);
                    self.triangle_vertices_nm
                        .push(to_rel_i32(vertex_nm[1], origin_nm[1])?);
                }

                if self.has_triangle_holes {
                    let hx = to_rel_i32(hole_x_nm, origin_nm[0])?;
                    let hy = to_rel_i32(hole_y_nm, origin_nm[1])?;
                    let hr = to_dim_i32(hole_radius_nm)?;
                    for _ in 0..3 {
                        self.triangle_hole_x_nm.push(hx);
                        self.triangle_hole_y_nm.push(hy);
                        self.triangle_hole_radius_nm.push(hr);
                    }
                }
            }
            Primitive::Circle {
                x_nm,
                y_nm,
                radius_nm,
                hole_x_nm,
                hole_y_nm,
                hole_radius_nm,
                ..
            } => {
                self.circles_x_nm.push(to_rel_i32(x_nm, origin_nm[0])?);
                self.circles_y_nm.push(to_rel_i32(y_nm, origin_nm[1])?);
                self.circles_radius_nm.push(to_dim_i32(radius_nm)?);
                if self.has_circle_holes {
                    self.circles_hole_x_nm
                        .push(to_rel_i32(hole_x_nm, origin_nm[0])?);
                    self.circles_hole_y_nm
                        .push(to_rel_i32(hole_y_nm, origin_nm[1])?);
                    self.circles_hole_radius_nm
                        .push(to_dim_i32(hole_radius_nm)?);
                }
            }
            Primitive::Arc {
                start_angle,
                end_angle,
                x_nm,
                y_nm,
                radius_nm,
                thickness_nm,
                ..
            } => {
                self.arcs_start_angle.push(start_angle);
                self.arcs_sweep_angle.push(end_angle - start_angle);
                self.arcs_x_nm.push(to_rel_i32(x_nm, origin_nm[0])?);
                self.arcs_y_nm.push(to_rel_i32(y_nm, origin_nm[1])?);
                self.arcs_radius_nm.push(to_dim_i32(radius_nm)?);
                self.arcs_thickness_nm.push(to_dim_i32(thickness_nm)?);
            }
            Primitive::Line {
                start_x_nm,
                start_y_nm,
                end_x_nm,
                end_y_nm,
                width_nm,
                ..
            } => {
                self.lines_start_x_nm
                    .push(to_rel_i32(start_x_nm, origin_nm[0])?);
                self.lines_start_y_nm
                    .push(to_rel_i32(start_y_nm, origin_nm[1])?);
                self.lines_end_x_nm
                    .push(to_rel_i32(end_x_nm, origin_nm[0])?);
                self.lines_end_y_nm
                    .push(to_rel_i32(end_y_nm, origin_nm[1])?);
                self.lines_width_nm.push(to_dim_i32(width_nm)?);
            }
            Primitive::Thermal {
                rotation,
                x_nm,
                y_nm,
                outer_diameter_nm,
                inner_diameter_nm,
                gap_thickness_nm,
                ..
            } => {
                self.thermals_rotation.push(rotation);
                self.thermals_x_nm.push(to_rel_i32(x_nm, origin_nm[0])?);
                self.thermals_y_nm.push(to_rel_i32(y_nm, origin_nm[1])?);
                self.thermals_outer_diameter_nm
                    .push(to_dim_i32(outer_diameter_nm)?);
                self.thermals_inner_diameter_nm
                    .push(to_dim_i32(inner_diameter_nm)?);
                self.thermals_gap_thickness_nm
                    .push(to_dim_i32(gap_thickness_nm)?);
            }
            Primitive::TriangleTemplateFlash {
                template,
                x_nm,
                y_nm,
                ..
            } => {
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

                        let mut instance_x_nm = Vec::new();
                        let mut instance_y_nm = Vec::new();
                        try_reserve_exact(
                            &mut instance_x_nm,
                            expected_instances,
                            "triangle template instance X nm buffer",
                        )?;
                        try_reserve_exact(
                            &mut instance_y_nm,
                            expected_instances,
                            "triangle template instance Y nm buffer",
                        )?;

                        let index = self.triangle_templates.len();
                        self.triangle_templates.push(TriangleTemplateOutputBuffers {
                            vertices,
                            instance_x_nm,
                            instance_y_nm,
                        });
                        self.triangle_template_indices.insert(key, index);
                        index
                    };

                let template = &mut self.triangle_templates[template_idx];
                template.instance_x_nm.push(to_rel_i32(x_nm, origin_nm[0])?);
                template.instance_y_nm.push(to_rel_i32(y_nm, origin_nm[1])?);
            }
        }

        Ok(())
    }

    fn into_gerber_data(
        self,
        path_regions: PathRegions,
        is_negative: bool,
        origin_nm: [i64; 2],
    ) -> GerberData {
        let boundary = combined_boundary(
            self.boundary(origin_nm),
            self.has_geometry(),
            &path_regions,
            origin_nm,
        );
        let triangle_templates = self
            .triangle_templates
            .into_iter()
            .map(|template| {
                TriangleTemplateInstances::new_with_nm(
                    template.vertices,
                    template.instance_x_nm,
                    template.instance_y_nm,
                )
            })
            .collect();

        GerberData::new_with_origin(
            Triangles::new_with_nm(
                self.triangle_vertices_nm,
                self.triangle_hole_x_nm,
                self.triangle_hole_y_nm,
                self.triangle_hole_radius_nm,
            ),
            triangle_templates,
            Lines::new_with_nm(
                self.lines_start_x_nm,
                self.lines_start_y_nm,
                self.lines_end_x_nm,
                self.lines_end_y_nm,
                self.lines_width_nm,
            ),
            Circles::new_with_nm(
                self.circles_x_nm,
                self.circles_y_nm,
                self.circles_radius_nm,
                self.circles_hole_x_nm,
                self.circles_hole_y_nm,
                self.circles_hole_radius_nm,
            ),
            Arcs::new_with_nm(
                self.arcs_x_nm,
                self.arcs_y_nm,
                self.arcs_radius_nm,
                self.arcs_start_angle,
                self.arcs_sweep_angle,
                self.arcs_thickness_nm,
            ),
            Thermals::new_with_nm(
                self.thermals_x_nm,
                self.thermals_y_nm,
                self.thermals_outer_diameter_nm,
                self.thermals_inner_diameter_nm,
                self.thermals_gap_thickness_nm,
                self.thermals_rotation,
            ),
            path_regions,
            boundary,
            is_negative,
            origin_nm,
        )
    }

    fn has_geometry(&self) -> bool {
        !self.triangle_vertices_nm.is_empty()
            || self
                .triangle_templates
                .iter()
                .any(|template| !template.vertices.is_empty() && !template.instance_x_nm.is_empty())
            || !self.lines_start_x_nm.is_empty()
            || !self.circles_x_nm.is_empty()
            || !self.arcs_x_nm.is_empty()
            || !self.thermals_x_nm.is_empty()
    }

    fn boundary(&self, origin_nm: [i64; 2]) -> Boundary {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let to_world_x =
            |x_rel: i32| -> f32 { ((origin_nm[0] + x_rel as i64) as f64 * 1e-6) as f32 };
        let to_world_y =
            |y_rel: i32| -> f32 { ((origin_nm[1] + y_rel as i64) as f64 * 1e-6) as f32 };

        for point in self.triangle_vertices_nm.chunks_exact(2) {
            let x = to_world_x(point[0]);
            let y = to_world_y(point[1]);
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

            for i in 0..template.instance_x_nm.len() {
                let x = to_world_x(template.instance_x_nm[i]);
                let y = to_world_y(template.instance_y_nm[i]);
                min_x = min_x.min(template_min_x + x);
                max_x = max_x.max(template_max_x + x);
                min_y = min_y.min(template_min_y + y);
                max_y = max_y.max(template_max_y + y);
            }
        }

        for i in 0..self.lines_start_x_nm.len() {
            let sx = to_world_x(self.lines_start_x_nm[i]);
            let sy = to_world_y(self.lines_start_y_nm[i]);
            let ex = to_world_x(self.lines_end_x_nm[i]);
            let ey = to_world_y(self.lines_end_y_nm[i]);
            let half_width = (self.lines_width_nm[i] as f64 * 0.5e-6) as f32;
            min_x = min_x.min(sx.min(ex) - half_width);
            max_x = max_x.max(sx.max(ex) + half_width);
            min_y = min_y.min(sy.min(ey) - half_width);
            max_y = max_y.max(sy.max(ey) + half_width);
        }

        for i in 0..self.circles_x_nm.len() {
            let x = to_world_x(self.circles_x_nm[i]);
            let y = to_world_y(self.circles_y_nm[i]);
            let r = (self.circles_radius_nm[i] as f64 * 1e-6) as f32;
            min_x = min_x.min(x - r);
            max_x = max_x.max(x + r);
            min_y = min_y.min(y - r);
            max_y = max_y.max(y + r);
        }

        for i in 0..self.arcs_x_nm.len() {
            let x = to_world_x(self.arcs_x_nm[i]);
            let y = to_world_y(self.arcs_y_nm[i]);
            let r = (self.arcs_radius_nm[i] as f64 * 1e-6) as f32;
            let t = (self.arcs_thickness_nm[i] as f64 * 1e-6) as f32;
            let half_width = t * 0.5;
            let (arc_min_x, arc_max_x, arc_min_y, arc_max_y) = arc_curve_bounds(
                [x, y],
                r,
                self.arcs_start_angle[i],
                self.arcs_sweep_angle[i],
            );
            min_x = min_x.min(arc_min_x - half_width);
            max_x = max_x.max(arc_max_x + half_width);
            min_y = min_y.min(arc_min_y - half_width);
            max_y = max_y.max(arc_max_y + half_width);
        }

        for i in 0..self.thermals_x_nm.len() {
            let x = to_world_x(self.thermals_x_nm[i]);
            let y = to_world_y(self.thermals_y_nm[i]);
            let r = (self.thermals_outer_diameter_nm[i] as f64 * 0.5e-6) as f32;
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
    origin_nm: [i64; 2],
) -> Boundary {
    let Some(path_boundary) = path_regions_boundary(path_regions, origin_nm) else {
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

fn path_regions_boundary(path_regions: &PathRegions, origin_nm: [i64; 2]) -> Option<Boundary> {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for point in path_regions.cover_vertices_nm.chunks_exact(2) {
        let x = ((origin_nm[0] + point[0] as i64) as f64 * 1e-6) as f32;
        let y = ((origin_nm[1] + point[1] as i64) as f64 * 1e-6) as f32;
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
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
    pub preserve_region_source_contours: bool,
    pub arc_tessellation_quality: u32,
    // Store primitive batches in object-stream polarity order.
    pub polarity_layers: Vec<PolarityLayer>,
    pub current_primitives: Vec<Primitive>, // Accumulating primitives for current polarity
    pub current_path_regions: PathRegionsBuilder,
    pub region_contours: Vec<RegionContour>, // Contours collected in Region mode
    pub interaction_layer: Option<InteractionLayer>,
    pub progress: Option<ParseProgress>,
}

impl GerberParser {
    pub fn with_options(preserve_arc_regions: bool, arc_tessellation_quality: u32) -> Self {
        Self::with_options_and_interactions(preserve_arc_regions, arc_tessellation_quality, false)
    }

    pub fn with_options_and_interactions(
        preserve_arc_regions: bool,
        arc_tessellation_quality: u32,
        collect_interactions: bool,
    ) -> Self {
        GerberParser {
            apertures: HashMap::new(),
            macros: HashMap::new(),
            current_state: ParserState::default(),
            preserve_arc_regions,
            preserve_region_source_contours: false,
            arc_tessellation_quality,
            polarity_layers: Vec::new(),
            current_primitives: Vec::new(),
            current_path_regions: PathRegionsBuilder::empty(),
            region_contours: Vec::new(),
            interaction_layer: collect_interactions.then(InteractionLayer::new),
            progress: None,
        }
    }

    /// Parse Gerber file content and return GerberData batches in object-stream polarity order.
    ///
    /// An ODB++ layer envelope (see `crate::odb`) is recognised here so every
    /// entry point that accepts layer text also accepts ODB++ layers; the ODB++
    /// driver fills the same aperture, primitive and region buffers.
    pub fn parse(&mut self, data: &str) -> Result<Vec<GerberData>, JsValue> {
        if crate::odb::is_odb_envelope(data) {
            crate::odb::drive_gerber_parser(self, data)?;
            return self.finish_layers();
        }

        let mut commands_iter = split_commands(data);
        let total_bytes = data.len();
        report_progress(&mut self.progress, ParseStage::Commands, 0, total_bytes);
        let mut reported_bytes = 0;
        let mut reported_shapes = 0;

        while let Some(raw_line) = commands_iter.next() {
            if let Some(progress) = &mut self.progress {
                // Every command is a slice of `data`, so where it starts is how
                // much of the file the parse has read.
                let read_bytes = (raw_line.as_ptr() as usize)
                    .saturating_sub(data.as_ptr() as usize)
                    .min(total_bytes);
                let shapes = self.current_primitives.len();
                // A polarity change moves the shapes out; count again from there.
                reported_shapes = reported_shapes.min(shapes);
                if read_bytes.saturating_sub(reported_bytes) >= PROGRESS_BYTE_STEP
                    || shapes - reported_shapes >= PROGRESS_SHAPE_STEP
                {
                    progress(ParseStage::Commands, read_bytes, total_bytes);
                    reported_bytes = read_bytes;
                    reported_shapes = shapes;
                }
            }

            let line_ref = raw_line.trim();

            if line_ref.is_empty() {
                continue;
            }

            // M02 ends the file. The deprecated M00 (program stop) has the same
            // effect and is still emitted by some CAM tools such as Zuken CR-5000.
            if line_ref.starts_with("M02") || line_ref.starts_with("M00") {
                break;
            } else if line_ref.starts_with('%') {
                parse_command(
                    line_ref,
                    &mut commands_iter,
                    &mut self.current_state,
                    &mut self.apertures,
                    &mut self.macros,
                    &mut self.current_primitives,
                    &mut self.current_path_regions,
                    &mut self.polarity_layers,
                    self.preserve_arc_regions,
                    self.arc_tessellation_quality,
                    self.interaction_layer.is_some(),
                    self.preserve_region_source_contours,
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
                let collect_interactions = self.interaction_layer.is_some();
                parse_graphic_command(
                    line_ref,
                    &mut self.current_state,
                    &self.apertures,
                    &mut self.current_primitives,
                    &mut self.region_contours,
                    &mut self.current_path_regions,
                    &mut self.polarity_layers,
                    self.interaction_layer.as_mut(),
                    self.preserve_arc_regions,
                    self.arc_tessellation_quality,
                    collect_interactions,
                    self.preserve_region_source_contours,
                )
                .map_err(|message| JsValue::from_str(&message))?;
            }
        }
        report_progress(
            &mut self.progress,
            ParseStage::Commands,
            total_bytes,
            total_bytes,
        );

        self.finish_layers()
    }

    /// Flush the accumulated primitives and convert every polarity layer into
    /// render buffers.
    pub(crate) fn finish_layers(&mut self) -> Result<Vec<GerberData>, JsValue> {
        // Save last accumulated primitives by polarity
        if !self.current_primitives.is_empty()
            || self.current_path_regions.has_geometry_or_source_contours()
        {
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
        let origin_nm =
            compute_layer_origin_nm(&polarity_layers).map_err(|msg| JsValue::from_str(&msg))?;
        let mut gerber_data_layers: Vec<GerberData> = Vec::new();
        let gerber_data_layer_capacity =
            checked_capacity(polarity_layers.len(), 2, "Gerber data layer list")?;
        try_reserve_exact(
            &mut gerber_data_layers,
            gerber_data_layer_capacity,
            "Gerber data layer list",
        )?;

        let mut sublayer_map = Vec::new();
        try_reserve_exact(
            &mut sublayer_map,
            polarity_layers.len(),
            "interaction path region sublayer map",
        )?;
        let total_shapes = polarity_layers
            .iter()
            .map(|layer| layer.primitives.len())
            .sum();
        let mut done_shapes = 0;
        let mut reported_shapes = 0;
        report_progress(&mut self.progress, ParseStage::Geometry, 0, total_shapes);
        for layer in polarity_layers {
            let render_sublayer_idx = gerber_data_layers.len();
            let layer_shapes = layer.primitives.len();
            let path_regions = layer
                .path_regions
                .finalize_origin_nm(origin_nm)
                .map_err(|msg| JsValue::from_str(&msg))?;
            let mut gerber_data = Self::primitives_to_gerber_data(
                layer.primitives,
                path_regions,
                layer.polarity == Polarity::Negative,
                origin_nm,
            )?;
            // Between polarity layers, because counting inside the loop that
            // moves the shapes would slow it down, and only after a step of
            // shapes or the last of them: a file can have thousands of layers.
            done_shapes += layer_shapes;
            if done_shapes - reported_shapes >= PROGRESS_SHAPE_STEP
                || (done_shapes == total_shapes && reported_shapes < total_shapes)
            {
                report_progress(
                    &mut self.progress,
                    ParseStage::Geometry,
                    done_shapes,
                    total_shapes,
                );
                reported_shapes = done_shapes;
            }
            sublayer_map.push(render_sublayer_idx);
            gerber_data_layers.append(&mut gerber_data);
        }
        if let Some(interaction_layer) = &mut self.interaction_layer {
            interaction_layer.remap_path_region_sublayers(&sublayer_map)?;
        }

        Ok(gerber_data_layers)
    }

    pub fn parse_payload(&mut self, data: &str) -> Result<ParsedGerberLayer, JsValue> {
        let render_layers = self.parse(data)?;
        Ok(ParsedGerberLayer {
            render_layers,
            interaction_layer: take(&mut self.interaction_layer),
        })
    }

    /// Convert a vector of primitives to GerberData
    fn primitives_to_gerber_data(
        primitives: Vec<Primitive>,
        path_regions: PathRegions,
        is_negative: bool,
        origin_nm: [i64; 2],
    ) -> Result<Vec<GerberData>, JsValue> {
        let counts = SplitPrimitiveBufferCounts::from_primitives(&primitives);
        let mut plain_buffers = PrimitiveOutputBuffers::reserved_for(&counts.plain)?;
        let mut holed_buffers = PrimitiveOutputBuffers::reserved_for(&counts.holed)?;

        for primitive in primitives {
            if primitive_has_hole(&primitive) {
                holed_buffers.push_primitive(primitive, origin_nm)?;
            } else {
                plain_buffers.push_primitive(primitive, origin_nm)?;
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
            gerber_data_layers.push(plain_buffers.into_gerber_data(
                path_regions,
                is_negative,
                origin_nm,
            ));
        }
        if holed_buffers.has_geometry() {
            gerber_data_layers.push(holed_buffers.into_gerber_data(
                PathRegions::empty(),
                is_negative,
                origin_nm,
            ));
        }

        Ok(gerber_data_layers)
    }
}

fn compute_layer_origin_nm(polarity_layers: &[PolarityLayer]) -> Result<[i64; 2], String> {
    let mut min_x = i64::MAX;
    let mut max_x = i64::MIN;
    let mut min_y = i64::MAX;
    let mut max_y = i64::MIN;
    let mut has_coords = false;

    let mut include_point = |x: i64, y: i64| {
        has_coords = true;
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    };

    for layer in polarity_layers {
        for primitive in &layer.primitives {
            if !primitive_is_renderable(primitive) {
                continue;
            }
            match primitive {
                Primitive::Triangle {
                    vertices_nm,
                    hole_x_nm,
                    hole_y_nm,
                    hole_radius_nm,
                    ..
                } => {
                    for v in vertices_nm {
                        include_point(v[0], v[1]);
                    }
                    if *hole_radius_nm > 0 {
                        include_point(*hole_x_nm, *hole_y_nm);
                    }
                }
                Primitive::Circle {
                    x_nm,
                    y_nm,
                    hole_x_nm,
                    hole_y_nm,
                    hole_radius_nm,
                    ..
                } => {
                    include_point(*x_nm, *y_nm);
                    if *hole_radius_nm > 0 {
                        include_point(*hole_x_nm, *hole_y_nm);
                    }
                }
                Primitive::Arc { x_nm, y_nm, .. }
                | Primitive::Thermal { x_nm, y_nm, .. }
                | Primitive::TriangleTemplateFlash { x_nm, y_nm, .. } => {
                    include_point(*x_nm, *y_nm);
                }
                Primitive::Line {
                    start_x_nm,
                    start_y_nm,
                    end_x_nm,
                    end_y_nm,
                    ..
                } => {
                    include_point(*start_x_nm, *start_y_nm);
                    include_point(*end_x_nm, *end_y_nm);
                }
            }
        }

        for point in layer.path_regions.cover_vertices_nm.chunks_exact(2) {
            include_point(point[0], point[1]);
        }
        for point in layer.path_regions.clear_vertices_nm.chunks_exact(2) {
            include_point(point[0], point[1]);
        }
        for point in layer.path_regions.wedge_vertices_nm.chunks_exact(2) {
            include_point(point[0], point[1]);
        }
        for vertex in layer
            .path_regions
            .sector_vertices_nm
            .chunks_exact(crate::geometry::PATH_SECTOR_VERTEX_FLOATS)
        {
            include_point(vertex[0], vertex[1]);
            include_point(vertex[2], vertex[3]);
        }
    }

    if !has_coords {
        return Ok([0, 0]);
    }

    let span_x = max_x.saturating_sub(min_x);
    let span_y = max_y.saturating_sub(min_y);
    if span_x > u32::MAX as i64 || span_y > u32::MAX as i64 {
        return Err(
            "Layer dimensions exceed maximum supported span (4.29 m) for integer nanometer coordinates"
                .to_string(),
        );
    }

    let origin_x = min_x + ((span_x + 1) / 2);
    let origin_y = min_y + ((span_y + 1) / 2);
    Ok([origin_x, origin_y])
}

fn parse_command(
    line_ref: &str,
    commands_iter: &mut dyn Iterator<Item = &str>,
    state: &mut ParserState,
    apertures: &mut HashMap<String, Aperture>,
    macros: &mut HashMap<String, ApertureMacro>,
    current_primitives: &mut Vec<Primitive>,
    current_path_regions: &mut PathRegionsBuilder,
    polarity_layers: &mut Vec<PolarityLayer>,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
    collect_interactions: bool,
    collect_region_source_contours: bool,
) -> Result<(), JsValue> {
    let line = if !line_ref.ends_with('%') {
        let mut buffer = String::new();
        try_reserve_string(&mut buffer, line_ref.len(), "extended command buffer")?;
        buffer.push_str(line_ref);

        for next_raw in &mut *commands_iter {
            let next_line = next_raw.trim();
            try_reserve_string(&mut buffer, next_line.len(), "extended command buffer")?;
            buffer.push_str(next_line);

            if next_line.ends_with('%') {
                break;
            }
        }

        buffer
    } else {
        line_ref.to_string()
    };

    if line.starts_with("%AM") {
        parse_macro(&line, macros);
    } else if line.starts_with("%ADD") {
        parse_aperture(
            &line,
            apertures,
            macros,
            state.unit_multiplier,
            collect_interactions,
        );
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
        parse_sr(&line, state).map_err(|message| JsValue::from_str(&message))?;
    } else if line.starts_with("%IF") {
        // Image polarity: %IFPOS*% or %IFNEG*%
        parse_if(&line, state);
    } else if line.starts_with("%AB") {
        // Block Aperture: %ABD##*% ... %AB*%
        parse_aperture_block(
            &line,
            commands_iter,
            state,
            apertures,
            macros,
            current_primitives,
            current_path_regions,
            polarity_layers,
            preserve_arc_regions,
            arc_tessellation_quality,
            collect_interactions,
            collect_region_source_contours,
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
    } else if line.starts_with("%TF")
        || line.starts_with("%TA")
        || line.starts_with("%TO")
        || line.starts_with("%TD")
    {
        // X2/X3 attributes do not affect image rendering.
    } else {
        // Unknown or unsupported command
    }

    Ok(())
}

fn flush_primitives(
    current_primitives: &mut Vec<Primitive>,
    current_path_regions: &mut PathRegionsBuilder,
    polarity_layers: &mut Vec<PolarityLayer>,
    polarity: Polarity,
) -> Result<(), JsValue> {
    if !current_primitives.is_empty() || current_path_regions.has_geometry_or_source_contours() {
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
    commands_iter: &mut dyn Iterator<Item = &str>,
    state: &mut ParserState,
    apertures: &mut HashMap<String, Aperture>,
    macros: &mut HashMap<String, ApertureMacro>,
    current_primitives: &mut Vec<Primitive>,
    current_path_regions: &mut PathRegionsBuilder,
    polarity_layers: &mut Vec<PolarityLayer>,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
    collect_interactions: bool,
    collect_region_source_contours: bool,
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
    let mut block_path_regions = PathRegionsBuilder::empty();
    let mut block_layers: Vec<PolarityLayer> = Vec::new();
    let mut block_region_contours: Vec<RegionContour> = Vec::new();

    while let Some(raw_block_line) = commands_iter.next() {
        let block_line = raw_block_line.trim();

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
                commands_iter,
                state,
                apertures,
                macros,
                &mut block_primitives,
                &mut block_path_regions,
                &mut block_layers,
                preserve_arc_regions,
                arc_tessellation_quality,
                collect_interactions,
                collect_region_source_contours,
            )?;
            if let Some(enclosing_state) = nested_block_state {
                let generated_items = state.generated_items();
                *state = enclosing_state;
                state.set_generated_items(generated_items);
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
                None,
                preserve_arc_regions,
                arc_tessellation_quality,
                collect_interactions,
                collect_region_source_contours,
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

    state.set_point(0.0, 0.0);
    state.pen_state = "up".to_string();

    apertures.insert(block_code, Aperture::new_block(block_layers));

    Ok(())
}

#[allow(dead_code)]
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
pub fn parse_gerber_payload_with_options(
    data: &str,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
) -> Result<ParsedGerberLayer, JsValue> {
    parse_gerber_payload_with_progress(
        data,
        preserve_arc_regions,
        arc_tessellation_quality,
        true,
        None,
    )
}

pub fn parse_gerber_payload_with_progress(
    data: &str,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
    collect_interactions: bool,
    progress: Option<ParseProgress>,
) -> Result<ParsedGerberLayer, JsValue> {
    let mut parser = GerberParser::with_options_and_interactions(
        preserve_arc_regions,
        arc_tessellation_quality,
        collect_interactions,
    );
    parser.progress = progress;
    parser.parse_payload(data)
}

#[cfg(test)]
mod tests;
