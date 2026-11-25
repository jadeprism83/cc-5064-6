#version 300 es
// VISIBILITY PASS — stage 1.
// Rasterizes geometry but writes NO color/material. It only records, per
// covered fragment, the instance identity, the geometry-relative primitive
// id and perspective-correct barycentric weights. Geometry index, instance
// transform and material identity are resolved later from separate tables.
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPos;      // object-space position
layout(location = 1) in vec3 aNormal;   // object-space normal (unused here)
layout(location = 2) in vec2 aUv;       // texcoord (unused here)
layout(location = 3) in vec3 aBary;     // (1,0,0)/(0,1,0)/(0,0,1) per corner

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform int  uInstanceId;

// gl_VertexID/3 is the primitive id because geometry is expanded to a
// non-indexed triangle soup (3 vertices per primitive, in index order).
flat out int  vInstanceId;
flat out int  vPrimitiveId;
out vec3      vBary;

void main() {
  int tri = gl_VertexID / 3;
  vPrimitiveId = tri;
  vInstanceId  = uInstanceId;
  // Bary is a normal varying, so it is interpolated perspective-correctly by
  // the rasterizer, exactly matching how a forward varying would be.
  vBary = aBary;

  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}
