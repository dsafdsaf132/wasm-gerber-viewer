#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp vec2 vHoleCenter;
in highp float vHoleRadius;
in highp float vWorldPerPixel;
uniform lowp vec4 color;
uniform float anti_aliasing;
out lowp vec4 fragColor;
void main() {
    if (anti_aliasing <= 0.5) {
        // Point-sampled, exactly as before the option existed.
        if (vHoleRadius > 0.0) {
            vec2 diff = vPosition - vHoleCenter;
            if (dot(diff, diff) < vHoleRadius * vHoleRadius) discard;
        }
        fragColor = color;
        return;
    }
    // Analytic edge coverage for the hole; the outer edges are triangle
    // edges and get their anti-aliasing from multisampling.
    float alpha = 1.0;
    if (vHoleRadius > 0.0) {
        float holeDist = length(vPosition - vHoleCenter);
        alpha = clamp((holeDist - vHoleRadius) / vWorldPerPixel + 0.5, 0.0, 1.0);
        if (alpha <= 0.0) discard;
    }
    fragColor = color * alpha;
}
