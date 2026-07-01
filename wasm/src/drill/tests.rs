use super::{default_coordinate_format, parse_drill_with_offset, parse_repeat_hole, Unit};

fn assert_approx_eq(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() < 0.0001,
        "expected {expected}, got {actual}"
    );
}

#[test]
fn parses_xnc_drill_hits_and_metadata() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.6
T02C0.8
%
G05
T01
X9.01Y3.3375
X9.01Y4.3125
T02
X8.01Y4.8
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("XNC drill file should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 3);
    assert_eq!(parsed.metadata.hit_count, 3);
    assert_eq!(parsed.metadata.tools.len(), 2);
    assert_approx_eq(parsed.fill_layer.circles.radius[0], 0.3);
    assert_approx_eq(parsed.outline_layer.circles.radius[0], 0.35);
}

#[test]
fn parses_xnc_linear_rout_as_slot() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
G00X8.01Y3.825
M15
G01X6.54Y3.825
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("XNC rout file should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 2);
    assert_eq!(parsed.outline_layer.circles.x.len(), 2);
    assert_eq!(parsed.outline_layer.arcs.x.len(), 0);
    assert_approx_eq(parsed.outline_layer.circles.radius[0], 0.45);
    assert_approx_eq(parsed.outline_layer.circles.radius[1], 0.45);
    assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.lines.width[0], 0.8);
    assert_approx_eq(parsed.outline_layer.lines.width[0], 0.9);
}

#[test]
fn parses_g85_as_slot_from_current_position() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
X1.0Y2.0
G85X4.0Y2.0
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("G85 slot command should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 3);
    assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
    assert_eq!(parsed.metadata.hit_count, 1);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.lines.start_x[0], 1.0);
    assert_approx_eq(parsed.fill_layer.lines.start_y[0], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[0], 4.0);
    assert_approx_eq(parsed.fill_layer.lines.end_y[0], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.width[0], 0.8);
}

#[test]
fn parses_inline_g85_start_and_end_coordinates() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
G85X1.0Y2.0X4.0Y2.0
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Inline G85 slot endpoints should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 2);
    assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
    assert_eq!(parsed.metadata.hit_count, 0);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.lines.start_x[0], 1.0);
    assert_approx_eq(parsed.fill_layer.lines.start_y[0], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[0], 4.0);
    assert_approx_eq(parsed.fill_layer.lines.end_y[0], 2.0);
}

#[test]
fn parses_embedded_g85_start_and_end_coordinates() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
X1.0Y2.0G85X4.0Y2.0
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Embedded G85 slot endpoints should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 2);
    assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
    assert_eq!(parsed.metadata.hit_count, 0);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.lines.start_x[0], 1.0);
    assert_approx_eq(parsed.fill_layer.lines.start_y[0], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[0], 4.0);
    assert_approx_eq(parsed.fill_layer.lines.end_y[0], 2.0);
}

#[test]
fn parses_embedded_g85_with_omitted_axes() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
Y2.0G85X4.0Y3.0
Y5.0G85X6.0
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Embedded G85 omitted axes should parse from the G85 split point");

    assert_eq!(parsed.fill_layer.lines.start_x.len(), 2);
    assert_eq!(parsed.metadata.slot_count, 2);
    assert_approx_eq(parsed.fill_layer.lines.start_x[0], 0.0);
    assert_approx_eq(parsed.fill_layer.lines.start_y[0], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[0], 4.0);
    assert_approx_eq(parsed.fill_layer.lines.end_y[0], 3.0);
    assert_approx_eq(parsed.fill_layer.lines.start_x[1], 4.0);
    assert_approx_eq(parsed.fill_layer.lines.start_y[1], 5.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[1], 6.0);
    assert_approx_eq(parsed.fill_layer.lines.end_y[1], 5.0);
}

#[test]
fn parses_short_g_rout_commands_as_slot() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
G0X8.01Y3.825
M15
G1X6.54Y3.825
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Short Excellon rout commands should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 2);
    assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
    assert_eq!(parsed.metadata.hit_count, 0);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.lines.start_x[0], 8.01);
    assert_approx_eq(parsed.fill_layer.lines.end_x[0], 6.54);
}

#[test]
fn accepts_g54_prefixed_tool_selection() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.6
%
G54T01
X9.0Y3.0
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("G54-prefixed tool selection should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 1);
    assert_eq!(parsed.metadata.hit_count, 1);
    assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
}

#[test]
fn accepts_tool_selection_with_feed_and_speed_words() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.6
T02C1.2
%
T02F200S61
X9.0Y3.0
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Tool selection with feed and speed words should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 1);
    assert_eq!(parsed.metadata.hit_count, 1);
    assert_approx_eq(parsed.fill_layer.circles.radius[0], 0.6);
}

#[test]
fn rejects_malformed_tool_selection_suffixes() {
    for selection in ["T02F", "T02Q1", "G54T02F", "T02F+", "T02S."] {
        assert!(
            super::parse_tool_selection(selection).is_err(),
            "malformed tool selection `{selection}` should fail"
        );
    }
}

