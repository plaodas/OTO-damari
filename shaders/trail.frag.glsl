precision mediump float;

varying float v_brightness;

void main() {
  vec3 color = vec3(0.22, 0.72, 1.0);
  gl_FragColor = vec4(color * v_brightness, v_brightness);
}
