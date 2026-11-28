#version 300 es
precision highp float;
precision highp int;
in vec2 position;
in int center_x_instance;
in int center_y_instance;
in int radius_instance;
in float startAngle_instance;
in float sweepAngle_instance;
in int thickness_instance;
uniform mat3 transform;
uniform ivec2 u_eye_nm;
uniform vec2 viewport_size;
uniform float minimum_feature_pixels;
uniform float pixels_per_world;
uniform float anti_aliasing;
uniform float inner_outline_pixels;
uniform float inner_outline_world;
out highp vec2 vPosition;
out highp float vRadius;
out highp float vStartAngle;
out highp float vWorldPerPixel;
out highp float vSweepAngle;
out highp float vThickness;
out highp float vOutlineThickness;

float sub_i32_to_f32(int a, int b) {
    return a >= b ? float(uint(a) - uint(b)) : -float(uint(b) - uint(a));
}

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
    float outlineWorldThickness = inner_outline_world
        + inner_outline_pixels / max(pixelsPerWorld, 0.000001);
    float rawThickness = float(thickness_instance) * 0.000001;
    float rawRadius = float(radius_instance) * 0.000001;
    float effectiveThickness = max(rawThickness, minimumWorldThickness)
        + outlineWorldThickness * 2.0;
    float maxRadius = max(rawRadius + effectiveThickness * 0.5, 0.0);
    float drawnRadius = maxRadius;
    vWorldPerPixel = 0.0;
    if (anti_aliasing > 0.5) {
        vWorldPerPixel = 1.0 / pixels_per_world;
        drawnRadius = maxRadius + 0.5 * vWorldPerPixel;
    }
    vec2 center = vec2(sub_i32_to_f32(center_x_instance, u_eye_nm.x) * 0.000001, sub_i32_to_f32(center_y_instance, u_eye_nm.y) * 0.000001);
    vec2 scaledPos = position * drawnRadius + center;
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position * drawnRadius;
    vRadius = rawRadius;
    vStartAngle = startAngle_instance;
    vSweepAngle = sweepAngle_instance;
    vThickness = effectiveThickness;
    vOutlineThickness = outlineWorldThickness;
}
