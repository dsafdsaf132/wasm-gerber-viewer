#version 300 es
precision mediump float;
in mediump vec2 v_uv;
uniform sampler2D u_texture;
uniform lowp vec4 u_color;
uniform bool u_mask_is_red;
out lowp vec4 fragColor;
void main() {
    vec4 texColor = texture(u_texture, v_uv);
    // Pre-multiply alpha: color * alpha for additive blending
    // R8 mask targets store coverage in red; the RGBA8 fallback preserves the
    // historic alpha-mask layout.
    float coverage = u_mask_is_red ? texColor.r : texColor.a;
    float finalAlpha = u_color.a * coverage;
    fragColor = vec4(u_color.rgb * finalAlpha, finalAlpha);
}
