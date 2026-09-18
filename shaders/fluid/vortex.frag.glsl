#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform vec2 u_center;
uniform float u_strength;
uniform float u_radius;
uniform vec2 u_span;
uniform float u_aspect;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 vel = texture(u_velocity, v_uv).xy;
  vec2 d = v_uv - u_center;
  d.x *= u_aspect;
  vec2 span = max(u_span, vec2(0.02));
  float diamond = abs(d.x) / span.x + abs(d.y) / span.y;
  float ring = exp(-pow(diamond - 1.0, 2.0) / max(u_radius, 0.0002));
  vec2 grad = vec2(sign(d.x) / span.x, sign(d.y) / span.y);
  float glen = max(length(grad), 0.001);
  vec2 tangent = vec2(-grad.y, grad.x) / glen;
  fragColor = vec4(vel + tangent * u_strength * ring, 0.0, 1.0);
}
