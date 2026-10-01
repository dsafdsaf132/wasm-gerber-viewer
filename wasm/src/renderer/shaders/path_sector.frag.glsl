#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vEdgeWidth;
uniform float anti_aliasing;
out lowp vec4 fragColor;

const float EDGE_EPSILON = 0.0000001;

void main() {
    if (anti_aliasing > 0.5) {
        // Alpha-to-coverage also masks stencil writes. Keep the contour's
        // parity operation binary per sample, including clear and holes.
        float alpha = clamp((1.0 - length(vPosition)) / vEdgeWidth + 0.5, 0.0, 1.0);
        if (alpha <= 0.0) discard;
        fragColor = vec4(1.0, 1.0, 1.0, alpha);
        return;
    }
    if (dot(vPosition, vPosition) > 1.0 + EDGE_EPSILON) {
        discard;
    }

    fragColor = vec4(1.0);
}
