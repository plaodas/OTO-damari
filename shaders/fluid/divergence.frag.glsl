#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform vec2 u_texel;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 l = texture(u_velocity, v_uv - vec2(u_texel.x, 0.0)).xy;
  vec2 r = texture(u_velocity, v_uv + vec2(u_texel.x, 0.0)).xy;
  vec2 b = texture(u_velocity, v_uv - vec2(0.0, u_texel.y)).xy;
  vec2 t = texture(u_velocity, v_uv + vec2(0.0, u_texel.y)).xy;
  float div = 0.5 * (r.x - l.x + t.y - b.y);
  fragColor = vec4(div, 0.0, 0.0, 1.0);
}
