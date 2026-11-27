#version 300 es
precision highp float;
precision highp int;
in vec2 position;
uniform mat3 transform;
uniform ivec2 u_eye_nm;
uniform float bounds_padding;

void main() {
    vec2 drawnPosition = position;
    if (bounds_padding > 0.0) {
        // Bounds quads use [LL, RL, LU, LU, RL, RU]. Do not pad wedges.
        int corner = gl_VertexID % 6;
        drawnPosition += bounds_padding * vec2(
            corner == 0 || corner == 2 || corner == 3 ? -1.0 : 1.0,
            corner == 0 || corner == 1 || corner == 4 ? -1.0 : 1.0);
    }
    vec2 eye_mm = vec2(float(u_eye_nm.x) * 0.000001, float(u_eye_nm.y) * 0.000001);
    vec3 transformed = transform * vec3(drawnPosition - eye_mm, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
