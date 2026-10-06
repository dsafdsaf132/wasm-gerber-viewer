use super::*;

// Local performance workloads are ignored by the ordinary test pipeline.
#[path = "local_benchmarks.rs"]
mod local_benchmarks;

#[test]
fn sr_template_fallback_accounts_for_every_raw_primitive() {
    let mut apertures = HashMap::new();
    crate::parser::aperture::parse_aperture(
        "%ADD10R,1X1*%",
        &mut apertures,
        &HashMap::new(),
        1.0,
        true,
    );
    let aperture = &apertures["10"];
    assert!(aperture.triangle_template.is_some());
    assert_eq!(aperture.primitives.len(), 2);

    for scale in [f32::EPSILON * 0.5, f32::EPSILON, 1.0] {
        let mut state = ParserState::default();
        state.current_aperture = "10".into();
        state.layer_scale = scale;
        state.sr_x = 2;
        state.sr_y = 2;
        state.sr_i = 1.0;
        state.sr_j = 1.0;
        let per_copy = if scale <= f32::EPSILON { 2 } else { 1 };
        let expected_count = per_copy * 4;
        let mut primitives = Vec::new();
        flash_aperture(
            &state,
            &apertures,
            &mut primitives,
            &mut PathRegions::empty(),
            &mut Vec::new(),
            0.0,
            0.0,
        )
        .unwrap();
        assert_eq!(primitives.len(), expected_count);
        assert_eq!(state.generated_items(), expected_count as u32);

        // Reject against the real expanded count before appending any copies.
        state.set_generated_items(
            crate::parser::state::MAX_GENERATED_ITEMS - expected_count as u32 + 1,
        );
        let mut rejected = Vec::new();
        let error = flash_aperture(
            &state,
            &apertures,
            &mut rejected,
            &mut PathRegions::empty(),
            &mut Vec::new(),
            0.0,
            0.0,
        )
        .unwrap_err();
        assert!(error.contains("generated geometry exceeds"));
        assert!(rejected.is_empty());
    }
}

fn sr_circle_aperture() -> Aperture {
    let mut aperture = Aperture::new(0.005);
    aperture.primitives.push(Primitive::Circle {
        x: 0.3,
        y: -0.2,
        radius: 0.005,
        exposure: 1.0,
        hole_x: 0.3,
        hole_y: -0.2,
        hole_radius: 0.001,
    });
    aperture
}

fn sr_test_primitives() -> Vec<Primitive> {
    vec![
        sr_circle_aperture().primitives.remove(0),
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
    ]
}

