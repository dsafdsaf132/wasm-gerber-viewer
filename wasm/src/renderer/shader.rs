use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use web_sys::{WebGl2RenderingContext, WebGlProgram, WebGlShader, WebGlUniformLocation};

// WebGL constants
pub const COLOR_BUFFER_BIT: u32 = WebGl2RenderingContext::COLOR_BUFFER_BIT;
pub const STENCIL_BUFFER_BIT: u32 = WebGl2RenderingContext::STENCIL_BUFFER_BIT;
pub const TRIANGLES: u32 = WebGl2RenderingContext::TRIANGLES;
pub const FLOAT: u32 = WebGl2RenderingContext::FLOAT;
pub const ARRAY_BUFFER: u32 = WebGl2RenderingContext::ARRAY_BUFFER;
pub const STATIC_DRAW: u32 = WebGl2RenderingContext::STATIC_DRAW;
pub const STREAM_DRAW: u32 = WebGl2RenderingContext::STREAM_DRAW;
pub const VERTEX_SHADER: u32 = WebGl2RenderingContext::VERTEX_SHADER;
pub const FRAGMENT_SHADER: u32 = WebGl2RenderingContext::FRAGMENT_SHADER;
pub const BLEND: u32 = WebGl2RenderingContext::BLEND;
pub const ONE_MINUS_SRC_ALPHA: u32 = WebGl2RenderingContext::ONE_MINUS_SRC_ALPHA;
pub const ONE: u32 = WebGl2RenderingContext::ONE;
pub const SRC_ALPHA: u32 = WebGl2RenderingContext::SRC_ALPHA;
pub const FUNC_ADD: u32 = WebGl2RenderingContext::FUNC_ADD;
pub const ZERO: u32 = WebGl2RenderingContext::ZERO;
pub const STENCIL_TEST: u32 = WebGl2RenderingContext::STENCIL_TEST;
pub const ALWAYS: u32 = WebGl2RenderingContext::ALWAYS;
pub const EQUAL: u32 = WebGl2RenderingContext::EQUAL;
pub const NOTEQUAL: u32 = WebGl2RenderingContext::NOTEQUAL;
pub const KEEP: u32 = WebGl2RenderingContext::KEEP;
pub const REPLACE: u32 = WebGl2RenderingContext::REPLACE;
pub const INVERT: u32 = WebGl2RenderingContext::INVERT;

// Shader sources
pub const TRIANGLE_VERTEX_SHADER: &str = include_str!("shaders/triangle.vert.glsl");

pub const TRIANGLE_FRAGMENT_SHADER: &str = include_str!("shaders/triangle.frag.glsl");

pub const LINE_VERTEX_SHADER: &str = include_str!("shaders/line.vert.glsl");

pub const LINE_FRAGMENT_SHADER: &str = include_str!("shaders/line.frag.glsl");

pub const TRIANGLE_TEMPLATE_VERTEX_SHADER: &str =
    include_str!("shaders/triangle_template.vert.glsl");

pub const TRIANGLE_TEMPLATE_FRAGMENT_SHADER: &str =
    include_str!("shaders/triangle_template.frag.glsl");

pub const CIRCLE_VERTEX_SHADER: &str = include_str!("shaders/circle.vert.glsl");

pub const CIRCLE_FRAGMENT_SHADER: &str = include_str!("shaders/circle.frag.glsl");

pub const CIRCLE_HOLED_VERTEX_SHADER: &str = include_str!("shaders/circle_holed.vert.glsl");

pub const CIRCLE_HOLED_FRAGMENT_SHADER: &str = include_str!("shaders/circle_holed.frag.glsl");

pub const ARC_VERTEX_SHADER: &str = include_str!("shaders/arc.vert.glsl");

pub const ARC_FRAGMENT_SHADER: &str = include_str!("shaders/arc.frag.glsl");

pub const THERMAL_VERTEX_SHADER: &str = include_str!("shaders/thermal.vert.glsl");

pub const THERMAL_FRAGMENT_SHADER: &str = include_str!("shaders/thermal.frag.glsl");

pub const TEXTURE_VERTEX_SHADER: &str = include_str!("shaders/texture.vert.glsl");

pub const TEXTURE_FRAGMENT_SHADER: &str = include_str!("shaders/texture.frag.glsl");

