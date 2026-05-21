use super::aperture_macro::{evaluate_expression, parse_macro};
use super::{format_count, parse_gerber, parse_gerber_with_options};
use crate::shape::GerberData;
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

fn collect_triangle_vertices(layer: &GerberData) -> Vec<f32> {
    let mut vertices = layer.triangles.vertices.clone();

    for template in &layer.triangle_templates {
        for i in 0..template.instance_x.len() {
            let offset_x = template.instance_x[i];
            let offset_y = template.instance_y[i];
            for point in template.vertices.chunks_exact(2) {
                vertices.push(point[0] + offset_x);
                vertices.push(point[1] + offset_y);
            }
        }
    }

    vertices
}

fn layer_triangle_bounds(layer: &GerberData) -> (f32, f32, f32, f32) {
    triangle_bounds(&collect_triangle_vertices(layer))
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
        for (template_idx, template) in layer.triangle_templates.iter().enumerate() {
            push_scaled_vec(
                &mut output,
                &format!("layer[{idx}].triangle_templates[{template_idx}].vertices"),
                &template.vertices,
            );
            push_scaled_vec(
                &mut output,
                &format!("layer[{idx}].triangle_templates[{template_idx}].instance_x"),
                &template.instance_x,
            );
            push_scaled_vec(
                &mut output,
                &format!("layer[{idx}].triangle_templates[{template_idx}].instance_y"),
                &template.instance_y,
            );
        }
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

    let vertices = collect_triangle_vertices(&layers[0]);
    for triangle in vertices.chunks_exact(6) {
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
layer[0].triangles.vertices=[10000, 0, 0, 10000, 0, 0, 10000, 10000, 0, 10000, 10000, 0]",
    );
}

#[test]
fn region_arc_is_preserved_for_path_renderer() {
    let layers = parse_gerber(
        "\
%FSLAX24Y24*%
%MOMM*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
M02*",
    )
    .expect("region arc should parse");

    assert_eq!(layers.len(), 1);
    let layer = &layers[0];
    assert!(layer.triangles.vertices.is_empty());
    assert_eq!(layer.path_regions.region_count(), 1);
    assert_eq!(layer.path_regions.wedge_vertex_offsets, vec![0, 9]);
    assert_eq!(layer.path_regions.sector_vertex_offsets, vec![0, 6]);
    assert_eq!(layer.path_regions.cover_vertices.len(), 12);
    assert_eq!(layer.path_regions.clear_vertices.len(), 12);
    assert_approx_eq(layer.boundary.min_x, -1.0);
    assert_approx_eq(layer.boundary.max_x, 1.0);
    assert_approx_eq(layer.boundary.min_y, 0.0);
    assert_approx_eq(layer.boundary.max_y, 1.0);
}

#[test]
fn region_arc_can_be_flattened_for_legacy_triangles() {
    let layers = parse_gerber_with_options(
        "\
%FSLAX24Y24*%
%MOMM*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
M02*",
        false,
        1,
    )
    .expect("flattened region arc should parse");

    assert_eq!(layers.len(), 1);
    assert_eq!(layers[0].path_regions.region_count(), 0);
    assert!(!layers[0].triangles.vertices.is_empty());
}

#[test]
fn region_arc_flattening_quality_controls_tessellation_density() {
    let data = "\
%FSLAX24Y24*%
%MOMM*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
M02*";
    let low_layers = parse_gerber_with_options(data, false, 0)
        .expect("low quality flattened region arc should parse");
    let high_layers = parse_gerber_with_options(data, false, 2)
        .expect("high quality flattened region arc should parse");

    assert!(
        high_layers[0].triangles.vertices.len() > low_layers[0].triangles.vertices.len(),
        "high quality should produce more tessellated triangle vertices than low quality"
    );
}

#[test]
fn aperture_block_region_arc_is_preserved_for_path_renderer() {
    let layers = parse_gerber(
        "\
%FSLAX24Y24*%
%MOMM*%
%ABD10*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
%AB*%
D10*
X000000Y000000D03*
M02*",
    )
    .expect("aperture block arc region should parse");

    assert_eq!(layers.len(), 1);
    assert!(layers[0].triangles.vertices.is_empty());
    assert_eq!(layers[0].path_regions.region_count(), 1);
}

