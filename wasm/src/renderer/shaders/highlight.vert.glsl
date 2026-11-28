#version 300 es
precision highp float;
precision highp int;

in ivec2 position;
uniform mat3 transform;
uniform ivec2 u_eye_nm;

float sub_i32_to_f32(int a, int b) {
    return a >= b ? float(uint(a) - uint(b)) : -float(uint(b) - uint(a));
}

void main() {
    vec2 pos_rel = vec2(sub_i32_to_f32(position.x, u_eye_nm.x) * 0.000001, sub_i32_to_f32(position.y, u_eye_nm.y) * 0.000001);
    vec3 transformed = transform * vec3(pos_rel, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
