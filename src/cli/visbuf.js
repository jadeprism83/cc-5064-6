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
import {
  ReasonCode, ReasonMeta, LogBudget, tracePixel, analyzeVisibilityFrame,
  buildVisFrameArchive, replayArchive,
} from '../../public/visibility-diagnostics.js';
import { normalMatrix } from '../../public/math.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', '..', 'public');
const { buildScene, updateTransforms, buildBatches } = await import(path.join(PUBLIC, 'scene.js'));
const { buildGlobalTables } = await import(path.join(PUBLIC, 'data-tables.js'));
const { perspective, lookAt, multiply } = await import(path.join(PUBLIC, 'math.js'));

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

// 实时场景解析器：把当前 scene/tables 适配成诊断模块的三表解析接口。
// 与 GPU 解析路径读取同一组几何/实例/材质表，保证诊断回溯到真实着色三角形。
export function liveSceneResolver(scene, tables, opts = {}) {
  const unloadedGeometry = opts.unloadedGeometry || new Set();
  const unloadedMaterial = opts.unloadedMaterial || new Set();
  return {
    resolveInstance(id) {
      const ins = scene.instances.find((i) => i.id === id);
      if (!ins) return null;
      const mat = scene.materials[ins.materialId];
      return {
        id: ins.id, name: ins.name,
        geometryId: ins.geometryId, materialId: ins.materialId,
        model: ins.model,
        normalMat: normalMatrix(ins.model),
        materialVersion: mat ? mat.version : 0,
      };
    },
    resolveGeometry(id) {
      const g = scene.geometryById.get(id);
      if (!g) return null;
      const info = tables.geomInfo.find((x) => x.id === id);
      if (unloadedGeometry.has(id)) return { id, name: g.name, unloaded: true };
      return {
        id, name: g.name,
        vertStart: info.vertStart, indexStart: info.indexStart,
        triCount: info.triCount, vertexCount: info.vertexCount,
        positions: g.mesh.positions, normals: g.mesh.normals,
        uvs: g.mesh.uvs, indices: g.mesh.indices,
      };
    },
    resolveMaterial(id, version) {
      const m = scene.materials[id];
      if (!m) return null;
      if (unloadedMaterial.has(id) || m.unloaded) return { id, name: m.name, unloaded: true };
      return {
        id: m.id, name: m.name, version: m.version, liveVersion: m.version,
        baseColor: m.baseColor, roughness: m.roughness, metalness: m.metalness,
        texture: m.texture,
      };
    },
  };
}

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
  // 允许调用方注入受控场景（共享顶点/实例复用/编号复用测试）；默认自建。
  const scene = opts.scene || buildScene();
  if (!opts.scene) updateTransforms(scene.instances, opts.time || 0);
  else if (opts.updateTransforms !== false) updateTransforms(scene.instances, opts.time || 0);
  const tables = opts.tables || buildGlobalTables(scene.geometries);
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

  // Stage 2: resolve + shade purely from visibility buffers, using the shared
  // diagnostic tracer so CLI and GUI follow one execution-evidence chain.
  const image = new Uint8Array(W * H * 3);
  const identityViz = new Uint8Array(W * H * 3);
  const reasonMap = new Uint8Array(W * H);
  const reasonIndex = Object.fromEntries(Object.values(ReasonCode).map((c, i) => [c, i + 1]));
  const indexReason = Object.fromEntries(Object.entries(reasonIndex).map(([k, v]) => [v, k]));
  const resolver = liveSceneResolver(scene, tables, opts);
  const traceCtx = { resolver, viewProj: vp, camPos: eye, perspectiveCorrect: opts.perspective !== false };
  let covered = 0, invalid = 0, halted = 0;
  const reasonCounts = {};
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const pi = py * W + px;
      if (identity[pi] === 0) {
        invalid++;
        const bg = [13, 18, 26];
        image.set(bg, pi * 3); identityViz.set(bg, pi * 3);
        reasonMap[pi] = reasonIndex[ReasonCode.BACKGROUND];
        continue;
      }
      covered++;
      const packed = identity[pi];
      const instanceId = (packed >> 16) & 0xff;
      const primitiveId = packed & 0xffff;
      identityViz.set(falseColor(instanceId, primitiveId), pi * 3);
      const t = tracePixel(packed, bary.subarray(pi * 3, pi * 3 + 3), {
        ...traceCtx,
        neighborPacked: px + 1 < W ? identity[pi + 1] : packed,
      });
      reasonMap[pi] = reasonIndex[t.primary];
      reasonCounts[t.primary] = (reasonCounts[t.primary] || 0) + 1;
      if (t.halted) {
        halted++;
        image.set(ReasonMeta[t.primary].color, pi * 3);
      } else {
        image.set([Math.round(t.rgb[0] * 255), Math.round(t.rgb[1] * 255), Math.round(t.rgb[2] * 255)], pi * 3);
      }
    }
  }

  return {
    width: W, height: H, image, identityViz,
    identity, bary, depth,
    reasonMap, reasonAt: (pi) => (reasonMap[pi] ? indexReason[reasonMap[pi]] : ReasonCode.BACKGROUND),
    reasonCounts,
    resolver, traceCtx,
    scene, tables, viewProj: vp, camPos: eye,
    stats: { drawnTris, clippedTris, degenerate, covered, invalid, halted, total: W * H },
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

// Reconstruct/resolve now lives in the shared diagnostic tracer
// (public/visibility-diagnostics.js tracePixel); this CLI rasterizer only owns
// stage-1 rasterization and delegates every attribute/material decision to it.

function falseColor(instance, primitive) {
  const hi = (Math.sin(instance * 12.9898 + primitive * 78.233) * 43758.5453) % 1;
  const h = hi - Math.floor(hi);
  const c = [0, 1, 2].map((k) => Math.round((0.5 + 0.5 * Math.cos(6.2831 * (h + k / 3))) * 255));
  return c;
}

function parseArgs(argv) {
  const opts = {
    width: 320, height: 240, time: 0, perspective: true, reorder: false,
    outDir: process.cwd(), diagnose: false, archive: false,
    unloadGeometry: [], unloadMaterial: [], stride: 2,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--width') opts.width = parseInt(argv[++i], 10);
    else if (a === '--height') opts.height = parseInt(argv[++i], 10);
    else if (a === '--time') opts.time = parseFloat(argv[++i]);
    else if (a === '--reorder') opts.reorder = true;
    else if (a === '--affine') opts.perspective = false;
    else if (a === '--diagnose') opts.diagnose = true;
    else if (a === '--archive') opts.archive = true;
    else if (a === '--stride') opts.stride = parseInt(argv[++i], 10);
    else if (a === '--unload-geometry') opts.unloadGeometry.push(parseInt(argv[++i], 10));
    else if (a === '--unload-material') opts.unloadMaterial.push(parseInt(argv[++i], 10));
    else if (a === '--out') opts.outDir = argv[++i];
  }
  return opts;
}

// 旧样例（无新参数）必须运行到底：默认只产出身份/着色两张 PNG 与统计。
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv);
  const diagOpts = {
    ...opts,
    unloadedGeometry: new Set(opts.unloadGeometry),
    unloadedMaterial: new Set(opts.unloadMaterial),
  };
  const result = runSoftwarePipeline(diagOpts);
  fs.mkdirSync(opts.outDir, { recursive: true });
  const shadedPath = path.join(opts.outDir, 'vis-shaded.png');
  const idPath = path.join(opts.outDir, 'vis-identity.png');
  fs.writeFileSync(shadedPath, encodePNG(result.width, result.height, result.image));
  fs.writeFileSync(idPath, encodePNG(result.width, result.height, result.identityViz));
  console.log('Visibility-buffer software reference (auxiliary CLI)');
  console.log('  shaded image   :', shadedPath);
  console.log('  identity buffer:', idPath);
  console.log('  stats          :', JSON.stringify(result.stats));

  // 封存帧：把同一可见性帧冻结为像素取证快照（含解析所需的全部资源）。
  let archive = null;
  if (opts.archive) {
    const archiveScene = { ...result.scene, geomInfo: result.tables.geomInfo };
    archive = buildVisFrameArchive(
      {
        width: result.width, height: result.height,
        identity: result.identity, bary: result.bary,
        viewProj: result.viewProj, camPos: result.camPos,
      },
      archiveScene,
      { perspectiveCorrect: opts.perspective, frameToken: 0 },
    );
    const archivePath = path.join(opts.outDir, 'vis-frame.json');
    fs.writeFileSync(archivePath, JSON.stringify(archive));
    console.log('  frame archive  :', archivePath);
  }

  // 诊断：对可见性缓冲复跑追踪，输出原因分布与有界日志成本。
  if (opts.diagnose) {
    const analysis = analyzeVisibilityFrame(
      { width: result.width, height: result.height, identity: result.identity, bary: result.bary },
      result.traceCtx,
      { stride: opts.stride, budget: new LogBudget() },
    );
    console.log('  diagnosis      :', JSON.stringify({
      analyzed: analysis.analyzed,
      halted: analysis.haltedCount,
      reasonCounts: analysis.counts,
      meanPixelDelta: Number(analysis.meanPixelDelta.toFixed(4)),
      maxPixelDelta: Number(analysis.maxPixelDelta.toFixed(4)),
      truncated: analysis.truncated,
      logEvents: analysis.logEvents,
      logPixels: analysis.logPixels,
    }));
    if (analysis.samples.length) {
      console.log('  first evidence chain:');
      const s = analysis.samples[0];
      for (const e of s.evidence) {
        console.log(`    - [${e.stage}] ${e.code} ${JSON.stringify(e.detail)}`);
      }
    }
  }

  // 卸载重放：仅有旧编号、资源已卸载时，标出缺失依赖并停在那次绘制。
  if (archive && (opts.unloadGeometry.length || opts.unloadMaterial.length)) {
    const replay = replayArchive(archive, {
      unloadedGeometry: new Set(opts.unloadGeometry),
      unloadedMaterial: new Set(opts.unloadMaterial),
    });
    const replayPath = path.join(opts.outDir, 'vis-replay.png');
    fs.writeFileSync(replayPath, encodePNG(replay.width, replay.height, replay.image));
    console.log('  replay image   :', replayPath);
    console.log('  halted pixels  :', replay.haltedCount);
    console.log('  missing deps   :', JSON.stringify(replay.missingDependencies));
  }
}
