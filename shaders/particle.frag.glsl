#version 300 es
precision highp float;

uniform sampler2D u_noise;
uniform float u_glowPulse;
uniform float u_glowFade;
uniform float u_blowLevel;
uniform float u_north;

in float v_brightness;
in float v_water;

out vec4 fragColor;

void main() {
  vec2 centered = gl_PointCoord - 0.5;
  float radius = length(centered);
  float level = mix(u_blowLevel, 3.0, u_glowFade);
  float brightness = v_brightness * (0.52 + u_glowPulse * 0.95 + level * 0.12);
  float emit = u_glowFade * smoothstep(0.4, 1.05, brightness);
  float halo = smoothstep(0.52 + emit * 0.08, 0.05, radius);
  float core = smoothstep(0.2, 0.0, radius);
  float ring = smoothstep(0.08, 0.24, radius) * smoothstep(0.5, 0.2, radius);
  float noise = texture(u_noise, gl_PointCoord).r;
  float alpha = halo * mix(0.42, 1.0, noise) * brightness;

  if (alpha < 0.02) {
    discard;
  }

  float north = u_north;
  vec3 haloCol = mix(vec3(0.04, 0.42, 0.95), vec3(0.95, 0.08, 0.05), north);
  vec3 coreCol = mix(vec3(0.55, 0.95, 1.0), vec3(1.0, 0.97, 0.95), north);
  vec3 color = mix(haloCol, coreCol, core);
  color = mix(color, vec3(0.78, 0.96, 1.0), v_water * 0.6 * (1.0 - north));
  color = mix(color, vec3(0.14, 0.98, 0.4), ring * emit * 0.4 * (1.0 - north * 0.9));
  fragColor = vec4(color * alpha, alpha);
}
