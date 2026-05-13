use super::aperture_macro::{evaluate_expression, parse_macro};
use super::geometry::Primitive;
use super::{parse_gerber, GerberParser, Polarity};
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
