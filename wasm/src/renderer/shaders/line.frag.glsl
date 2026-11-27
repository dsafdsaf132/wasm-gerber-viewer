#version 300 es
precision highp float;
in highp float vSide;
in highp float vInnerSide;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    if (abs(vSide) < vInnerSide) discard;
    fragColor = color;
}
