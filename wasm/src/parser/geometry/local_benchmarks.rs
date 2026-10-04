// Local-only, explicitly run with --ignored. No CI timing gate.
use super::*;

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
#[ignore]
fn benchmark_sr_primitive_matrix() {
    for (kind, primitive) in sr_test_primitives().into_iter().enumerate() {
        let mut aperture = Aperture::new(0.7);
        aperture.primitives.push(primitive);
        let apertures = HashMap::from([("10".into(), aperture.clone())]);
        for rotation in [0.0, 0.37] {
            for picking in [false, true] {
                let mut results = [Vec::new(), Vec::new()];
                for round in 0..5 {
                    for mode in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
                        let mut state = ParserState::default();
                        state.current_aperture = "10".into();
                        state.sr_x = 155;
                        state.sr_y = 155;
                        state.sr_i = 0.1;
                        state.sr_j = 0.1;
                        state.layer_rotation = rotation;
                        let properties = InteractionFeature::gerber_properties_with_transform(
                            &aperture, 1.0, false, false, rotation,
                        );
                        let mut rendered = Vec::new();
                        let mut interactions = InteractionLayer::new();
                        let start = std::time::Instant::now();
                        for index in 0..10 {
                            let x = index as f32 * 0.02;
                            let offset = rendered.len();
                            if mode == 1 {
                                flash_aperture(
                                    &state,
                                    &apertures,
                                    &mut rendered,
                                    &mut PathRegions::empty(),
                                    &mut Vec::new(),
                                    x,
                                    0.0,
                                )
                                .unwrap();
                                if picking {
                                    record_flash_interactions(
                                        Some(&mut interactions),
                                        "10",
                                        &aperture,
                                        &state,
                                        x,
                                        0.0,
                                        &rendered[offset..],
                                    )
                                    .unwrap();
                                }
                            } else {
                                for sy in 0..155 {
                                    for sx in 0..155 {
                                        flash_aperture_no_sr(
                                            &aperture,
                                            &mut rendered,
                                            x + sx as f32 * 0.1,
                                            sy as f32 * 0.1,
                                            1.0,
                                            false,
                                            false,
                                            rotation,
                                        )
                                        .unwrap();
                                    }
                                }
                                if picking {
                                    for sy in 0..155 {
                                        for sx in 0..155 {
                                            let mut scratch = Vec::new();
                                            flash_aperture_no_sr(
                                                &aperture,
                                                &mut scratch,
                                                x + sx as f32 * 0.1,
                                                sy as f32 * 0.1,
                                                1.0,
                                                false,
                                                false,
                                                rotation,
                                            )
                                            .unwrap();
                                            if let Some(feature) = feature_from_primitive_delta(
                                                FeatureKind::Flash,
                                                "10",
                                                &aperture,
                                                state.polarity,
                                                &scratch,
                                                properties.clone(),
                                            ) {
                                                interactions.push(feature);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        results[mode].push(start.elapsed().as_secs_f64() * 1000.0);
                        assert_eq!(rendered.len(), 240_250);
                        if picking {
                            assert_eq!(interactions.features.len(), 240_250);
                        }
                        std::hint::black_box((&rendered, &interactions));
                    }
                }
                for values in &mut results {
                    values.sort_by(f64::total_cmp);
                }
                eprintln!("kind={kind} rotation={rotation} picking={picking} baseline_ms={:.3} current_ms={:.3}",
                    results[0][2], results[1][2]);
            }
        }
    }
}
