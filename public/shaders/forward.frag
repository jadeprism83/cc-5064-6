#version 300 es
// FORWARD REFERENCE fragment — identical lighting to the resolve pass.
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform vec3  uCamPos;
uniform vec4  uBaseRough;
uniform float uMetal;
uniform sampler2D uTex;
uniform int   uOutputMode; // 0 shaded,1 worldPos,2 normal,3 uv,4 albedo

vec3 shadeSurface(vec3 worldPos, vec3 N, vec3 albedo, float rough, float metal) {
  vec3 L = normalize(vec3(0.6, 0.9, 0.4));
  vec3 V = normalize(uCamPos - worldPos);
  vec3 H = normalize(L + V);
  float ndl = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, H), 0.0), mix(8.0, 96.0, 1.0 - rough)) * (1.0 - metal * 0.5);
  vec3 ambient = albedo * 0.25;
  vec3 diffuse = albedo * ndl * (1.0 - metal * 0.7);
  vec3 specCol = mix(vec3(1.0), albedo, metal) * spec;
  return ambient + diffuse + specCol;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 texColor = texture(uTex, vUv).rgb;
  vec3 albedo = texColor * uBaseRough.rgb;
  if (uOutputMode == 1) { outColor = vec4(vWorldPos * 0.5 + 0.5, 1.0); return; }
  if (uOutputMode == 2) { outColor = vec4(N * 0.5 + 0.5, 1.0); return; }
  if (uOutputMode == 3) { outColor = vec4(vUv, 0.0, 1.0); return; }
  if (uOutputMode == 4) { outColor = vec4(albedo, 1.0); return; }
  outColor = vec4(shadeSurface(vWorldPos, N, albedo, uBaseRough.a, uMetal), 1.0);
}
