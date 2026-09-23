#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vInnerRadius;
in highp float vEdgeWidth;
uniform lowp vec4 color;
uniform float anti_aliasing;
out lowp vec4 fragColor;
void main() {
    if (anti_aliasing <= 0.5) {
        // Point-sampled, exactly as before the option existed.
        float dist = dot(vPosition, vPosition);
        float innerDist = vInnerRadius * vInnerRadius;
        if (dist > 1.0 || dist < innerDist) discard;
        fragColor = color;
        return;
    }
    // Analytic edge coverage: the disc edge is at length(vPosition) == 1.0
    // and vEdgeWidth is how much that length changes across one pixel, so
    // alpha ramps over exactly one pixel. Multisampling alone cannot smooth
    // an edge shaped by discard.
    float dist = length(vPosition);
    float alpha = clamp((1.0 - dist) / vEdgeWidth + 0.5, 0.0, 1.0);
    if (vInnerRadius > 0.0) {
        alpha *= clamp((dist - vInnerRadius) / vEdgeWidth + 0.5, 0.0, 1.0);
    }
    if (alpha <= 0.0) discard;
    fragColor = color * alpha;
}
