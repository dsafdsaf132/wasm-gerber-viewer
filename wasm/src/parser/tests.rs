use super::aperture_macro::{evaluate_expression, parse_macro};
use super::geometry::Primitive;
use super::{format_count, parse_gerber, GerberParser, Polarity};
use std::collections::HashMap;

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

fn has_circle_at(
    circles: &crate::shape::Circles,
    expected_x: f32,
    expected_y: f32,
    expected_radius: f32,
) -> bool {
    circles
        .x
        .iter()
        .zip(&circles.y)
        .zip(&circles.radius)
        .any(|((&x, &y), &radius)| {
            (x - expected_x).abs() < 0.0001
                && (y - expected_y).abs() < 0.0001
                && (radius - expected_radius).abs() < 0.0001
        })
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
fn allocation_count_formatting_groups_digits_without_underflow() {
    assert_eq!(format_count(0), "0");
    assert_eq!(format_count(12), "12");
    assert_eq!(format_count(123), "123");
    assert_eq!(format_count(1_234), "1,234");
    assert_eq!(format_count(12_345), "12,345");
    assert_eq!(format_count(123_456), "123,456");
    assert_eq!(format_count(24_000_000), "24,000,000");
}

fn scaled(value: f32) -> i32 {
    (value * 10_000.0).round() as i32
}

fn scaled_vec(values: &[f32]) -> Vec<i32> {
    values.iter().map(|value| scaled(*value)).collect()
}

fn push_scaled_vec(output: &mut String, label: &str, values: &[f32]) {
    if !values.is_empty() {
        output.push_str(&format!("{label}={:?}\n", scaled_vec(values)));
    }
}

fn push_indices(output: &mut String, label: &str, values: &[u32]) {
    if !values.is_empty() {
        output.push_str(&format!("{label}={values:?}\n"));
    }
}

fn gerber_snapshot(data: &str) -> String {
    let layers = parse_gerber(data).expect("snapshot input should parse");
    let mut output = String::new();
    output.push_str(&format!("layers={}\n", layers.len()));

    for (idx, layer) in layers.iter().enumerate() {
        output.push_str(&format!("layer[{idx}].negative={}\n", layer.is_negative));
        output.push_str(&format!(
            "layer[{idx}].boundary=[{},{},{},{}]",
            scaled(layer.boundary.min_x),
            scaled(layer.boundary.max_x),
            scaled(layer.boundary.min_y),
            scaled(layer.boundary.max_y)
        ));
        output.push('\n');
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].triangles.vertices"),
            &layer.triangles.vertices,
        );
        push_indices(
            &mut output,
            &format!("layer[{idx}].triangles.indices"),
            &layer.triangles.indices,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].triangles.hole_x"),
            &layer.triangles.hole_x,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].triangles.hole_y"),
            &layer.triangles.hole_y,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].triangles.hole_radius"),
            &layer.triangles.hole_radius,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].circles.x"),
            &layer.circles.x,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].circles.y"),
            &layer.circles.y,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].circles.radius"),
            &layer.circles.radius,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].circles.hole_x"),
            &layer.circles.hole_x,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].circles.hole_y"),
            &layer.circles.hole_y,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].circles.hole_radius"),
            &layer.circles.hole_radius,
        );
        push_scaled_vec(&mut output, &format!("layer[{idx}].arcs.x"), &layer.arcs.x);
        push_scaled_vec(&mut output, &format!("layer[{idx}].arcs.y"), &layer.arcs.y);
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].arcs.radius"),
            &layer.arcs.radius,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].arcs.start_angle"),
            &layer.arcs.start_angle,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].arcs.sweep_angle"),
            &layer.arcs.sweep_angle,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].arcs.thickness"),
            &layer.arcs.thickness,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].thermals.x"),
            &layer.thermals.x,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].thermals.y"),
            &layer.thermals.y,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].thermals.outer_diameter"),
            &layer.thermals.outer_diameter,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].thermals.inner_diameter"),
            &layer.thermals.inner_diameter,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].thermals.gap_thickness"),
            &layer.thermals.gap_thickness,
        );
        push_scaled_vec(
            &mut output,
            &format!("layer[{idx}].thermals.rotation"),
            &layer.thermals.rotation,
        );
    }

    output
}

