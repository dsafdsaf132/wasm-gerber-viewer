#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vInnerRadius;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    float dist = dot(vPosition, vPosition);
    float innerDist = vInnerRadius * vInnerRadius;
    if (dist > 1.0 || dist < innerDist) discard;
    fragColor = color;
}
