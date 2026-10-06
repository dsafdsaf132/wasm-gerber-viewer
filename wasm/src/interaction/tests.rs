use super::*;

#[test]
fn compact_single_primitive_decodes_directly_into_retained_storage() {
    let primitives = vec![
        Primitive::Circle {
            x: 0.3,
            y: -0.2,
            radius: 0.5,
            exposure: 1.0,
            hole_x: 0.1,
            hole_y: -0.1,
            hole_radius: 0.05,
        },
        Primitive::Arc {
            x: 0.3,
            y: -0.2,
            radius: 0.7,
            start_angle: -0.4,
            end_angle: 2.1,
            thickness: 0.15,
            exposure: 1.0,
        },
        Primitive::Thermal {
            x: 0.3,
            y: -0.2,
            outer_diameter: 1.4,
            inner_diameter: 0.7,
            gap_thickness: 0.16,
            rotation: 0.31,
            exposure: 1.0,
        },
        Primitive::Line {
            start_x: -0.8,
            start_y: 0.3,
            end_x: 0.7,
            end_y: -0.2,
            width: 0.15,
            exposure: 1.0,
        },
        Primitive::Triangle {
            vertices: [[-0.3, 0.2], [0.7, -0.4], [0.6, 0.8]],
            exposure: 1.0,
            hole_x: 0.3,
            hole_y: 0.2,
            hole_radius: 0.03,
        },
        Primitive::TriangleTemplateFlash {
            template: Rc::new(vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
            x: 0.2,
            y: -0.1,
        },
    ];
    assert!(compact_primitives_from_parts(&[], &[], &[])
        .unwrap()
        .is_empty());
    for primitive in &primitives {
        let mut types = Vec::new();
        let mut data = Vec::new();
        let mut templates = CompactTemplateTable::default();
        append_compact_primitive(primitive, &mut types, &mut data, &mut templates);
        let template_sources = if let Primitive::TriangleTemplateFlash { template, .. } = primitive
        {
            vec![Rc::clone(template)]
        } else {
            Vec::new()
        };
        let decoded = compact_primitives_from_parts(&types, &data, &template_sources).unwrap();
        assert!(!matches!(
            decoded.storage,
            FeaturePrimitiveStorage::Multiple(_)
        ));
        decoded.for_each(|actual| assert_eq!(format!("{actual:?}"), format!("{primitive:?}")));
    }
    let mut types = Vec::new();
    let mut data = Vec::new();
    let mut templates = CompactTemplateTable::default();
    for primitive in &primitives {
        append_compact_primitive(primitive, &mut types, &mut data, &mut templates);
    }
    let sources = if let Primitive::TriangleTemplateFlash { template, .. } = &primitives[5] {
        vec![Rc::clone(template)]
    } else {
        unreachable!()
    };
    let decoded = compact_primitives_from_parts(&types, &data, &sources).unwrap();
    assert!(matches!(
        decoded.storage,
        FeaturePrimitiveStorage::Multiple(_)
    ));
    let mut index = 0;
    decoded.for_each(|actual| {
        assert_eq!(format!("{actual:?}"), format!("{:?}", primitives[index]));
        index += 1;
    });
    assert_eq!(index, primitives.len());
}

#[test]
fn repeated_flash_shares_descriptor_but_preserves_independent_geometry() {
    let mut layer = InteractionLayer::new();
    layer.push(circle_feature(0.0, 0.5, Polarity::Positive));
    let primitive = Primitive::Circle {
        x: 1.0,
        y: 0.0,
        radius: 0.5,
        exposure: 1.0,
        hole_x: 1.0,
        hole_y: 0.0,
        hole_radius: 0.0,
    };
    layer.push_repeated_flash(0, std::slice::from_ref(&primitive));
    assert!(Rc::ptr_eq(
        &layer.features[0].descriptor,
        &layer.features[1].descriptor
    ));
    assert!(layer.features[0].hit([0.0, 0.0], 0.0));
    assert!(!layer.features[0].hit([1.0, 0.0], 0.0));
    assert!(layer.features[1].hit([1.0, 0.0], 0.0));
    layer.push(circle_feature(0.0, 0.25, Polarity::Negative));
    layer.push_repeated_flash(2, std::slice::from_ref(&primitive));
    assert!(Rc::ptr_eq(
        &layer.features[2].descriptor,
        &layer.features[3].descriptor
    ));
    assert!(!Rc::ptr_eq(
        &layer.features[0].descriptor,
        &layer.features[2].descriptor
    ));
    assert_eq!(layer.features[3].descriptor.polarity, Polarity::Negative);
    let count = layer.features.len();
    layer.push_repeated_flash(0, &[]);
    assert_eq!(layer.features.len(), count);
}

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
    let empty = compact_path_region_refs_from_parts_invariant(&[], &[], usize::MAX)
        .expect("no references should need no feature-sized allocation");
    assert!(empty.is_empty());
    assert_eq!(empty.capacity(), 0);
    assert!(compact_path_region_refs_from_parts_invariant(&[], &[4, 5, 6], 4).is_err());
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

#[test]
fn path_region_ref_checked_indices_preserve_u32_boundaries() {
    let max = u32::MAX as usize;
    let reference = PathRegionRef::new(max, max, max).unwrap();
    assert_eq!(reference.sublayer_idx, u32::MAX);
    assert_eq!(reference.region_start, u32::MAX);
    assert_eq!(reference.region_count, u32::MAX);
    assert_eq!(std::mem::size_of::<PathRegionRef>(), 12);
    assert_eq!(std::mem::size_of::<Option<PathRegionRef>>(), 16);
    #[cfg(target_pointer_width = "64")]
    {
        let overflow = max + 1;
        assert!(PathRegionRef::new(overflow, 0, 1).is_err());
        assert!(PathRegionRef::new(0, overflow, 1).is_err());
        assert!(PathRegionRef::new(0, 0, overflow).is_err());
    }
}