fn assert_gerber_snapshot(data: &str, expected: &str) {
    assert_eq!(gerber_snapshot(data).trim(), expected.trim());
}

#[test]
fn m02_stops_parsing_following_commands() {
    let layers = parse_gerber(
        "\
%FSLAX24Y24*%
%MOMM*%
%ADD10C,1.0*%
D10*
X000000Y000000D03*
M02*
X010000Y000000D03*",
    )
    .expect("flash should parse");

    assert_eq!(layers.len(), 1);
    assert_eq!(layers[0].circles.x.len(), 1);
    assert_approx_eq(layers[0].circles.x[0], 0.0);
}

#[test]
fn aperture_macro_omitted_variables_default_to_zero() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%AMSTAR5*
$3=$1x0.5*
$4=$3x0.4*
4,1,10,
$3x0.0000,$3x1.0000,
$4x-0.5878,$4x0.8090,
$3x-0.9511,$3x0.3090,
$4x-0.9511,$4x-0.3090,
$3x-0.5878,$3x-0.8090,
$4x0.0000,$4x-1.0000,
$3x0.5878,$3x-0.8090,
$4x0.9511,$4x-0.3090,
$3x0.9511,$3x0.3090,
$4x0.5878,$4x0.8090,
$3x0.0000,$3x1.0000,
$2*%
%ADD23STAR5,5.000000*%
%ADD24STAR5,5.000000X45*%
%ADD25STAR5,5.000000X90*%
%ADD26STAR5,5.000000X135*%
D23*
X025000000Y025000000D03*
D24*
X-025000000Y025000000D03*
D25*
X-025000000Y-025000000D03*
D26*
X025000000Y-025000000D03*
M02*",
    )
    .expect("macro should parse omitted parameters");
    let mut occupied_quadrants = [false; 4];

    for triangle in layers[0].triangles.vertices.chunks_exact(6) {
        let centroid_x = (triangle[0] + triangle[2] + triangle[4]) / 3.0;
        let centroid_y = (triangle[1] + triangle[3] + triangle[5]) / 3.0;

        if centroid_x > 10.0 && centroid_y > 10.0 {
            occupied_quadrants[0] = true;
        } else if centroid_x < -10.0 && centroid_y > 10.0 {
            occupied_quadrants[1] = true;
        } else if centroid_x < -10.0 && centroid_y < -10.0 {
            occupied_quadrants[2] = true;
        } else if centroid_x > 10.0 && centroid_y < -10.0 {
            occupied_quadrants[3] = true;
        }
    }

    assert_eq!(occupied_quadrants, [true, true, true, true]);
}

#[test]
fn golden_region_d02_output_matches_current_parser() {
    assert_gerber_snapshot(
        "\
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
M02*",
        "\
layers=1
layer[0].negative=false
layer[0].boundary=[0,10000,0,10000]
layer[0].triangles.vertices=[10000, 0, 0, 10000, 0, 0, 10000, 10000, 0, 10000, 10000, 0]
layer[0].triangles.indices=[0, 1, 2, 3, 4, 5]
layer[0].triangles.hole_x=[0, 0, 0, 0, 0, 0]
layer[0].triangles.hole_y=[0, 0, 0, 0, 0, 0]
layer[0].triangles.hole_radius=[0, 0, 0, 0, 0, 0]",
    );
}

#[test]
fn golden_step_repeat_output_matches_current_parser() {
    assert_gerber_snapshot(
        "\
%FSLAX26Y26*%
%MOIN*%
%ADD10C,0.1*%
%SRX2Y1I1.0J0*%
D10*
X000000Y000000D03*
%SR*%
M02*",
        "\
layers=1
layer[0].negative=false
layer[0].boundary=[-12700,266700,-12700,12700]
layer[0].circles.x=[0, 254000]
layer[0].circles.y=[0, 0]
layer[0].circles.radius=[12700, 12700]
layer[0].circles.hole_x=[0, 254000]
layer[0].circles.hole_y=[0, 0]
layer[0].circles.hole_radius=[0, 0]",
    );
}

