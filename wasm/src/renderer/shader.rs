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
pub const VERTEX_SHADER: u32 = WebGl2RenderingContext::VERTEX_SHADER;
pub const FRAGMENT_SHADER: u32 = WebGl2RenderingContext::FRAGMENT_SHADER;
pub const BLEND: u32 = WebGl2RenderingContext::BLEND;
pub const ONE_MINUS_SRC_ALPHA: u32 = WebGl2RenderingContext::ONE_MINUS_SRC_ALPHA;
pub const ONE: u32 = WebGl2RenderingContext::ONE;
pub const FUNC_ADD: u32 = WebGl2RenderingContext::FUNC_ADD;
pub const ZERO: u32 = WebGl2RenderingContext::ZERO;
pub const STENCIL_TEST: u32 = WebGl2RenderingContext::STENCIL_TEST;
pub const ALWAYS: u32 = WebGl2RenderingContext::ALWAYS;
pub const NOTEQUAL: u32 = WebGl2RenderingContext::NOTEQUAL;
pub const KEEP: u32 = WebGl2RenderingContext::KEEP;
pub const INVERT: u32 = WebGl2RenderingContext::INVERT;

// Shader sources
pub const TRIANGLE_VERTEX_SHADER: &str = r#"#version 300 es
precision highp float;
in vec2 position;
in float hole_x_instance;
in float hole_y_instance;
in float hole_radius_instance;
uniform mat3 transform;
out highp vec2 vPosition;
out highp vec2 vHoleCenter;
out highp float vHoleRadius;
void main() {
    vec3 transformed = transform * vec3(position, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position;
    vHoleCenter = vec2(hole_x_instance, hole_y_instance);
    vHoleRadius = hole_radius_instance;
}
"#;

pub const TRIANGLE_FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp vec2 vHoleCenter;
in highp float vHoleRadius;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    if (vHoleRadius > 0.0) {
        vec2 diff = vPosition - vHoleCenter;
        if (dot(diff, diff) < vHoleRadius * vHoleRadius) discard;
    }
    fragColor = color;
}
"#;

pub const LINE_VERTEX_SHADER: &str = r#"#version 300 es
precision highp float;
in vec2 position;
in float start_x_instance;
in float start_y_instance;
in float end_x_instance;
in float end_y_instance;
in float width_instance;
uniform mat3 transform;
uniform vec2 viewport_size;
uniform float minimum_feature_pixels;

vec2 clipToPixel(vec2 clipPosition) {
    return clipPosition * viewport_size * 0.5;
}

vec2 pixelToClip(vec2 pixelPosition) {
    return pixelPosition / max(viewport_size * 0.5, vec2(1.0));
}

void main() {
    vec2 start = vec2(start_x_instance, start_y_instance);
    vec2 end = vec2(end_x_instance, end_y_instance);
    vec3 startClip = transform * vec3(start, 1.0);
    vec3 endClip = transform * vec3(end, 1.0);
    vec2 startPixels = clipToPixel(startClip.xy);
    vec2 endPixels = clipToPixel(endClip.xy);

    vec2 linePixels = endPixels - startPixels;
    float lineLength = length(linePixels);
    vec2 direction = lineLength > 0.000001 ? linePixels / lineLength : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);

    vec2 lineWorld = end - start;
    float worldLength = length(lineWorld);
    vec2 worldNormal = worldLength > 0.000001
        ? vec2(-lineWorld.y, lineWorld.x) / worldLength
        : vec2(0.0, 1.0);
    vec2 widthClip = mat2(transform) * worldNormal * width_instance;
    float halfWidthPixels = length(widthClip * viewport_size * 0.5) * 0.5;
    halfWidthPixels = max(halfWidthPixels, minimum_feature_pixels * 0.5);

    float t = position.x * 0.5 + 0.5;
    vec2 centerPixels = mix(startPixels, endPixels, t);
    vec2 adjustedPixels = centerPixels + normal * position.y * halfWidthPixels;
    gl_Position = vec4(pixelToClip(adjustedPixels), 0.0, 1.0);
}
"#;

pub const LINE_FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    fragColor = color;
}
"#;

pub const TRIANGLE_TEMPLATE_VERTEX_SHADER: &str = r#"#version 300 es
precision highp float;
in vec2 position;
in float instance_x;
in float instance_y;
uniform mat3 transform;
void main() {
    vec2 worldPosition = position + vec2(instance_x, instance_y);
    vec3 transformed = transform * vec3(worldPosition, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
"#;

pub const TRIANGLE_TEMPLATE_FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    fragColor = color;
}
"#;

pub const CIRCLE_VERTEX_SHADER: &str = r#"#version 300 es
precision highp float;
in vec2 position;
in float center_x_instance;
in float center_y_instance;
in float radius_instance;
in float hole_x_instance;
in float hole_y_instance;
in float hole_radius_instance;
uniform mat3 transform;
out highp vec2 vPosition;
out highp vec2 vHoleCenter;
out highp float vHoleRadius;
void main() {
    vec2 center = vec2(center_x_instance, center_y_instance);
    vec2 scaledPos = position * radius_instance + center;
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position;
    float safeRadius = max(radius_instance, 0.000000001);
    vHoleCenter = (vec2(hole_x_instance, hole_y_instance) - center) / safeRadius;
    vHoleRadius = hole_radius_instance / safeRadius;
}
"#;

pub const CIRCLE_FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp vec2 vHoleCenter;
in highp float vHoleRadius;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    float dist = dot(vPosition, vPosition);
    if (dist > 1.0) discard;
    if (vHoleRadius > 0.0) {
        vec2 diff = vPosition - vHoleCenter;
        if (dot(diff, diff) < vHoleRadius * vHoleRadius) discard;
    }
    fragColor = color;
}
"#;

