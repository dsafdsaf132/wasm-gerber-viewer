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

use self::geometry::{parse_graphic_command, Primitive};
use crate::shape::{Arcs, Boundary, Circles, GerberData, Thermals, Triangles};
use std::collections::HashMap;
use std::mem::take;
use wasm_bindgen::prelude::*;

// Security limits for resource consumption
const MAX_TOTAL_PRIMITIVES: usize = 70_000_000; // 70 million total primitives max

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
    circles: usize,
    arcs: usize,
    thermals: usize,
}

impl PrimitiveBufferCounts {
    fn from_primitives(primitives: &[Primitive]) -> Self {
        let mut counts = Self::default();

        for primitive in primitives {
            match primitive {
                Primitive::Triangle { .. } => counts.triangles += 1,
                Primitive::Circle { .. } => counts.circles += 1,
                Primitive::Arc { .. } => counts.arcs += 1,
                Primitive::Thermal { .. } => counts.thermals += 1,
            }
        }

        counts
    }
}

struct PrimitiveOutputBuffers {
    triangle_vertices: Vec<f32>,
    triangle_indices: Vec<u32>,
    triangle_hole_x: Vec<f32>,
    triangle_hole_y: Vec<f32>,
    triangle_hole_radius: Vec<f32>,
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
    fn reserved_for(primitives: &[Primitive]) -> Result<Self, JsValue> {
        let counts = PrimitiveBufferCounts::from_primitives(primitives);
        let triangle_vertex_values =
            checked_capacity(counts.triangles, 6, "triangle vertex buffer")?;
        let triangle_index_values = checked_capacity(counts.triangles, 3, "triangle index buffer")?;

        if triangle_index_values > u32::MAX as usize {
            return Err(JsValue::from_str(
                "Gerber layer is too large to render: triangle index buffer exceeds WebGL index range",
            ));
        }

        let mut buffers = Self {
            triangle_vertices: Vec::new(),
            triangle_indices: Vec::new(),
            triangle_hole_x: Vec::new(),
            triangle_hole_y: Vec::new(),
            triangle_hole_radius: Vec::new(),
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
        try_reserve_exact(
            &mut buffers.triangle_indices,
            triangle_index_values,
            "triangle index buffer",
        )?;
        try_reserve_exact(
            &mut buffers.triangle_hole_x,
            triangle_index_values,
            "triangle hole X buffer",
        )?;
        try_reserve_exact(
            &mut buffers.triangle_hole_y,
            triangle_index_values,
            "triangle hole Y buffer",
        )?;
        try_reserve_exact(
            &mut buffers.triangle_hole_radius,
            triangle_index_values,
            "triangle hole radius buffer",
        )?;

        try_reserve_exact(&mut buffers.circles_x, counts.circles, "circle X buffer")?;
        try_reserve_exact(&mut buffers.circles_y, counts.circles, "circle Y buffer")?;
        try_reserve_exact(
            &mut buffers.circles_radius,
            counts.circles,
            "circle radius buffer",
        )?;
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

fn try_reserve_exact<T>(
    values: &mut Vec<T>,
    additional: usize,
    buffer_name: &str,
) -> Result<(), JsValue> {
    values.try_reserve_exact(additional).map_err(|error| {
        JsValue::from_str(&format!(
            "Gerber layer is too large to render: unable to allocate {} ({} values): {:?}",
            buffer_name, additional, error
        ))
    })
}

/// Gerber parser with stateful aperture and macro storage
pub struct GerberParser {
    pub apertures: HashMap<String, Aperture>,
    pub macros: HashMap<String, ApertureMacro>,
    pub current_state: ParserState,
    // Store primitive batches in object-stream polarity order.
    pub polarity_layers: Vec<(Polarity, Vec<Primitive>)>,
    pub current_primitives: Vec<Primitive>, // Accumulating primitives for current polarity
    pub region_contours: Vec<Vec<[f32; 2]>>, // Contour points collected in Region mode
}

impl GerberParser {
    /// Create new parser instance
    pub fn new() -> Self {
        GerberParser {
            apertures: HashMap::new(),
            macros: HashMap::new(),
            current_state: ParserState::default(),
            polarity_layers: Vec::new(),
            current_primitives: Vec::new(),
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
                    &mut self.polarity_layers,
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
                    &mut self.polarity_layers,
                )
                .map_err(|message| JsValue::from_str(&message))?;
            }

            self.enforce_primitive_limit(MAX_TOTAL_PRIMITIVES)
                .map_err(|message| JsValue::from_str(&message))?;
            i += 1;
        }

        // Save last accumulated primitives by polarity
        if !self.current_primitives.is_empty() {
            try_reserve_exact(&mut self.polarity_layers, 1, "polarity layer list")?;
            self.polarity_layers.push((
                self.current_state.polarity,
                take(&mut self.current_primitives),
            ));
            self.enforce_primitive_limit(MAX_TOTAL_PRIMITIVES)
                .map_err(|message| JsValue::from_str(&message))?;
        }

        // Convert each layer to individual GerberData
        let mut gerber_data_layers: Vec<GerberData> = Vec::new();
        try_reserve_exact(
            &mut gerber_data_layers,
            self.polarity_layers.len(),
            "Gerber data layer list",
        )?;

        for (polarity, primitives) in &self.polarity_layers {
            let gerber_data =
                Self::primitives_to_gerber_data(primitives, *polarity == Polarity::Negative)?;
            gerber_data_layers.push(gerber_data);
        }

        Ok(gerber_data_layers)
    }

    fn enforce_primitive_limit(&self, max_total_primitives: usize) -> Result<(), String> {
        let flushed_primitives = self
            .polarity_layers
            .iter()
            .map(|(_, primitives)| primitives.len())
            .sum::<usize>();
        let total_primitives = flushed_primitives + self.current_primitives.len();

        if total_primitives > max_total_primitives {
            return Err(format!(
                "Too many total primitives: {} (max: {})",
                total_primitives, max_total_primitives
            ));
        }

        Ok(())
    }

    /// Convert a vector of primitives to GerberData
    fn primitives_to_gerber_data(
        primitives: &[Primitive],
        is_negative: bool,
    ) -> Result<GerberData, JsValue> {
        let mut buffers = PrimitiveOutputBuffers::reserved_for(primitives)?;

        let mut vertex_offset: u32 = 0;

        // Unit conversion: aperture.rs already converts to mm using unit_multiplier
        // No additional conversion needed
        const TO_MM: f32 = 1.0;

        for primitive in primitives {
            match primitive {
                Primitive::Triangle {
                    vertices,
                    hole_x,
                    hole_y,
                    hole_radius,
                    ..
                } => {
                    // Add triangle vertices to array (convert to mm units)
                    for vertex in vertices {
                        buffers.triangle_vertices.push(vertex[0] * TO_MM);
                        buffers.triangle_vertices.push(vertex[1] * TO_MM);
                    }
                    // Add index for every 3 vertices (one triangle)
                    buffers.triangle_indices.push(vertex_offset);
                    buffers.triangle_indices.push(vertex_offset + 1);
                    buffers.triangle_indices.push(vertex_offset + 2);
                    vertex_offset += 3;

                    // Add hole data for each vertex (3 times per triangle)
                    for _ in 0..3 {
                        buffers.triangle_hole_x.push(*hole_x * TO_MM);
                        buffers.triangle_hole_y.push(*hole_y * TO_MM);
                        buffers.triangle_hole_radius.push(*hole_radius * TO_MM);
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
                    buffers.circles_x.push(*x * TO_MM);
                    buffers.circles_y.push(*y * TO_MM);
                    buffers.circles_radius.push(*radius * TO_MM);
                    buffers.circles_hole_x.push(*hole_x * TO_MM);
                    buffers.circles_hole_y.push(*hole_y * TO_MM);
                    buffers.circles_hole_radius.push(*hole_radius * TO_MM);
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
                    buffers.arcs_x.push(*x * TO_MM);
                    buffers.arcs_y.push(*y * TO_MM);
                    buffers.arcs_radius.push(*radius * TO_MM);
                    buffers.arcs_start_angle.push(*start_angle);
                    // sweep_angle = end_angle - start_angle
                    buffers.arcs_sweep_angle.push(*end_angle - *start_angle);
                    buffers.arcs_thickness.push(*thickness * TO_MM);
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
                    buffers.thermals_x.push(*x * TO_MM);
                    buffers.thermals_y.push(*y * TO_MM);
                    buffers
                        .thermals_outer_diameter
                        .push(*outer_diameter * TO_MM);
                    buffers
                        .thermals_inner_diameter
                        .push(*inner_diameter * TO_MM);
                    buffers.thermals_gap_thickness.push(*gap_thickness * TO_MM);
                    buffers.thermals_rotation.push(*rotation);
                }
            }
        }

        // Calculate boundary from all geometry
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        // Include triangle vertices in boundary
        for i in (0..buffers.triangle_vertices.len()).step_by(2) {
            let x = buffers.triangle_vertices[i];
            let y = buffers.triangle_vertices[i + 1];
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }

        // Include circles in boundary (center +/- radius)
        for i in 0..buffers.circles_x.len() {
            let x = buffers.circles_x[i];
            let y = buffers.circles_y[i];
            let r = buffers.circles_radius[i];
            min_x = min_x.min(x - r);
            max_x = max_x.max(x + r);
            min_y = min_y.min(y - r);
            max_y = max_y.max(y + r);
        }

        // Include arcs in boundary (center +/- radius + thickness/2)
        for i in 0..buffers.arcs_x.len() {
            let x = buffers.arcs_x[i];
            let y = buffers.arcs_y[i];
            let r = buffers.arcs_radius[i];
            let t = buffers.arcs_thickness[i];
            let outer = r + t / 2.0;
            min_x = min_x.min(x - outer);
            max_x = max_x.max(x + outer);
            min_y = min_y.min(y - outer);
            max_y = max_y.max(y + outer);
        }

        // Include thermals in boundary (center +/- outer_diameter/2)
        for i in 0..buffers.thermals_x.len() {
            let x = buffers.thermals_x[i];
            let y = buffers.thermals_y[i];
            let r = buffers.thermals_outer_diameter[i] / 2.0;
            min_x = min_x.min(x - r);
            max_x = max_x.max(x + r);
            min_y = min_y.min(y - r);
            max_y = max_y.max(y + r);
        }

        // Handle empty geometry case
        if min_x == f32::INFINITY {
            min_x = 0.0;
            max_x = 0.0;
            min_y = 0.0;
            max_y = 0.0;
        }

        Ok(GerberData::new(
            Triangles::new(
                buffers.triangle_vertices,
                buffers.triangle_indices,
                buffers.triangle_hole_x,
                buffers.triangle_hole_y,
                buffers.triangle_hole_radius,
            ),
            Circles::new(
                buffers.circles_x,
                buffers.circles_y,
                buffers.circles_radius,
                buffers.circles_hole_x,
                buffers.circles_hole_y,
                buffers.circles_hole_radius,
            ),
            Arcs::new(
                buffers.arcs_x,
                buffers.arcs_y,
                buffers.arcs_radius,
                buffers.arcs_start_angle,
                buffers.arcs_sweep_angle,
                buffers.arcs_thickness,
            ),
            Thermals::new(
                buffers.thermals_x,
                buffers.thermals_y,
                buffers.thermals_outer_diameter,
                buffers.thermals_inner_diameter,
                buffers.thermals_gap_thickness,
                buffers.thermals_rotation,
            ),
            Boundary::new(min_x, max_x, min_y, max_y),
            is_negative,
        ))
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
    polarity_layers: &mut Vec<(Polarity, Vec<Primitive>)>,
) -> Result<(), JsValue> {
    let line = if !line_ref.ends_with('%') {
        let mut buffer = Vec::new();
        try_reserve_exact(&mut buffer, 1, "extended command line buffer")?;
        buffer.push(line_ref.to_string());
        *i += 1;

        while *i < length {
            let next_line = lines[*i].trim();
            buffer.push(next_line.to_string());

            if next_line.ends_with('%') {
                break;
            }
            *i += 1;
        }

        buffer.join("")
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
        parse_lp(&line, state, current_primitives, polarity_layers)
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
            polarity_layers,
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
    polarity_layers: &mut Vec<(Polarity, Vec<Primitive>)>,
    polarity: Polarity,
) -> Result<(), JsValue> {
    if !current_primitives.is_empty() {
        try_reserve_exact(polarity_layers, 1, "polarity layer list")?;
        polarity_layers.push((polarity, take(current_primitives)));
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
    polarity_layers: &mut Vec<(Polarity, Vec<Primitive>)>,
) -> Result<(), JsValue> {
    let Some(block_code) = parse_aperture_block_code(line) else {
        return Ok(());
    };

    flush_primitives(current_primitives, polarity_layers, state.polarity)?;

    let mut block_primitives: Vec<Primitive> = Vec::new();
    let mut block_layers: Vec<(Polarity, Vec<Primitive>)> = Vec::new();
    let mut block_region_contours: Vec<Vec<[f32; 2]>> = Vec::new();

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
                &mut block_layers,
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
                &mut block_layers,
            )
            .map_err(|message| JsValue::from_str(&message))?;
        }
    }

    flush_primitives(&mut block_primitives, &mut block_layers, state.polarity)?;

    state.x = 0.0;
    state.y = 0.0;
    state.pen_state = "up".to_string();

    apertures.insert(block_code, Aperture::new_block(block_layers));

    Ok(())
}

pub fn parse_gerber(data: &str) -> Result<Vec<GerberData>, JsValue> {
    let mut parser = GerberParser::new();
    parser.parse(data)
}

#[cfg(test)]
mod tests;
