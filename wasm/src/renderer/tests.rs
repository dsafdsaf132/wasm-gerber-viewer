
use super::*;
use crate::parser::GerberParser;

fn outline_line(start: [f32; 2], end: [f32; 2]) -> OutlineSegment {
    OutlineSegment {
        start,
        end,
        points: vec![start, end],
        segment: RegionSegment::Line { start, end },
    }
}

fn empty_gerber_data(boundary: Boundary, is_negative: bool) -> GerberData {
    GerberData::new(
        Triangles::new(Vec::new(), Vec::new(), Vec::new(), Vec::new()),
        Vec::new(),
        Lines::new(Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new()),
        Circles::new(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ),
        Arcs::new(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ),
        Thermals::new(
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ),
        PathRegions::empty(),
        boundary,
        is_negative,
    )
}

fn parse_gerber_with_source_contours(data: &str) -> Vec<GerberData> {
    let mut parser = GerberParser::with_options(true, 1);
    parser.preserve_region_source_contours = true;
    parser
        .parse(data)
        .expect("Gerber with source contours should parse")
}

#[test]
fn validate_offsets_rejects_nonzero_initial_offset() {
    assert!(Renderer::validate_offsets_invariant("path wedge offsets", 0, &[0, 9], 9).is_ok());
    assert!(Renderer::validate_offsets_invariant("path wedge offsets", 0, &[1, 9], 9).is_err());
    assert!(Renderer::validate_offsets_invariant("path sector offsets", 0, &[2, 6], 6).is_err());
    assert!(Renderer::validate_offsets_invariant("path sector offsets", 0, &[0, 5], 7).is_err());
}

#[test]
fn validate_path_region_data_accepts_normalized_empty_offsets() {
    let path_regions = PathRegions::new(vec![], vec![], vec![], vec![], vec![], vec![]);
    assert_eq!(path_regions.wedge_vertex_offsets, vec![0]);
    assert_eq!(path_regions.sector_vertex_offsets, vec![0]);
    assert!(Renderer::validate_path_region_data(&path_regions, 0).is_ok());
}

#[test]
fn validate_path_region_data_accepts_five_float_sector_vertices() {
    let path_regions = PathRegions::new(
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![0, 3],
        vec![
            1.0, 0.0, 0.0, 0.0, 1.0, //
            0.0, 1.0, 0.0, 0.0, 1.0, //
            2.0, 2.0, 0.0, 0.0, 1.0,
        ],
        vec![0, 3],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
    );

    assert!(Renderer::validate_path_region_data(&path_regions, 0).is_ok());
}

#[test]
fn validate_path_region_data_rejects_legacy_sector_stride() {
    let path_regions = PathRegions::new(
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![0, 3],
        vec![
            1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.5708, //
            0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.5708, //
            2.0, 2.0, 0.0, 0.0, 1.0, 0.0, 1.5708,
        ],
        vec![0, 3],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
    );

    assert!(Renderer::validate_path_sector_vertices_invariant(&path_regions, 0).is_err());
}

#[test]
fn validate_path_region_data_rejects_negative_sector_radius() {
    let path_regions = PathRegions::new(
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![0, 3],
        vec![1.0, 0.0, 0.0, 0.0, -1.0],
        vec![0, 1],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
    );

    assert!(Renderer::validate_path_sector_vertices_invariant(&path_regions, 0).is_err());
}

#[test]
fn validate_path_region_data_rejects_stale_sector_offsets() {
    assert!(Renderer::validate_offsets_invariant("path sector offsets", 0, &[0, 5], 7).is_err());
}

#[test]
fn closed_outline_regions_preserve_multiple_contours() {
    let segments = vec![
        outline_line([0.0, 0.0], [10.0, 0.0]),
        outline_line([10.0, 0.0], [10.0, 10.0]),
        outline_line([10.0, 10.0], [0.0, 10.0]),
        outline_line([0.0, 10.0], [0.0, 0.0]),
        outline_line([3.0, 3.0], [7.0, 3.0]),
        outline_line([7.0, 3.0], [7.0, 7.0]),
        outline_line([7.0, 7.0], [3.0, 7.0]),
        outline_line([3.0, 7.0], [3.0, 3.0]),
    ];

    let contours = Renderer::closed_outline_regions(&segments);
    assert_eq!(contours.len(), 2);
    let boundary = Renderer::outline_regions_boundary(&contours).expect("finite boundary");
    assert!((boundary.min_x() - 0.0).abs() < 0.0001);
    assert!((boundary.max_x() - 10.0).abs() < 0.0001);
    assert!((boundary.min_y() - 0.0).abs() < 0.0001);
    assert!((boundary.max_y() - 10.0).abs() < 0.0001);
}

