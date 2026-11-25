#version 300 es
// Per-pixel absolute difference between the visibility-resolve image and the
// conventional forward reference, for position/normal/color validation.
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA;
uniform sampler2D uB;
uniform highp usampler2D uIdentity;
void main() {
  uint id = texture(uIdentity, vUv).r;
  vec3 a = texture(uA, vUv).rgb;
  vec3 b = texture(uB, vUv).rgb;
  vec3 d = abs(a - b);
  // Background pixels share the same clear color; report zero there.
  if ((id & (1u << 31u)) == 0u) d = vec3(0.0);
  outColor = vec4(d, 1.0);
}
