// CPU reference implementation of the SAME two-stage visibility-buffer
// pipeline used by the WebGL2 renderer. It exists to validate the identity +
// barycentric contract and to give the CLI a way to inspect the visibility
// buffer headlessly. It does NOT replace the real GPU pipeline.
//
// Stage 1 (rasterize): write only identity + perspective-correct bary + depth.
// Stage 2 (resolve):   read identity/bary, rebuild attributes from the
//                      separate geometry/instance/material tables and shade.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './png.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', '..', 'public');
const { buildScene, updateTransforms, buildBatches } = await import(path.join(PUBLIC, 'scene.js'));
const { buildGlobalTables } = await import(path.join(PUBLIC, 'data-tables.js'));
const { perspective, lookAt, multiply, normalMatrix, transformDir3 } = await import(path.join(PUBLIC, 'math.js'));

function mat4mul(a, b) { return multiply(a, b); }
function apply4(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// Perspective divide + NDC near/far clip (clip space -w..w). Returns null if
// the triangle is fully outside; otherwise clips against the six planes.
function clipTriangle(verts) {
  let out = verts;
  const planes = [
    [0, 0, 1, 1], [0, 0, -1, 1],   // -w <= z <= w
    [1, 0, 0, 1], [-1, 0, 0, 1],   // -w <= x <= w
    [0, 1, 0, 1], [0, -1, 0, 1],   // -w <= y <= w
  ];
  for (const [ax, ay, az, aw] of planes) {
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const dc = ax * cur.c[0] + ay * cur.c[1] + az * cur.c[2] + aw * cur.c[3];
      const dp = ax * prev.c[0] + ay * prev.c[1] + az * prev.c[2] + aw * prev.c[3];
      const cin = dc >= 0, pin = dp >= 0;
      if (cin) {
        if (!pin) {
          const t = dp / (dp - dc);
          out.push(interpClip(prev, cur, t));
        }
        out.push(cur);
      } else if (pin) {
        const t = dp / (dp - dc);
        out.push(interpClip(prev, cur, t));
      }
    }
    if (out.length < 3) return null;
  }
  return out;
}
function interpClip(a, b, t) {
  const c = a.c.map((v, i) => v + (b.c[i] - v) * t);
  return { c, idx: a.idx, baryHint: null };
}

export function runSoftwarePipeline(opts = {}) {
  const W = opts.width || 320, H = opts.height || 240;
  const scene = buildScene();
  updateTransforms(scene.instances, opts.time || 0);
  const tables = buildGlobalTables(scene.geometries);
  const batches = buildBatches(scene.instances, !!opts.reorder);

  const proj = perspective(Math.PI / 4, W / H, 0.1, 100);
  const eye = [0, 1.5, 9];
  const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
  const vp = mat4mul(proj, view);

  // Visibility buffers (stage 1 outputs). 0 explicitly means "no identity":
  // it is never interpreted as instance 0 / primitive 0.
  const identity = new Uint32Array(W * H);
  const bary = new Float32Array(W * H * 3);
  const depth = new Float32Array(W * H).fill(Infinity);

  let drawnTris = 0, clippedTris = 0, degenerate = 0;

  for (const batch of batches) {
    const ins = scene.instances[batch.instanceId];
    const geom = scene.geometryById.get(batch.geometryId);
    const ginfo = tables.geomInfo.find((g) => g.id === geom.id);
    const mvp = mat4mul(vp, ins.model);
    const triCount = geom.mesh.indices.length / 3;

    for (let tri = 0; tri < triCount; tri++) {
      const ids = [0, 1, 2].map((c) => geom.mesh.indices[tri * 3 + c]);
      const obj = ids.map((vi) => [
        geom.mesh.positions[vi * 3], geom.mesh.positions[vi * 3 + 1], geom.mesh.positions[vi * 3 + 2],
      ]);
      const clipVerts = obj.map((p, k) => ({ c: apply4(mvp, p), idx: ids[k] }));
      const clipped = clipTriangle(clipVerts);
      if (!clipped) { clippedTris++; continue; }

      // Fan triangulate the (possibly clipped) polygon.
      for (let f = 1; f < clipped.length - 1; f++) {
        const fan = [clipped[0], clipped[f], clipped[f + 1]];
        const ndc = fan.map((v) => [v.c[0] / v.c[3], v.c[1] / v.c[3], v.c[2] / v.c[3], v.c[3]]);
        const screen = ndc.map((n) => [(n[0] * 0.5 + 0.5) * W, (1 - (n[1] * 0.5 + 0.5)) * H, n[2]]);
        const area = edge(screen[1], screen[2], screen[0]);
        if (Math.abs(area) < 1e-8) { degenerate++; continue; } // no samples
        rasterTriangle(screen, ndc, ins.id, tri, W, H, identity, bary, depth, area);
        drawnTris++;
      }
    }
  }

  // Stage 2: resolve + shade purely from visibility buffers.
  const image = new Uint8Array(W * H * 3);
  const identityViz = new Uint8Array(W * H * 3);
  let covered = 0, invalid = 0;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const pi = py * W + px;
      if (identity[pi] === 0) {
        invalid++;
        const bg = [13, 18, 26];
        image.set(bg, pi * 3); identityViz.set(bg, pi * 3);
        continue;
      }
      covered++;
      const packed = identity[pi];
      const instanceId = (packed >> 16) & 0xff;
      const primitiveId = packed & 0xffff;
      identityViz.set(falseColor(instanceId, primitiveId), pi * 3);
      const col = resolvePixel(scene, tables, vp, eye, instanceId, primitiveId,
        bary.subarray(pi * 3, pi * 3 + 3), opts.perspective !== false);
      image.set(col, pi * 3);
    }
  }

  return {
    width: W, height: H, image, identityViz,
    identity, bary, depth,
    stats: { drawnTris, clippedTris, degenerate, covered, invalid, total: W * H },
  };
}