#[test]
fn golden_macro_center_line_output_matches_current_parser() {
    assert_gerber_snapshot(
        "\
%FSLAX26Y26*%
%MOMM*%
%AMRECT*21,1,2,1,1,0,90*%
%ADD10RECT*%
D10*
X000000Y000000D03*
M02*",
        "\
layers=1
layer[0].negative=false
layer[0].boundary=[-5000,5000,0,20000]
layer[0].triangles.vertices=[5000, 0, 5000, 20000, -5000, 20000, 5000, 0, -5000, 20000, -5000, 0]
layer[0].triangles.indices=[0, 1, 2, 3, 4, 5]
layer[0].triangles.hole_x=[0, 0, 0, 0, 0, 0]
layer[0].triangles.hole_y=[0, 0, 0, 0, 0, 0]
layer[0].triangles.hole_radius=[0, 0, 0, 0, 0, 0]",
    );
}

#[test]
fn golden_aperture_block_polarity_output_matches_current_parser() {
    assert_gerber_snapshot(
        "\
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
M02*",
        "\
layers=2
layer[0].negative=false
layer[0].boundary=[80000,120000,-20000,20000]
layer[0].circles.x=[100000]
layer[0].circles.y=[0]
layer[0].circles.radius=[20000]
layer[0].circles.hole_x=[100000]
layer[0].circles.hole_y=[0]
layer[0].circles.hole_radius=[0]
layer[1].negative=true
layer[1].boundary=[90000,110000,-10000,10000]
layer[1].circles.x=[100000]
layer[1].circles.y=[0]
layer[1].circles.radius=[10000]
layer[1].circles.hole_x=[100000]
layer[1].circles.hole_y=[0]
layer[1].circles.hole_radius=[0]",
    );
}

#[test]
fn golden_layer_rotation_block_output_matches_current_parser() {
    assert_gerber_snapshot(
        "\
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
M02*",
        "\
layers=1
layer[0].negative=false
layer[0].boundary=[95000,105000,5000,15000]
layer[0].circles.x=[100000]
layer[0].circles.y=[10000]
layer[0].circles.radius=[5000]
layer[0].circles.hole_x=[100000]
layer[0].circles.hole_y=[10000]
layer[0].circles.hole_radius=[0]",
    );
}

