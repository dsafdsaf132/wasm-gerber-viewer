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
    // Per-sample coverage: this pass runs with SAMPLE_ALPHA_TO_COVERAGE, so
    // alpha selects the samples and the colour is the value they take, white
    // for a dark sublayer and black for a clear one.
    fragColor = vec4(color.rgb, alpha);
}
