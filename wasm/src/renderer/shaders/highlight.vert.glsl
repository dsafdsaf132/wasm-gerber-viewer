#version 300 es
precision highp float;
precision highp int;

in vec2 position;
uniform mat3 transform;
uniform ivec2 u_eye_nm;

void main() {
    vec2 eye_mm = vec2(float(u_eye_nm.x) * 0.000001, float(u_eye_nm.y) * 0.000001);
    vec3 transformed = transform * vec3(position - eye_mm, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