pub const ARC_VERTEX_SHADER: &str = r#"#version 300 es
precision highp float;
in vec2 position;
in float center_x_instance;
in float center_y_instance;
in float radius_instance;
in float startAngle_instance;
in float sweepAngle_instance;
in float thickness_instance;
uniform mat3 transform;
uniform vec2 viewport_size;
uniform float minimum_feature_pixels;
out highp vec2 vPosition;
out highp float vRadius;
out highp float vStartAngle;
out highp float vSweepAngle;
out highp float vThickness;

float weakestPixelsPerWorld() {
    vec2 pixelScale = viewport_size * 0.5;
    vec2 axisX = (mat2(transform) * vec2(1.0, 0.0)) * pixelScale;
    vec2 axisY = (mat2(transform) * vec2(0.0, 1.0)) * pixelScale;
    float a = dot(axisX, axisX);
    float b = dot(axisX, axisY);
    float d = dot(axisY, axisY);
    float trace = a + d;
    float discriminant = sqrt(max((a - d) * (a - d) + 4.0 * b * b, 0.0));
    float weakestScaleSquared = max((trace - discriminant) * 0.5, 0.0);
    return sqrt(weakestScaleSquared);
}

void main() {
    float pixelsPerWorld = weakestPixelsPerWorld();
    float minimumWorldThickness = minimum_feature_pixels / max(pixelsPerWorld, 0.000001);
    float effectiveThickness = max(thickness_instance, minimumWorldThickness);
    float maxRadius = max(radius_instance + effectiveThickness * 0.5, 0.0);
    vec2 scaledPos = position * maxRadius + vec2(center_x_instance, center_y_instance);
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position * maxRadius;
    vRadius = radius_instance;
    vStartAngle = startAngle_instance;
    vSweepAngle = sweepAngle_instance;
    vThickness = effectiveThickness;
}
"#;

pub const ARC_FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vRadius;
in highp float vStartAngle;
in highp float vSweepAngle;
in highp float vThickness;
uniform lowp vec4 color;
out lowp vec4 fragColor;

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

float normalizeAngle(float angle) {
    float normalized = mod(angle, TWO_PI);
    if (normalized < 0.0) {
        normalized += TWO_PI;
    }
    return normalized;
}

void main() {
    float dist = length(vPosition);
    float angle = atan(vPosition.y, vPosition.x);

    angle = normalizeAngle(angle);
    float startAngle = normalizeAngle(vStartAngle);
    float endAngle = normalizeAngle(startAngle + vSweepAngle);

    float innerRadius = vRadius - vThickness * 0.5;
    float outerRadius = vRadius + vThickness * 0.5;

    bool inRange;
    if (vSweepAngle > 0.0) {
        if (endAngle > startAngle) {
            inRange = angle >= startAngle && angle <= endAngle;
        } else {
            inRange = angle >= startAngle || angle <= endAngle;
        }
    } else {
        if (endAngle < startAngle) {
            inRange = angle <= startAngle && angle >= endAngle;
        } else {
            inRange = angle <= startAngle || angle >= endAngle;
        }
    }

    bool inArcBody = dist >= innerRadius && dist <= outerRadius && inRange;
    bool hasCaps = abs(vSweepAngle) < TWO_PI - 0.001;
    bool inCap = false;
    if (hasCaps) {
        float halfThickness = vThickness * 0.5;
        vec2 startPoint = vec2(cos(vStartAngle), sin(vStartAngle)) * vRadius;
        vec2 endPoint = vec2(cos(vStartAngle + vSweepAngle), sin(vStartAngle + vSweepAngle)) * vRadius;
        inCap = length(vPosition - startPoint) <= halfThickness
            || length(vPosition - endPoint) <= halfThickness;
    }

    if (!inArcBody && !inCap) {
        discard;
    }

    fragColor = color;
}
"#;

pub const THERMAL_VERTEX_SHADER: &str = r#"#version 300 es
precision highp float;
in vec2 position;
in float center_x_instance;
in float center_y_instance;
in float outer_diameter_instance;
in float inner_diameter_instance;
in float gap_thickness_instance;
in float rotation_instance;
uniform mat3 transform;
out highp vec2 vPosition;
out highp float vInnerDiameter;
out highp float vOuterDiameter;
out highp float vGapThickness;
out highp float vRotation;
void main() {
    float outer_radius = max(outer_diameter_instance, 0.0) * 0.5;
    vec2 scaledPos = position * outer_radius + vec2(center_x_instance, center_y_instance);
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position;
    vInnerDiameter = inner_diameter_instance;
    vOuterDiameter = outer_diameter_instance;
    vGapThickness = gap_thickness_instance;
    vRotation = rotation_instance;
}
"#;

