#version 300 es
precision highp float;

uniform float u_north;

in float v_brightness;

out vec4 fragColor;

void main() {
  vec3 color = mix(vec3(0.22, 0.72, 1.0), vec3(1.0, 0.22, 0.12), u_north);
  fragColor = vec4(color * v_brightness, v_brightness);
}
