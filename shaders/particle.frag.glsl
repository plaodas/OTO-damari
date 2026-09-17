precision mediump float;

uniform sampler2D u_noise;

varying float v_brightness;
varying float v_water;

void main() {
  vec2 centered = gl_PointCoord - 0.5;
  float radius = length(centered);
  float halo = smoothstep(0.52, 0.05, radius);
  float core = smoothstep(0.2, 0.0, radius);
  float noise = texture2D(u_noise, gl_PointCoord).r;
  float alpha = halo * mix(0.42, 1.0, noise) * v_brightness;

  if (alpha < 0.02) {
    discard;
  }

  vec3 color = mix(vec3(0.04, 0.42, 0.95), vec3(0.55, 0.95, 1.0), core);
  color = mix(color, vec3(0.78, 0.96, 1.0), v_water * 0.6);
  gl_FragColor = vec4(color * alpha, alpha);
}
