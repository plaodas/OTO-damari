#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform vec2 u_origin;
uniform vec2 u_axis;
uniform vec2 u_perp;
uniform float u_bloomLength;
uniform float u_gather;
uniform float u_flow;
uniform float u_dt;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 vel = texture(u_velocity, v_uv).xy;
  if (u_gather < 0.01) {
    fragColor = vec4(vel, 0.0, 1.0);
    return;
  }

  vec2 rel = v_uv - u_origin;
  float along = dot(rel, u_axis);
  float across = dot(rel, u_perp);
  float bloom = max(u_bloomLength, 0.08);
  float rise = clamp(along / bloom, 0.0, 1.2);
  float tube = 0.14;
  float u = max(0.0, (rise - tube) / (1.0 - tube));
  float flare = pow(u, 2.7);
  float theta = atan(across, max(0.012, along));
  float petal = 0.86 + 0.14 * pow(abs(cos(theta * 2.5)), 1.1);
  float halfWidth = (0.045 + flare * 0.42) * petal;
  float mask = exp(-pow(across / max(halfWidth, 0.02), 2.0));
  mask *= smoothstep(-0.04, 0.02, along) * smoothstep(bloom * 1.15, bloom * 0.15, along);
  vec2 force = u_axis * u_flow * (0.55 + rise * 0.6);
  force += u_perp * sign(across + 0.00001) * u_flow * flare * 0.45;
  if (rise > 0.5) {
    float lip = clamp((rise - 0.5) / 0.5, 0.0, 1.0);
    float curl = lip * lip * (3.0 - 2.0 * lip);
    force += u_perp * sign(across + 0.00001) * u_flow * 0.7 * curl;
    force -= u_axis * u_flow * 0.35 * curl;
  }
  fragColor = vec4(vel + force * mask * u_gather * u_dt * 2.2, 0.0, 1.0);
}
