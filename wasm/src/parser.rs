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
        let lines: Vec<&str> = data.split('\n').collect();
        let length = lines.len();
        let mut i = 0;

        while i < length {
            let line_ref = lines[i].trim();

            if line_ref.is_empty() {
                i += 1;
                continue;
            }

            if line_ref.starts_with('%') {
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
                );
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
                );
            }

            self.enforce_primitive_limit(MAX_TOTAL_PRIMITIVES)
                .map_err(|message| JsValue::from_str(&message))?;
            i += 1;
        }

        // Save last accumulated primitives by polarity
        if !self.current_primitives.is_empty() {
            self.polarity_layers.push((
                self.current_state.polarity,
                take(&mut self.current_primitives),
            ));
            self.enforce_primitive_limit(MAX_TOTAL_PRIMITIVES)
                .map_err(|message| JsValue::from_str(&message))?;
        }

        // Convert each layer to individual GerberData
        let mut gerber_data_layers: Vec<GerberData> = Vec::new();

        for (polarity, primitives) in &self.polarity_layers {
            let gerber_data =
                Self::primitives_to_gerber_data(primitives, *polarity == Polarity::Negative);
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
    fn primitives_to_gerber_data(primitives: &[Primitive], is_negative: bool) -> GerberData {
        let mut triangle_vertices: Vec<f32> = Vec::new();
        let mut triangle_indices: Vec<u32> = Vec::new();
        let mut triangle_hole_x: Vec<f32> = Vec::new();
        let mut triangle_hole_y: Vec<f32> = Vec::new();
        let mut triangle_hole_radius: Vec<f32> = Vec::new();
        let mut circles_x: Vec<f32> = Vec::new();
        let mut circles_y: Vec<f32> = Vec::new();
        let mut circles_radius: Vec<f32> = Vec::new();
        let mut circles_hole_x: Vec<f32> = Vec::new();
        let mut circles_hole_y: Vec<f32> = Vec::new();
        let mut circles_hole_radius: Vec<f32> = Vec::new();
        let mut arcs_x: Vec<f32> = Vec::new();
        let mut arcs_y: Vec<f32> = Vec::new();
        let mut arcs_radius: Vec<f32> = Vec::new();
        let mut arcs_start_angle: Vec<f32> = Vec::new();
        let mut arcs_sweep_angle: Vec<f32> = Vec::new();
        let mut arcs_thickness: Vec<f32> = Vec::new();
        let mut thermals_x: Vec<f32> = Vec::new();
        let mut thermals_y: Vec<f32> = Vec::new();
        let mut thermals_outer_diameter: Vec<f32> = Vec::new();
        let mut thermals_inner_diameter: Vec<f32> = Vec::new();
        let mut thermals_gap_thickness: Vec<f32> = Vec::new();
        let mut thermals_rotation: Vec<f32> = Vec::new();

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
                        triangle_vertices.push(vertex[0] * TO_MM);
                        triangle_vertices.push(vertex[1] * TO_MM);
                    }
                    // Add index for every 3 vertices (one triangle)
                    triangle_indices.push(vertex_offset);
                    triangle_indices.push(vertex_offset + 1);
                    triangle_indices.push(vertex_offset + 2);
                    vertex_offset += 3;

                    // Add hole data for each vertex (3 times per triangle)
                    for _ in 0..3 {
                        triangle_hole_x.push(*hole_x * TO_MM);
                        triangle_hole_y.push(*hole_y * TO_MM);
                        triangle_hole_radius.push(*hole_radius * TO_MM);
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
                    circles_x.push(*x * TO_MM);
                    circles_y.push(*y * TO_MM);
                    circles_radius.push(*radius * TO_MM);
                    circles_hole_x.push(*hole_x * TO_MM);
                    circles_hole_y.push(*hole_y * TO_MM);
                    circles_hole_radius.push(*hole_radius * TO_MM);
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
                    arcs_x.push(*x * TO_MM);
                    arcs_y.push(*y * TO_MM);
                    arcs_radius.push(*radius * TO_MM);
                    arcs_start_angle.push(*start_angle);
                    // sweep_angle = end_angle - start_angle
                    arcs_sweep_angle.push(*end_angle - *start_angle);
                    arcs_thickness.push(*thickness * TO_MM);
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
                    thermals_x.push(*x * TO_MM);
                    thermals_y.push(*y * TO_MM);
                    thermals_outer_diameter.push(*outer_diameter * TO_MM);
                    thermals_inner_diameter.push(*inner_diameter * TO_MM);
                    thermals_gap_thickness.push(*gap_thickness * TO_MM);
                    thermals_rotation.push(*rotation);
                }
            }
        }

        // Calculate boundary from all geometry
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        // Include triangle vertices in boundary
        for i in (0..triangle_vertices.len()).step_by(2) {
            let x = triangle_vertices[i];
            let y = triangle_vertices[i + 1];
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }

        // Include circles in boundary (center +/- radius)
        for i in 0..circles_x.len() {
            let x = circles_x[i];
            let y = circles_y[i];
            let r = circles_radius[i];
            min_x = min_x.min(x - r);
            max_x = max_x.max(x + r);
            min_y = min_y.min(y - r);
            max_y = max_y.max(y + r);
        }

        // Include arcs in boundary (center +/- radius + thickness/2)
        for i in 0..arcs_x.len() {
            let x = arcs_x[i];
            let y = arcs_y[i];
            let r = arcs_radius[i];
            let t = arcs_thickness[i];
            let outer = r + t / 2.0;
            min_x = min_x.min(x - outer);
            max_x = max_x.max(x + outer);
            min_y = min_y.min(y - outer);
            max_y = max_y.max(y + outer);
        }

        // Include thermals in boundary (center +/- outer_diameter/2)
        for i in 0..thermals_x.len() {
            let x = thermals_x[i];
            let y = thermals_y[i];
            let r = thermals_outer_diameter[i] / 2.0;
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

        GerberData::new(
            Triangles::new(
                triangle_vertices,
                triangle_indices,
                triangle_hole_x,
                triangle_hole_y,
                triangle_hole_radius,
            ),
            Circles::new(
                circles_x,
                circles_y,
                circles_radius,
                circles_hole_x,
                circles_hole_y,
                circles_hole_radius,
            ),
            Arcs::new(
                arcs_x,
                arcs_y,
                arcs_radius,
                arcs_start_angle,
                arcs_sweep_angle,
                arcs_thickness,
            ),
            Thermals::new(
                thermals_x,
                thermals_y,
                thermals_outer_diameter,
                thermals_inner_diameter,
                thermals_gap_thickness,
                thermals_rotation,
            ),
            Boundary::new(min_x, max_x, min_y, max_y),
            is_negative,
        )
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
) {
    let line = if !line_ref.ends_with('%') {
        let mut buffer = vec![line_ref.to_string()];
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
        parse_lp(&line, state, current_primitives, polarity_layers);
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
        );
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
}

