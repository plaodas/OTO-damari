#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform vec2 u_center;
uniform float u_strength;
uniform float u_radius;
uniform float u_aspect;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 vel = texture(u_velocity, v_uv).xy;
  vec2 d = v_uv - u_center;
  d.x *= u_aspect;
  d.y *= 1.7;
  float dist = length(d);
  float radius = max(u_radius, 0.0002);
  float mask = exp(-dot(d, d) / radius);
  vec2 tangent = vec2(-d.y, d.x) / max(dist, 0.0008);
  float diamond = 0.62 + 0.38 * abs(d.x) / max(dist, 0.0008);
  fragColor = vec4(vel + tangent * u_strength * mask * diamond, 0.0, 1.0);
}
