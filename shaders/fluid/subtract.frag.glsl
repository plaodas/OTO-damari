#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform sampler2D u_pressure;
uniform vec2 u_texel;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 vel = texture(u_velocity, v_uv).xy;
  float l = texture(u_pressure, v_uv - vec2(u_texel.x, 0.0)).x;
  float r = texture(u_pressure, v_uv + vec2(u_texel.x, 0.0)).x;
  float b = texture(u_pressure, v_uv - vec2(0.0, u_texel.y)).x;
  float t = texture(u_pressure, v_uv + vec2(0.0, u_texel.y)).x;
  vec2 grad = 0.5 * vec2(r - l, t - b);
  fragColor = vec4(vel - grad, 0.0, 1.0);
}
