#version 300 es
precision highp float;

uniform sampler2D u_pressure;
uniform sampler2D u_divergence;
uniform vec2 u_texel;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  float l = texture(u_pressure, v_uv - vec2(u_texel.x, 0.0)).x;
  float r = texture(u_pressure, v_uv + vec2(u_texel.x, 0.0)).x;
  float b = texture(u_pressure, v_uv - vec2(0.0, u_texel.y)).x;
  float t = texture(u_pressure, v_uv + vec2(0.0, u_texel.y)).x;
  float div = texture(u_divergence, v_uv).x;
  float p = (l + r + b + t - div) * 0.25;
  fragColor = vec4(p, 0.0, 0.0, 1.0);
}
