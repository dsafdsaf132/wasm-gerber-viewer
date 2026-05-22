#version 300 es
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