#[test]
fn preserves_modal_rout_coordinate_moves() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
G00X1.0Y1.0
M15
G01X2.0Y1.0
X3.0Y1.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Modal coordinate-only rout move should parse as a slot");

    assert_eq!(parsed.fill_layer.circles.x.len(), 4);
    assert_eq!(parsed.fill_layer.lines.start_x.len(), 2);
    assert_eq!(parsed.metadata.hit_count, 0);
    assert_eq!(parsed.metadata.slot_count, 2);
    assert_approx_eq(parsed.fill_layer.lines.start_x[0], 1.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[0], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.start_x[1], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[1], 3.0);
}

#[test]
fn preserves_modal_arc_rout_coordinate_moves() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C1.0
%
T01
G00X10.0Y0.0
M15
G03X0.0Y10.0I-10.0J0.0
X-10.0Y0.0I0.0J-10.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Modal coordinate-only arc rout move should parse as an arc");

    assert_eq!(parsed.fill_layer.lines.start_x.len(), 0);
    assert_eq!(parsed.fill_layer.arcs.x.len(), 2);
    assert_eq!(parsed.metadata.hit_count, 0);
    assert_eq!(parsed.metadata.slot_count, 2);
    assert_approx_eq(parsed.fill_layer.arcs.x[1], 0.0);
    assert_approx_eq(parsed.fill_layer.arcs.y[1], 0.0);
}

#[test]
fn preserves_modal_arc_definition_for_coordinate_only_rout() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C1.0
%
T01
G00X10.0Y0.0
M15
G03I-10.0J0.0
X0.0Y10.0
X-10.0Y0.0I0.0J-10.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Modal arc definition should apply to coordinate-only rout moves");

    assert_eq!(parsed.fill_layer.lines.start_x.len(), 0);
    assert_eq!(parsed.fill_layer.arcs.x.len(), 2);
    assert_eq!(parsed.metadata.hit_count, 0);
    assert_eq!(parsed.metadata.slot_count, 2);
    assert_approx_eq(parsed.fill_layer.arcs.x[0], 0.0);
    assert_approx_eq(parsed.fill_layer.arcs.y[0], 0.0);
    assert_approx_eq(parsed.fill_layer.arcs.x[1], 0.0);
    assert_approx_eq(parsed.fill_layer.arcs.y[1], 0.0);
}

#[test]
fn updates_modal_arc_definition_without_endpoint() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C1.0
%
T01
G00X10.0Y0.0
M15
G03I-10.0J0.0
I-10.0J0.0
X0.0Y10.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Arc definition-only rout records should update modal state");

    assert_eq!(parsed.fill_layer.lines.start_x.len(), 0);
    assert_eq!(parsed.fill_layer.arcs.x.len(), 1);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.arcs.x[0], 0.0);
    assert_approx_eq(parsed.fill_layer.arcs.y[0], 0.0);
}

#[test]
fn stores_arc_definition_before_arc_interpolation() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C1.0
%
T01
G00X0.0Y0.0
M15
A1.0
G03X1.0Y1.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Arc definition-only records should be modal before G03");

    assert_eq!(parsed.fill_layer.lines.start_x.len(), 0);
    assert_eq!(parsed.fill_layer.arcs.x.len(), 1);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.arcs.radius[0], 1.0);
}

#[test]
fn merges_partial_modal_arc_center_offsets() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C1.0
%
T01
G00X0.0Y10.0
M15
G03I0.0J-10.0
X-10.0Y0.0I0.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Partial modal I/J updates should retain the omitted companion word");

    assert_eq!(parsed.fill_layer.lines.start_x.len(), 0);
    assert_eq!(parsed.fill_layer.arcs.x.len(), 1);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.arcs.x[0], 0.0);
    assert_approx_eq(parsed.fill_layer.arcs.y[0], 0.0);
}

#[test]
fn routes_g01_after_m15_without_prior_g00() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
M15
G01X2.0Y1.0
X3.0Y1.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("G01 after M15 should start a routed slot");

    assert_eq!(parsed.fill_layer.circles.x.len(), 4);
    assert_eq!(parsed.fill_layer.lines.start_x.len(), 2);
    assert_eq!(parsed.metadata.hit_count, 0);
    assert_eq!(parsed.metadata.slot_count, 2);
    assert_approx_eq(parsed.fill_layer.lines.start_x[0], 0.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[0], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.start_x[1], 2.0);
    assert_approx_eq(parsed.fill_layer.lines.end_x[1], 3.0);
}

#[test]
fn incremental_coordinates_keep_omitted_axis_current() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.6
%
T01
X10.0Y10.0
G91
X1.0
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Incremental omitted axes should preserve current coordinate");

    assert_eq!(parsed.fill_layer.circles.x.len(), 2);
    assert_approx_eq(parsed.fill_layer.circles.x[0], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.x[1], 11.0);
    assert_approx_eq(parsed.fill_layer.circles.y[1], 10.0);
}

