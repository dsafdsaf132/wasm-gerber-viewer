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
    pub fn get_rte_transform_and_eye(
        &self,
        canvas_width: u32,
        canvas_height: u32,
    ) -> ([f32; 9], [i32; 2]) {
        let transform = self.get_transform_matrix(canvas_width, canvas_height);
        compute_rte_transform_and_eye(&transform)
    }
}

/// Compute RTE (Relative-To-Eye) transformation matrix and eye coordinates in nanometers.
pub fn compute_rte_transform_and_eye(transform: &[f32; 9]) -> ([f32; 9], [i32; 2]) {
    let scale_x = transform[0];
    let scale_y = transform[4];
    let offset_x = transform[6];
    let offset_y = transform[7];

    let eye_x_nm = if scale_x.abs() > 1e-12 {
        ((-offset_x / scale_x) as f64 * 1_000_000.0)
            .round()
            .clamp(i32::MIN as f64, i32::MAX as f64) as i32
    } else {
        0
    };
    let eye_y_nm = if scale_y.abs() > 1e-12 {
        ((-offset_y / scale_y) as f64 * 1_000_000.0)
            .round()
            .clamp(i32::MIN as f64, i32::MAX as f64) as i32
    } else {
        0
    };

    let eye_x_mm = (eye_x_nm as f64 * 1e-6) as f32;
    let eye_y_mm = (eye_y_nm as f64 * 1e-6) as f32;

    let offset_x_rte = offset_x + scale_x * eye_x_mm;
    let offset_y_rte = offset_y + scale_y * eye_y_mm;

    let mut rte_transform = *transform;
    rte_transform[6] = offset_x_rte;
    rte_transform[7] = offset_y_rte;

    (rte_transform, [eye_x_nm, eye_y_nm])
}

impl Default for Camera {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests;