fn flush_primitives(
    current_primitives: &mut Vec<Primitive>,
    polarity_layers: &mut Vec<(Polarity, Vec<Primitive>)>,
    polarity: Polarity,
) {
    if !current_primitives.is_empty() {
        polarity_layers.push((polarity, take(current_primitives)));
    }
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
) {
    let Some(block_code) = parse_aperture_block_code(line) else {
        return;
    };

    flush_primitives(current_primitives, polarity_layers, state.polarity);

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
            );
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
            );
        }
    }

    flush_primitives(&mut block_primitives, &mut block_layers, state.polarity);

    state.x = 0.0;
    state.y = 0.0;
    state.pen_state = "up".to_string();

    apertures.insert(block_code, Aperture::new_block(block_layers));
}

pub fn parse_gerber(data: &str) -> Result<Vec<GerberData>, JsValue> {
    let mut parser = GerberParser::new();
    parser.parse(data)
}

#[cfg(test)]
mod tests {
    use super::geometry::Primitive;
    use super::{parse_gerber, GerberParser, Polarity};

    fn assert_approx_eq(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.0001,
            "expected {expected}, got {actual}"
        );
    }

    fn triangle_bounds(vertices: &[f32]) -> (f32, f32, f32, f32) {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;

        for point in vertices.chunks_exact(2) {
            min_x = min_x.min(point[0]);
            max_x = max_x.max(point[0]);
            min_y = min_y.min(point[1]);
            max_y = max_y.max(point[1]);
        }

        (min_x, max_x, min_y, max_y)
    }

    fn test_circle() -> Primitive {
        Primitive::Circle {
            x: 0.0,
            y: 0.0,
            radius: 0.5,
            exposure: 1.0,
            hole_x: 0.0,
            hole_y: 0.0,
            hole_radius: 0.0,
        }
    }

    #[test]
    fn primitive_limit_counts_flushed_polarity_layers() {
        let mut parser = GerberParser::new();
        parser
            .polarity_layers
            .push((Polarity::Positive, vec![test_circle()]));
        parser.current_primitives.push(test_circle());

        assert!(parser.enforce_primitive_limit(1).is_err());
    }

    #[test]
    fn region_d02_move_is_included_as_first_contour_vertex() {
        let data = "\
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

        let layers = parse_gerber(data).expect("region should parse");
        let triangles = &layers[0].triangles;

        assert_eq!(triangles.vertices.len() / 2, 6);
        assert_eq!(triangles.indices.len(), 6);
    }

    #[test]
    fn clear_polarity_first_layer_preserves_negative_polarity() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%LPC*%