pub const PATH_SOLID_VERTEX_SHADER: &str = include_str!("shaders/path_solid.vert.glsl");

pub const PATH_SOLID_FRAGMENT_SHADER: &str = include_str!("shaders/path_solid.frag.glsl");

pub const PATH_SECTOR_VERTEX_SHADER: &str = include_str!("shaders/path_sector.vert.glsl");

pub const PATH_SECTOR_FRAGMENT_SHADER: &str = include_str!("shaders/path_sector.frag.glsl");

pub const HIGHLIGHT_VERTEX_SHADER: &str = include_str!("shaders/highlight.vert.glsl");

pub const HIGHLIGHT_FRAGMENT_SHADER: &str = include_str!("shaders/highlight.frag.glsl");

pub const HIGHLIGHT_STENCIL_FRAGMENT_SHADER: &str =
    include_str!("shaders/highlight_stencil.frag.glsl");

/// Shader program with uniform locations
pub struct ShaderProgram {
    pub program: WebGlProgram,
    pub uniforms: HashMap<String, WebGlUniformLocation>,
    pub attributes: HashMap<String, u32>,
}

/// All shader programs
pub struct ShaderPrograms {
    pub triangle: ShaderProgram,
    pub triangle_template: ShaderProgram,
    pub line: ShaderProgram,
    pub circle: ShaderProgram,
    pub circle_holed: ShaderProgram,
    pub arc: ShaderProgram,
    pub thermal: ShaderProgram,
    pub texture: ShaderProgram,
    pub path_solid: ShaderProgram,
    pub path_sector: ShaderProgram,
}

impl ShaderPrograms {
    /// Compile all shader programs
    pub fn new(gl: &WebGl2RenderingContext) -> Result<ShaderPrograms, JsValue> {
        let triangle = compile_program(
            gl,
            TRIANGLE_VERTEX_SHADER,
            TRIANGLE_FRAGMENT_SHADER,
            &[
                "position",
                "hole_x_instance",
                "hole_y_instance",
                "hole_radius_instance",
            ],
            &["transform", "color"],
        )?;

        let triangle_template = compile_program(
            gl,
            TRIANGLE_TEMPLATE_VERTEX_SHADER,
            TRIANGLE_TEMPLATE_FRAGMENT_SHADER,
            &["position", "instance_x", "instance_y"],
            &["transform", "color"],
        )?;

        let line = compile_program(
            gl,
            LINE_VERTEX_SHADER,
            LINE_FRAGMENT_SHADER,
            &[
                "position",
                "start_x_instance",
                "start_y_instance",
                "end_x_instance",
                "end_y_instance",
                "width_instance",
            ],
            &[
                "transform",
                "color",
                "viewport_size",
                "minimum_feature_pixels",
                "inner_outline_pixels",
                "inner_outline_world",
            ],
        )?;

        let circle = compile_program(
            gl,
            CIRCLE_VERTEX_SHADER,
            CIRCLE_FRAGMENT_SHADER,
            &[
                "position",
                "center_x_instance",
                "center_y_instance",
                "radius_instance",
            ],
            &[
                "transform",
                "color",
                "viewport_size",
                "inner_outline_pixels",
                "inner_outline_world",
            ],
        )?;

        let circle_holed = compile_program(
            gl,
            CIRCLE_HOLED_VERTEX_SHADER,
            CIRCLE_HOLED_FRAGMENT_SHADER,
            &[
                "position",
                "center_x_instance",
                "center_y_instance",
                "radius_instance",
                "hole_x_instance",
                "hole_y_instance",
                "hole_radius_instance",
            ],
            &["transform", "color"],
        )?;

        let arc = compile_program(
            gl,
            ARC_VERTEX_SHADER,
            ARC_FRAGMENT_SHADER,
            &[
                "position",
                "center_x_instance",
                "center_y_instance",
                "radius_instance",
                "startAngle_instance",
                "sweepAngle_instance",
                "thickness_instance",
            ],
            &[
                "transform",
                "color",
                "viewport_size",
                "minimum_feature_pixels",
                "inner_outline_pixels",
                "inner_outline_world",
            ],
        )?;

        let thermal = compile_program(
            gl,
            THERMAL_VERTEX_SHADER,
            THERMAL_FRAGMENT_SHADER,
            &[
                "position",
                "center_x_instance",
                "center_y_instance",
                "outer_diameter_instance",
                "inner_diameter_instance",
                "gap_thickness_instance",
                "rotation_instance",
            ],
            &["transform", "color"],
        )?;

        let texture = compile_program(
            gl,
            TEXTURE_VERTEX_SHADER,
            TEXTURE_FRAGMENT_SHADER,
            &["position"],
            &["u_texture", "u_color"],
        )?;

        let path_solid = compile_program(
            gl,
            PATH_SOLID_VERTEX_SHADER,
            PATH_SOLID_FRAGMENT_SHADER,
            &["position"],
            &["transform", "color"],
        )?;

        let path_sector = compile_program(
            gl,
            PATH_SECTOR_VERTEX_SHADER,
            PATH_SECTOR_FRAGMENT_SHADER,
            &["position", "center", "radius"],
            &["transform"],
        )?;

        Ok(ShaderPrograms {
            triangle,
            triangle_template,
            line,
            circle,
            circle_holed,
            arc,
            thermal,
            texture,
            path_solid,
            path_sector,
        })
    }
}

