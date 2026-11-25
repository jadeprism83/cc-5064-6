#version 300 es
// RESOLVE / MATERIAL SHADING PASS — stage 2.
// Geometry is NOT drawn here. A fullscreen triangle reads the visibility
// buffer, unpacks identity + bary, and reconstructs every vertex attribute
// from the separate geometry / instance / material tables, then shades.
precision highp float;
precision highp int;

in vec2 vUv;
layout(location = 0) out vec4 outColor;

uniform highp usampler2D uIdentityTex; // R32UI visibility identity
uniform highp sampler2D  uBaryTex;     // RGBA16F bary.xyz + depth
uniform highp sampler2D  uVertTex;     // global vertex table
uniform highp isampler2D uIndexTex;    // global index table (per-triangle 3 ids)
uniform highp usampler2D uGeomTex;     // per-geometry descriptor

uniform mat4  uViewProj;
uniform vec3  uCamPos;
uniform vec3  uBackground;
uniform int   uPerspectiveCorrect; // 1 = perspective (matches forward), 0 = affine
uniform int   uMaterialMode;       // 0 = descriptor snapshot, 1 = rebind by version
uniform int   uOutputMode;         // 0 shaded,1 worldPos,2 normal,3 uv,4 albedo,5 identity viz
uniform int   uVisFrameToken;      // descriptor snapshot token captured with visibility
uniform int   uCurrentFrameToken;  // latest material descriptor token
uniform vec2  uViewport;

// Per-instance tables (small, bounded counts -> uniforms).
#define MAX_INSTANCES 16
uniform int   uInstanceGeometry[MAX_INSTANCES];
uniform int   uInstanceMaterial[MAX_INSTANCES];
uniform mat4  uInstanceModel[MAX_INSTANCES];
uniform mat3  uInstanceNormalMat[MAX_INSTANCES];
uniform int   uInstanceCount;

#define MAX_MATERIALS 5
uniform vec4  uMatBase[MAX_MATERIALS];        // rgb baseColor, a roughness
uniform float uMatMetal[MAX_MATERIALS];
uniform int   uMatVersion[MAX_MATERIALS];     // version of the currently bound bank
uniform int   uMatLiveVersion[MAX_MATERIALS]; // current live version
// Single sampler array. The renderer binds EITHER the frozen snapshot bank
// (snapshot strategy) OR the live bank (rebind-by-version strategy) to these
// units before the resolve pass, so no dynamically indexed array is needed.
uniform sampler2D uMatTex[MAX_MATERIALS];
uniform int   uMaterialCount;

void unpackIdentity(uint id, out int instanceId, out int primitiveId, out bool valid) {
  valid = (id & (1u << 31u)) != 0u;
  instanceId  = int((id >> 16u) & 0xFFu);
  primitiveId = int(id & 0xFFFFu);
}

// Fetch a global vertex's attributes from the vertex table (two texel rows,
// one texel column per vertex).
void fetchVertex(int globalVertex, out vec3 pos, out vec3 nrm, out vec2 uv) {
  vec4 p0 = texelFetch(uVertTex, ivec2(globalVertex, 0), 0);
  vec4 p1 = texelFetch(uVertTex, ivec2(globalVertex, 1), 0);
  pos = p0.xyz;
  nrm = vec3(p0.w, p1.xy);
  uv  = p1.zw;
}

ivec3 fetchTriangle(int globalTri) {
  return texelFetch(uIndexTex, ivec2(globalTri, 0), 0).xyz;
}

