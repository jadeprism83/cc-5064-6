// Flatten all meshes into global vertex / index / geometry tables.
// Keeping these separate from per-instance transforms is what lets the
// resolve pass reconstruct attributes purely from the visibility identity.

export function buildGlobalTables(geometries) {
  const vertData = [];   // per vertex: pos.xyz, normal.xyz, uv.xy (8 floats)
  const indexData = [];  // per triangle: 3 local indices (ints)
  const geomInfo = [];   // per geometry: vertStart, indexStart, triCount, id
  let vertexOffset = 0;
  let triangleOffset = 0;

  for (const g of geometries) {
    const m = g.mesh;
    const vertStart = vertexOffset;
    for (let i = 0; i < m.vertexCount; i++) {
      vertData.push(
        m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2],
        m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2],
        m.uvs[i * 2], m.uvs[i * 2 + 1],
      );
    }
    const indexStart = triangleOffset;
    const triCount = m.indices.length / 3;
    for (let t = 0; t < triCount; t++) {
      indexData.push(
        m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2],
      );
    }
    geomInfo.push({ id: g.id, vertStart, indexStart, triCount, vertexCount: m.vertexCount });
    vertexOffset += m.vertexCount;
    triangleOffset += triCount;
  }

  return {
    vertData: new Float32Array(vertData),
    indexData: new Int32Array(indexData),
    geomInfo,
    totalVertices: vertexOffset,
    totalTriangles: triangleOffset,
  };
}

// Expand an indexed mesh into a non-indexed triangle soup for the visibility
// pass, baking barycentric corner weights. gl_VertexID/3 then equals the
// geometry-relative primitive id; original indexed vertices stay in the
// global vertex/index tables used by the resolve pass.
export function expandTriangleSoup(mesh) {
  const tris = mesh.indices.length / 3;
  const outCount = tris * 3;
  const pos = new Float32Array(outCount * 3);
  const nrm = new Float32Array(outCount * 3);
  const uv = new Float32Array(outCount * 2);
  const bary = new Float32Array(outCount * 3);
  const baryCorner = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  for (let t = 0; t < tris; t++) {
    const ids = [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]];
    for (let c = 0; c < 3; c++) {
      const vi = ids[c];
      const o = (t * 3 + c);
      pos[o * 3] = mesh.positions[vi * 3];
      pos[o * 3 + 1] = mesh.positions[vi * 3 + 1];
      pos[o * 3 + 2] = mesh.positions[vi * 3 + 2];
      nrm[o * 3] = mesh.normals[vi * 3];
      nrm[o * 3 + 1] = mesh.normals[vi * 3 + 1];
      nrm[o * 3 + 2] = mesh.normals[vi * 3 + 2];
      uv[o * 2] = mesh.uvs[vi * 2];
      uv[o * 2 + 1] = mesh.uvs[vi * 2 + 1];
      bary[o * 3] = baryCorner[c][0];
      bary[o * 3 + 1] = baryCorner[c][1];
      bary[o * 3 + 2] = baryCorner[c][2];
    }
  }
  return { pos, nrm, uv, bary, vertexCount: outCount };
}
