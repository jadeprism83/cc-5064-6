// Procedural indexed meshes: cube, sphere, torus, plus a deliberately
// degenerate (zero-area) triangle batch to exercise invalid-primitive handling.
// Every mesh is {positions:[x,y,z...], normals, uvs, indices:[...]}.

function pushVertex(out, p, n, uv) {
  out.positions.push(p[0], p[1], p[2]);
  out.normals.push(n[0], n[1], n[2]);
  out.uvs.push(uv[0], uv[1]);
  return out.vertexCount++;
}

function empty() {
  return { positions: [], normals: [], uvs: [], indices: [], vertexCount: 0 };
}

export function makeCube(size = 1) {
  const out = empty(), h = size / 2;
  const faces = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], c: [h, 0, 0] },
    { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], c: [-h, 0, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], c: [0, h, 0] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], c: [0, -h, 0] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], c: [0, 0, h] },
    { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], c: [0, 0, -h] },
  ];
  for (const f of faces) {
    const corners = [
      [-1, -1], [1, -1], [1, 1], [-1, 1],
    ];
    const base = out.vertexCount;
    for (const [cu, cv] of corners) {
      const p = [
        f.c[0] + f.u[0] * cu * h + f.v[0] * cv * h,
        f.c[1] + f.u[1] * cu * h + f.v[1] * cv * h,
        f.c[2] + f.u[2] * cu * h + f.v[2] * cv * h,
      ];
      pushVertex(out, p, f.n, [(cu + 1) / 2, (cv + 1) / 2]);
    }
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return out;
}

export function makeSphere(seg = 32, rings = 16, radius = 1) {
  const out = empty();
  for (let r = 0; r <= rings; r++) {
    const theta = (r / rings) * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let s = 0; s <= seg; s++) {
      const phi = (s / seg) * Math.PI * 2;
      const n = [st * Math.cos(phi), ct, st * Math.sin(phi)];
      pushVertex(out, [n[0] * radius, n[1] * radius, n[2] * radius], n, [
        s / seg, r / rings,
      ]);
    }
  }
  const row = seg + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * row + s, b = a + 1, c = a + row, d = c + 1;
      out.indices.push(a, c, b, b, c, d);
    }
  }
  return out;
}

export function makeTorus(R = 1, r = 0.35, segU = 32, segV = 16) {
  const out = empty();
  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    for (let j = 0; j <= segV; j++) {
      const v = (j / segV) * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
      const p = [(R + r * cv) * cu, r * sv, (R + r * cv) * su];
      const n = [cv * cu, sv, cv * su];
      pushVertex(out, p, n, [i / segU, j / segV]);
    }
  }
  const row = segV + 1;
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < segV; j++) {
      const a = i * row + j, b = a + row, c = a + 1, d = a + row + 1;
      out.indices.push(a, b, c, c, b, d);
    }
  }
  return out;
}

// A mesh containing a degenerate triangle (two coincident vertices -> zero
// screen area). Rasterizers produce no fragments for it, but the primitive
// still consumes a primitive ID, proving IDs stay aligned with the index
// buffer rather than visible-triangle order.
export function makeDegeneratePatch() {
  const out = empty();
  const a = pushVertex(out, [-1, 0, 0], [0, 0, 1], [0, 0]);
  const b = pushVertex(out, [0, 0, 0], [0, 0, 1], [0.5, 0]);
  const c = pushVertex(out, [0, 0, 0], [0, 0, 1], [0.5, 0]); // coincident with b
  const d = pushVertex(out, [0, 1, 0], [0, 0, 1], [0.5, 1]);
  // tri 0 = a,b,c (degenerate), tri 1 = b,c,d (valid thin triangle)
  out.indices.push(a, b, c, b, c, d);
  return out;
}

// 共享顶点楔形网格：两个三角形沿一条共享边相接，4 个顶点、2 个三角形。
// 共享边的两个顶点被两个三角形复用（索引相同），用于区分三类问题：
//  1) 身份编码：每个片元仍凭实例号/图元号定位到"实际被着色的三角形"；
//  2) 导数：共享顶点处法线导数由相邻三角形决定，诊断需回溯到具体三角形；
//  3) 越界读取：所有索引都在 4 个顶点内，正常情况绝不触发越界。
export function makeSharedWedge() {
  const out = empty();
  const v0 = pushVertex(out, [-1, -0.8, 0], [0, 0, 1], [0, 0]);
  const v1 = pushVertex(out, [0, 0.4, 0], [0, 0, 1], [0.5, 0.5]); // 共享边顶点
  const v2 = pushVertex(out, [1, -0.8, 0], [0, 0, 1], [1, 0]);
  const v3 = pushVertex(out, [0, 0.9, 0.6], [0, 0, 1], [0.5, 1]);  // 共享边顶点
  // tri0 = v0,v1,v3 ; tri1 = v1,v2,v3 —— v1/v3 被两三角形共享。
  out.indices.push(v0, v1, v3, v1, v2, v3);
  return out;
}
