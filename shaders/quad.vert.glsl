#version 300 es
precision highp float;

const vec2 kVerts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));

out vec2 v_uv;

void main() {
  vec2 pos = kVerts[gl_VertexID];
  gl_Position = vec4(pos, 0.0, 1.0);
  v_uv = pos * 0.5 + 0.5;
}
