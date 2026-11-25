#version 300 es
// VISIBILITY PASS — fragment. Emits identity and barycentric storage only.
// Attachment 0 (R32UI): packed [instance | primitive | valid]
// Attachment 1 (RGBA16F): bary.xyz + view-space depth (w)
precision highp float;
precision highp int;

flat in int   vInstanceId;
flat in int   vPrimitiveId;
in vec3       vBary;

layout(location = 0) out uint outIdentity;
layout(location = 1) out vec4 outBary;

// Packing layout (32 bits):
//   valid   : 1  bit  (bit 31)
//   instance: 8  bits (bits 16..23)
//   primitive:16 bits (bits 0..15)
uint packIdentity(int instanceId, int primitiveId) {
  uint valid = 1u << 31u;
  uint inst  = (uint(instanceId)  & 0xFFu) << 16u;
  uint prim  = uint(primitiveId) & 0xFFFFu;
  return valid | inst | prim;
}

void main() {
  // Defensive: a rasterized fragment of a degenerate triangle cannot occur
  // (zero area produces no samples). If weights are degenerate anyway, mark
  // the pixel invalid instead of mislabeling it as primitive 0.
  if (vBary.x < 0.0 || vBary.y < 0.0 || vBary.z < 0.0) discard;

  outIdentity = packIdentity(vInstanceId, vPrimitiveId);
  outBary = vec4(vBary, gl_FragCoord.z);
}
