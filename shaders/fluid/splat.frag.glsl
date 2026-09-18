#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform vec2 u_point;
uniform vec2 u_force;
uniform float u_radius;
uniform float u_aspect;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 vel = texture(u_velocity, v_uv).xy;
  vec2 d = v_uv - u_point;
  d.x *= u_aspect;
  float influence = exp(-dot(d, d) / max(u_radius, 0.00001));
  fragColor = vec4(vel + u_force * influence, 0.0, 1.0);
}
