#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform float u_dt;
uniform float u_dissipation;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 vel = texture(u_velocity, v_uv).xy;
  vec2 coord = clamp(v_uv - vel * u_dt, 0.0, 1.0);
  vec2 next = texture(u_velocity, coord).xy * u_dissipation;
  fragColor = vec4(next, 0.0, 1.0);
}
