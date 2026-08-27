#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_membership;
uniform sampler2D u_outline;
uniform highp uint u_selected_code;
uniform bool u_clip_to_outline;

out highp vec4 fragColor;

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    uvec3 rgb = uvec3(round(texelFetch(u_membership, pixel, 0).rgb * 255.0));
    uint code = rgb.r | (rgb.g << 8u) | (rgb.b << 16u);
    if (code != u_selected_code) discard;
    if (u_clip_to_outline && texelFetch(u_outline, pixel, 0).r < 0.5) discard;

    ivec2 local = pixel & 3;
    if (local.x >= 2 || local.y >= 2) discard;

    ivec2 tile = pixel >> 2;
    if (((tile.x ^ tile.y) & 1) == 0) {
        fragColor = vec4(1.0, 1.0, 1.0, 0.86);
    } else {
        fragColor = vec4(0.0, 0.0, 0.0, 0.72);
    }
}
