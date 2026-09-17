attribute vec2 a_position;
attribute float a_brightness;

uniform vec2 u_resolution;

varying float v_brightness;

void main() {
  vec2 clip = (a_position / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_brightness = a_brightness;
}