#[test]
fn aperture_block_path_region_flash_transform_is_applied() {
    let layers = parse_gerber(
        "\
%FSLAX24Y24*%
%MOMM*%
%ABD10*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
%AB*%
%LR90*%
D10*
X100000Y200000D03*
M02*",
    )
    .expect("aperture block arc region should transform");

    assert_eq!(layers.len(), 1);
    assert_eq!(layers[0].path_regions.region_count(), 1);
    assert_approx_eq(layers[0].boundary.min_x, 9.0);
    assert_approx_eq(layers[0].boundary.max_x, 10.0);
    assert_approx_eq(layers[0].boundary.min_y, 19.0);
    assert_approx_eq(layers[0].boundary.max_y, 21.0);
}

#[test]
fn path_region_before_flash_preserves_sublayer_order() {
    let layers = parse_gerber(
        "\
%FSLAX24Y24*%
%MOMM*%
%ADD10C,1.0*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
D10*
X030000Y000000D03*
M02*",
    )
    .expect("path region followed by flash should parse");

    assert_eq!(layers.len(), 2);
    assert_eq!(layers[0].path_regions.region_count(), 1);
    assert!(layers[0].circles.x.is_empty());
    assert_eq!(layers[1].path_regions.region_count(), 0);
    assert_eq!(layers[1].circles.x.len(), 1);
}

#[test]
fn flash_before_path_region_preserves_sublayer_order() {
    let layers = parse_gerber(
        "\
%FSLAX24Y24*%
%MOMM*%
%ADD10C,1.0*%
D10*
X-030000Y000000D03*
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
M02*",
    )
    .expect("flash followed by path region should parse");

    assert_eq!(layers.len(), 2);
    assert_eq!(layers[0].circles.x.len(), 1);
    assert_eq!(layers[0].path_regions.region_count(), 0);
    assert!(layers[1].circles.x.is_empty());
    assert_eq!(layers[1].path_regions.region_count(), 1);
}

#[test]
fn path_region_translate_moves_arc_sector_bounds_and_center() {
    let mut layers = parse_gerber(
        "\
%FSLAX24Y24*%
%MOMM*%
G75*
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
G37*
M02*",
    )
    .expect("region arc should parse");

    layers[0].translate(10.0, 20.0);
    let sector = &layers[0].path_regions.sector_vertices;
    assert_approx_eq(sector[0], 9.0);
    assert_approx_eq(sector[1], 20.0);
    assert_approx_eq(sector[2], 10.0);
    assert_approx_eq(sector[3], 20.0);
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
layer[0].circles.radius=[12700, 12700]",
    );
}

#[test]
fn no_hole_apertures_omit_hole_buffers() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,1.0X1.0*%
%ADD11C,1.0*%
D10*
X000000Y000000D03*
D11*
X2000000Y000000D03*
M02*",
    )
    .expect("apertures should parse");

    let triangles = &layers[0].triangles;
    assert!(
        !triangles.vertices.is_empty()
            || layers[0]
                .triangle_templates
                .iter()
                .any(|template| !template.vertices.is_empty())
    );
    assert!(triangles.hole_x.is_empty());
    assert!(triangles.hole_y.is_empty());
    assert!(triangles.hole_radius.is_empty());

    let circles = &layers[0].circles;
    assert_eq!(circles.x.len(), 1);
    assert!(circles.hole_x.is_empty());
    assert!(circles.hole_y.is_empty());
    assert!(circles.hole_radius.is_empty());
}

