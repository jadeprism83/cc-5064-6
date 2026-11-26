// 可见性缓冲解码追踪 / 取证诊断的无头不变量。
// 所有结论都由共享诊断实现（public/visibility-diagnostics.js）对真实可见性
// 缓冲复跑得出，不允许在测试里用固定数据冒充身份/着色图。
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runSoftwarePipeline, liveSceneResolver } from '../src/cli/visbuf.js';
import {
  ReasonCode, LogBudget, tracePixel, analyzeVisibilityFrame,
  buildVisFrameArchive, replayArchive,
} from '../public/visibility-diagnostics.js';
import { buildScene, updateTransforms, deleteAndReuseInstanceId, restoreInstances } from '../public/scene.js';
import { buildGlobalTables } from '../public/data-tables.js';
import { makeSharedWedge } from '../public/geometry.js';
import { makeTexture, publishEdit } from '../public/materials.js';
import { normalMatrix } from '../public/math.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS', name); passed++; }
  catch (e) { console.error('  FAIL', name, '\n    ', e.stack || e.message); process.exitCode = 1; }
}

console.log('Visibility decode-tracing & forensic diagnostics:');

// ---------------------------------------------------------------------------
test('clean frame produces no false-positive anomaly codes', () => {
  const r = runSoftwarePipeline({ width: 200, height: 150 });
  const analysis = analyzeVisibilityFrame(
    { width: r.width, height: r.height, identity: r.identity, bary: r.bary },
    r.traceCtx,
    { stride: 2, budget: new LogBudget() },
  );
  // 干净帧只允许 clean / background / material-boundary（边界是结构事实，非错误）。
  for (const code of Object.keys(analysis.counts)) {
    assert.ok(
      [ReasonCode.CLEAN, ReasonCode.MATERIAL_BOUNDARY].includes(code),
      `unexpected anomaly on clean frame: ${code}`,
    );
  }
  assert.equal(analysis.haltedCount, 0);
  assert.equal(analysis.truncated, false);
});

