use web_sys::{
    WebGlBuffer, WebGlFramebuffer, WebGlRenderbuffer, WebGlTexture, WebGlVertexArrayObject,
};

/// Frame buffer object for off-screen rendering
pub struct Fbo {
    pub framebuffer: WebGlFramebuffer,
    pub texture: WebGlTexture,
    pub stencil: Option<WebGlRenderbuffer>,
}

/// Buffer cache for one repeated triangle mesh template.
#[derive(Default)]
pub struct TriangleTemplateBufferCache {
    pub vao: Option<WebGlVertexArrayObject>,
    pub vertex_count: i32,
    pub instance_count: i32,
    pub vertex_buffer: Option<WebGlBuffer>,
    pub instance_x_buffer: Option<WebGlBuffer>,
    pub instance_y_buffer: Option<WebGlBuffer>,
}

/// Buffer cache for geometry rendering (per polarity sublayer)
#[derive(Default)]
pub struct BufferCache {
    // Triangles cache
    pub triangle_vao: Option<WebGlVertexArrayObject>,
    pub triangle_vertex_count: i32,
    pub triangle_vertex_buffer: Option<WebGlBuffer>,
    pub triangle_hole_x_buffer: Option<WebGlBuffer>,
    pub triangle_hole_y_buffer: Option<WebGlBuffer>,
    pub triangle_hole_radius_buffer: Option<WebGlBuffer>,
    pub triangle_template_caches: Vec<TriangleTemplateBufferCache>,

    // Lines cache
    pub line_vao: Option<WebGlVertexArrayObject>,
    pub line_instance_count: i32,
    pub line_start_x_buffer: Option<WebGlBuffer>,
    pub line_start_y_buffer: Option<WebGlBuffer>,
    pub line_end_x_buffer: Option<WebGlBuffer>,
    pub line_end_y_buffer: Option<WebGlBuffer>,
    pub line_width_buffer: Option<WebGlBuffer>,

    // Circles cache
    pub circle_vao: Option<WebGlVertexArrayObject>,
    pub circle_instance_count: i32,
    pub circle_center_x_buffer: Option<WebGlBuffer>,
    pub circle_center_y_buffer: Option<WebGlBuffer>,
    pub circle_radius_buffer: Option<WebGlBuffer>,
    pub circle_hole_x_buffer: Option<WebGlBuffer>,
    pub circle_hole_y_buffer: Option<WebGlBuffer>,
    pub circle_hole_radius_buffer: Option<WebGlBuffer>,

    // Arcs cache
    pub arc_vao: Option<WebGlVertexArrayObject>,
    pub arc_instance_count: i32,
    pub arc_center_x_buffer: Option<WebGlBuffer>,
    pub arc_center_y_buffer: Option<WebGlBuffer>,
    pub arc_radius_buffer: Option<WebGlBuffer>,
    pub arc_start_angle_buffer: Option<WebGlBuffer>,
    pub arc_sweep_angle_buffer: Option<WebGlBuffer>,
    pub arc_thickness_buffer: Option<WebGlBuffer>,

    // Thermals cache
    pub thermal_vao: Option<WebGlVertexArrayObject>,
    pub thermal_instance_count: i32,
    pub thermal_center_x_buffer: Option<WebGlBuffer>,
    pub thermal_center_y_buffer: Option<WebGlBuffer>,
    pub thermal_outer_diameter_buffer: Option<WebGlBuffer>,
    pub thermal_inner_diameter_buffer: Option<WebGlBuffer>,
    pub thermal_gap_thickness_buffer: Option<WebGlBuffer>,
    pub thermal_rotation_buffer: Option<WebGlBuffer>,

    // Arc-containing region path cache
    pub path_wedge_vao: Option<WebGlVertexArrayObject>,
    pub path_wedge_vertex_count: i32,
    pub path_wedge_vertex_buffer: Option<WebGlBuffer>,
    pub path_sector_vao: Option<WebGlVertexArrayObject>,
    pub path_sector_vertex_count: i32,
    pub path_sector_vertex_buffer: Option<WebGlBuffer>,
    pub path_cover_vao: Option<WebGlVertexArrayObject>,
    pub path_cover_vertex_count: i32,
    pub path_cover_vertex_buffer: Option<WebGlBuffer>,
    pub path_clear_vao: Option<WebGlVertexArrayObject>,
    pub path_clear_vertex_count: i32,
    pub path_clear_vertex_buffer: Option<WebGlBuffer>,
}