#[test]
fn closed_outline_regions_accept_arc_only_circle() {
    let center = [5.0, 5.0];
    let radius = 2.0;
    let start_angle = 0.0;
    let sweep_angle = std::f32::consts::PI * 2.0;
    let points = Renderer::outline_arc_points(center, radius, start_angle, sweep_angle);
    let start = points[0];
    let end = *points.last().expect("arc endpoint");
    let segments = vec![OutlineSegment {
        start,
        end,
        points,
        segment: RegionSegment::Arc {
            start,
            end,
            center,
            radius,
            start_angle,
            sweep_angle,
            clamp_sweep: false,
        },
    }];

    let contours = Renderer::closed_outline_regions(&segments);
    assert_eq!(contours.len(), 1);
    assert!(contours[0].has_arc);
    assert!(contours[0].points.len() >= 4);
    let boundary = Renderer::outline_regions_boundary(&contours).expect("finite boundary");
    assert!((boundary.min_x() - 3.0).abs() < 0.0001);
    assert!((boundary.max_x() - 7.0).abs() < 0.0001);
    assert!((boundary.min_y() - 3.0).abs() < 0.0001);
    assert!((boundary.max_y() - 7.0).abs() < 0.0001);
}

#[test]
fn outline_region_boundary_uses_canonical_arc_bounds() {
    let mut contour = RegionContour::default();
    contour
        .push_arc(
            [1.0, 0.0],
            [0.0, 1.0],
            [0.25, 0.0],
            0.75,
            0.0,
            std::f32::consts::FRAC_PI_2,
        )
        .expect("arc contour should build");

    let boundary = Renderer::outline_regions_boundary(&[contour]).expect("finite boundary");

    assert!((boundary.min_x() - 0.0).abs() < 0.0001);
    assert!((boundary.min_y() - 0.0).abs() < 0.0001);
    assert!(boundary.max_x() > 1.001);
    assert!(boundary.max_y() > 1.001);
}

#[test]
fn outside_clip_layer_covers_target_overflow() {
    let fill_bounds = Boundary::new(0.0, 10.0, 0.0, 10.0);
    let fill_contours = vec![Renderer::bounds_region_contour(&fill_bounds).unwrap()];
    let target = empty_gerber_data(Boundary::new(-2.0, 12.0, -3.0, 11.0), false);

    let clip = Renderer::outside_clip_layer(&fill_contours, &fill_bounds, &[target]).unwrap();

    assert!(clip.is_negative);
    assert!(clip.path_regions.has_geometry());
    assert_eq!(clip.path_regions.region_count(), 1);
    assert!((clip.boundary.min_x() + 2.0).abs() < 0.0001);
    assert!((clip.boundary.max_x() - 12.0).abs() < 0.0001);
    assert!((clip.boundary.min_y() + 3.0).abs() < 0.0001);
    assert!((clip.boundary.max_y() - 11.0).abs() < 0.0001);
}

#[test]
fn region_outline_fill_uses_source_region_contours() {
    let outline_data = "\
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
    let default_layers = GerberParser::with_options(true, 1)
        .parse(outline_data)
        .expect("default region outline should parse");
    assert!(!default_layers[0].path_regions.has_source_contours());

    let outline_layers = parse_gerber_with_source_contours(
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
    );

    assert_eq!(outline_layers.len(), 1);
    assert!(!outline_layers[0].path_regions.has_geometry());
    assert!(outline_layers[0].path_regions.has_source_contours());

    let (fill_layers, fill_contours) = Renderer::region_outline_fill_layers(&outline_layers)
        .expect("region outline fill should build")
        .expect("region outline source should be used");

    assert_eq!(fill_layers.len(), 1);
    assert!(!fill_layers[0].is_negative);
    assert!(fill_layers[0].path_regions.has_geometry());
    assert_eq!(fill_layers[0].path_regions.region_count(), 1);
    assert_eq!(fill_contours.len(), 1);
}

#[test]
fn region_outline_fill_preserves_source_sublayer_polarity() {
    let outline_layers = parse_gerber_with_source_contours(
        "\
%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X000000Y000000D02*
G01*
X020000Y000000D01*
X020000Y020000D01*
X000000Y020000D01*
G37*
%LPC*%
G36*
X005000Y005000D02*
G01*
X015000Y005000D01*
X015000Y015000D01*
X005000Y015000D01*
G37*
M02*",
    );

    assert_eq!(outline_layers.len(), 2);
    assert!(outline_layers
        .iter()
        .all(|layer| layer.path_regions.has_source_contours()));

    let (fill_layers, fill_contours) = Renderer::region_outline_fill_layers(&outline_layers)
        .expect("region outline fill should build")
        .expect("region outline source should be used");

    assert_eq!(fill_layers.len(), 2);
    assert!(!fill_layers[0].is_negative);
    assert!(fill_layers[1].is_negative);
    assert_eq!(fill_contours.len(), 2);

    let fill_boundary =
        fill_layers_boundary(&fill_layers).expect("fill layer boundary should be finite");
    let clip_layer = Renderer::outside_clip_layer(&fill_contours, &fill_boundary, &[])
        .expect("outside clip should be built from all source contours");
    assert!(clip_layer.is_negative);
    assert!(clip_layer.path_regions.has_geometry());
}

