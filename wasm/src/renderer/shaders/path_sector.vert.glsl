#version 300 es
precision highp float;
precision highp int;
in ivec2 position;
in ivec2 center;
in int radius;
uniform mat3 transform;
uniform ivec2 u_eye_nm;
uniform float anti_aliasing;
uniform float pixels_per_world;
out highp vec2 vPosition;
out highp float vEdgeWidth;

float sub_i32_to_f32(int a, int b) {
    return a >= b ? float(uint(a) - uint(b)) : -float(uint(b) - uint(a));
}

void main() {
    float safeRadius = max(float(radius) * 0.000001, 0.0);
    vec2 pos_rel = vec2(
        sub_i32_to_f32(position.x, u_eye_nm.x) * 0.000001,
        sub_i32_to_f32(position.y, u_eye_nm.y) * 0.000001
    );
    vec2 center_rel = vec2(
        sub_i32_to_f32(center.x, u_eye_nm.x) * 0.000001,
        sub_i32_to_f32(center.y, u_eye_nm.y) * 0.000001
    );
    vec2 drawnPosition = pos_rel;
    int corner = gl_VertexID % 6;
    if (anti_aliasing > 0.5 && (corner == 2 || corner == 4 || corner == 5)) {
        drawnPosition = center_rel + (pos_rel - center_rel)
            * (1.0 + 0.5 / max(safeRadius * pixels_per_world, 0.000001));
    }
    vec3 transformed = transform * vec3(drawnPosition, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = safeRadius > 0.0 ? (drawnPosition - center_rel) / safeRadius : vec2(2.0, 2.0);
    vEdgeWidth = anti_aliasing > 0.5
        ? 1.0 / max(safeRadius * pixels_per_world, 0.000001)
        : 0.0;
}