G36*
X000000Y000000D02*
G01*
X010000Y000000D01*
X010000Y010000D01*
X000000Y010000D01*
G37*
M02*";

        let layers = parse_gerber(data).expect("region should parse");

        assert_eq!(layers.len(), 1);
        assert!(layers[0].is_negative);
    }

    #[test]
    fn aperture_identifier_above_9999_is_selectable() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ADD10000C,1.0*%
D10000*
X000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("flash should parse");

        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].circles.x.len(), 1);
    }

    #[test]
    fn aperture_identifier_leading_zeroes_are_normalized() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ADD010C,1.0*%
D10*
X000000Y000000D03*
%ADD11C,1.0*%
D011*
X010000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("flashes should parse");

        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].circles.x.len(), 2);
    }

    #[test]
    fn load_scaling_transforms_aperture_not_operation_coordinates() {
        let data = "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0*%
D10*
X1000000Y000000D03*
%LS2.0*%
X2000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("flashes should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 2);
        assert_approx_eq(circles.x[0], 1.0);
        assert_approx_eq(circles.x[1], 2.0);
        assert_approx_eq(circles.radius[0], 0.5);
        assert_approx_eq(circles.radius[1], 1.0);
    }

    #[test]
    fn load_mirroring_transforms_aperture_not_operation_coordinates() {
        let data = "\
%FSLAX26Y26*%
%MOMM*%
%AMOFF*1,1,0.5,0.25,0*%
%ADD10OFF*%
%LMX*%
D10*
X1000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("macro flash should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 1);
        assert_approx_eq(circles.x[0], 0.75);
        assert_approx_eq(circles.y[0], 0.0);
        assert_approx_eq(circles.radius[0], 0.25);
    }

    #[test]
    fn macro_circle_rotation_moves_center_in_degrees_about_origin() {
        let data = "\
%FSLAX26Y26*%
%MOMM*%
%AMCIRCLE*1,1,1,1,0,90*%
%ADD10CIRCLE*%
D10*
X000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("macro circle should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 1);
        assert_approx_eq(circles.x[0], 0.0);
        assert_approx_eq(circles.y[0], 1.0);
    }

    #[test]
    fn macro_center_line_rotation_uses_degrees_about_origin() {
        let data = "\
%FSLAX26Y26*%
%MOMM*%
%AMRECT*21,1,2,1,1,0,90*%
%ADD10RECT*%
D10*
X000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("macro rectangle should parse");
        let (min_x, max_x, min_y, max_y) = triangle_bounds(&layers[0].triangles.vertices);

        assert_approx_eq(min_x, -0.5);
        assert_approx_eq(max_x, 0.5);
        assert_approx_eq(min_y, 0.0);
        assert_approx_eq(max_y, 2.0);
    }

    #[test]
    fn macro_outline_rotation_uses_closing_point_before_rotation_parameter() {
        let data = "\
%FSLAX26Y26*%
%MOMM*%
%AMOUTLINE*4,1,4,0,0,2,0,2,1,0,1,0,0,90*%
%ADD10OUTLINE*%
D10*
X000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("macro outline should parse");
        let (min_x, max_x, min_y, max_y) = triangle_bounds(&layers[0].triangles.vertices);

        assert_approx_eq(min_x, -1.0);
        assert_approx_eq(max_x, 0.0);
        assert_approx_eq(min_y, 0.0);
        assert_approx_eq(max_y, 2.0);
    }

    #[test]
    fn macro_expressions_support_lowercase_multiply_and_parentheses() {
        let data = "\
%FSLAX26Y26*%
%MOMM*%
%AMBOXS2*
4,1,4,
-$1/2+$4,$2/2-$3+$5,
(-$1+3x$3)/2+$4,$2/2+$5,
($1-3x$3)/2+$4,$2/2+$5,
$1/2+$4,$2/2-$3+$5,
-$1/2+$4,$2/2-$3+$5,
$6*%
%ADD10BOXS2,2.0X1.0X0.2X0.1X-0.3X90*%
D10*
X000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("macro expression should parse");

        assert_eq!(layers.len(), 1);
        assert!(!layers[0].triangles.indices.is_empty());
    }

    #[test]
    fn step_repeat_offsets_use_file_units() {
        let data = "\
%FSLAX26Y26*%
%MOIN*%
%ADD10C,0.1*%
%SRX2Y1I1.0J0*%
D10*
X000000Y000000D03*
%SR*%
M02*";

        let layers = parse_gerber(data).expect("step repeat should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 2);
        assert_approx_eq(circles.x[0], 0.0);
        assert_approx_eq(circles.x[1], 25.4);
    }

    #[test]
    fn region_arcs_in_clear_polarity_are_tessellated() {
        let data = "\
%FSLAX36Y36*%
%MOMM*%
%LPC*%
G75*
G36*
X10000000Y25000000D02*
G01*
Y30000000D01*
G02*
X12500000Y32500000I2500000J0D01*
G01*
X30000000D01*
G02*
X30000000Y25000000I0J-3750000D01*
G01*
X10000000D01*
G37*
M02*";

        let layers = parse_gerber(data).expect("region with arcs should parse");

        assert_eq!(layers.len(), 1);
        assert!(layers[0].is_negative);
        assert!(layers[0].triangles.vertices.len() / 2 > 60);
    }

    #[test]
    fn aperture_block_flashes_stored_graphics_at_operation_coordinate() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ABD20*%
%ADD10C,1.0*%
D10*
X010000Y020000D03*
%AB*%
D20*
X100000Y200000D03*
M02*";

        let layers = parse_gerber(data).expect("aperture block should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 1);
        assert_approx_eq(circles.x[0], 11.0);
        assert_approx_eq(circles.y[0], 22.0);
        assert_approx_eq(circles.radius[0], 0.5);
    }

    #[test]
    fn aperture_block_preserves_internal_polarity_order() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ABD20*%
%LPD*%
%ADD10C,4.0*%
D10*
X000000Y000000D03*
%LPC*%
%ADD11C,2.0*%
D11*
X000000Y000000D03*
%AB*%
%LPD*%
D20*
X100000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("aperture block should parse");

        assert_eq!(layers.len(), 2);
        assert!(!layers[0].is_negative);
        assert!(layers[1].is_negative);
        assert_eq!(layers[0].circles.x.len(), 1);
        assert_eq!(layers[1].circles.x.len(), 1);
        assert_approx_eq(layers[0].circles.x[0], 10.0);
        assert_approx_eq(layers[0].circles.radius[0], 2.0);
        assert_approx_eq(layers[1].circles.x[0], 10.0);
        assert_approx_eq(layers[1].circles.radius[0], 1.0);
    }

    #[test]
    fn clear_polarity_flash_toggles_aperture_block_polarity() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ABD20*%
%LPD*%
%ADD10C,4.0*%
D10*
X000000Y000000D03*
%LPC*%
%ADD11C,2.0*%
D11*
X000000Y000000D03*
%AB*%
%LPC*%
D20*
X100000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("aperture block should parse");

        assert_eq!(layers.len(), 2);
        assert!(layers[0].is_negative);
        assert!(!layers[1].is_negative);
        assert_eq!(layers[0].circles.x.len(), 1);
        assert_eq!(layers[1].circles.x.len(), 1);
        assert_approx_eq(layers[0].circles.radius[0], 2.0);
        assert_approx_eq(layers[1].circles.radius[0], 1.0);
    }

    #[test]
    fn nested_aperture_blocks_are_available_to_enclosing_block() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ABD20*%
%ADD10C,1.0*%
D10*
X010000Y000000D03*
%AB*%
%ABD21*%
D20*
X020000Y000000D03*
%AB*%
D21*
X100000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("nested aperture block should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 1);
        assert_approx_eq(circles.x[0], 13.0);
        assert_approx_eq(circles.y[0], 0.0);
    }

    #[test]
    fn layer_scaling_transforms_aperture_block_about_origin() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ABD20*%
%ADD10C,1.0*%
D10*
X010000Y000000D03*
%AB*%
%LS2.0*%
D20*
X100000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("scaled aperture block should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 1);
        assert_approx_eq(circles.x[0], 12.0);
        assert_approx_eq(circles.radius[0], 1.0);
    }

    #[test]
    fn layer_rotation_transforms_aperture_about_origin() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ADD10R,2.0X1.0*%
%LR90*%
D10*
X000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("rotated aperture should parse");
        let (min_x, max_x, min_y, max_y) = triangle_bounds(&layers[0].triangles.vertices);

        assert_approx_eq(min_x, -0.5);
        assert_approx_eq(max_x, 0.5);
        assert_approx_eq(min_y, -1.0);
        assert_approx_eq(max_y, 1.0);
    }

    #[test]
    fn layer_rotation_is_applied_after_mirroring() {
        let data = "\
%FSLAX26Y26*%
%MOMM*%
%AMOFF*1,1,0.5,0.25,0*%
%ADD10OFF*%
%LMX*%
%LR90*%
D10*
X1000000Y1000000D03*
M02*";

        let layers = parse_gerber(data).expect("mirrored rotated aperture should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 1);
        assert_approx_eq(circles.x[0], 1.0);
        assert_approx_eq(circles.y[0], 0.75);
    }

    #[test]
    fn layer_rotation_replaces_previous_value() {
        let data = "\
%FSLAX26Y26*%
%MOMM*%
%AMOFF*1,1,0.5,1,0*%
%ADD10OFF*%
%LR90*%
%LR180*%
D10*
X000000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("rotated aperture should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 1);
        assert_approx_eq(circles.x[0], -1.0);
        assert_approx_eq(circles.y[0], 0.0);
    }

    #[test]
    fn layer_rotation_transforms_aperture_block_about_origin() {
        let data = "\
%FSLAX24Y24*%
%MOMM*%
%ABD20*%
%ADD10C,1.0*%
D10*
X010000Y000000D03*
%AB*%
%LR90*%
D20*
X100000Y000000D03*
M02*";

        let layers = parse_gerber(data).expect("rotated aperture block should parse");
        let circles = &layers[0].circles;

        assert_eq!(circles.x.len(), 1);
        assert_approx_eq(circles.x[0], 10.0);
        assert_approx_eq(circles.y[0], 1.0);
    }
}
