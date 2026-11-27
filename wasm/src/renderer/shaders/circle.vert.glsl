#version 300 es
precision highp float;
precision highp int;
in vec2 position;
in int center_x_instance;
in int center_y_instance;
in int radius_instance;
uniform mat3 transform;
uniform ivec2 u_eye_nm;
uniform vec2 viewport_size;
uniform float pixels_per_world;
uniform float anti_aliasing;
uniform float inner_outline_pixels;
uniform float inner_outline_world;
out highp vec2 vPosition;
out highp float vInnerRadius;
out highp float vEdgeWidth;

float weakestPixelsPerWorld() {
    vec2 pixelScale = viewport_size * 0.5;
    vec2 axisX = (mat2(transform) * vec2(1.0, 0.0)) * pixelScale;
    vec2 axisY = (mat2(transform) * vec2(0.0, 1.0)) * pixelScale;
    float a = dot(axisX, axisX);
    float b = dot(axisX, axisY);
    float d = dot(axisY, axisY);
    float trace = a + d;
    float discriminant = sqrt(max((a - d) * (a - d) + 4.0 * b * b, 0.0));
    float weakestScaleSquared = max((trace - discriminant) * 0.5, 0.0);
    return sqrt(weakestScaleSquared);
}

void main() {
    vec2 center = vec2(float(center_x_instance - u_eye_nm.x) * 0.000001, float(center_y_instance - u_eye_nm.y) * 0.000001);
    float pixelsPerWorld = weakestPixelsPerWorld();
    float outlineWorldRadius = inner_outline_world
        + inner_outline_pixels / max(pixelsPerWorld, 0.000001);
    float baseRadius = max(float(radius_instance) * 0.000001, 0.0);
    float effectiveRadius = baseRadius + outlineWorldRadius;
    float drawnRadius = effectiveRadius;
    vPosition = position;
    vEdgeWidth = 0.0;
    if (anti_aliasing > 0.5) {
        drawnRadius = effectiveRadius + 0.5 / pixels_per_world;
        vPosition = position * (drawnRadius / max(effectiveRadius, 0.000000001));
        vEdgeWidth = 1.0 / max(effectiveRadius * pixels_per_world, 0.000001);
    }
    vec2 scaledPos = position * drawnRadius + center;
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vInnerRadius = outlineWorldRadius > 0.0 && effectiveRadius > 0.000001
        ? baseRadius / effectiveRadius
        : 0.0;
}
