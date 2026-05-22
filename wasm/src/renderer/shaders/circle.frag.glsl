#version 300 es
precision highp float;
in highp vec2 vPosition;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    float dist = dot(vPosition, vPosition);
    if (dist > 1.0) discard;
    fragColor = color;
}