#[test]
fn apertures_with_holes_keep_hole_buffers() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,1.0X1.0X0.2*%
%ADD11C,1.0X0.2*%
D10*
X000000Y000000D03*
D11*
X2000000Y000000D03*
M02*",
    )
    .expect("apertures should parse");

    let triangles = &layers[0].triangles;
    assert!(!triangles.vertices.is_empty());
    assert_eq!(triangles.hole_x.len(), triangles.vertices.len() / 2);
    assert_eq!(triangles.hole_y.len(), triangles.vertices.len() / 2);
    assert_eq!(triangles.hole_radius.len(), triangles.vertices.len() / 2);
    assert!(triangles.hole_radius.iter().all(|radius| *radius > 0.0));

    let circles = &layers[0].circles;
    assert_eq!(circles.x.len(), 1);
    assert_eq!(circles.hole_x.len(), circles.x.len());
    assert_eq!(circles.hole_y.len(), circles.x.len());
    assert_eq!(circles.hole_radius.len(), circles.x.len());
    assert!(circles.hole_radius.iter().all(|radius| *radius > 0.0));
}

#[test]
fn macro_exposure_off_only_erases_earlier_macro_primitives() {
    let data = "\
%FSLAX26Y26*%
%MOMM*%
%AMCLEARFIRST*
1,0,0.6,0,0,0*
21,1,1.0,1.0,0,0,0*%
%ADD10CLEARFIRST*%
D10*
X000000Y000000D03*
M02*";

    let layers = parse_gerber(data).expect("macro exposure order should parse");
    let vertices = collect_triangle_vertices(&layers[0]);

    // The leading exposure-off circle has no earlier macro solid to erase, so
    // the result is the plain square rather than a square with a circular hole.
    assert_eq!(vertices.len(), 12);
    let (min_x, max_x, min_y, max_y) = triangle_bounds(&vertices);
    assert_approx_eq(min_x, -0.5);
    assert_approx_eq(max_x, 0.5);
    assert_approx_eq(min_y, -0.5);
    assert_approx_eq(max_y, 0.5);
}

#[test]
fn mixed_hole_apertures_are_split_into_separate_sublayers() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0*%
%ADD11C,1.0X0.2*%
D10*
X000000Y000000D03*
D11*
X2000000Y000000D03*
M02*",
    )
    .expect("apertures should parse");

    assert_eq!(layers.len(), 2);

    let plain_circles = &layers[0].circles;
    assert_eq!(plain_circles.x.len(), 1);
    assert!(plain_circles.hole_x.is_empty());
    assert!(plain_circles.hole_y.is_empty());
    assert!(plain_circles.hole_radius.is_empty());

    let holed_circles = &layers[1].circles;
    assert_eq!(holed_circles.x.len(), 1);
    assert_eq!(holed_circles.hole_x.len(), 1);
    assert_eq!(holed_circles.hole_y.len(), 1);
    assert_eq!(holed_circles.hole_radius.len(), 1);
    assert!(holed_circles.hole_radius[0] > 0.0);
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
layer[0].triangle_templates[0].vertices=[5000, 0, 5000, 20000, -5000, 20000, 5000, 0, -5000, 20000, -5000, 0]
layer[0].triangle_templates[0].instance_x=[0]
layer[0].triangle_templates[0].instance_y=[0]",
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
layer[1].negative=true
layer[1].boundary=[90000,110000,-10000,10000]
layer[1].circles.x=[100000]
layer[1].circles.y=[0]
layer[1].circles.radius=[10000]",
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
layer[0].circles.radius=[5000]",
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
layer[0].triangle_templates[0].vertices=[-2000, 8000, -2000, -6000, 0, -9000, 0, 11000, -2000, 8000, 0, -9000]
layer[0].triangle_templates[0].instance_x=[0]
layer[0].triangle_templates[0].instance_y=[0]",
    );
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
    let (min_x, max_x, min_y, max_y) = layer_triangle_bounds(&layers[0]);

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
    let (min_x, max_x, min_y, max_y) = layer_triangle_bounds(&layers[0]);

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
    assert!(!collect_triangle_vertices(&layers[0]).is_empty());
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
fn repeated_triangle_aperture_flashes_use_template_instances() {
    let data = "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,1.0X0.5*%
D10*
X000000Y000000D03*
X2000000Y000000D03*
M02*";

    let layers = parse_gerber(data).expect("rectangle flashes should parse");

    assert_eq!(layers.len(), 1);
    assert!(layers[0].triangles.vertices.is_empty());
    assert_eq!(layers[0].triangle_templates.len(), 1);
    assert_eq!(layers[0].triangle_templates[0].vertices.len(), 12);
    assert_eq!(layers[0].triangle_templates[0].instance_x.len(), 2);
    assert_eq!(layers[0].triangle_templates[0].instance_y.len(), 2);
    assert_approx_eq(layers[0].triangle_templates[0].instance_x[0], 0.0);
    assert_approx_eq(layers[0].triangle_templates[0].instance_x[1], 2.0);
}

