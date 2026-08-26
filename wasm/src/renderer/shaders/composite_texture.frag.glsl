#version 300 es
precision highp float;
in mediump vec2 v_uv;
uniform sampler2D u_texture;
uniform lowp vec4 u_color;
uniform bool u_mask_is_red;
out lowp vec4 fragColor;
void main() {
    vec4 texel = texture(u_texture, v_uv);
    float mask = u_mask_is_red ? texel.r : texel.a;
    float finalAlpha = u_color.a * mask;
    fragColor = vec4(u_color.rgb * finalAlpha, finalAlpha);
}
