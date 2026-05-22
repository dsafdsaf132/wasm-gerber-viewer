#version 300 es
precision highp float;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    fragColor = color;
}