/// Compile a shader program
pub(crate) fn compile_program(
    gl: &WebGl2RenderingContext,
    vertex_src: &str,
    fragment_src: &str,
    attributes: &[&str],
    uniforms: &[&str],
) -> Result<ShaderProgram, JsValue> {
    let vert_shader = compile_shader(gl, VERTEX_SHADER, vertex_src)?;
    let frag_shader = match compile_shader(gl, FRAGMENT_SHADER, fragment_src) {
        Ok(shader) => shader,
        Err(error) => {
            gl.delete_shader(Some(&vert_shader));
            return Err(error);
        }
    };

    let program = match gl.create_program() {
        Some(program) => program,
        None => {
            gl.delete_shader(Some(&vert_shader));
            gl.delete_shader(Some(&frag_shader));
            return Err(JsValue::from_str("Unable to create shader program"));
        }
    };

    gl.attach_shader(&program, &vert_shader);
    gl.attach_shader(&program, &frag_shader);

    for (i, attr_name) in attributes.iter().enumerate() {
        gl.bind_attrib_location(&program, i as u32, attr_name);
    }

    gl.link_program(&program);

    if !gl
        .get_program_parameter(&program, WebGl2RenderingContext::LINK_STATUS)
        .as_bool()
        .unwrap_or(false)
    {
        let error = gl
            .get_program_info_log(&program)
            .unwrap_or_else(|| "Unknown error".to_string());
        gl.delete_shader(Some(&vert_shader));
        gl.delete_shader(Some(&frag_shader));
        gl.delete_program(Some(&program));
        return Err(JsValue::from_str(&format!("Shader link error: {}", error)));
    }

    gl.delete_shader(Some(&vert_shader));
    gl.delete_shader(Some(&frag_shader));

    let mut attr_map = HashMap::new();
    for (i, attr_name) in attributes.iter().enumerate() {
        attr_map.insert(attr_name.to_string(), i as u32);
    }

    let mut uniform_map = HashMap::new();
    for uniform_name in uniforms.iter() {
        let loc = gl
            .get_uniform_location(&program, uniform_name)
            .ok_or_else(|| {
                let message = format!("Missing shader uniform: {}", uniform_name);
                gl.delete_program(Some(&program));
                JsValue::from_str(&message)
            })?;
        uniform_map.insert(uniform_name.to_string(), loc);
    }

    Ok(ShaderProgram {
        program,
        uniforms: uniform_map,
        attributes: attr_map,
    })
}

/// Compile a single shader
fn compile_shader(
    gl: &WebGl2RenderingContext,
    shader_type: u32,
    source: &str,
) -> Result<WebGlShader, JsValue> {
    let shader = gl
        .create_shader(shader_type)
        .ok_or_else(|| JsValue::from_str("Unable to create shader object"))?;

    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);

    if !gl
        .get_shader_parameter(&shader, WebGl2RenderingContext::COMPILE_STATUS)
        .as_bool()
        .unwrap_or(false)
    {
        let error = gl
            .get_shader_info_log(&shader)
            .unwrap_or_else(|| "Unknown error".to_string());
        gl.delete_shader(Some(&shader));
        return Err(JsValue::from_str(&format!(
            "Shader compile error: {}",
            error
        )));
    }

    Ok(shader)
}