#[test]
fn golden_macro_expression_output_matches_current_parser() {
    assert_gerber_snapshot(
        "\
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
M02*",
        "\
layers=1
layer[0].negative=false
layer[0].boundary=[-2000,0,-9000,11000]
layer[0].triangles.vertices=[-2000, 8000, -2000, -6000, 0, -9000, 0, 11000, -2000, 8000, 0, -9000]
layer[0].triangles.indices=[0, 1, 2, 3, 4, 5]
layer[0].triangles.hole_x=[0, 0, 0, 0, 0, 0]
layer[0].triangles.hole_y=[0, 0, 0, 0, 0, 0]
layer[0].triangles.hole_radius=[0, 0, 0, 0, 0, 0]",
    );
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
fn macro_thermal_rotation_from_ucamco_sample_is_preserved() {
    let data = "\
%FSLAX36Y36*%
%MOMM*%
%AMTHERS4T*
7,0,0,$1,$2,$3,$4*%
%ADD40THERS4T,0.1000X0.0500X0.0200X0.00*%
%ADD41THERS4T,0.2000X0.1000X0.0200X10.00*%
%ADD42THERS4T,0.2500X0.2000X0.0600X30.00*%
%ADD43THERS4T,0.2700X0.2000X0.0600X45.00*%
D40*
X0Y1100000D03*
D41*
X400000D03*
D42*
X800000D03*
D43*
X1200000D03*
M02*";

    let layers = parse_gerber(data).expect("thermal macro sample should parse");
    let thermals = &layers[0].thermals;

    assert_eq!(thermals.x.len(), 4);
    assert_approx_eq(thermals.x[0], 0.0);
    assert_approx_eq(thermals.x[1], 0.4);
    assert_approx_eq(thermals.x[2], 0.8);
    assert_approx_eq(thermals.x[3], 1.2);
    assert_approx_eq(thermals.y[0], 1.1);
    assert_approx_eq(thermals.outer_diameter[2], 0.25);
    assert_approx_eq(thermals.inner_diameter[2], 0.2);
    assert_approx_eq(thermals.gap_thickness[2], 0.06);
    assert_approx_eq(thermals.rotation[0], 0.0);
    assert_approx_eq(thermals.rotation[1], 10.0_f32.to_radians());
    assert_approx_eq(thermals.rotation[2], 30.0_f32.to_radians());
    assert_approx_eq(thermals.rotation[3], 45.0_f32.to_radians());
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
fn nested_aperture_block_restores_enclosing_graphic_state() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0*%
%ADD11C,0.5*%
%ABD20*%
D11*
G02*
G75*
X0000000Y2500000D02*
%ABD21*%
D10*
G01*
X0000000Y0000000D02*
X1000000Y0000000D01*
%AB*%
X2500000Y0I0J-2500000D01*
%AB*%
D20*
X0Y0D03*
M02*",
    )
    .expect("nested aperture block should parse");
    let arcs = &layers[0].arcs;
    let circles = &layers[0].circles;

    assert_eq!(arcs.x.len(), 1);
    assert_approx_eq(arcs.x[0], 0.0);
    assert_approx_eq(arcs.y[0], 0.0);
    assert_approx_eq(arcs.radius[0], 2.5);
    assert!(has_circle_at(circles, 0.0, 2.5, 0.25));
    assert!(has_circle_at(circles, 2.5, 0.0, 0.25));
}

#[test]
fn aperture_block_definition_preserves_ending_graphic_state() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0*%
%ADD11C,2.0*%
%ABD20*%
D10*
X0000000Y0000000D03*
D11*
%AB*%
X1000000Y0000000D03*
M02*",
    )
    .expect("aperture block should parse");
    let circles = &layers[0].circles;

    assert!(has_circle_at(circles, 1.0, 0.0, 1.0));
}

#[test]
fn arc_caps_use_rendered_arc_endpoints() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0*%
D10*
G03*
G75*
X0000000Y-2500000D02*
X-5000000Y0I0J2500000D01*
M02*",
    )
    .expect("arc should parse");
    let circles = &layers[0].circles;

    assert!(has_circle_at(circles, 0.0, -2.5, 0.5));
    assert!(has_circle_at(circles, -2.5, 0.0, 0.5));
    assert!(!has_circle_at(circles, -5.0, 0.0, 0.5));
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

#[test]
fn expression_supports_lowercase_multiply_and_parentheses() {
    let variables = HashMap::from([
        ("$1".to_string(), 2.0),
        ("$3".to_string(), 0.2),
        ("$4".to_string(), 0.1),
    ]);

    let value =
        evaluate_expression("(-$1+3x$3)/2+$4", &variables).expect("expression should parse");

    assert!((value + 0.6).abs() < 0.0001);
}

#[test]
fn multiline_outline_macro_instantiates_geometry() {
    let mut macros = HashMap::new();
    parse_macro(
        "%AMBOXS2*4,1,4,-$1/2+$4,$2/2-$3+$5,(-$1+3x$3)/2+$4,$2/2+$5,($1-3x$3)/2+$4,$2/2+$5,$1/2+$4,$2/2-$3+$5,-$1/2+$4,$2/2-$3+$5,$6*%",
        &mut macros,
    );
    let macro_def = macros.get("BOXS2").expect("macro should be parsed");
    let primitives = macro_def.instantiate(&[2.0, 1.0, 0.2, 0.1, -0.3, 90.0]);

    assert!(!primitives.is_empty());
}
