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
// Pixels per world unit along the view's weaker axis, computed once per
// view on the CPU and only read when anti-aliasing is on.
uniform float pixels_per_world;
uniform float anti_aliasing;
out highp vec2 vPosition;
out highp vec2 vHoleCenter;
out highp float vHoleRadius;
// Change of length(vPosition) across one pixel for the anti-aliased edge.
out highp float vEdgeWidth;

void main() {
    vec2 center = vec2(center_x_instance, center_y_instance);
    float effectiveRadius = max(radius_instance, 0.0);
    float drawnRadius = effectiveRadius;
    vPosition = position;
    vEdgeWidth = 0.0;
    float safeRadius = max(effectiveRadius, 0.000000001);
    if (anti_aliasing > 0.5) {
        // Half-pixel fringe as in circle.vert.glsl.
        drawnRadius = effectiveRadius + 0.5 / pixels_per_world;
        vPosition = position * (drawnRadius / safeRadius);
        vEdgeWidth = 1.0 / max(effectiveRadius * pixels_per_world, 0.000001);
    }
    vec2 scaledPos = position * drawnRadius + center;
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vHoleCenter = (vec2(hole_x_instance, hole_y_instance) - center) / safeRadius;
    vHoleRadius = hole_radius_instance / safeRadius;
}
