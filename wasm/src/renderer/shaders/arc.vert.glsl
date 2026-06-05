#version 300 es
precision highp float;
in vec2 position;
in float center_x_instance;
in float center_y_instance;
in float radius_instance;
in float startAngle_instance;
in float sweepAngle_instance;
in float thickness_instance;
uniform mat3 transform;
uniform vec2 viewport_size;
uniform float minimum_feature_pixels;
uniform float inner_outline_pixels;
uniform float inner_outline_world;
out highp vec2 vPosition;
out highp float vRadius;
out highp float vStartAngle;
out highp float vSweepAngle;
out highp float vThickness;
out highp float vOutlineThickness;

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
    float pixelsPerWorld = weakestPixelsPerWorld();
    float minimumWorldThickness = minimum_feature_pixels / max(pixelsPerWorld, 0.000001);
    float effectiveThickness = max(thickness_instance, minimumWorldThickness);
    float maxRadius = max(radius_instance + effectiveThickness * 0.5, 0.0);
    vec2 scaledPos = position * maxRadius + vec2(center_x_instance, center_y_instance);
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position * maxRadius;
    vRadius = radius_instance;
    vStartAngle = startAngle_instance;
    vSweepAngle = sweepAngle_instance;
    vThickness = effectiveThickness;
    vOutlineThickness = inner_outline_world
        + inner_outline_pixels / max(pixelsPerWorld, 0.000001);
}
