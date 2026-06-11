#version 300 es
precision highp float;

out vec4 fragColor;

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    ivec2 local = pixel & 3;
    ivec2 tile = pixel >> 2;

    if (local.x >= 2 || local.y >= 2) {
        discard;
    }

    if (((tile.x ^ tile.y) & 1) == 0) {
        fragColor = vec4(1.0, 1.0, 1.0, 0.86);
    } else {
        fragColor = vec4(0.0, 0.0, 0.0, 0.72);
    }
}
