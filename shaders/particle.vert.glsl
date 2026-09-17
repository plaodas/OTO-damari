attribute vec2 a_position;
attribute float a_size;
attribute float a_brightness;

uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_waterSheen;

varying float v_brightness;
varying float v_water;

void main() {
  vec2 clip = (a_position / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_size * u_pixelRatio;
  v_brightness = a_brightness;
  float yNorm = a_position.y / max(u_resolution.y, 1.0);
  v_water = u_waterSheen * (1.0 - clamp(yNorm * 1.55, 0.0, 1.0));
}
