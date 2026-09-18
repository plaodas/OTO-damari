#version 300 es
precision highp float;

uniform sampler2D u_noise;
uniform float u_glowPulse;
uniform float u_blooming;
uniform float u_blowLevel;

in float v_brightness;
in float v_water;
in vec2 v_pointCoord;

out vec4 fragColor;

void main() {
  vec2 centered = v_pointCoord - 0.5;
  float radius = length(centered);
  float halo = smoothstep(0.52, 0.05, radius);
  float core = smoothstep(0.2, 0.0, radius);
  float noise = texture(u_noise, v_pointCoord).r;
  float level = mix(u_blowLevel, 3.0, u_blooming);
  float brightness = v_brightness * (0.52 + u_glowPulse * 0.95 + level * 0.12);
  float alpha = halo * mix(0.42, 1.0, noise) * brightness;

  if (alpha < 0.02) {
    discard;
  }

  vec3 color = mix(vec3(0.04, 0.42, 0.95), vec3(0.55, 0.95, 1.0), core);
  color = mix(color, vec3(0.78, 0.96, 1.0), v_water * 0.6);
  fragColor = vec4(color * alpha, alpha);
}
