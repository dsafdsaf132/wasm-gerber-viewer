#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_membership;
uniform highp usampler2D u_lookup;
uniform sampler2D u_outline;
uniform int u_lookup_width;
uniform bool u_inverted;

out highp vec4 fragColor;

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    uvec3 rgb = uvec3(round(texelFetch(u_membership, pixel, 0).rgb * 255.0));
    uint code = rgb.r | (rgb.g << 8u) | (rgb.b << 16u);
    uint byte_index = code >> 3u;
    int lookup_x = int(byte_index % uint(u_lookup_width));
    int lookup_y = int(byte_index / uint(u_lookup_width));
    uint lookup_byte = texelFetch(u_lookup, ivec2(lookup_x, lookup_y), 0).r;
    bool selected = (lookup_byte & (1u << (code & 7u))) != 0u;
    bool inside_outline = texelFetch(u_outline, pixel, 0).r >= 0.5;
    if (code == 0u) selected = selected && inside_outline;
    if (u_inverted) selected = inside_outline && !selected;
    float mask = selected ? 1.0 : 0.0;
    // R8 output stores red; RGBA8 fallback uses alpha. Writing both keeps the
    // lookup shader identical for both framebuffer formats.
    fragColor = vec4(mask, 0.0, 0.0, mask);
}
