#version 300 es
precision highp float;
in vec2 position;
in float center_x_instance;
in float center_y_instance;
in float outer_diameter_instance;
in float inner_diameter_instance;
in float gap_thickness_instance;
in float rotation_instance;
uniform mat3 transform;
out highp vec2 vPosition;
out highp float vInnerDiameter;
out highp float vOuterDiameter;
out highp float vGapThickness;
out highp float vRotation;
void main() {
    float outer_radius = max(outer_diameter_instance, 0.0) * 0.5;
    vec2 scaledPos = position * outer_radius + vec2(center_x_instance, center_y_instance);
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position;
    vInnerDiameter = inner_diameter_instance;
    vOuterDiameter = outer_diameter_instance;
    vGapThickness = gap_thickness_instance;
    vRotation = rotation_instance;
}
