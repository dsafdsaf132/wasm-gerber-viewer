#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_membership;
uniform highp usampler2D u_lookup;
uniform sampler2D u_outline;
uniform int u_lookup_width;

out highp vec4 fragColor;

uint mixHash24(uint value) {
    const uint mask24 = 0x00ffffffu;
    value &= mask24;
    value ^= value >> 12u;
    value = (value * 0x0045d9f3u) & mask24;
    value ^= value >> 11u;
    value = (value * 0x00119de1u) & mask24;
    value ^= value >> 13u;
    return value & mask24;
}

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    uvec3 rgb = uvec3(round(texelFetch(u_membership, pixel, 0).rgb * 255.0));
    uint code = rgb.r | (rgb.g << 8u) | (rgb.b << 16u);
    bool inside_outline = texelFetch(u_outline, pixel, 0).r >= 0.5;
    if (code == 0u && !inside_outline) discard;

    uint byte_index = code >> 3u;
    int lookup_x = int(byte_index % uint(u_lookup_width));
    int lookup_y = int(byte_index / uint(u_lookup_width));
    uint lookup_byte = texelFetch(u_lookup, ivec2(lookup_x, lookup_y), 0).r;
    bool selected = (lookup_byte & (1u << (code & 7u))) != 0u;

    uint hashed = mixHash24(code + 1u);
    vec3 base = vec3(
        float(hashed & 255u),
        float((hashed >> 8u) & 255u),
        float((hashed >> 16u) & 255u)
    ) / 255.0;
    if (selected) {
        // OFF areas keep their uniform pseudo-color. Only ON areas receive
        // the normal feature-selection checker highlight.
        ivec2 local = pixel & 3;
        if (local.x < 2 && local.y < 2) {
            ivec2 tile = pixel >> 2;
            bool light_cell = ((tile.x ^ tile.y) & 1) == 0;
            vec3 highlight = light_cell ? vec3(1.0) : vec3(0.0);
            float highlight_alpha = light_cell ? 0.86 : 0.72;
            base = mix(base, highlight, highlight_alpha);
        }
    }
    fragColor = vec4(base, 1.0);
}