#[test]
fn transformed_triangle_aperture_flashes_use_template_instances() {
    let data = "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,1.0X0.5*%
%LR45.0*%
D10*
X000000Y000000D03*
X2000000Y000000D03*
M02*";

    let layers = parse_gerber(data).expect("rotated rectangle flashes should parse");

    assert_eq!(layers.len(), 1);
    assert!(layers[0].triangles.vertices.is_empty());
    assert_eq!(layers[0].triangle_templates.len(), 1);
    assert_eq!(layers[0].triangle_templates[0].vertices.len(), 12);
    assert_eq!(layers[0].triangle_templates[0].instance_x.len(), 2);
    assert_eq!(layers[0].triangle_templates[0].instance_y.len(), 2);
    assert_approx_eq(layers[0].triangle_templates[0].instance_x[0], 0.0);
    assert_approx_eq(layers[0].triangle_templates[0].instance_x[1], 2.0);
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
fn full_circle_arc_preserves_equal_start_end_with_center_offset() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0*%
D10*
G03*
G75*
X1000000Y0000000D02*
X1000000Y0000000I-1000000J0000000D01*
M02*",
    )
    .expect("full-circle arc should parse");
    let layer = &layers[0];

    assert_eq!(layer.arcs.x.len(), 1);
    assert_approx_eq(layer.arcs.x[0], 0.0);
    assert_approx_eq(layer.arcs.y[0], 0.0);
    assert_approx_eq(layer.arcs.radius[0], 1.0);
    assert_approx_eq(layer.arcs.sweep_angle[0], 2.0 * std::f32::consts::PI);
    assert_eq!(layer.circles.x.len(), 2);
    assert!(has_circle_at(&layer.circles, 1.0, 0.0, 0.5));
}

#[test]
fn full_circle_arc_requires_solid_standard_circle_aperture() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,1.0X1.0*%
D10*
G03*
G75*
X1000000Y0000000D02*
X1000000Y0000000I-1000000J0000000D01*
M02*",
    )
    .expect("non-solid full-circle arc should parse without image geometry");

    assert!(layers.is_empty());
}

#[test]
fn linear_draw_requires_solid_standard_circle_aperture() {
    let rectangle_layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,1.0X1.0*%
D10*
X0000000Y0000000D02*
X1000000Y0000000D01*
M02*",
    )
    .expect("rectangle D01 should parse without image geometry");
    assert!(rectangle_layers.is_empty());

    let holed_circle_layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0X0.2*%
D10*
X0000000Y0000000D02*
X1000000Y0000000D01*
M02*",
    )
    .expect("holed circle D01 should parse without image geometry");
    assert!(holed_circle_layers.is_empty());

    let macro_circle_layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%AMCIRC*1,1,1.0,0,0,0*%
%ADD10CIRC*%
D10*
X0000000Y0000000D02*
X1000000Y0000000D01*
M02*",
    )
    .expect("macro circle D01 should parse without image geometry");
    assert!(macro_circle_layers.is_empty());
}