// ---------------------------------------------------------------------------
test('tracePixel follows a full stage evidence chain back to the shaded triangle', () => {
  const r = runSoftwarePipeline({ width: 200, height: 150 });
  // 找一个被覆盖像素。
  let pi = -1;
  for (let i = 0; i < r.identity.length; i++) if (r.identity[i] !== 0) { pi = i; break; }
  assert.ok(pi >= 0);
  const t = tracePixel(r.identity[pi], r.bary.subarray(pi * 3, pi * 3 + 3), r.traceCtx);
  const stages = t.evidence.map((e) => e.stage);
  for (const s of ['decode', 'instance-table', 'geometry-table', 'vertex-fetch', 'attribute-recover', 'material-binding', 'material-shade']) {
    assert.ok(stages.includes(s), `evidence chain missing stage ${s}`);
  }
  assert.match(t.triangle, /#tri\d+$/);
  assert.ok(t.rgb.every((c) => c >= 0 && c <= 1));
  assert.equal(t.halted, false);
});

// ---------------------------------------------------------------------------
test('shared-vertex wedge traces each pixel to its actual triangle, never out of bounds', () => {
  const scene = buildScene();
  // 用共享楔形替换一个几何，并构造两个实例复用它（实例重用场景）。
  const wedge = makeSharedWedge();
  const geom = { id: 99, name: 'shared-wedge', mesh: wedge };
  scene.geometries.push(geom);
  scene.geometryById.set(99, geom);
  scene.instances.length = 0;
  scene.instances.push(
    { id: 0, name: 'wedge-a', geometryId: 99, materialId: 0, pos: [-1.2, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1], dynamic: false },
    { id: 1, name: 'wedge-b', geometryId: 99, materialId: 1, pos: [1.2, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1], dynamic: false },
  );
  updateTransforms(scene.instances, 0);
  const tables = buildGlobalTables(scene.geometries);
  const r = runSoftwarePipeline({ width: 200, height: 150, scene, tables });
  // 该场景的解析器基于替换后的 scene/tables。
  const resolver = liveSceneResolver(scene, tables);
  const W = r.width;
  const seenPrims = new Set();
  let sharedNoted = 0;
  for (let pi = 0; pi < r.identity.length; pi++) {
    if (r.identity[pi] === 0) continue;
    const t = tracePixel(r.identity[pi], r.bary.subarray(pi * 3, pi * 3 + 3),
      { resolver, viewProj: r.viewProj, camPos: r.camPos, perspectiveCorrect: true });
    // 允许 clean 与材质/纹素边界；核心断言是绝不越界、绝不中止。
    assert.ok(
      [ReasonCode.CLEAN, ReasonCode.MATERIAL_BOUNDARY].includes(t.primary),
      `unexpected reason ${t.primary} on shared wedge`,
    );
    assert.notEqual(t.primary, ReasonCode.OUT_OF_BOUNDS_FETCH);
    assert.equal(t.halted, false);
    seenPrims.add(`${t.instanceId}:${t.primitiveId}`);
    const vf = t.evidence.find((e) => e.stage === 'vertex-fetch');
    if (vf.detail.sharedVertices) sharedNoted++;
  }
  // 两个几何图元（0 与 1）都必须能被回溯到实际着色像素。
  const prims = new Set([...seenPrims].map((s) => s.split(':')[1]));
  assert.ok(prims.has('0') && prims.has('1'), 'both wedge triangles must be traceable');
  // 楔形索引层面：两三角形共享 v1/v3 两个顶点（身份/导数区分的数据基础）。
  const tri0 = [wedge.indices[0], wedge.indices[1], wedge.indices[2]];
  const tri1 = [wedge.indices[3], wedge.indices[4], wedge.indices[5]];
  const sharedVerts = tri0.filter((v) => tri1.includes(v));
  assert.equal(sharedVerts.length, 2, 'wedge triangles share two vertices');
  assert.ok(sharedNoted >= 0);
});

// ---------------------------------------------------------------------------
test('object deletion + id reuse flags stale material binding at the binding stage', () => {
  const scene = buildScene();
  updateTransforms(scene.instances, 0);
  scene.materials.forEach((m) => { m.unloaded = false; }); // 隔离其他测试的卸载状态
  // 1) 先捕获一帧（实例 1 = sphere B，材质 1，版本 0）。
  const captured = runSoftwarePipeline({ width: 200, height: 150, scene });
  const archive = buildVisFrameArchive(
    { width: captured.width, height: captured.height, identity: captured.identity, bary: captured.bary, viewProj: captured.viewProj, camPos: captured.camPos },
    { ...captured.scene, geomInfo: captured.tables.geomInfo },
    { frameToken: 7 },
  );
  // 2) 删除实例 1 并把编号 1 复用到材质不同的新物体（几何 0 / 材质 3）。
  const snapshot = scene.instances.map((i) => ({ ...i }));
  deleteAndReuseInstanceId(scene, 1, { name: 'reused-1', geometryId: 0, materialId: 3 });
  updateTransforms(scene.instances, 0);
  // 推进实时材质版本，模拟热换后首次重放读到旧属性。
  publishEdit(scene.materials[1], { baseColor: [0.2, 0.3, 0.9] });
  const liveVersions = Object.fromEntries(scene.materials.map((m) => [m.id, m.version]));

  // 3) 用"封存描述符 + 当代实时版本"重放：旧像素仍引用捕获时的旧版本。
  const resolver = {
    resolveInstance(id) {
      const ins = archive.instances.find((x) => x.id === id);
      return ins ? { ...ins, normalMat: normalMatrix(new Float32Array(ins.model)) } : null;
    },
    resolveGeometry(id) { return archive.geometries.find((g) => g.id === id); },
    resolveMaterial(id) {
      const m = archive.materials.find((x) => x.id === id);
      if (!m) return null;
      return { ...m, liveVersion: liveVersions[id] };
    },
  };
  let pi = -1;
  for (let i = 0; i < archive.identity.length; i++) {
    if (((archive.identity[i] >> 16) & 0xff) === 1) { pi = i; break; }
  }
  assert.ok(pi >= 0, 'frame must contain instance 1 pixels');
  const t = tracePixel(
    archive.identity[pi],
    Float32Array.from(archive.bary.slice(pi * 3, pi * 3 + 3)),
    {
      resolver,
      viewProj: new Float32Array(archive.camera.viewProj),
      camPos: archive.camera.camPos,
      perspectiveCorrect: true,
    },
  );
  const bind = t.evidence.find((e) => e.stage === 'material-binding');
  assert.equal(bind.code, ReasonCode.MATERIAL_STALE_BINDING);
  assert.equal(bind.detail.boundVersion, 0);
  assert.equal(bind.detail.liveVersion, 1);
  assert.equal(t.primary, ReasonCode.MATERIAL_STALE_BINDING);
  restoreInstances(scene, snapshot);
});

// ---------------------------------------------------------------------------
test('unloaded geometry/material marks missing dependency and halts that draw', () => {
  const r = runSoftwarePipeline({ width: 180, height: 140 });
  const archive = buildVisFrameArchive(
    { width: r.width, height: r.height, identity: r.identity, bary: r.bary, viewProj: r.viewProj, camPos: r.camPos },
    { ...r.scene, geomInfo: r.tables.geomInfo },
  );
  const replay = replayArchive(archive, {
    unloadedGeometry: new Set([2]),
    unloadedMaterial: new Set([4]),
  });
  assert.ok(replay.haltedCount > 0, 'halted draws expected');
  const codes = replay.missingDependencies.map((m) => m.code);
  assert.ok(codes.includes(ReasonCode.GEOMETRY_UNLOADED));
  assert.ok(codes.includes(ReasonCode.MATERIAL_UNLOADED));
  // 缺失像素不得产出正常着色，而是原因标记色。
  let pi = -1;
  for (let i = 0; i < r.identity.length; i++) {
    if (((r.identity[i] >> 16) & 0xff) === 2) { pi = i; break; }
  }
  assert.ok(pi >= 0);
  assert.equal(replay.reasonAt(pi), ReasonCode.GEOMETRY_UNLOADED);
});

// ---------------------------------------------------------------------------
test('hot material swap on an archived frame still reproduces original colors', () => {
  const r = runSoftwarePipeline({ width: 160, height: 120 });
  const baseline = Uint8Array.from(r.image); // 捕获时的基准着色
  const archive = buildVisFrameArchive(
    { width: r.width, height: r.height, identity: r.identity, bary: r.bary, viewProj: r.viewProj, camPos: r.camPos },
    { ...r.scene, geomInfo: r.tables.geomInfo },
  );
  // 热换实时材质（封存资源是独立副本，不受影响）。
  publishEdit(r.scene.materials[0], { texture: makeTexture('noise') });
  const replay = replayArchive(archive); // 不带 liveVersions -> 使用封存描述符
  let diff = 0, n = 0;
  for (let pi = 0; pi < r.identity.length; pi++) {
    if (r.identity[pi] === 0) continue;
    const o = pi * 3;
    diff += Math.abs(replay.image[o] - baseline[o]) + Math.abs(replay.image[o + 1] - baseline[o + 1]) + Math.abs(replay.image[o + 2] - baseline[o + 2]);
    n++;
  }
  // 封存重放与捕获时着色应当逐像素一致（同一描述符、同一数学）。
  assert.ok(diff / n < 1.0, `archived replay should preserve colors, mean abs diff=${diff / n}`);
});

// ---------------------------------------------------------------------------
test('affine control path is localized to the attribute-recover stage', () => {
  const persp = runSoftwarePipeline({ width: 180, height: 140, perspective: true });
  const affine = runSoftwarePipeline({ width: 180, height: 140, perspective: false });
  const analysis = analyzeVisibilityFrame(
    {
      width: affine.width, height: affine.height,
      identity: affine.identity, bary: affine.bary,
      expected: persp.image,
    },
    affine.traceCtx,
    { stride: 2, budget: new LogBudget() },
  );
  assert.ok(analysis.counts[ReasonCode.BARY_PERSPECTIVE_MISMATCH] > 0, 'perspective mismatch expected');
  const sample = analysis.samples.find((s) => s.primary === ReasonCode.BARY_PERSPECTIVE_MISMATCH);
  assert.ok(sample, 'a mismatch sample must be retained');
  const stageCodes = sample.evidence.filter((e) => e.code === ReasonCode.BARY_PERSPECTIVE_MISMATCH).map((e) => e.stage);
  assert.deepEqual(stageCodes, ['verify']);
  assert.ok(analysis.maxPixelDelta > 0);
});

// ---------------------------------------------------------------------------
test('log budget caps forensic log cost and reports truncation', () => {
  const r = runSoftwarePipeline({ width: 240, height: 180 });
  const tight = new LogBudget({ maxEvents: 8, maxPixels: 50 });
  const analysis = analyzeVisibilityFrame(
    { width: r.width, height: r.height, identity: r.identity, bary: r.bary },
    r.traceCtx,
    { stride: 1, budget: tight },
  );
  assert.ok(analysis.truncated, 'tight budget must truncate');
  assert.ok(analysis.logPixels <= 50);
  assert.ok(analysis.samples.length <= 8);
});

// ---------------------------------------------------------------------------
test('out-of-range identity is reported as an encoding problem, not rendered as id 0', () => {
  const r = runSoftwarePipeline({ width: 120, height: 90 });
  const corrupt = new Uint32Array(r.identity);
  corrupt[0] = 0x80000000 | (200 << 16) | 5; // instance 200 out of table range
  const t = tracePixel(corrupt[0], r.bary.subarray(0, 3), r.traceCtx);
  assert.equal(t.primary, ReasonCode.INSTANCE_OUT_OF_RANGE);
  assert.equal(t.halted, true);
  assert.equal(t.rgb, null);
});

// ---------------------------------------------------------------------------
test('boundary pixels are classified as material boundary, never attribute misread', () => {
  const r = runSoftwarePipeline({ width: 220, height: 160 });
  // 找到一个与右邻属于不同实例的边界覆盖像素。
  let pi = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width - 1; x++) {
      const i = y * r.width + x;
      if (r.identity[i] === 0) continue;
      const inst = (r.identity[i] >> 16) & 0xff;
      const nInst = (r.identity[i + 1] >> 16) & 0xff;
      if ((r.identity[i + 1] & 0x80000000) !== 0 && nInst !== inst) { pi = i; break; }
    }
    if (pi >= 0) break;
  }
  assert.ok(pi >= 0, 'scene must contain an instance boundary');
  const t = tracePixel(r.identity[pi], r.bary.subarray(pi * 3, pi * 3 + 3), {
    ...r.traceCtx,
    neighborPacked: r.identity[pi + 1],
    expected: { rgb: [r.image[pi * 3] / 255, r.image[pi * 3 + 1] / 255, r.image[pi * 3 + 2] / 255] },
  });
  const boundary = t.evidence.find((e) => e.code === ReasonCode.MATERIAL_BOUNDARY);
  assert.ok(boundary, 'boundary pixel must be labelled material-boundary');
  assert.equal(boundary.detail.kind, 'instance-reuse');
  // 边界是结构事实，不得升级为属性错读，也不得产生像素差异告警。
  assert.notEqual(t.primary, ReasonCode.ATTRIBUTE_MISREAD);
  assert.ok(t.pixelDelta === null || t.pixelDelta < 0.06);
});

// ---------------------------------------------------------------------------
test('archived frame JSON round-trips and old samples still run to completion', () => {
  const r = runSoftwarePipeline({ width: 120, height: 90 });
  const archive = buildVisFrameArchive(
    { width: r.width, height: r.height, identity: r.identity, bary: r.bary, viewProj: r.viewProj, camPos: r.camPos },
    { ...r.scene, geomInfo: r.tables.geomInfo },
  );
  const json = JSON.stringify(archive);
  const back = JSON.parse(json);
  assert.equal(back.format, 'vis-frame-archive');
  const replay = replayArchive(back);
  assert.equal(replay.haltedCount, 0);
  assert.equal(replay.image.length, r.width * r.height * 3);
  // 每个像素的原因码都必须是已知码，不允许出现未定义/伪造原因。
  const validCodes = new Set(Object.values(ReasonCode));
  for (let pi = 0; pi < r.width * r.height; pi++) {
    assert.ok(validCodes.has(replay.reasonAt(pi)), `unknown reason code at ${pi}`);
  }
  // 左上角是背景，应标 background。
  assert.equal(replay.reasonAt(0), ReasonCode.BACKGROUND);
});

console.log(`\n${passed} diagnostic test groups passed`);
