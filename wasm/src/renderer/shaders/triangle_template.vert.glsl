#version 300 es
precision highp float;
in vec2 position;
in float instance_x;
in float instance_y;
uniform mat3 transform;
void main() {
    vec2 worldPosition = position + vec2(instance_x, instance_y);
    vec3 transformed = transform * vec3(worldPosition, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
