#version 300 es
precision highp float;
in vec2 position;
in vec2 center;
in float radius;
uniform mat3 transform;
out highp vec2 vPosition;
void main() {
    float safeRadius = max(radius, 0.0);
    vec3 transformed = transform * vec3(position, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = safeRadius > 0.0 ? (position - center) / safeRadius : vec2(2.0, 2.0);
}
