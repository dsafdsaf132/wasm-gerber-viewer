
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
fn highlight_clear_features_follow_selected_dark_feature() {
    let mut layer = InteractionLayer::new();
    layer.push(circle_feature(0.0, 1.0, Polarity::Negative));
    layer.push(circle_feature(0.0, 2.0, Polarity::Positive));
    layer.push(circle_feature(0.0, 0.5, Polarity::Negative));
    layer.push(circle_feature(10.0, 0.5, Polarity::Negative));
    layer.push(circle_feature(0.0, 0.5, Polarity::Positive));

    let clear_features = layer.following_clear_features_for_highlight(1);

    assert_eq!(clear_features.len(), 1);
    assert_eq!(clear_features[0].descriptor.polarity, Polarity::Negative);
    assert!((clear_features[0].bounds.max_x() - 0.5).abs() < 0.0001);
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

    assert!(region.descriptor.aperture_type.is_none());
    assert!(drill.descriptor.aperture_type.is_none());
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

#[test]
fn negative_coverage_batches_preserve_aperture_holes() {
    let feature = InteractionFeature::from_primitives(
        FeatureKind::Flash,
        Some("D10".to_string()),
        Some("circle".to_string()),
        None,
        Polarity::Negative,
        vec![Primitive::Circle {
            x: 0.0,
            y: 0.0,
            radius: 2.0,
            exposure: 0.0,
            hole_x: 0.0,
            hole_y: 0.0,
            hole_radius: 0.5,
        }],
        FeatureProperties::default(),
    )
    .expect("negative circle feature should have bounds");

    let batches = feature.coverage_batches();

    assert_eq!(batches.len(), 2);
    assert!(!batches[0].clear);
    assert!(batches[1].clear);
}

#[test]
fn path_region_feature_bounds_can_use_conservative_render_bounds() {
    let mut full_path_regions = PathRegions::new(
        vec![],
        vec![0, 0],
        vec![],
        vec![0, 0],
        vec![
            -1.0, 0.0, 1.0, 0.0, -1.0, 1.0, -1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
        ],
        vec![
            -1.0, 0.0, 1.0, 0.0, -1.0, 1.0, -1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
        ],
    );
    full_path_regions.pick_contours =
        vec![vec![vec![[-1.0, 0.0], [1.0, 0.0], [0.0, 0.8], [-1.0, 0.0]]]];
    let bounds = InteractionFeature::bounds_for_geometry(&[], &full_path_regions)
        .expect("full path region should have conservative bounds");

    let feature = InteractionFeature::from_geometry_with_bounds(
        FeatureKind::Region,
        None,
        None,
        None,
        Polarity::Positive,
        Vec::new(),
        full_path_regions.clone_for_interaction_pick(),
        Some(PathRegionRef {
            sublayer_idx: 0,
            region_start: 0,
            region_count: 1,
        }),
        bounds,
        FeatureProperties::default(),
    );

    assert_eq!(feature.bounds.max_y(), 1.0);
    let stored_path_regions = feature
        .path_regions
        .as_deref()
        .expect("pick contour should be retained");
    assert!(stored_path_regions.cover_vertices.is_empty());
    assert_eq!(stored_path_regions.pick_contours[0][0][2], [0.0, 0.8]);
}

#[test]
fn compact_path_region_validation_rejects_negative_sector_radius() {
    let path_regions = PathRegions::new(
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        vec![0, 3],
        vec![1.0, 0.0, 0.0, 0.0, -1.0],
        vec![0, 1],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
        vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0],
    );

    assert!(validate_compact_path_region_invariant(&path_regions).is_err());
}

#[test]
fn compact_pick_offsets_require_canonical_ranges() {
    assert!(validate_compact_pick_offsets_invariant(&[0, 1], &[0, 3], 3).is_ok());
    assert!(validate_compact_pick_offsets_invariant(&[1, 1], &[0, 3], 3).is_err());
    assert!(validate_compact_pick_offsets_invariant(&[0, 2], &[0, 3], 3).is_err());
    assert!(validate_compact_pick_offsets_invariant(&[0, 1], &[1, 3], 3).is_err());
    assert!(validate_compact_pick_offsets_invariant(&[0, 1], &[0, 4], 3).is_err());
}

#[test]
fn compact_path_region_refs_are_sparse_and_reject_duplicates() {
    let refs = compact_path_region_refs_from_parts_invariant(&[2], &[4, 5, 6], 4)
        .expect("sparse path region refs should parse");

    assert_eq!(refs[0], None);
    assert_eq!(
        refs[2],
        Some(PathRegionRef {
            sublayer_idx: 4,
            region_start: 5,
            region_count: 6,
        })
    );
    assert!(
        compact_path_region_refs_from_parts_invariant(&[2, 2], &[4, 5, 6, 7, 8, 9], 4).is_err()
    );
    assert!(compact_path_region_refs_from_parts_invariant(&[4], &[4, 5, 6], 4).is_err());
    assert!(compact_path_region_refs_from_parts_invariant(&[1], &[4, 5], 4).is_err());
}
