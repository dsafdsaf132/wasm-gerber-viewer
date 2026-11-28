#version 300 es
precision highp float;
precision highp int;
in vec2 position;
in int start_x_instance;
in int start_y_instance;
in int end_x_instance;
in int end_y_instance;
in int width_instance;
uniform mat3 transform;
uniform ivec2 u_eye_nm;
uniform vec2 viewport_size;
uniform float minimum_feature_pixels;
uniform float inner_outline_pixels;
uniform float inner_outline_world;
out highp float vSide;
out highp float vInnerSide;

float sub_i32_to_f32(int a, int b) {
    return a >= b ? float(uint(a) - uint(b)) : -float(uint(b) - uint(a));
}

void main() {
    // Relative-To-Eye: subtract u_eye_nm in overflow-safe integer space first
    vec2 start = vec2(sub_i32_to_f32(start_x_instance, u_eye_nm.x) * 0.000001, sub_i32_to_f32(start_y_instance, u_eye_nm.y) * 0.000001);
    vec2 end = vec2(sub_i32_to_f32(end_x_instance, u_eye_nm.x) * 0.000001, sub_i32_to_f32(end_y_instance, u_eye_nm.y) * 0.000001);

    // Compute line segment direction and normal in world space
    vec2 lineWorld = end - start;
    float worldLength = length(lineWorld);
    vec2 worldNormal = worldLength > 0.000001
        ? vec2(-lineWorld.y, lineWorld.x) / worldLength
        : vec2(0.0, 1.0);

    // Screen pixel scale along the normal
    vec2 normalClip = mat2(transform) * worldNormal;
    float pixelsPerWorld = length(normalClip * viewport_size * 0.5);

    float baseHalfWidthWorld = float(width_instance) * 0.0000005;
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

    // Compute vertex in world coordinates
    float t = position.x * 0.5 + 0.5;
    vec2 centerWorld = mix(start, end, t);
    vec2 vertexWorld = centerWorld + worldNormal * (position.y * totalHalfWidthWorld);

    // Transform directly to clip space
    vec3 transformed = transform * vec3(vertexWorld, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
