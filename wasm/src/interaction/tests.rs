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
