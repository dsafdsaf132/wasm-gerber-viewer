#version 300 es
precision highp float;
in highp vec2 vPosition;
out lowp vec4 fragColor;

const float EDGE_EPSILON = 0.0000001;

void main() {
    if (dot(vPosition, vPosition) > 1.0 + EDGE_EPSILON) {
        discard;
    }

    fragColor = vec4(1.0);
}
