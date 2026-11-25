#version 300 es
// FORWARD REFERENCE PASS. A conventional indexed-mesh forward path whose
// output is the ground truth used to validate the visibility-buffer resolve.
// Same lighting, same textures, hardware perspective-correct interpolation.
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMat;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;

void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorldPos = wp.xyz / wp.w;
  vNormal = normalize(uNormalMat * aNormal);
  vUv = aUv;
  gl_Position = uViewProj * wp;
}
