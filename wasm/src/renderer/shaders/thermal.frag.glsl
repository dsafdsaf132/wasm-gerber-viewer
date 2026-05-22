#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vInnerDiameter;
in highp float vOuterDiameter;
in highp float vGapThickness;
in highp float vRotation;
uniform lowp vec4 color;
out lowp vec4 fragColor;

void main() {
    // Inverse-rotate the fragment point into thermal-local space.
    float cosR = cos(vRotation);
    float sinR = sin(vRotation);
    vec2 rotated = vec2(
        vPosition.x * cosR + vPosition.y * sinR,
        -vPosition.x * sinR + vPosition.y * cosR
    );

    float dist = length(rotated);
    float safeOuterDiameter = max(vOuterDiameter, 0.000000001);
    float inner_radius = clamp(vInnerDiameter / safeOuterDiameter, 0.0, 1.0);
    float outer_radius = 1.0;

    // Discard if outside outer radius or inside inner radius
    if (dist > outer_radius || dist < inner_radius) {
        discard;
    }

    // Compute half gap thickness in normalized space
    float half_gap = max(vGapThickness / safeOuterDiameter, 0.0);

    // Discard if in cross-shaped gap region
    if (abs(rotated.x) < half_gap || abs(rotated.y) < half_gap) {
        discard;
    }

    fragColor = color;
}