#[test]
fn honors_ici_incremental_coordinate_mode() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
ICI,ON
T01C0.6
%
T01
X10.0Y10.0
X1.0Y0.0
ICI,OFF
X1.0Y0.0
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("ICI incremental coordinate mode should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 3);
    assert_approx_eq(parsed.fill_layer.circles.x[0], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.x[1], 11.0);
    assert_approx_eq(parsed.fill_layer.circles.y[1], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.x[2], 1.0);
    assert_approx_eq(parsed.fill_layer.circles.y[2], 0.0);
}

#[test]
fn treats_t00_as_tool_unload() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.6
%
T01
X9.0Y3.0
T00
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("T00 should unload the current drill tool");

    assert_eq!(parsed.fill_layer.circles.x.len(), 1);
    assert_eq!(parsed.metadata.hit_count, 1);
}

#[test]
fn honors_included_leading_zero_metric_coordinates() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC,LZ
T01C0.6
%
T01
X009Y010
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("METRIC,LZ omitted-decimal coordinates should parse");

    assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
    assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
}

#[test]
fn honors_included_trailing_zero_metric_coordinates() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC,TZ
T01C0.6
%
T01
X009Y010
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("METRIC,TZ omitted-decimal coordinates should parse");

    assert_approx_eq(parsed.fill_layer.circles.x[0], 0.009);
    assert_approx_eq(parsed.fill_layer.circles.y[0], 0.010);
}

#[test]
fn honors_standalone_zero_suppression_commands() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
LZ
T01C0.6
%
T01
X009Y010
TZ
X011Y012
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Standalone zero-suppression commands should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 2);
    assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
    assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.x[1], 0.011);
    assert_approx_eq(parsed.fill_layer.circles.y[1], 0.012);
}

#[test]
fn honors_file_format_precision_comments() {
    let parsed = parse_drill_with_offset(
        "\
M48
;FILE_FORMAT=4:4
METRIC,LZ
T01C0.6
%
T01
X00090000Y00100000
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("FILE_FORMAT comment should set coordinate precision");

    assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
    assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
}

#[test]
fn parses_repeat_hole_records() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC,LZ
T01C0.6
%
T01
X009Y010
R3X001Y000
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Repeat-hole records should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 4);
    assert_eq!(parsed.metadata.hit_count, 4);
    assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
    assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.x[1], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.y[1], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.x[2], 11.0);
    assert_approx_eq(parsed.fill_layer.circles.y[2], 10.0);
    assert_approx_eq(parsed.fill_layer.circles.x[3], 12.0);
    assert_approx_eq(parsed.fill_layer.circles.y[3], 10.0);
}

#[test]
fn rejects_unsupported_repeat_pattern_records() {
    let error = parse_repeat_hole(
        "R2M02X001Y001",
        Unit::Metric,
        default_coordinate_format(Unit::Metric),
    )
    .expect_err("Repeat-pattern records should not be treated as repeat holes");

    assert!(error.contains("requires X or Y spacing"));
}

#[test]
fn rejects_repeat_hole_counts_over_four_digits() {
    let error = parse_repeat_hole(
        "R10000X001Y000",
        Unit::Metric,
        default_coordinate_format(Unit::Metric),
    )
    .expect_err("Repeat-hole counts should be limited");

    assert!(error.contains("1 to 4 digits"));
}

#[test]
fn ignores_fmat_and_preserves_zero_format_after_m71() {
    let parsed = parse_drill_with_offset(
        "\
M48
FMAT,2
METRIC,LZ
T01C0.6
%
M71
T01
X009Y010
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("LibrePCB-style drill header should parse");

    assert_eq!(parsed.fill_layer.circles.x.len(), 1);
    assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
    assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
}

#[test]
fn parses_xnc_circular_rout_as_arc() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C0.8
%
T01
G00X5.05Y2.6
M15
G03X6.0Y1.6A1.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("XNC circular rout should parse as analytic arc");

    assert_eq!(parsed.fill_layer.lines.start_x.len(), 0);
    assert_eq!(parsed.fill_layer.arcs.x.len(), 1);
    assert_eq!(parsed.metadata.slot_count, 1);
    assert_approx_eq(parsed.fill_layer.arcs.radius[0], 1.0);
    assert_approx_eq(parsed.fill_layer.arcs.thickness[0], 0.8);
}

#[test]
fn routed_arc_bounds_follow_sweep() {
    let parsed = parse_drill_with_offset(
        "\
M48
METRIC
T01C1.0
%
T01
G00X10.0Y0.0
M15
G03X0.0Y10.0I-10.0J0.0
M16
M30",
        0.05,
        0.0,
        0.0,
    )
    .expect("Routed arc should parse");

    assert_eq!(parsed.fill_layer.arcs.x.len(), 1);
    assert_approx_eq(parsed.fill_layer.boundary.min_x, -0.5);
    assert_approx_eq(parsed.fill_layer.boundary.max_x, 10.5);
    assert_approx_eq(parsed.fill_layer.boundary.min_y, -0.5);
    assert_approx_eq(parsed.fill_layer.boundary.max_y, 10.5);
}
