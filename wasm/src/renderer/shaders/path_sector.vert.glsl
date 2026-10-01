#version 300 es
precision highp float;
in vec2 position;
in vec2 center;
in float radius;
uniform mat3 transform;
uniform float anti_aliasing;
uniform float pixels_per_world;
out highp vec2 vPosition;
out highp float vEdgeWidth;
void main() {
    float safeRadius = max(radius, 0.0);
    vec2 drawnPosition = position;
    int corner = gl_VertexID % 6;
    if (anti_aliasing > 0.5 && (corner == 2 || corner == 4 || corner == 5)) {
        // Only the outer corners move. The inner chord must keep matching
        // the solid wedge used by the stencil parity construction.
        drawnPosition = center + (position - center)
            * (1.0 + 0.5 / max(safeRadius * pixels_per_world, 0.000001));
    }
    vec3 transformed = transform * vec3(drawnPosition, 1.0);
    gl_Position = vec4(transformed.xy, 0.0, 1.0);
    vPosition = safeRadius > 0.0 ? (drawnPosition - center) / safeRadius : vec2(2.0, 2.0);
    vEdgeWidth = anti_aliasing > 0.5
        ? 1.0 / max(safeRadius * pixels_per_world, 0.000001)
        : 0.0;
}
