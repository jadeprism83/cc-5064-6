#version 300 es
// Raster debug view: decode the packed R32UI identity buffer into false color.
// Invalid pixels (valid bit clear) are drawn as the background, never black=id0.
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform highp usampler2D uIdentity;
uniform vec3 uBackground;
void main() {
  uint packed = texture(uIdentity, vUv).r;
  if ((packed & (1u << 31u)) == 0u) { outColor = vec4(uBackground, 1.0); return; }
  int instance  = int((packed >> 16u) & 0xFFu);
  int primitive = int(packed & 0xFFFFu);
  float hi = fract(sin(float(instance) * 12.9898 + float(primitive) * 78.233) * 43758.5453);
  vec3 col = 0.5 + 0.5 * cos(6.2831 * (hi + vec3(0.0, 0.33, 0.67)));
  outColor = vec4(col, 1.0);
}