function edge(a, b, p) {
  return (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
}

function rasterTriangle(screen, ndc, instanceId, tri, W, H, identity, bary, depth, area) {
  const minX = Math.max(0, Math.floor(Math.min(screen[0][0], screen[1][0], screen[2][0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(screen[0][0], screen[1][0], screen[2][0])));
  const minY = Math.max(0, Math.floor(Math.min(screen[0][1], screen[1][1], screen[2][1])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(screen[0][1], screen[1][1], screen[2][1])));
  const invW = ndc.map((n) => 1 / n[3]);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      // Screen-space winding may be either sign (y is flipped); normalize the
      // edge functions by the signed area so inside is always >= 0.
      const e0 = edge(screen[1], screen[2], p);
      const e1 = edge(screen[2], screen[0], p);
      const e2 = edge(screen[0], screen[1], p);
      const w0 = e0 / area, w1 = e1 / area, w2 = e2 / area;
      const inside = area > 0
        ? (e0 >= 0 && e1 >= 0 && e2 >= 0)
        : (e0 <= 0 && e1 <= 0 && e2 <= 0);
      if (!inside) continue;
      // Perspective-correct bary: interpolate 1/w then renormalize.
      const persp = [w0 * invW[0], w1 * invW[1], w2 * invW[2]];
      const sum = persp[0] + persp[1] + persp[2];
      const b = [persp[0] / sum, persp[1] / sum, persp[2] / sum];
      const z = w0 * screen[0][2] + w1 * screen[1][2] + w2 * screen[2][2];
      const pi = y * W + x;
      if (z < depth[pi]) {
        depth[pi] = z;
        identity[pi] = ((1 << 31) >>> 0) | (instanceId << 16) | tri;
        bary[pi * 3] = b[0]; bary[pi * 3 + 1] = b[1]; bary[pi * 3 + 2] = b[2];
      }
    }
  }
}

// Reconstruct object attributes from identity + bary, then transform & shade.
function resolvePixel(scene, tables, vp, eye, instanceId, primitiveId, b, perspectiveCorrect) {
  const ins = scene.instances[instanceId];
  const geom = scene.geometryById.get(ins.geometryId);
  const ginfo = tables.geomInfo.find((g) => g.id === geom.id);
  if (primitiveId >= ginfo.triCount) return [255, 0, 0];
  const ids = [0, 1, 2].map((c) => geom.mesh.indices[primitiveId * 3 + c]);
  const P = ids.map((vi) => [
    geom.mesh.positions[vi * 3], geom.mesh.positions[vi * 3 + 1], geom.mesh.positions[vi * 3 + 2]]);
  const N = ids.map((vi) => norm3([
    geom.mesh.normals[vi * 3], geom.mesh.normals[vi * 3 + 1], geom.mesh.normals[vi * 3 + 2]]));
  const UV = ids.map((vi) => [geom.mesh.uvs[vi * 2], geom.mesh.uvs[vi * 2 + 1]]);

  let w;
  if (perspectiveCorrect) {
    const inv = P.map((p) => 1 / apply4(mat4mul(vp, ins.model), p)[3]);
    const persp = [b[0] / inv[0], b[1] / inv[1], b[2] / inv[2]];
    const s = persp.reduce((a, c) => a + c, 0);
    w = persp.map((v) => v / s);
  } else {
    const s = b[0] + b[1] + b[2]; w = [b[0] / s, b[1] / s, b[2] / s];
  }
  const objPos = [0, 1, 2].map((k) => w[0] * P[0][k] + w[1] * P[1][k] + w[2] * P[2][k]);
  const objNrm = [0, 1, 2].map((k) => w[0] * N[0][k] + w[1] * N[1][k] + w[2] * N[2][k]);
  const uv = [w[0] * UV[0][0] + w[1] * UV[1][0] + w[2] * UV[2][0],
              w[0] * UV[0][1] + w[1] * UV[1][1] + w[2] * UV[2][1]];

  const wp = apply4(ins.model, objPos);
  const worldPos = [wp[0] / wp[3], wp[1] / wp[3], wp[2] / wp[3]];
  const nmat = normalMatrix(ins.model);
  const Nw = norm3(transformDir3(nmat, objNrm));

  const mat = scene.materials[ins.materialId];
  const tex = sampleTexture(mat.texture, uv);
  const albedo = [tex[0] * mat.baseColor[0], tex[1] * mat.baseColor[1], tex[2] * mat.baseColor[2]];
  const L = norm3([0.6, 0.9, 0.4]);
  const V = norm3([eye[0] - worldPos[0], eye[1] - worldPos[1], eye[2] - worldPos[2]]);
  const H = norm3([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
  const ndl = Math.max(dot3(Nw, L), 0);
  const spec = Math.pow(Math.max(dot3(Nw, H), 0), 8 + (1 - mat.roughness) * 88) * (1 - mat.metalness * 0.5);
  const shade = albedo.map((a) => {
    const amb = a * 0.25;
    const dif = a * ndl * (1 - mat.metalness * 0.7);
    const sp = (1 - mat.metalness) * spec;
    return Math.min(255, Math.round((amb + dif + sp) * 255));
  });
  return shade;
}

function sampleTexture(tex, uv) {
  const u = ((uv[0] % 1) + 1) % 1, v = ((uv[1] % 1) + 1) % 1;
  const x = Math.min(tex.size - 1, Math.floor(u * tex.size));
  const y = Math.min(tex.size - 1, Math.floor(v * tex.size));
  const i = (y * tex.size + x) * 4;
  return [tex.data[i] / 255, tex.data[i + 1] / 255, tex.data[i + 2] / 255];
}

function falseColor(instance, primitive) {
  const hi = (Math.sin(instance * 12.9898 + primitive * 78.233) * 43758.5453) % 1;
  const h = hi - Math.floor(hi);
  const c = [0, 1, 2].map((k) => Math.round((0.5 + 0.5 * Math.cos(6.2831 * (h + k / 3))) * 255));
  return c;
}

function parseArgs(argv) {
  const opts = { width: 320, height: 240, time: 0, perspective: true, reorder: false, outDir: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--width') opts.width = parseInt(argv[++i], 10);
    else if (a === '--height') opts.height = parseInt(argv[++i], 10);
    else if (a === '--time') opts.time = parseFloat(argv[++i]);
    else if (a === '--reorder') opts.reorder = true;
    else if (a === '--affine') opts.perspective = false;
    else if (a === '--out') opts.outDir = argv[++i];
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv);
  const result = runSoftwarePipeline(opts);
  fs.mkdirSync(opts.outDir, { recursive: true });
  const shadedPath = path.join(opts.outDir, 'vis-shaded.png');
  const idPath = path.join(opts.outDir, 'vis-identity.png');
  fs.writeFileSync(shadedPath, encodePNG(result.width, result.height, result.image));
  fs.writeFileSync(idPath, encodePNG(result.width, result.height, result.identityViz));
  console.log('Visibility-buffer software reference (auxiliary CLI)');
  console.log('  shaded image   :', shadedPath);
  console.log('  identity buffer:', idPath);
  console.log('  stats          :', JSON.stringify(result.stats));
}