// Standard Blinn-Phong-ish direct lighting shared by forward & resolve so the
// per-pixel comparison is apples-to-apples.
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
  uint packedId = texelFetch(uIdentityTex, ivec2(gl_FragCoord.xy), 0).r;
  vec4 baryPack = texelFetch(uBaryTex, ivec2(gl_FragCoord.xy), 0);

  int instanceId, primitiveId;
  bool valid;
  unpackIdentity(packedId, instanceId, primitiveId, valid);

  if (uOutputMode == 5) { // identity visualization (false color by instance/prim)
    if (!valid) { outColor = vec4(uBackground, 1.0); return; }
    float hi = fract(sin(float(instanceId) * 12.9898 + float(primitiveId) * 78.233) * 43758.5453);
    vec3 col = 0.5 + 0.5 * cos(6.2831 * (hi + vec3(0.0, 0.33, 0.67)));
    outColor = vec4(col, 1.0);
    return;
  }

  // Background / cleared / clipped pixels: valid bit clear. Never treat an
  // invalid identity as triangle zero.
  if (!valid) { outColor = vec4(uBackground, 1.0); return; }

  // Range checks: corrupted/out-of-table identity is reported, not silently
  // rendered as instance 0 / primitive 0.
  if (instanceId < 0 || instanceId >= uInstanceCount) {
    outColor = vec4(1.0, 0.0, 1.0, 1.0); // magenta error marker
    return;
  }

  int geometryId = uInstanceGeometry[instanceId];
  int materialId = uInstanceMaterial[instanceId];
  uvec4 ginfo = texelFetch(uGeomTex, ivec2(geometryId, 0), 0);
  int vertStart  = int(ginfo.x);
  int indexStart = int(ginfo.y);
  int triCount   = int(ginfo.z);

  if (primitiveId < 0 || primitiveId >= triCount) {
    outColor = vec4(1.0, 0.0, 0.0, 1.0); // red: primitive id out of range
    return;
  }

  ivec3 triLocal = fetchTriangle(indexStart + primitiveId);
  ivec3 triGlobal = ivec3(vertStart + triLocal.x, vertStart + triLocal.y, vertStart + triLocal.z);

  vec3 p0, p1, p2, n0, n1, n2; vec2 uv0, uv1, uv2;
  fetchVertex(triGlobal.x, p0, n0, uv0);
  fetchVertex(triGlobal.y, p1, n1, uv1);
  fetchVertex(triGlobal.z, p2, n2, uv2);

  vec3 b = baryPack.xyz;
  // The stored bary weights are the rasterizer's perspective-correct
  // interpolation of (1,0,0)/(0,1,0)/(0,0,1): b_i = (a_i / w_i) / sum(a_k/w_k),
  // where a are affine weights. To recover affine weights, divide each b_i by
  // the per-vertex reciprocal clip w and renormalize. This exactly mirrors the
  // hardware perspective interpolation the forward path relies on.
  vec3 w;
  if (uPerspectiveCorrect == 1) {
    vec4 sp0 = uViewProj * uInstanceModel[instanceId] * vec4(p0, 1.0);
    vec4 sp1 = uViewProj * uInstanceModel[instanceId] * vec4(p1, 1.0);
    vec4 sp2 = uViewProj * uInstanceModel[instanceId] * vec4(p2, 1.0);
    vec3 persp = vec3(b.x / sp0.w, b.y / sp1.w, b.z / sp2.w);
    w = persp / (persp.x + persp.y + persp.z);
  } else {
    // Control path: treat bary as affine (intentionally diverges from forward).
    w = b / (b.x + b.y + b.z);
  }

  // Reconstruct object-space attributes from the indexed vertices.
  vec3 objPos = p0 * w.x + p1 * w.y + p2 * w.z;
  vec3 objNrm = n0 * w.x + n1 * w.y + n2 * w.z;
  vec2 uv     = uv0 * w.x + uv1 * w.y + uv2 * w.z;

  mat4 model = uInstanceModel[instanceId];
  mat3 nmat  = uInstanceNormalMat[instanceId];
  vec4 wp4   = model * vec4(objPos, 1.0);
  vec3 worldPos = wp4.xyz / wp4.w;
  vec3 N = normalize(nmat * objNrm);

  // ---- Material resolution: two explicit strategies ----
  // Snapshot mode uses the descriptor version captured with the visibility
  // buffer; rebind mode re-resolves the live material by current version.
  bool versionMismatch = uMatVersion[materialId] != uMatLiveVersion[materialId];

  vec4 baseRough = uMatBase[materialId];
  float metal = uMatMetal[materialId];
  // Static branch over material id selects the sampler without a dynamically
  // indexed sampler array. uMaterialMode chooses the frozen snapshot bank or
  // the live (re-bound by version) bank.
  vec3 texColor = vec3(0.5);
  for (int k = 0; k < MAX_MATERIALS; k++) {
    if (k == materialId) texColor = texture(uMatTex[k], uv).rgb;
  }
  vec3 albedo = texColor * baseRough.rgb;
  float rough = baseRough.a;

  if (uOutputMode == 1) { outColor = vec4(worldPos * 0.5 + 0.5, 1.0); return; }
  if (uOutputMode == 2) { outColor = vec4(N * 0.5 + 0.5, 1.0); return; }
  if (uOutputMode == 3) { outColor = vec4(uv, 0.0, 1.0); return; }
  if (uOutputMode == 4) { outColor = vec4(albedo, 1.0); return; }

  vec3 shaded = shadeSurface(worldPos, N, albedo, rough, metal);

  // Surface mismatch in the UI rather than hiding it: tint a diagnostic edge.
  if (versionMismatch && uMaterialMode == 0) {
    shaded = mix(shaded, vec3(1.0, 0.85, 0.0), 0.25);
  }
  outColor = vec4(shaded, 1.0);
}
