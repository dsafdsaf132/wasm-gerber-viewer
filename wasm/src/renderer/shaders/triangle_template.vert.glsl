#version 300 es
precision highp float;
precision highp int;
in vec2 position;
in int instance_x;
in int instance_y;
uniform mat3 transform;
uniform ivec2 u_eye_nm;

void main() {
    vec2 instance_rel = vec2(float(instance_x - u_eye_nm.x) * 0.000001, float(instance_y - u_eye_nm.y) * 0.000001);
    vec2 worldPosition = position + instance_rel;
    vec3 transformed = transform * vec3(worldPosition, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
