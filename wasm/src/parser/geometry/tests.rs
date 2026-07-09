use super::*;

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
