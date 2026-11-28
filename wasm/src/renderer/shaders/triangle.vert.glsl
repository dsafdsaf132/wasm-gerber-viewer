#version 300 es
precision highp float;
precision highp int;
in ivec2 position;
in int hole_x_instance;
in int hole_y_instance;
in int hole_radius_instance;
uniform mat3 transform;
uniform ivec2 u_eye_nm;
uniform float pixels_per_world;
uniform float anti_aliasing;
out highp vec2 vPosition;
out highp vec2 vHoleCenter;
out highp float vHoleRadius;
out highp float vWorldPerPixel;

float sub_i32_to_f32(int a, int b) {
    return a >= b ? float(uint(a) - uint(b)) : -float(uint(b) - uint(a));
}

void main() {
    vec2 pos_rel = vec2(sub_i32_to_f32(position.x, u_eye_nm.x) * 0.000001, sub_i32_to_f32(position.y, u_eye_nm.y) * 0.000001);
    vec3 transformed = transform * vec3(pos_rel, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = pos_rel;
    if (hole_radius_instance > 0) {
        vHoleCenter = vec2(sub_i32_to_f32(hole_x_instance, u_eye_nm.x) * 0.000001, sub_i32_to_f32(hole_y_instance, u_eye_nm.y) * 0.000001);
        vHoleRadius = float(hole_radius_instance) * 0.000001;
    } else {
        vHoleCenter = vec2(0.0);
        vHoleRadius = 0.0;
    }
    vWorldPerPixel = anti_aliasing > 0.5 ? 1.0 / pixels_per_world : 0.0;
}
