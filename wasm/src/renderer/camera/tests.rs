use super::{compute_rte_transform_and_eye, Camera};

#[test]
fn transform_matrix_preserves_signed_axis_zoom() {
    let camera = Camera {
        zoom_x: -4.0,
        zoom_y: 3.0,
        offset_x: 1.0,
        offset_y: -2.0,
    };

    let transform = camera.get_transform_matrix(200, 100);

    assert_eq!(transform[0], -2.0);
    assert_eq!(transform[4], 3.0);
    assert_eq!(transform[6], 0.5);
    assert_eq!(transform[7], -2.0);
}

#[test]
fn transform_matrix_handles_zero_canvas_dimensions() {
    let camera = Camera::default();
    let transform = camera.get_transform_matrix(0, 0);

    assert!(transform.iter().all(|value| value.is_finite()));
}

#[test]
fn rte_transform_matches_standard_transform_with_extreme_precision() {
    // Simulate camera centered at a large coordinate on Zaius board (e.g. 350.5 mm, 280.25 mm)
    let world_x = 350.5_f32;
    let world_y = 280.25_f32;
    let world_x_nm = (world_x as f64 * 1_000_000.0).round() as i32;
    let world_y_nm = (world_y as f64 * 1_000_000.0).round() as i32;

    let zoom = 50.0_f32; // zoomed in
    let camera = Camera {
        zoom_x: zoom,
        zoom_y: zoom,
        offset_x: -world_x * zoom,
        offset_y: -world_y * zoom,
    };

    let transform = camera.get_transform_matrix(1920, 1080);
    let (rte_transform, eye_nm) = camera.get_rte_transform_and_eye(1920, 1080);
    let (rte_direct, eye_direct) = compute_rte_transform_and_eye(&transform);
    assert_eq!(eye_nm, eye_direct);
    assert_eq!(rte_transform, rte_direct);

    // Eye in nanometers should be within a couple nanometers of the camera center
    assert!((eye_nm[0] - world_x_nm).abs() <= 2);
    assert!((eye_nm[1] - world_y_nm).abs() <= 2);

    // For any nearby test point (e.g. +1.5 mm, -2.3 mm)
    let test_x_nm = world_x_nm + 1_500_000;
    let test_y_nm = world_y_nm - 2_300_000;
    let test_x_mm = (test_x_nm as f64 * 1e-6) as f32;
    let test_y_mm = (test_y_nm as f64 * 1e-6) as f32;

    // Standard clip position
    let clip_x = transform[0] * test_x_mm + transform[6];
    let clip_y = transform[4] * test_y_mm + transform[7];

    // RTE clip position: (pos_nm - eye_nm) * 1e-6 in shader
    let rel_x = ((test_x_nm - eye_nm[0]) as f64 * 1e-6) as f32;
    let rel_y = ((test_y_nm - eye_nm[1]) as f64 * 1e-6) as f32;
    let rte_clip_x = rte_transform[0] * rel_x + rte_transform[6];
    let rte_clip_y = rte_transform[4] * rel_y + rte_transform[7];

    // The standard transform suffers 32-bit catastrophic cancellation (~1e-3)
    // when subtracting large world coordinates, whereas RTE is mathematically exact.
    assert!(
        (clip_x - rte_clip_x).abs() < 2e-3,
        "X mismatch: {} vs {}",
        clip_x,
        rte_clip_x
    );
    assert!(
        (clip_y - rte_clip_y).abs() < 2e-3,
        "Y mismatch: {} vs {}",
        clip_y,
        rte_clip_y
    );
}
