#version 300 es
precision highp float;

in vec2 position;
uniform mat3 transform;

void main() {
    vec3 transformed = transform * vec3(position, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
}
