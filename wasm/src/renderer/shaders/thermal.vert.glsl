#version 300 es
precision highp float;
precision highp int;
in vec2 position;
in int center_x_instance;
in int center_y_instance;
in int outer_diameter_instance;
in int inner_diameter_instance;
in int gap_thickness_instance;
in float rotation_instance;
uniform mat3 transform;
uniform ivec2 u_eye_nm;
out highp vec2 vPosition;
out highp float vInnerDiameter;
out highp float vOuterDiameter;
out highp float vGapThickness;
out highp float vRotation;

float sub_i32_to_f32(int a, int b) {
    return a >= b ? float(uint(a) - uint(b)) : -float(uint(b) - uint(a));
}

void main() {
    float outer_diameter = float(outer_diameter_instance) * 0.000001;
    float outer_radius = max(outer_diameter, 0.0) * 0.5;
    vec2 center = vec2(sub_i32_to_f32(center_x_instance, u_eye_nm.x) * 0.000001, sub_i32_to_f32(center_y_instance, u_eye_nm.y) * 0.000001);
    vec2 scaledPos = position * outer_radius + center;
    vec3 transformed = transform * vec3(scaledPos, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = position;
    vInnerDiameter = float(inner_diameter_instance) * 0.000001;
    vOuterDiameter = outer_diameter;
    vGapThickness = float(gap_thickness_instance) * 0.000001;
    vRotation = rotation_instance;
}