pub const THERMAL_FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vInnerDiameter;
in highp float vOuterDiameter;
in highp float vGapThickness;
in highp float vRotation;
uniform lowp vec4 color;
out lowp vec4 fragColor;

void main() {
    // Inverse-rotate the fragment point into thermal-local space.
    float cosR = cos(vRotation);
    float sinR = sin(vRotation);
    vec2 rotated = vec2(
        vPosition.x * cosR + vPosition.y * sinR,
        -vPosition.x * sinR + vPosition.y * cosR
    );

    float dist = length(rotated);
    float safeOuterDiameter = max(vOuterDiameter, 0.000000001);
    float inner_radius = clamp(vInnerDiameter / safeOuterDiameter, 0.0, 1.0);
    float outer_radius = 1.0;

    // Discard if outside outer radius or inside inner radius
    if (dist > outer_radius || dist < inner_radius) {
        discard;
    }

    // Compute half gap thickness in normalized space
    float half_gap = max(vGapThickness / safeOuterDiameter, 0.0);

    // Discard if in cross-shaped gap region
    if (abs(rotated.x) < half_gap || abs(rotated.y) < half_gap) {
        discard;
    }

    fragColor = color;
}
"#;

pub const TEXTURE_VERTEX_SHADER: &str = r#"#version 300 es
precision mediump float;
in vec2 position;
out mediump vec2 v_uv;
void main() {
    v_uv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}
"#;

pub const TEXTURE_FRAGMENT_SHADER: &str = r#"#version 300 es
precision mediump float;
in mediump vec2 v_uv;
uniform sampler2D u_texture;
uniform lowp vec4 u_color;
out lowp vec4 fragColor;
void main() {
    vec4 texColor = texture(u_texture, v_uv);
    // Pre-multiply alpha: color * alpha for additive blending
    float finalAlpha = u_color.a * texColor.a;
    fragColor = vec4(u_color.rgb * finalAlpha, finalAlpha);
}
"#;

pub const PATH_SOLID_VERTEX_SHADER: &str = r#"#version 300 es
precision highp float;
in vec2 position;
uniform mat3 transform;
void main() {
    vec3 transformed = transform * vec3(position, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
"#;

pub const PATH_SOLID_FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    fragColor = color;
}
"#;

pub const PATH_SECTOR_VERTEX_SHADER: &str = r#"#version 300 es
precision highp float;
in vec2 position;
in vec2 center;
in float radius;
in float startAngle;
in float sweepAngle;
uniform mat3 transform;
out highp vec2 vPosition;
out highp float vStartAngle;
out highp float vSweepAngle;
void main() {
    float safeRadius = max(radius, 0.0);
    vec3 transformed = transform * vec3(position, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = safeRadius > 0.0 ? (position - center) / safeRadius : vec2(2.0, 2.0);
    vStartAngle = startAngle;
    vSweepAngle = sweepAngle;
}
"#;

pub const PATH_SECTOR_FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vStartAngle;
in highp float vSweepAngle;
out lowp vec4 fragColor;

const float TWO_PI = 6.28318530718;

float normalizeAngle(float angle) {
    float normalized = mod(angle, TWO_PI);
    if (normalized < 0.0) {
        normalized += TWO_PI;
    }
    return normalized;
}

void main() {
    if (dot(vPosition, vPosition) > 1.0) {
        discard;
    }

    float angle = normalizeAngle(atan(vPosition.y, vPosition.x));
    float startAngle = normalizeAngle(vStartAngle);
    float sweep = clamp(vSweepAngle, -TWO_PI, TWO_PI);
    float endAngle = normalizeAngle(startAngle + sweep);

    bool inRange;
    if (abs(sweep) >= TWO_PI - 0.00001) {
        inRange = true;
    } else if (sweep > 0.0) {
        if (endAngle > startAngle) {
            inRange = angle >= startAngle && angle <= endAngle;
        } else {
            inRange = angle >= startAngle || angle <= endAngle;
        }
    } else {
        if (endAngle < startAngle) {
            inRange = angle <= startAngle && angle >= endAngle;
        } else {
            inRange = angle <= startAngle || angle >= endAngle;
        }
    }

    if (!inRange) {
        discard;
    }

    fragColor = vec4(1.0);
}
"#;

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
            &["position", "center", "radius", "startAngle", "sweepAngle"],
            &["transform"],
        )?;

        Ok(ShaderPrograms {
            triangle,
            triangle_template,
            line,
            circle,
            arc,
            thermal,
            texture,
            path_solid,
            path_sector,
        })
    }
}

/// Compile a shader program
fn compile_program(
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
