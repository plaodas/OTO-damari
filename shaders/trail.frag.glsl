#version 300 es
precision highp float;

in float v_brightness;

out vec4 fragColor;

void main() {
  vec3 color = vec3(0.22, 0.72, 1.0);
  fragColor = vec4(color * v_brightness, v_brightness);
}
