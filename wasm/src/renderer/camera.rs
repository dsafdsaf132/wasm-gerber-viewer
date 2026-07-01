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
}

impl Default for Camera {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests;