#[test]
fn solid_circle_linear_draw_still_renders_round_caps_and_body() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0*%
D10*
X0000000Y0000000D02*
X1000000Y0000000D01*
M02*",
    )
    .expect("solid circle D01 should parse");
    let layer = &layers[0];

    assert_eq!(layer.circles.x.len(), 2);
    assert!(has_circle_at(&layer.circles, 0.0, 0.0, 0.5));
    assert!(has_circle_at(&layer.circles, 1.0, 0.0, 0.5));
    assert!(layer.triangles.vertices.is_empty());
    assert_eq!(layer.lines.start_x, vec![0.0]);
    assert_eq!(layer.lines.start_y, vec![0.0]);
    assert_eq!(layer.lines.end_x, vec![1.0]);
    assert_eq!(layer.lines.end_y, vec![0.0]);
    assert_eq!(layer.lines.width, vec![1.0]);
}

#[test]
fn zero_width_solid_circle_draw_does_not_create_line_body() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,0.0*%
D10*
X0000000Y0000000D02*
X1000000Y0000000D01*
M02*",
    )
    .expect("zero-width solid circle D01 should parse");

    assert!(layers.is_empty());
}

#[test]
fn zero_length_solid_circle_draw_matches_single_flash_image() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,1.0*%
D10*
X0000000Y0000000D02*
X0000000Y0000000D01*
M02*",
    )
    .expect("zero-length solid circle D01 should parse");
    let layer = &layers[0];

    assert_eq!(layer.circles.x.len(), 1);
    assert!(has_circle_at(&layer.circles, 0.0, 0.0, 0.5));
    assert!(layer.triangles.vertices.is_empty());
    assert!(layer.lines.start_x.is_empty());
}

#[test]
fn zero_length_non_solid_draw_matches_flash_image() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,1.0X1.0*%
D10*
X0000000Y0000000D02*
X0000000Y0000000D01*
M02*",
    )
    .expect("zero-length rectangle D01 should parse");

    assert_eq!(layers.len(), 1);
    assert!(layers[0].triangles.vertices.is_empty());
    assert_eq!(layers[0].triangle_templates.len(), 1);
    let vertices = collect_triangle_vertices(&layers[0]);
    assert_eq!(vertices.len(), 12);
    let (min_x, max_x, min_y, max_y) = triangle_bounds(&vertices);
    assert_approx_eq(min_x, -0.5);
    assert_approx_eq(max_x, 0.5);
    assert_approx_eq(min_y, -0.5);
    assert_approx_eq(max_y, 0.5);
}

#[test]
fn transformed_zero_length_non_solid_draw_uses_template_instance() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,1.0X1.0*%
%LR45.0*%
D10*
X0000000Y0000000D02*
X0000000Y0000000D01*
M02*",
    )
    .expect("rotated zero-length rectangle D01 should parse");

    assert_eq!(layers.len(), 1);
    assert!(layers[0].triangles.vertices.is_empty());
    assert_eq!(layers[0].triangle_templates.len(), 1);
    let vertices = collect_triangle_vertices(&layers[0]);
    assert_eq!(vertices.len(), 12);
    let (min_x, max_x, min_y, max_y) = triangle_bounds(&vertices);
    let expected_extent = std::f32::consts::FRAC_1_SQRT_2;
    assert_approx_eq(min_x, -expected_extent);
    assert_approx_eq(max_x, expected_extent);
    assert_approx_eq(min_y, -expected_extent);
    assert_approx_eq(max_y, expected_extent);
}

#[test]
fn degenerate_triangle_apertures_do_not_create_template_instances() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10R,0.0X1.0*%
D10*
X0000000Y0000000D03*
M02*",
    )
    .expect("degenerate rectangle aperture should parse");

    assert!(layers.is_empty());
}

#[test]
fn invalid_thermal_macro_is_filtered_before_render_buffers() {
    let layers = parse_gerber(
        "\
%FSLAX26Y26*%
%MOMM*%
%AMBADTHERM*7,0,0,1.0,-0.2,0.1,0*%
%ADD10BADTHERM*%
D10*
X0000000Y0000000D03*
M02*",
    )
    .expect("invalid thermal macro should parse");

    assert!(layers.is_empty());
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
    let (min_x, max_x, min_y, max_y) = layer_triangle_bounds(&layers[0]);

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
