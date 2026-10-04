#version 300 es
precision highp float;
in vec2 position;
in float hole_x_instance;
in float hole_y_instance;
in float hole_radius_instance;
uniform mat3 transform;
// Pixels per world unit along the view's weaker axis, computed once per
// view on the CPU and only read when anti-aliasing is on.
uniform float pixels_per_world;
uniform float anti_aliasing;
out highp vec2 vPosition;
out highp vec2 vHoleCenter;
out highp float vHoleRadius;
// World units per pixel for the anti-aliased hole edge.
out highp float vWorldPerPixel;
void main() {
    vec3 transformed = transform * vec3(position, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position;
    vHoleCenter = vec2(hole_x_instance, hole_y_instance);
    vHoleRadius = hole_radius_instance;
    vWorldPerPixel = anti_aliasing > 0.5 ? 1.0 / pixels_per_world : 0.0;
}
