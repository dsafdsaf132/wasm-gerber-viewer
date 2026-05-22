#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp vec2 vHoleCenter;
in highp float vHoleRadius;
uniform lowp vec4 color;
out lowp vec4 fragColor;
void main() {
    float dist = dot(vPosition, vPosition);
    if (dist > 1.0) discard;
    if (vHoleRadius > 0.0) {
        vec2 diff = vPosition - vHoleCenter;
        if (dot(diff, diff) < vHoleRadius * vHoleRadius) discard;
    }
    fragColor = color;
}
