#version 300 es
// Raster debug view: visualize the barycentric buffer (rgb = bary weights).
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform highp usampler2D uIdentity;
uniform sampler2D uBary;
uniform vec3 uBackground;
void main() {
  uint packed = texture(uIdentity, vUv).r;
  if ((packed & (1u << 31u)) == 0u) { outColor = vec4(uBackground, 1.0); return; }
  vec3 b = texture(uBary, vUv).xyz;
  outColor = vec4(clamp(b, 0.0, 1.0), 1.0);
}
