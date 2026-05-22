#version 300 es
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
