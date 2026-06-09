#version 300 es
precision highp float;
in vec2 position;
in float start_x_instance;
in float start_y_instance;
in float end_x_instance;
in float end_y_instance;
in float width_instance;
uniform mat3 transform;
uniform vec2 viewport_size;
uniform float minimum_feature_pixels;
uniform float inner_outline_pixels;
uniform float inner_outline_world;
out highp float vSide;
out highp float vInnerSide;

vec2 clipToPixel(vec2 clipPosition) {
    return clipPosition * viewport_size * 0.5;
}

vec2 pixelToClip(vec2 pixelPosition) {
    return pixelPosition / max(viewport_size * 0.5, vec2(1.0));
}

void main() {
    vec2 start = vec2(start_x_instance, start_y_instance);
    vec2 end = vec2(end_x_instance, end_y_instance);
    vec3 startClip = transform * vec3(start, 1.0);
    vec3 endClip = transform * vec3(end, 1.0);
    vec2 startPixels = clipToPixel(startClip.xy);
    vec2 endPixels = clipToPixel(endClip.xy);

    vec2 linePixels = endPixels - startPixels;
    float lineLength = length(linePixels);
    vec2 direction = lineLength > 0.000001 ? linePixels / lineLength : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);

    vec2 lineWorld = end - start;
    float worldLength = length(lineWorld);
    vec2 worldNormal = worldLength > 0.000001
        ? vec2(-lineWorld.y, lineWorld.x) / worldLength
        : vec2(0.0, 1.0);
    vec2 widthClip = mat2(transform) * worldNormal * width_instance;
    float halfWidthPixels = length(widthClip * viewport_size * 0.5) * 0.5;
    halfWidthPixels = max(halfWidthPixels, minimum_feature_pixels * 0.5);
    float pixelsPerWorld = width_instance > 0.000001
        ? halfWidthPixels / (width_instance * 0.5)
        : 0.0;
    float outlinePixels = inner_outline_pixels + inner_outline_world * pixelsPerWorld;
    float expandedHalfWidthPixels = halfWidthPixels + outlinePixels;
    vSide = position.y;
    vInnerSide = outlinePixels > 0.0 && expandedHalfWidthPixels > 0.000001
        ? halfWidthPixels / expandedHalfWidthPixels
        : 0.0;

    float t = position.x * 0.5 + 0.5;
    vec2 centerPixels = mix(startPixels, endPixels, t);
    vec2 adjustedPixels = centerPixels + normal * position.y * expandedHalfWidthPixels;
    gl_Position = vec4(pixelToClip(adjustedPixels), 0.0, 1.0);
}
