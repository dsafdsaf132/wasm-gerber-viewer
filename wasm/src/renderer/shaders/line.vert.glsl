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

void main() {
    // Relative-To-Eye: subtract u_eye_nm in integer space first
    vec2 start = vec2(float(start_x_instance - u_eye_nm.x) * 0.000001, float(start_y_instance - u_eye_nm.y) * 0.000001);
    vec2 end = vec2(float(end_x_instance - u_eye_nm.x) * 0.000001, float(end_y_instance - u_eye_nm.y) * 0.000001);

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
    vec2 vertexWorld;

    // When unclamped and no outline, horizontal and vertical raster lines
    // use exact integer nanometer edge alignment to prevent 1-ULP raster seams
    bool useExactInteger = (clampedHalfWidthPixels <= halfWidthPixels) && (outlineWorld == 0.0);

    if (useExactInteger && start_y_instance == end_y_instance) {
        float norm_y = worldNormal.y * position.y;
        int half_w_top = (width_instance + 1) / 2;
        int half_w_bottom = width_instance / 2;
        int edge_y_nm = start_y_instance + (norm_y > 0.0 ? half_w_top : -half_w_bottom);
        int edge_x_nm = position.x < 0.0 ? start_x_instance : end_x_instance;
        vertexWorld = vec2(float(edge_x_nm - u_eye_nm.x) * 0.000001, float(edge_y_nm - u_eye_nm.y) * 0.000001);
    } else if (useExactInteger && start_x_instance == end_x_instance) {
        float norm_x = worldNormal.x * position.y;
        int half_w_right = (width_instance + 1) / 2;
        int half_w_left = width_instance / 2;
        int edge_x_nm = start_x_instance + (norm_x > 0.0 ? half_w_right : -half_w_left);
        int edge_y_nm = position.x < 0.0 ? start_y_instance : end_y_instance;
        vertexWorld = vec2(float(edge_x_nm - u_eye_nm.x) * 0.000001, float(edge_y_nm - u_eye_nm.y) * 0.000001);
    } else {
        vertexWorld = centerWorld + worldNormal * (position.y * totalHalfWidthWorld);
    }

    // Transform directly to clip space
    vec3 transformed = transform * vec3(vertexWorld, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
