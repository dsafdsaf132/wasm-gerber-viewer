use super::*;

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

// Explicit local benchmark; not a CI timing gate. Uses the Downloads sample's
// 155x155 repeat count, with 100 base flashes to bound temporary memory.
#[test]
#[ignore]
fn benchmark_sr_circle_expansion() {
    let aperture = sr_circle_aperture();
    let apertures = HashMap::from([("10".into(), aperture.clone())]);
    let mut state = ParserState::default();
    state.current_aperture = "10".into();
    state.sr_x = 155;
    state.sr_y = 155;
    state.sr_i = 1.0;
    state.sr_j = 1.0;
    for optimized in [false, true] {
        let start = std::time::Instant::now();
        let mut primitives = Vec::new();
        for index in 0..100 {
            let x = index as f32 * 0.02;
            if optimized {
                flash_aperture(
                    &state,
                    &apertures,
                    &mut primitives,
                    &mut PathRegions::empty(),
                    &mut Vec::new(),
                    x,
                    0.0,
                )
                .unwrap();
            } else {
                for sy in 0..155 {
                    for sx in 0..155 {
                        flash_aperture_no_sr(
                            &aperture,
                            &mut primitives,
                            x + sx as f32,
                            sy as f32,
                            1.0,
                            false,
                            false,
                            0.0,
                        )
                        .unwrap();
                    }
                }
            }
        }
        assert_eq!(primitives.len(), 2_402_500);
        eprintln!("optimized={optimized} elapsed={:?}", start.elapsed());
        std::hint::black_box(&primitives);
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
