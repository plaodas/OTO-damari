#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_velocity;
in float a_lane;
in float a_phase;
in vec2 a_home;

uniform sampler2D u_velocity;
uniform float u_hasField;
uniform sampler2D u_photoField;
uniform float u_photoAmount;
uniform float u_dt;
uniform float u_time;
uniform float u_gather;
uniform float u_disperse;
uniform float u_blooming;
uniform float u_flowSpeed;
uniform float u_burst;
uniform vec2 u_origin;
uniform vec2 u_axis;
uniform vec2 u_perp;
uniform float u_bloomLength;
uniform float u_swipeHeld;
uniform vec2 u_impactPoint;
uniform float u_impact;
uniform vec2 u_tilt;
uniform float u_shake;
uniform float u_blowLevel;
uniform float u_north;

out vec2 v_position;
out vec2 v_velocity;

void main() {
  vec2 pos = a_position;
  vec2 vel = a_velocity;
  float ambient = step(0.52, fract(a_phase * 1.17 + a_home.x * 0.73));
  vec4 photo = texelFetch(u_photoField, ivec2(gl_VertexID, 0), 0);
  float shapeSeed = fract(a_phase * 0.7548777 + a_home.x * 0.5698403);
  float shapeShare = 1.0 - step(0.8, shapeSeed);
  float shapeReveal = smoothstep(shapeSeed * 0.72, shapeSeed * 0.72 + 0.3, u_photoAmount);
  float photoHold = shapeReveal * shapeShare * photo.a;
  float idle = 1.0 - max(u_gather, max(step(0.5, u_blooming), step(0.5, u_blowLevel)));
  float spread = ambient > 0.5 ? 1.0 : (u_blooming > 0.5 ? u_disperse : 1.0);
  vec2 rel = pos - u_origin;
  float along = dot(rel, u_axis);
  float across = dot(rel, u_perp);
  float bloom = max(u_bloomLength, 0.08);
  float rise = clamp(along / bloom, 0.0, 1.2);

  if (u_hasField > 0.5) {
    vec2 field = texture(u_velocity, clamp(vec2(pos.x, 1.0 - pos.y), 0.002, 0.998)).xy;
    field.y = -field.y;
    vel += field * mix(1.0, 0.08, ambient) * mix(1.0, 0.32, idle) * (1.0 - photoHold * 0.92);
  }

  if (u_gather > 0.02 && ambient < 0.5 && photoHold < 0.2) {
    float theta = atan(across, max(0.012, along));
    float petal = 0.86 + 0.14 * pow(abs(cos(theta * 2.5)), 1.1);
    float tube = 0.14;
    float u = max(0.0, (rise - tube) / (1.0 - tube));
    float flare = pow(u, 2.7);
    float amp = 0.5 * petal;
    float targetAcross = a_lane * (0.055 + amp * flare);
    vec2 target = u_origin + u_axis * along + u_perp * targetAcross;
    vec2 tangent = normalize(u_axis * bloom + u_perp * a_lane * amp * 2.7 * pow(max(u, 0.0), 1.7) + vec2(0.0001));
    float speed = u_flowSpeed * (0.92 + rise * 0.4);
    float gatherMix = u_hasField > 0.5 ? 0.55 : 1.0;
    vel += (tangent * speed - vel) * min(1.0, 3.4 * u_dt) * u_gather * gatherMix;
    float pull = 7.0 * u_gather * min(1.0, 0.18 + rise * 2.2) * gatherMix;
    vel += (target - pos) * pull * u_dt;
    if (along < bloom * 0.22) vel += u_axis * u_flowSpeed * 1.6 * u_gather * u_dt;
  }

  if (spread > 0.02) {
    float waveA = sin(u_time * mix(0.72, 0.32, idle) + a_phase + pos.y * mix(6.0, 2.8, idle));
    float waveB = cos(u_time * mix(0.51, 0.24, idle) - a_phase * 1.7 + pos.x * mix(5.0, 2.3, idle));
    float homePull = mix(
      ambient > 0.5 ? 0.28 : (u_blooming > 0.5 ? 1.15 * u_disperse : 0.22),
      ambient > 0.5 ? 0.4 : 0.32,
      idle
    ) * (1.0 - u_north * idle * 0.72);
    vec2 wander = vec2(waveA, waveB) * mix(0.028, 0.015, idle);
    float freedom = 1.0 - photoHold * 0.88;
    vel += (wander - vel) * min(1.0, mix(1.8, 0.75, idle) * u_dt) * spread * freedom;
    vel += (a_home - pos) * homePull * u_dt * freedom;
  }

  if (photoHold > 0.001) {
    vec2 shimmer = vec2(
      sin(u_time * 0.38 + a_phase * 1.7),
      cos(u_time * 0.31 - a_phase * 1.3)
    ) * 0.0035;
    vec2 edgeTarget = photo.rg + shimmer;
    float revealed = smoothstep(0.0, 0.55, photoHold);
    float arrive = (1.0 - exp(-u_dt * mix(0.3, 0.9, revealed))) * revealed;
    pos = mix(pos, edgeTarget, arrive);
    vel *= 1.0 - revealed * 0.42;
  }

  if (u_burst > 0.01 && ambient < 0.5 && photoHold < 0.2) {
    float len = max(0.02, length(rel));
    vel += (rel / len) * u_burst;
  }

  if (u_impact > 0.01 && photoHold < 0.2) {
    vec2 delta = pos - u_impactPoint;
    float dist = length(delta);
    float radius = 0.34;
    if (dist < radius) {
      vel += normalize(delta + vec2(0.0001)) * (1.0 - dist / radius) * u_impact * mix(0.45, 0.18, ambient);
    }
  }

  float tiltLen = length(u_tilt);
  vel += u_tilt * (0.055 + tiltLen * 0.04) * (1.0 - photoHold * 0.9);
  vel += vec2(0.0, -u_north * 0.022) * idle * (1.0 - photoHold * 0.9);
  if (u_shake > 0.01 && photoHold < 0.5) {
    vec2 jolt = vec2(
      sin(a_phase * 17.0 + u_time * 31.0),
      cos(a_phase * 13.0 - u_time * 27.0)
    );
    vel += jolt * u_shake * 0.28;
  }

  float damping = mix(mix(0.965, 0.954, idle), 0.972, step(0.55, u_gather) * (1.0 - ambient));
  vel *= pow(damping, u_dt * 60.0);
  pos += vel * u_dt;

  along = dot(pos - u_origin, u_axis);
  bool recycle = photoHold < 0.2 && ambient < 0.5 && u_blooming > 0.5 && u_disperse < 0.42 && along < -0.04;
  if (recycle) {
    float t = 0.1 + fract(a_phase * 1.73) * 0.55;
    float halfW = 0.055 + 0.28 * t * t;
    pos = u_origin + u_axis * (t * bloom) + u_perp * a_lane * halfW * 0.5;
    vel = u_axis * u_flowSpeed * 0.85 + u_perp * a_lane * 0.04;
  } else {
    pos = fract(pos + vec2(1.0));
  }

  v_position = pos;
  v_velocity = vel;
  gl_Position = vec4(-2.0, -2.0, 0.0, 1.0);
}