#[test]
fn sr_all_primitives_match_reference_geometry_and_picking() {
    let shapes = sr_test_primitives();
    // Separate primitives exercise the stack fast path; mixed apertures exercise
    // scratch storage. Small/zero steps include overlapping and coincident copies.
    let mut cases: Vec<Vec<Primitive>> = shapes
        .iter()
        .map(|p| vec![p.clone()])
        .chain(std::iter::once(shapes.clone()))
        .collect();
    cases.push(vec![
        Primitive::Circle {
            x: 0.3,
            y: -0.2,
            radius: 0.7,
            exposure: 1.0,
            hole_x: 0.0,
            hole_y: 0.0,
            hole_radius: 0.0,
        },
        Primitive::Circle {
            x: 0.4,
            y: -0.1,
            radius: 0.2,
            exposure: 0.0,
            hole_x: 0.0,
            hole_y: 0.0,
            hole_radius: 0.0,
        },
    ]);
    for primitives in cases {
        let mut aperture = Aperture::new(0.7);
        aperture.has_negative = primitives.iter().any(|primitive| {
            matches!(primitive,
            Primitive::Circle { exposure, .. } if *exposure == 0.0)
        });
        aperture.primitives = primitives;
        for rotation in [
            0.0,
            0.37,
            std::f32::consts::FRAC_PI_2,
            std::f32::consts::PI,
            -0.61,
        ] {
            for (mirror_x, mirror_y) in [(false, false), (true, false), (false, true), (true, true)]
            {
                for scale in [0.6, 1.7] {
                    for (step_x, step_y) in [(2.0, -3.0), (0.1, 0.1), (0.0, 0.0)] {
                        for polarity in [Polarity::Positive, Polarity::Negative] {
                            let mut state = ParserState::default();
                            state.current_aperture = "10".into();
                            state.sr_x = 3;
                            state.sr_y = 2;
                            state.sr_i = step_x;
                            state.sr_j = step_y;
                            state.layer_rotation = rotation;
                            state.mirror_x = mirror_x;
                            state.mirror_y = mirror_y;
                            state.layer_scale = scale;
                            state.polarity = polarity;
                            let mut expected = Vec::new();
                            let mut expected_picking = InteractionLayer::new();
                            let properties = InteractionFeature::gerber_properties_with_transform(
                                &aperture, scale, mirror_x, mirror_y, rotation,
                            );
                            for sy in 0..state.sr_y {
                                for sx in 0..state.sr_x {
                                    let start = expected.len();
                                    flash_aperture_no_sr(
                                        &aperture,
                                        &mut expected,
                                        0.7 + sx as f32 * step_x,
                                        -0.4 + sy as f32 * step_y,
                                        scale,
                                        mirror_x,
                                        mirror_y,
                                        rotation,
                                    )
                                    .unwrap();
                                    if let Some(feature) = feature_from_primitive_delta(
                                        FeatureKind::Flash,
                                        "10",
                                        &aperture,
                                        polarity,
                                        &expected[start..],
                                        properties.clone(),
                                    ) {
                                        expected_picking.push(feature);
                                    }
                                }
                            }
                            let apertures = HashMap::from([("10".into(), aperture.clone())]);
                            let mut actual = Vec::new();
                            flash_aperture(
                                &state,
                                &apertures,
                                &mut actual,
                                &mut PathRegions::empty(),
                                &mut Vec::new(),
                                0.7,
                                -0.4,
                            )
                            .unwrap();
                            assert_eq!(format!("{actual:?}"), format!("{expected:?}"));
                            let mut actual_picking = InteractionLayer::new();
                            record_flash_interactions(
                                Some(&mut actual_picking),
                                "10",
                                &aperture,
                                &state,
                                0.7,
                                -0.4,
                                &actual,
                            )
                            .unwrap();
                            assert_eq!(
                                format!("{:?}", actual_picking.features),
                                format!("{:?}", expected_picking.features)
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn sr_flash_matches_per_copy_transform_and_preserves_order() {
    for rotation in [0.0, 37.0, 90.0] {
        for mirror in [false, true] {
            for multi in [false, true] {
                let mut aperture = sr_circle_aperture();
                if multi {
                    aperture.primitives.push(offset_primitive_by(
                        &aperture.primitives[0],
                        0.13,
                        -0.17,
                    ));
                }
                let mut state = ParserState::default();
                state.current_aperture = "10".into();
                state.sr_x = 3;
                state.sr_y = 2;
                state.sr_i = 1.1;
                state.sr_j = -2.3;
                state.layer_scale = 1.7;
                state.mirror_x = mirror;
                state.layer_rotation = rotation;
                let mut expected = Vec::new();
                for sy in 0..state.sr_y {
                    for sx in 0..state.sr_x {
                        flash_aperture_no_sr(
                            &aperture,
                            &mut expected,
                            0.7 + sx as f32 * state.sr_i,
                            -0.4 + sy as f32 * state.sr_j,
                            state.layer_scale,
                            state.mirror_x,
                            state.mirror_y,
                            state.layer_rotation,
                        )
                        .unwrap();
                    }
                }
                let apertures = HashMap::from([("10".into(), aperture)]);
                let mut actual = Vec::new();
                flash_aperture(
                    &state,
                    &apertures,
                    &mut actual,
                    &mut PathRegions::empty(),
                    &mut Vec::new(),
                    0.7,
                    -0.4,
                )
                .unwrap();
                assert_eq!(format!("{actual:?}"), format!("{expected:?}"));
                let aperture = &apertures["10"];
                let mut interactions = InteractionLayer::new();
                record_flash_interactions(
                    Some(&mut interactions),
                    "10",
                    aperture,
                    &state,
                    0.7,
                    -0.4,
                    &actual,
                )
                .unwrap();
                assert_eq!(interactions.features.len(), 6);
                for (feature, copy) in interactions
                    .features
                    .iter()
                    .zip(expected.chunks(aperture.primitives.len()))
                {
                    let expected_feature = feature_from_primitive_delta(
                        FeatureKind::Flash,
                        "10",
                        aperture,
                        state.polarity,
                        copy,
                        InteractionFeature::gerber_properties_with_transform(
                            aperture,
                            state.layer_scale,
                            state.mirror_x,
                            state.mirror_y,
                            state.layer_rotation,
                        ),
                    )
                    .unwrap();
                    assert_eq!(
                        format!("{:?}", feature.bounds),
                        format!("{:?}", expected_feature.bounds)
                    );
                }
            }
        }
    }
}

#[test]
fn canonical_arc_preserves_clamped_equal_radius_sweep() {
    let arc = canonical_arc_geometry(
        [1.0, 0.0],
        [0.0, -1.0],
        [0.0, 0.0],
        1.0,
        0.0,
        std::f32::consts::PI / 2.0,
        true,
    );

    assert!((arc.sweep_angle - std::f32::consts::PI / 2.0).abs() < 0.0001);
}

#[test]
fn canonical_arc_preserves_clamped_mismatched_radius_sweep() {
    let arc = canonical_arc_geometry(
        [1.0, 0.0],
        [0.0, -1.2],
        [0.0, 0.0],
        1.0,
        0.0,
        std::f32::consts::PI / 2.0,
        true,
    );

    assert!(arc.sweep_angle.abs() <= std::f32::consts::PI / 2.0 + 0.0001);
}
