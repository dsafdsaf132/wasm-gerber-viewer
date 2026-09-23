#version 300 es
precision highp float;
in highp float vSide;
in highp float vInnerSide;
in highp float vEdgeWidth;
uniform lowp vec4 color;
uniform float anti_aliasing;
out lowp vec4 fragColor;
void main() {
    float side = abs(vSide);
    float alpha;
    if (anti_aliasing > 0.5) {
        // Analytic edge coverage across the line body (see circle.frag.glsl).
        float edge = vEdgeWidth;
        alpha = clamp((1.0 - side) / edge + 0.5, 0.0, 1.0);
        if (vInnerSide > 0.0) {
            alpha *= clamp((side - vInnerSide) / edge + 0.5, 0.0, 1.0);
        }
    } else {
        alpha = side >= vInnerSide ? 1.0 : 0.0;
    }
    if (alpha <= 0.0) discard;
    fragColor = color * alpha;
}
