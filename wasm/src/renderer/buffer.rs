use web_sys::{WebGlBuffer, WebGlFramebuffer, WebGlTexture, WebGlVertexArrayObject};

/// Frame buffer object for off-screen rendering
pub struct Fbo {
    pub framebuffer: WebGlFramebuffer,
    pub texture: WebGlTexture,
}

/// Buffer cache for geometry rendering (per polarity sublayer)
#[derive(Default)]
pub struct BufferCache {
    // Triangles cache
    pub triangle_vao: Option<WebGlVertexArrayObject>,
    pub triangle_vertex_buffer: Option<WebGlBuffer>,
    pub triangle_hole_center_buffer: Option<WebGlBuffer>,
    pub triangle_hole_radius_buffer: Option<WebGlBuffer>,

    // Circles cache
    pub circle_vao: Option<WebGlVertexArrayObject>,
    pub circle_center_buffer: Option<WebGlBuffer>,
    pub circle_radius_buffer: Option<WebGlBuffer>,
    pub circle_hole_center_buffer: Option<WebGlBuffer>,
    pub circle_hole_radius_buffer: Option<WebGlBuffer>,

    // Arcs cache
    pub arc_vao: Option<WebGlVertexArrayObject>,
    pub arc_center_buffer: Option<WebGlBuffer>,
    pub arc_radius_buffer: Option<WebGlBuffer>,
    pub arc_start_angle_buffer: Option<WebGlBuffer>,
    pub arc_sweep_angle_buffer: Option<WebGlBuffer>,
    pub arc_thickness_buffer: Option<WebGlBuffer>,

    // Thermals cache
    pub thermal_vao: Option<WebGlVertexArrayObject>,
    pub thermal_center_buffer: Option<WebGlBuffer>,
    pub thermal_outer_diameter_buffer: Option<WebGlBuffer>,
    pub thermal_inner_diameter_buffer: Option<WebGlBuffer>,
    pub thermal_gap_thickness_buffer: Option<WebGlBuffer>,
    pub thermal_rotation_buffer: Option<WebGlBuffer>,
}
