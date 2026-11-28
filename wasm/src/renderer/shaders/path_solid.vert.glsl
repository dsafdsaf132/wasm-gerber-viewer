#version 300 es
precision highp float;
precision highp int;
in ivec2 position;
uniform mat3 transform;
uniform ivec2 u_eye_nm;
uniform float bounds_padding;

float sub_i32_to_f32(int a, int b) {
    return a >= b ? float(uint(a) - uint(b)) : -float(uint(b) - uint(a));
}

void main() {
    vec2 drawnPosition = vec2(
        sub_i32_to_f32(position.x, u_eye_nm.x) * 0.000001,
        sub_i32_to_f32(position.y, u_eye_nm.y) * 0.000001
    );
    if (bounds_padding > 0.0) {
        // Bounds quads use [LL, RL, LU, LU, RL, RU]. Do not pad wedges.
        int corner = gl_VertexID % 6;
        drawnPosition += bounds_padding * vec2(
            corner == 0 || corner == 2 || corner == 3 ? -1.0 : 1.0,
            corner == 0 || corner == 1 || corner == 4 ? -1.0 : 1.0);
    }
    vec3 transformed = transform * vec3(drawnPosition, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
