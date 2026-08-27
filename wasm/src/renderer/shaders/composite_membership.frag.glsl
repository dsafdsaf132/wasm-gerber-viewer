#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_source0;
uniform sampler2D u_source1;
uniform sampler2D u_source2;
uniform sampler2D u_source3;
uniform sampler2D u_source4;
uniform sampler2D u_source5;
uniform sampler2D u_source6;
uniform sampler2D u_source7;
uniform int u_source_count;
uniform int u_base_slot;

out highp vec4 fragColor;

bool covered(sampler2D source_texture, ivec2 pixel) {
    return texelFetch(source_texture, pixel, 0).a >= 0.5;
}

void addMembership(inout uvec3 membership, int local_slot, bool is_covered) {
    if (!is_covered || local_slot >= u_source_count) return;
    int slot = u_base_slot + local_slot;
    uint value = 1u << uint(slot & 7);
    if (slot < 8) membership.r |= value;
    else if (slot < 16) membership.g |= value;
    else membership.b |= value;
}

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    uvec3 membership = uvec3(0u);
    addMembership(membership, 0, covered(u_source0, pixel));
    addMembership(membership, 1, covered(u_source1, pixel));
    addMembership(membership, 2, covered(u_source2, pixel));
    addMembership(membership, 3, covered(u_source3, pixel));
    addMembership(membership, 4, covered(u_source4, pixel));
    addMembership(membership, 5, covered(u_source5, pixel));
    addMembership(membership, 6, covered(u_source6, pixel));
    addMembership(membership, 7, covered(u_source7, pixel));
    fragColor = vec4(vec3(membership) / 255.0, 0.0);
}
