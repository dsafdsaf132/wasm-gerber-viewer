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

void main() {
    vec2 start = vec2(start_x_instance, start_y_instance);
    vec2 end = vec2(end_x_instance, end_y_instance);

    // Compute line segment direction and normal in world space
    vec2 lineWorld = end - start;
    float worldLength = length(lineWorld);
    vec2 worldNormal = worldLength > 0.000001
        ? vec2(-lineWorld.y, lineWorld.x) / worldLength
        : vec2(0.0, 1.0);

    // Screen pixel scale along the normal
    vec2 normalClip = mat2(transform) * worldNormal;
    float pixelsPerWorld = length(normalClip * viewport_size * 0.5);

    float baseHalfWidthWorld = width_instance * 0.5;
    float halfWidthPixels = baseHalfWidthWorld * pixelsPerWorld;

    // Minimum feature clamping and outline calculations
    float clampedHalfWidthPixels = max(halfWidthPixels, minimum_feature_pixels * 0.5);
    float effectiveHalfWidthWorld = (clampedHalfWidthPixels > halfWidthPixels && pixelsPerWorld > 0.000001)
        ? clampedHalfWidthPixels / pixelsPerWorld
        : baseHalfWidthWorld;

    float outlineWorld = inner_outline_world
        + (inner_outline_pixels > 0.0 && pixelsPerWorld > 0.000001 ? inner_outline_pixels / pixelsPerWorld : 0.0);
    float totalHalfWidthWorld = effectiveHalfWidthWorld + outlineWorld;

    vSide = position.y;
    vInnerSide = outlineWorld > 0.0 && totalHalfWidthWorld > 0.000001
        ? effectiveHalfWidthWorld / totalHalfWidthWorld
        : 0.0;

    // Compute vertex directly in world coordinates
    float t = position.x * 0.5 + 0.5;
    vec2 centerWorld = mix(start, end, t);
    vec2 vertexWorld = centerWorld + worldNormal * (position.y * totalHalfWidthWorld);

    // Transform directly to clip space
    vec3 transformed = transform * vec3(vertexWorld, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
