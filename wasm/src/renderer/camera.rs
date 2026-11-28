/// Camera transformation for viewport control
pub struct Camera {
    pub zoom_x: f32,
    pub zoom_y: f32,
    pub offset_x: f32,
    pub offset_y: f32,
}

impl Camera {
    /// Create a new camera with default settings
    pub fn new() -> Camera {
        Camera {
            zoom_x: 2.0,
            zoom_y: 2.0,
            offset_x: 0.0,
            offset_y: 0.0,
        }
    }

    /// Get the transformation matrix for the camera
    ///
    /// # Arguments
    /// * `canvas_width` - Canvas width in pixels
    /// * `canvas_height` - Canvas height in pixels
    ///
    /// # Returns
    /// A 3x3 transformation matrix as [f32; 9]
    pub fn get_transform_matrix(&self, canvas_width: u32, canvas_height: u32) -> [f32; 9] {
        let width = canvas_width.max(1) as f32;
        let height = canvas_height.max(1) as f32;
        let aspect = width / height;

        let (scale_x, scale_y) = if aspect > 1.0 {
            (self.zoom_x / aspect, self.zoom_y)
        } else {
            (self.zoom_x, self.zoom_y * aspect)
        };

        let (offset_x, offset_y) = if aspect > 1.0 {
            (self.offset_x / aspect, self.offset_y)
        } else {
            (self.offset_x, self.offset_y * aspect)
        };

        [
            scale_x, 0.0, 0.0, 0.0, scale_y, 0.0, offset_x, offset_y, 1.0,
        ]
    }

    /// Get the RTE transformation matrix and eye coordinates in nanometers.
    #[cfg(test)]
    pub fn get_rte_transform_and_eye(
        &self,
        canvas_width: u32,
        canvas_height: u32,
    ) -> ([f32; 9], [i32; 2]) {
        self.get_rte_transform_and_eye_for_origin(canvas_width, canvas_height, [0, 0])
    }

    /// Get the RTE transformation matrix and eye coordinates relative to `origin_nm`.
    #[cfg(test)]
    pub fn get_rte_transform_and_eye_for_origin(
        &self,
        canvas_width: u32,
        canvas_height: u32,
        origin_nm: [i64; 2],
    ) -> ([f32; 9], [i32; 2]) {
        let transform = self.get_transform_matrix(canvas_width, canvas_height);
        compute_rte_transform_and_eye_for_origin(&transform, origin_nm)
    }
}

/// Compute RTE (Relative-To-Eye) transformation matrix and eye coordinates in nanometers.
#[cfg(test)]
pub fn compute_rte_transform_and_eye(transform: &[f32; 9]) -> ([f32; 9], [i32; 2]) {
    compute_rte_transform_and_eye_for_origin(transform, [0, 0])
}

/// Compute RTE transformation matrix and eye coordinates relative to `origin_nm`.
pub fn compute_rte_transform_and_eye_for_origin(
    transform: &[f32; 9],
    origin_nm: [i64; 2],
) -> ([f32; 9], [i32; 2]) {
    let scale_x = transform[0] as f64;
    let scale_y = transform[4] as f64;
    let offset_x = transform[6] as f64;
    let offset_y = transform[7] as f64;

    let eye_x_nm_abs = if scale_x.abs() > 1e-12 {
        ((-offset_x / scale_x) * 1_000_000.0).round() as i64
    } else {
        0
    };
    let eye_y_nm_abs = if scale_y.abs() > 1e-12 {
        ((-offset_y / scale_y) * 1_000_000.0).round() as i64
    } else {
        0
    };

    let eye_x_rel = (eye_x_nm_abs - origin_nm[0]).clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    let eye_y_rel = (eye_y_nm_abs - origin_nm[1]).clamp(i32::MIN as i64, i32::MAX as i64) as i32;

    let actual_eye_x_mm = (origin_nm[0] + eye_x_rel as i64) as f64 * 1e-6;
    let actual_eye_y_mm = (origin_nm[1] + eye_y_rel as i64) as f64 * 1e-6;

    let offset_x_rte = (offset_x + scale_x * actual_eye_x_mm) as f32;
    let offset_y_rte = (offset_y + scale_y * actual_eye_y_mm) as f32;

    let mut rte_transform = *transform;
    rte_transform[6] = offset_x_rte;
    rte_transform[7] = offset_y_rte;

    (rte_transform, [eye_x_rel, eye_y_rel])
}

impl Default for Camera {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests;
