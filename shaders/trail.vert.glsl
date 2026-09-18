#version 300 es
precision highp float;

in vec2 a_current;
in vec2 a_previous;

uniform vec2 u_resolution;
uniform float u_trailFade;

out float v_brightness;

void main() {
  vec2 uv = gl_VertexID == 0 ? a_current : a_previous;
  vec2 clip = uv * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_brightness = gl_VertexID == 0 ? u_trailFade * 0.85 : 0.0;
}
