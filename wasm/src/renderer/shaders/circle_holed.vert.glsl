#version 300 es
precision highp float;
precision highp int;
in vec2 position;
in int center_x_instance;
in int center_y_instance;
in int radius_instance;
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
out highp float vEdgeWidth;

float sub_i32_to_f32(int a, int b) {
    return a >= b ? float(uint(a) - uint(b)) : -float(uint(b) - uint(a));
}

void main() {
    vec2 center = vec2(sub_i32_to_f32(center_x_instance, u_eye_nm.x) * 0.000001, sub_i32_to_f32(center_y_instance, u_eye_nm.y) * 0.000001);
    float effectiveRadius = max(float(radius_instance) * 0.000001, 0.0);
    float drawnRadius = effectiveRadius;
    vPosition = position;
    vEdgeWidth = 0.0;
    float safeRadius = max(effectiveRadius, 0.000000001);
    if (anti_aliasing > 0.5) {
        drawnRadius = effectiveRadius + 0.5 / pixels_per_world;
        vPosition = position * (drawnRadius / safeRadius);
        vEdgeWidth = 1.0 / max(effectiveRadius * pixels_per_world, 0.000001);
    }
    vec2 scaledPos = position * drawnRadius + center;
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    if (hole_radius_instance > 0) {
        vHoleCenter = vec2(float(hole_x_instance - center_x_instance) * 0.000001, float(hole_y_instance - center_y_instance) * 0.000001) / safeRadius;
        vHoleRadius = (float(hole_radius_instance) * 0.000001) / safeRadius;
    } else {
        vHoleCenter = vec2(0.0);
        vHoleRadius = 0.0;
    }
}
