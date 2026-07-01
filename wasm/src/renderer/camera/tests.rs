use super::Camera;

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
