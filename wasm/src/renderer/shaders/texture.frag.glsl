#version 300 es
precision mediump float;
in mediump vec2 v_uv;
uniform sampler2D u_texture;
uniform lowp vec4 u_color;
out lowp vec4 fragColor;
void main() {
    vec4 texColor = texture(u_texture, v_uv);
    // Pre-multiply alpha: color * alpha for additive blending
    float finalAlpha = u_color.a * texColor.a;
    fragColor = vec4(u_color.rgb * finalAlpha, finalAlpha);
}
