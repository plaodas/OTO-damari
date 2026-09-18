#version 300 es
precision highp float;

in vec2 a_position;
in float a_size;
in float a_brightness;

uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform float u_waterSheen;
uniform float u_sizePulse;
uniform float u_blowEnergy;
uniform float u_blooming;

out float v_brightness;
out float v_water;
out vec2 v_pointCoord;

const vec2 kQuad[6] = vec2[6](
  vec2(-1.0, -1.0),
  vec2(1.0, -1.0),
  vec2(-1.0, 1.0),
  vec2(-1.0, 1.0),
  vec2(1.0, -1.0),
  vec2(1.0, 1.0)
);

void main() {
  vec2 corner = kQuad[gl_VertexID];
  float size = a_size * (1.0 + u_sizePulse * 0.5 + u_blooming * 0.18 + u_blowEnergy * 0.08);
  vec2 pixel = a_position * u_resolution + corner * size * 0.5 * max(u_pixelRatio, 1.0);
  vec2 clip = pixel / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_brightness = a_brightness;
  v_water = u_waterSheen * (1.0 - clamp(a_position.y * 1.55, 0.0, 1.0));
  v_pointCoord = corner * 0.5 + 0.5;
}