#[test]
fn region_outline_fill_preserves_arc_source_contours() {
    let outline_layers = parse_gerber_with_source_contours(
        "\
%FSLAX24Y24*%
%MOMM*%
G75*
%LPD*%
G36*
X010000Y000000D02*
G03*
X-010000Y000000I-010000J000000D01*
X010000Y000000I010000J000000D01*
G37*
M02*",
    );

    assert_eq!(outline_layers.len(), 1);
    assert!(outline_layers[0].path_regions.has_geometry());
    assert!(outline_layers[0].path_regions.has_source_contours());

    let (fill_layers, fill_contours) = Renderer::region_outline_fill_layers(&outline_layers)
        .expect("arc region outline fill should build")
        .expect("arc region outline source should be used");

    assert_eq!(fill_layers.len(), 1);
    assert!(fill_contours.iter().any(|contour| contour.has_arc));
    assert!(!fill_layers[0].path_regions.wedge_vertices.is_empty());
    assert!(!fill_layers[0].path_regions.sector_vertices.is_empty());
}

#[test]
fn region_source_contours_survive_following_draw_geometry() {
    let layers = parse_gerber_with_source_contours(
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
%ADD10C,0.100*%
D10*
X020000Y000000D02*
X030000Y000000D01*
M02*",
    );

    assert_eq!(layers.len(), 1);
    assert!(layers[0].path_regions.has_source_contours());
    assert!(!layers[0].lines.start_x.is_empty());
}

#[test]
fn inverted_outline_fill_prefers_closed_aperture_outline_over_region_source() {
    let outline_layers = parse_gerber_with_source_contours(
        "\
%FSLAX24Y24*%
%MOMM*%
%ADD10C,0.100*%
D10*
X000000Y000000D02*
X040000Y000000D01*
X040000Y040000D01*
X000000Y040000D01*
X000000Y000000D01*
%LPD*%
G36*
X010000Y010000D02*
G01*
X020000Y010000D01*
X020000Y020000D01*
X010000Y020000D01*
G37*
M02*",
    );

    let (fill_layers, fill_contours) = Renderer::inverted_outline_fill_layers(&outline_layers)
        .expect("mixed outline source should build fill");

    assert_eq!(fill_layers.len(), 1);
    assert_eq!(fill_contours.len(), 1);
    assert!((fill_layers[0].boundary.min_x() - 0.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.max_x() - 4.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.min_y() - 0.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.max_y() - 4.0).abs() < 0.0001);
}

#[test]
fn inverted_outline_fill_uses_zero_width_aperture_lines() {
    let outline_layers = parse_gerber_with_source_contours(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,0.0*%
D10*
X0000000Y0000000D02*
X1000000Y0000000D01*
X1000000Y1000000D01*
X0000000Y1000000D01*
X0000000Y0000000D01*
M02*",
    );

    let (fill_layers, fill_contours) = Renderer::inverted_outline_fill_layers(&outline_layers)
        .expect("zero-width line outline should build fill");

    assert_eq!(fill_layers.len(), 1);
    assert_eq!(fill_contours.len(), 1);
    assert!((fill_layers[0].boundary.min_x() - 0.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.max_x() - 1.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.min_y() - 0.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.max_y() - 1.0).abs() < 0.0001);
}

#[test]
fn inverted_outline_fill_uses_zero_width_aperture_arcs() {
    let outline_layers = parse_gerber_with_source_contours(
        "\
%FSLAX26Y26*%
%MOMM*%
%ADD10C,0.0*%
D10*
G03*
G75*
X1000000Y0000000D02*
X1000000Y0000000I-1000000J0000000D01*
M02*",
    );

    let (fill_layers, fill_contours) = Renderer::inverted_outline_fill_layers(&outline_layers)
        .expect("zero-width arc outline should build fill");

    assert_eq!(fill_layers.len(), 1);
    assert_eq!(fill_contours.len(), 1);
    assert!(fill_contours[0].has_arc);
    assert!((fill_layers[0].boundary.min_x() + 1.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.max_x() - 1.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.min_y() + 1.0).abs() < 0.0001);
    assert!((fill_layers[0].boundary.max_y() - 1.0).abs() < 0.0001);
}
