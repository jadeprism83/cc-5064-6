#version 300 es
// Blit a texture to the default framebuffer. Diff mode amplifies error.
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform int uMode; // 0 normal, 1 amplified difference (already encoded)
void main() {
  vec4 c = texture(uTex, vUv);
  if (uMode == 1) c.rgb = clamp(c.rgb * 8.0, 0.0, 1.0);
  outColor = c;
}
