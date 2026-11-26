// 可见性缓冲解码追踪与诊断（取证核心）。
//
// 这是 WebGL2 渲染器与 CPU 参考管线共用的唯一诊断实现：界面按钮与 CLI 都
// 调用这里的真实追踪逻辑，不允许任何调用方用固定数据冒充身份/着色图。
//
// 设计要点：
//  - 追踪"实际被着色的三角形"：从可见性身份解包实例/图元，经几何/实例/材质
//    三张分离的表反查，记录一条带阶段（stage）的执行证据链；
//  - 每个异常都归到明确原因（ReasonCode），并附带恢复属性与像素差异；
//  - 日志有界（LogBudget），按像素预算/容量上限提前停止，限制取证日志成本；
//  - 封存帧（VisFrameArchive）可在材质热换、实例删除、编号复用、材质卸载后
//    重放：封存资源齐全则还原原色，依赖缺失则标出缺失依赖并停在那次绘制。
import { normalMatrix, transformDir3, multiply } from './math.js';

// ---------------------------------------------------------------------------
// 原因码。clean 表示无异常；其余每个码都对应一个可定位的阶段，禁止伪报。
// ---------------------------------------------------------------------------
export const ReasonCode = Object.freeze({
  CLEAN: 'clean',
  BACKGROUND: 'background',
  IDENTITY_INVALID: 'identity-invalid',
  IDENTITY_CORRUPT: 'identity-corrupt',
  INSTANCE_OUT_OF_RANGE: 'instance-out-of-range',
  GEOMETRY_UNLOADED: 'geometry-unloaded',
  PRIMITIVE_OUT_OF_RANGE: 'primitive-out-of-range',
  SHARED_VERTEX_DERIVATIVE: 'shared-vertex-derivative',
  OUT_OF_BOUNDS_FETCH: 'out-of-bounds-fetch',
  MATERIAL_UNLOADED: 'material-unloaded',
  MATERIAL_STALE_BINDING: 'material-stale-binding',
  MATERIAL_BOUNDARY: 'material-boundary',
  BARY_NON_NORMALIZED: 'bary-non-normalized',
  BARY_PERSPECTIVE_MISMATCH: 'bary-perspective-mismatch',
  ATTRIBUTE_MISREAD: 'attribute-misread',
});

// 原因 -> 阶段 / 中文说明 / 颜色。颜色用于联动调试视窗的原因叠加。
export const ReasonMeta = Object.freeze({
  [ReasonCode.CLEAN]: { stage: 'shade', label: '无异常', color: [63, 185, 80] },
  [ReasonCode.BACKGROUND]: { stage: 'decode', label: '背景/裁剪（有效位为 0）', color: [13, 18, 26] },
  [ReasonCode.IDENTITY_INVALID]: { stage: 'decode', label: '无效身份（未当作零号三角形）', color: [120, 120, 120] },
  [ReasonCode.IDENTITY_CORRUPT]: { stage: 'decode', label: '身份编码越界（有效位/字段损坏）', color: [248, 81, 73] },
  [ReasonCode.INSTANCE_OUT_OF_RANGE]: { stage: 'instance-table', label: '实例号越界（身份编码问题）', color: [255, 0, 255] },
  [ReasonCode.GEOMETRY_UNLOADED]: { stage: 'geometry-table', label: '几何资源已卸载（缺失依赖，绘制中止）', color: [255, 128, 0] },
  [ReasonCode.PRIMITIVE_OUT_OF_RANGE]: { stage: 'geometry-table', label: '图元号越界（身份编码问题）', color: [255, 0, 0] },
  [ReasonCode.SHARED_VERTEX_DERIVATIVE]: { stage: 'vertex-fetch', label: '共享顶点导数不一致（身份/导数区分）', color: [188, 128, 255] },
  [ReasonCode.OUT_OF_BOUNDS_FETCH]: { stage: 'vertex-fetch', label: '顶点/索引越界读取', color: [255, 80, 120] },
  [ReasonCode.MATERIAL_UNLOADED]: { stage: 'material-binding', label: '材质资源已卸载（缺失依赖，绘制中止）', color: [255, 160, 40] },
  [ReasonCode.MATERIAL_STALE_BINDING]: { stage: 'material-binding', label: '编号复用读到旧材质（首次读旧属性）', color: [227, 179, 65] },
  [ReasonCode.MATERIAL_BOUNDARY]: { stage: 'material-shade', label: '材质边界像素（实例重用/边界区分）', color: [88, 166, 255] },
  [ReasonCode.BARY_NON_NORMALIZED]: { stage: 'attribute-recover', label: '重心权重未归一（属性错读）', color: [255, 200, 0] },
  [ReasonCode.BARY_PERSPECTIVE_MISMATCH]: { stage: 'attribute-recover', label: '透视恢复与前向不一致（属性错读）', color: [255, 140, 0] },
  [ReasonCode.ATTRIBUTE_MISREAD]: { stage: 'attribute-recover', label: '恢复属性与参考不符（属性错读）', color: [255, 90, 90] },
});

// 缺失依赖类原因：诊断器必须停在那次绘制（不继续着色）。
const HALT_REASONS = new Set([
  ReasonCode.GEOMETRY_UNLOADED,
  ReasonCode.MATERIAL_UNLOADED,
  ReasonCode.INSTANCE_OUT_OF_RANGE,
  ReasonCode.PRIMITIVE_OUT_OF_RANGE,
  ReasonCode.OUT_OF_BOUNDS_FETCH,
]);

export function isHaltReason(code) { return HALT_REASONS.has(code); }

// ---------------------------------------------------------------------------
// 有界日志：像素取证可能非常多，这里用容量/预算硬上限控制日志成本。
// ---------------------------------------------------------------------------
export class LogBudget {
  constructor({ maxEvents = 2000, maxPixels = 4096 } = {}) {
    this.maxEvents = maxEvents;
    this.maxPixels = maxPixels;
    this.events = 0;
    this.pixels = 0;
    this.truncated = false;
  }
  get exhausted() {
    return this.events >= this.maxEvents || this.pixels >= this.maxPixels;
  }
  claimPixel() {
    if (this.exhausted) { this.truncated = true; return false; }
    this.pixels++;
    return true;
  }
  claimEvent() {
    if (this.events >= this.maxEvents) { this.truncated = true; return false; }
    this.events++;
    return true;
  }
}

// 解析器：把实例/材质/几何编号解析成表记录，或返回 null 表示资源已卸载。
// 解析器由调用方（实时场景 / 封存帧）提供，保证同一份诊断逻辑两种来源通用。
//
// resolveInstance(id) -> {
//   id, name, geometryId, materialId,
//   model: mat4, normalMat?: mat3,
//   materialVersion, geometryVersion
// } | null
// resolveGeometry(id) -> {
//   id, name, vertStart, indexStart, triCount, vertexCount,
//   positions, normals, uvs, indices, unloaded?: bool
// } | null
// resolveMaterial(id, version) -> {
//   id, name, version, baseColor:[r,g,b], roughness, metalness,
//   texture:{size,data}, unloaded?: bool, liveVersion?: int
// } | null

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function apply4(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

// 最近邻纹理采样，与 CPU 参考及 GPU NEAREST 调试语义一致（材质边界判定专用）。
function sampleTextureNearest(tex, uv) {
  const u = ((uv[0] % 1) + 1) % 1, v = ((uv[1] % 1) + 1) % 1;
  const x = Math.min(tex.size - 1, Math.floor(u * tex.size));
  const y = Math.min(tex.size - 1, Math.floor(v * tex.size));
  const i = (y * tex.size + x) * 4;
  return [tex.data[i] / 255, tex.data[i + 1] / 255, tex.data[i + 2] / 255];
}

// 双线性采样，匹配 GPU 的 LINEAR + REPEAT。着色核查必须与前向路径同滤波，
// 否则纹理边界会产生与属性错读无关的巨大伪差异。
function sampleTextureLinear(tex, uv) {
  const size = tex.size;
  const u = ((uv[0] % 1) + 1) % 1, v = ((uv[1] % 1) + 1) % 1;
  const fx = u * size - 0.5, fy = v * size - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const at = (xi, yi) => {
    const x = ((xi % size) + size) % size, y = ((yi % size) + size) % size;
    const i = (y * size + x) * 4;
    return [tex.data[i] / 255, tex.data[i + 1] / 255, tex.data[i + 2] / 255];
  };
  const c00 = at(x0, y0), c10 = at(x0 + 1, y0), c01 = at(x0, y0 + 1), c11 = at(x0 + 1, y0 + 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  return [0, 1, 2].map((k) =>
    lerp(lerp(c00[k], c10[k], tx), lerp(c01[k], c11[k], tx), ty));
}

// 与 resolve.frag / forward.frag 完全一致的光照，保证逐像素核查 apples-to-apples。
function shadeSurface(worldPos, N, albedo, rough, metal, camPos) {
  const L = norm3([0.6, 0.9, 0.4]);
  const V = norm3([camPos[0] - worldPos[0], camPos[1] - worldPos[1], camPos[2] - worldPos[2]]);
  const H = norm3([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
  const ndl = Math.max(dot3(N, L), 0);
  const spec = Math.pow(Math.max(dot3(N, H), 0), 8 + (1 - rough) * 88) * (1 - metal * 0.5);
  const ambient = [albedo[0] * 0.25, albedo[1] * 0.25, albedo[2] * 0.25];
  const diffuse = [albedo[0] * ndl * (1 - metal * 0.7), albedo[1] * ndl * (1 - metal * 0.7), albedo[2] * ndl * (1 - metal * 0.7)];
  // 与 GPU 的 mix(vec3(1), albedo, metal) 完全等价。
  const specCol = [
    (1 - metal + albedo[0] * metal) * spec,
    (1 - metal + albedo[1] * metal) * spec,
    (1 - metal + albedo[2] * metal) * spec,
  ];
  return [ambient[0] + diffuse[0] + specCol[0], ambient[1] + diffuse[1] + specCol[1], ambient[2] + diffuse[2] + specCol[2]];
}

// ---------------------------------------------------------------------------
// 单像素追踪：从 packed 身份出发，重建实际被着色三角形的全部证据。
// 返回的 evidence 数组即"执行证据链"，每条带 stage / code / 详情。
// opts:
//   perspectiveCorrect: bool  是否启用透视正确恢复
//   viewProj: mat4             用于从重心还原仿射权重
//   camPos: [x,y,z]
//   expected?: { instanceId, primitiveId, rgb?:[r,g,b]0..1 }  参考（前向）结果
//   neighborPacked?: uint      相邻像素身份，用于材质/实例边界判定
// ---------------------------------------------------------------------------
export function tracePixel(packed, bary, ctx) {
  const { resolver, viewProj, camPos } = ctx;
  const perspectiveCorrect = ctx.perspectiveCorrect !== false;
  const evidence = [];
  const push = (stage, code, detail = {}) => evidence.push({ stage, code, detail });

  const valid = (packed & 0x80000000) !== 0;
  const instanceId = valid ? (packed >> 16) & 0xff : -1;
  const primitiveId = valid ? packed & 0xffff : -1;

  // 阶段 1：身份解码。
  push('decode', valid ? ReasonCode.CLEAN : ReasonCode.BACKGROUND, { packed, valid, instanceId, primitiveId });
  if (!valid) {
    return halt({ packed, valid, instanceId, primitiveId, evidence, rgb: null, recovered: null, primary: ReasonCode.BACKGROUND });
  }
  // 编码字段损坏：有效位在但字段超出可表达范围（uint 已天然限定，这里查表前先做形状校验）。
  if (instanceId > 0xff || primitiveId > 0xffff || instanceId < 0 || primitiveId < 0) {
    push('decode', ReasonCode.IDENTITY_CORRUPT, { instanceId, primitiveId });
    return halt({ packed, valid, instanceId, primitiveId, evidence, rgb: null, recovered: null, primary: ReasonCode.IDENTITY_CORRUPT });
  }

  // 阶段 2：实例表反查（编号复用 / 实例删除后复用编号在此暴露）。
  const inst = resolver.resolveInstance(instanceId);
  if (!inst) {
    push('instance-table', ReasonCode.INSTANCE_OUT_OF_RANGE, { instanceId });
    return halt({ packed, valid, instanceId, primitiveId, evidence, rgb: null, recovered: null, primary: ReasonCode.INSTANCE_OUT_OF_RANGE });
  }
  push('instance-table', ReasonCode.CLEAN, {
    instanceId, name: inst.name, geometryId: inst.geometryId, materialId: inst.materialId,
    materialVersion: inst.materialVersion ?? 0,
  });

  // 阶段 3：几何表反查（资源卸载 -> 缺失依赖，停在那次绘制）。
  const geom = resolver.resolveGeometry(inst.geometryId);
  if (!geom || geom.unloaded) {
    push('geometry-table', ReasonCode.GEOMETRY_UNLOADED, { geometryId: inst.geometryId });
    return halt({ packed, valid, instanceId, primitiveId, evidence, rgb: null, recovered: null, primary: ReasonCode.GEOMETRY_UNLOADED });
  }
  if (primitiveId >= geom.triCount) {
    push('geometry-table', ReasonCode.PRIMITIVE_OUT_OF_RANGE, { primitiveId, triCount: geom.triCount });
    return halt({ packed, valid, instanceId, primitiveId, evidence, rgb: null, recovered: null, primary: ReasonCode.PRIMITIVE_OUT_OF_RANGE });
  }
  push('geometry-table', ReasonCode.CLEAN, {
    geometryId: geom.id, name: geom.name,
    vertStart: geom.vertStart || 0, indexStart: geom.indexStart || 0, triCount: geom.triCount,
  });

  // 阶段 4：索引/顶点取数（越界读取 / 共享顶点导数区分）。
  // geom.indices 是该几何的本地下标数组，按本地图元号索引；indexStart 仅用于
  // 全局索引表（调试展示），不参与本地下标计算。
  const indexStart = geom.indexStart || 0;
  const vertStart = geom.vertStart || 0;
  if (!geom.indices || !geom.positions || !geom.normals || !geom.uvs) {
    push('vertex-fetch', ReasonCode.OUT_OF_BOUNDS_FETCH, { reason: 'geometry attribute arrays missing' });
    return halt({ packed, valid, instanceId, primitiveId, evidence, rgb: null, recovered: null, primary: ReasonCode.OUT_OF_BOUNDS_FETCH });
  }
  const localIds = [
    geom.indices[primitiveId * 3],
    geom.indices[primitiveId * 3 + 1],
    geom.indices[primitiveId * 3 + 2],
  ];
  const globalIds = localIds.map((li) => vertStart + li);
  const vertexCount = geom.vertexCount;
  const oob = globalIds.some((g) => g < 0 || g >= vertStart + vertexCount)
    || localIds.some((li) => li < 0 || li >= vertexCount);
  if (oob) {
    push('vertex-fetch', ReasonCode.OUT_OF_BOUNDS_FETCH, { localIds, globalIds, vertexCount });
    return halt({ packed, valid, instanceId, primitiveId, evidence, rgb: null, recovered: null, primary: ReasonCode.OUT_OF_BOUNDS_FETCH });
  }
  // 共享顶点：三个索引顶点出现复用（同顶点被三角形共享）。导数由相邻三角形
  // 决定，这里记录共享结构，供"身份编码 vs 导数"区分，不单独判错。
  const shared = new Set(localIds).size < 3;
  push('vertex-fetch', ReasonCode.CLEAN, {
    localIds, globalIds, sharedVertices: shared,
    triangle: actualTriangleLabel(geom, primitiveId),
  });

  const P = localIds.map((vi) => [geom.positions[vi * 3], geom.positions[vi * 3 + 1], geom.positions[vi * 3 + 2]]);
  const N = localIds.map((vi) => norm3([geom.normals[vi * 3], geom.normals[vi * 3 + 1], geom.normals[vi * 3 + 2]]));
  const UV = localIds.map((vi) => [geom.uvs[vi * 2], geom.uvs[vi * 2 + 1]]);

  // 阶段 5：重心 -> 仿射权重，恢复对象空间属性。
  const b = [bary[0], bary[1], bary[2]];
  const bSum = b[0] + b[1] + b[2];
  const baryNonNorm = Math.abs(bSum - 1) > 0.02;
  let w;
  const nmat = inst.normalMat || normalMatrix(inst.model);
  if (perspectiveCorrect) {
    const mvp = multiply(viewProj, inst.model);
    const inv = P.map((p) => 1 / apply4(mvp, p)[3]);
    const persp = [b[0] * inv[0], b[1] * inv[1], b[2] * inv[2]];
    const s = persp[0] + persp[1] + persp[2];
    w = persp.map((v) => v / s);
  } else {
    w = b.map((v) => v / bSum);
  }
  const objPos = [0, 1, 2].map((k) => w[0] * P[0][k] + w[1] * P[1][k] + w[2] * P[2][k]);
  const objNrm = [0, 1, 2].map((k) => w[0] * N[0][k] + w[1] * N[1][k] + w[2] * N[2][k]);
  const uv = [
    w[0] * UV[0][0] + w[1] * UV[1][0] + w[2] * UV[2][0],
    w[0] * UV[0][1] + w[1] * UV[1][1] + w[2] * UV[2][1],
  ];
  if (baryNonNorm) push('attribute-recover', ReasonCode.BARY_NON_NORMALIZED, { bary: b, sum: bSum });
  push('attribute-recover', ReasonCode.CLEAN, { weights: w, objectPos: objPos, objectNormal: objNrm, uv });

  const wp = apply4(inst.model, objPos);
  const worldPos = [wp[0] / wp[3], wp[1] / wp[3], wp[2] / wp[3]];
  const Nw = norm3(transformDir3(nmat, objNrm));

  // 阶段 6：材质绑定（卸载 / 编号复用读旧版本 / 版本错配）。
  const mat = resolver.resolveMaterial(inst.materialId, inst.materialVersion ?? 0);
  if (!mat || mat.unloaded) {
    push('material-binding', ReasonCode.MATERIAL_UNLOADED, { materialId: inst.materialId, wantedVersion: inst.materialVersion ?? 0 });
    return halt({ packed, valid, instanceId, primitiveId, evidence, rgb: null, recovered: { worldPos, N: Nw, uv, objectPos: objPos, objectNormal: objNrm }, primary: ReasonCode.MATERIAL_UNLOADED });
  }
  // 仅当解析器显式给出实时版本且与封存/绑定版本不同时，才判定为旧绑定。
  // 实时视口（无 liveVersion）永远不会伪报陈旧。
  const stale = mat.liveVersion !== undefined && mat.liveVersion !== mat.version;
  if (stale) {
    push('material-binding', ReasonCode.MATERIAL_STALE_BINDING, {
      materialId: mat.id, boundVersion: mat.version, liveVersion: mat.liveVersion,
    });
  } else {
    push('material-binding', ReasonCode.CLEAN, { materialId: mat.id, name: mat.name, version: mat.version });
  }

  // 阶段 7：材质着色 + 材质边界 / 实例重用判定。
  const texColor = sampleTextureLinear(mat.texture, uv);
  const albedo = [texColor[0] * mat.baseColor[0], texColor[1] * mat.baseColor[1], texColor[2] * mat.baseColor[2]];
  let boundary = false;
  if (ctx.neighborPacked !== undefined && (ctx.neighborPacked & 0x80000000) !== 0) {
    const nInst = (ctx.neighborPacked >> 16) & 0xff;
    boundary = nInst !== instanceId;
  }
  if (boundary) push('material-shade', ReasonCode.MATERIAL_BOUNDARY, { neighborInstance: (ctx.neighborPacked >> 16) & 0xff, kind: 'instance-reuse' });

  // 材质自身纹理边界（同一三角形内纹素突变）：与实例重用边界区分，避免把
  // 程序化纹理的高频边缘误诊成属性错读。
  const here = sampleTextureNearest(mat.texture, uv);
  const uvEps = 1 / mat.texture.size;
  const east = sampleTextureNearest(mat.texture, [uv[0] + uvEps, uv[1]]);
  const texEdge = Math.abs(here[0] - east[0]) + Math.abs(here[1] - east[1]) + Math.abs(here[2] - east[2]) > 0.6;
  if (texEdge && !boundary) push('material-shade', ReasonCode.MATERIAL_BOUNDARY, { kind: 'texture-texel' });
  const shaded = shadeSurface(worldPos, Nw, albedo, mat.roughness, mat.metalness, camPos);
  const rgb = shaded.map((c) => Math.min(1, Math.max(0, c)));
  // 始终记录着色阶段证据（含恢复反照率），保证证据链覆盖到实际被着色的三角形。
  if (!boundary && !texEdge) {
    push('material-shade', ReasonCode.CLEAN, { albedo, roughness: mat.roughness, metalness: mat.metalness });
  }

  // 阶段 8：与参考（前向）逐像素核查，属性错读在这一阶段定位。
  let primary = ReasonCode.CLEAN;
  let pixelDelta = null;
  if (ctx.expected && ctx.expected.rgb) {
    pixelDelta = Math.abs(rgb[0] - ctx.expected.rgb[0]) + Math.abs(rgb[1] - ctx.expected.rgb[1]) + Math.abs(rgb[2] - ctx.expected.rgb[2]);
    if (!perspectiveCorrect && pixelDelta > 0.02) {
      push('verify', ReasonCode.BARY_PERSPECTIVE_MISMATCH, { pixelDelta, perspectiveCorrect });
      primary = ReasonCode.BARY_PERSPECTIVE_MISMATCH;
    } else if (pixelDelta > 0.06) {
      push('verify', ReasonCode.ATTRIBUTE_MISREAD, { pixelDelta, expected: ctx.expected.rgb, recovered: rgb });
      primary = ReasonCode.ATTRIBUTE_MISREAD;
    }
  }
  if (primary === ReasonCode.CLEAN) {
    for (let i = evidence.length - 1; i >= 0; i--) {
      if (evidence[i].code !== ReasonCode.CLEAN) { primary = evidence[i].code; break; }
    }
  }

  return {
    packed, valid, instanceId, primitiveId,
    rgb,
    recovered: { worldPos, normal: Nw, uv, albedo, weights: w, objectPos: objPos, objectNormal: objNrm },
    triangle: actualTriangleLabel(geom, primitiveId),
    material: { id: mat.id, name: mat.name, version: mat.version },
    pixelDelta,
    evidence,
    primary,
    halted: false,
  };
}

function actualTriangleLabel(geom, primitiveId) {
  return `${geom.name}#tri${primitiveId}`;
}

function halt(r) {
  return { ...r, halted: true, primary: r.primary, triangle: null, material: null, pixelDelta: null };
}

// ---------------------------------------------------------------------------
// 整帧分析：对身份/重心缓冲复跑追踪，统计原因分布、恢复属性与像素差异。
// 采用 stride 抽样 + LogBudget 双上限，限制属性错读排查的日志成本。
// 输入 frame: { width,height,identity:Uint32Array, bary:Float32Array(3*N),
//               expected?: Uint8Array(RGB 0..255, 可选) }
// ---------------------------------------------------------------------------
export function analyzeVisibilityFrame(frame, ctx, opts = {}) {
  const { width, height, identity, bary } = frame;
  const stride = Math.max(1, opts.stride || 2);
  const budget = opts.budget || new LogBudget();
  const counts = {};
  const samples = [];
  const reasonPixels = {};
  let analyzed = 0, haltedCount = 0, covered = 0;
  let deltaSum = 0, deltaN = 0, deltaMax = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const pi = y * width + x;
      const packed = identity[pi];
      if ((packed & 0x80000000) === 0) continue;
      covered++;
      if (!budget.claimPixel()) break;
      // 右邻像素身份用于材质/实例边界判定。
      const nx = x + 1 < width ? pi + 1 : pi;
      const pixelCtx = {
        ...ctx,
        neighborPacked: identity[nx],
        expected: frame.expected ? { rgb: readExpectedRGB(frame.expected, width, x, y) } : undefined,
      };
      const t = tracePixel(packed, bary.subarray(pi * 3, pi * 3 + 3), pixelCtx);
      analyzed++;
      counts[t.primary] = (counts[t.primary] || 0) + 1;
      (reasonPixels[t.primary] ||= []).push([x, y]);
      if (t.halted) haltedCount++;
      if (t.pixelDelta !== null) { deltaSum += t.pixelDelta; deltaN++; if (t.pixelDelta > deltaMax) deltaMax = t.pixelDelta; }
      // 只保留少量代表性样本（同样受预算约束）。
      if (t.primary !== ReasonCode.CLEAN && samples.length < 64 && budget.claimEvent()) {
        samples.push({ x, y, ...t });
      }
    }
    if (budget.exhausted) break;
  }

  return {
    width, height, stride, analyzed, covered, haltedCount,
    counts,
    reasonPixels,
    samples,
    meanPixelDelta: deltaN ? deltaSum / deltaN : 0,
    maxPixelDelta: deltaMax,
    truncated: budget.truncated,
    logEvents: budget.events,
    logPixels: budget.pixels,
  };
}

function readExpectedRGB(expected, width, x, y) {
  const i = (y * width + x) * 3;
  return [expected[i] / 255, expected[i + 1] / 255, expected[i + 2] / 255];
}

// ---------------------------------------------------------------------------
// 封存帧：同一可见性帧既可实时显示，也可作为像素取证快照保存。
// archive 冻结身份/重心/相机以及解析所需的实例、几何、材质描述符与纹理，
// 因此材质热换后仍能还原原三角颜色；旧编号资源卸载后重放会报缺失依赖。
// ---------------------------------------------------------------------------
export function buildVisFrameArchive(frame, sceneLike, opts = {}) {
  const instances = sceneLike.instances.map((ins) => ({
    id: ins.id,
    name: ins.name,
    geometryId: ins.geometryId,
    materialId: ins.materialId,
    materialVersion: ins.materialVersion ?? (sceneLike.materials[ins.materialId]?.version ?? 0),
    geometryVersion: ins.geometryVersion ?? 0,
    model: Array.from(ins.model),
  }));
  // 全局顶点/索引偏移来自 buildGlobalTables 的 geomInfo；多几何场景必须带上，
  // 否则封存重放会把每个几何当成从 0 开始而读到错误顶点（属性错读）。
  const geomInfoMap = new Map((sceneLike.geomInfo || []).map((x) => [x.id, x]));
  const geometries = sceneLike.geometries.map((g) => {
    const info = geomInfoMap.get(g.id) || {};
    return {
      id: g.id, name: g.name,
      vertStart: info.vertStart ?? g.vertStart ?? 0,
      indexStart: info.indexStart ?? g.indexStart ?? 0,
      triCount: info.triCount ?? g.triCount ?? g.mesh.indices.length / 3,
      vertexCount: info.vertexCount ?? g.vertexCount ?? g.mesh.vertexCount,
      positions: Array.from(g.mesh ? g.mesh.positions : g.positions),
      normals: Array.from(g.mesh ? g.mesh.normals : g.normals),
      uvs: Array.from(g.mesh ? g.mesh.uvs : g.uvs),
      indices: Array.from(g.mesh ? g.mesh.indices : g.indices),
    };
  });
  const materials = sceneLike.materials.map((m) => ({
    id: m.id, name: m.name, version: m.version,
    baseColor: Array.from(m.baseColor), roughness: m.roughness, metalness: m.metalness,
    texture: { kind: m.texture.kind, size: m.texture.size, data: Array.from(m.texture.data) },
  }));
  return {
    format: 'vis-frame-archive',
    formatVersion: 1,
    capturedAt: opts.capturedAt || Date.now(),
    frameToken: opts.frameToken ?? 0,
    width: frame.width,
    height: frame.height,
    perspectiveCorrect: opts.perspectiveCorrect !== false,
    camera: { viewProj: Array.from(frame.viewProj), camPos: Array.from(frame.camPos) },
    identity: Array.from(frame.identity),
    bary: Array.from(frame.bary),
    instances,
    geometries,
    materials,
  };
}

// 封存帧解析器：默认从封存资源解析；unloadedIds 标记已卸载依赖，用于演示
// "只有旧编号而资源已经卸载"时诊断器标出缺失依赖并停在那次绘制。
export function archiveResolver(archive, { unloadedGeometry = new Set(), unloadedMaterial = new Set(), removedInstances = new Set(), liveVersions = null } = {}) {
  const geoById = new Map(archive.geometries.map((g) => [g.id, g]));
  const matById = new Map(archive.materials.map((m) => [m.id, m]));
  return {
    resolveInstance(id) {
      const ins = archive.instances.find((i) => i.id === id);
      if (!ins || removedInstances.has(id)) return null;
      return { ...ins, normalMat: normalMatrix(new Float32Array(ins.model)) };
    },
    resolveGeometry(id) {
      const g = geoById.get(id);
      if (!g) return null;
      return unloadedGeometry.has(id) ? { ...g, unloaded: true } : g;
    },
    resolveMaterial(id) {
      const m = matById.get(id);
      if (!m) return null;
      if (unloadedMaterial.has(id)) return { ...m, unloaded: true };
      // 封存资源记录捕获时版本；外部显式给出现代版本且不同 -> 旧绑定。
      const live = liveVersions ? liveVersions[id] : undefined;
      return live !== undefined && live !== m.version
        ? { ...m, version: m.version, liveVersion: live }
        : { ...m, liveVersion: m.version };
    },
  };
}

// 重放一整帧封存资源。返回每像素追踪主因 + 还原着色图；遇到缺失依赖在该
// 像素停在那次绘制（halted），并聚合缺失依赖清单。
export function replayArchive(archive, opts = {}) {
  const W = archive.width, H = archive.height;
  const identity = Uint32Array.from(archive.identity);
  const bary = Float32Array.from(archive.bary);
  const resolver = archiveResolver(archive, opts);
  const ctx = {
    resolver,
    viewProj: new Float32Array(archive.camera.viewProj),
    camPos: archive.camera.camPos,
    perspectiveCorrect: archive.perspectiveCorrect,
  };
  const reasonMap = new Uint8Array(W * H); // 0 = 未处理/背景
  const image = new Uint8Array(W * H * 3);
  const missing = [];
  const reasonIndex = Object.fromEntries(Object.values(ReasonCode).map((c, i) => [c, i + 1]));
  const indexReason = Object.fromEntries(Object.entries(reasonIndex).map(([k, v]) => [v, k]));
  let halted = 0;
  for (let pi = 0; pi < W * H; pi++) {
    const packed = identity[pi];
    if ((packed & 0x80000000) === 0) { image.set([13, 18, 26], pi * 3); continue; }
    const t = tracePixel(packed, bary.subarray(pi * 3, pi * 3 + 3), {
      ...ctx,
      neighborPacked: pi + 1 < W * H ? identity[pi + 1] : packed,
    });
    reasonMap[pi] = reasonIndex[t.primary];
    if (t.halted) {
      halted++;
      const dep = t.evidence[t.evidence.length - 1];
      if (!missing.some((m) => m.code === t.primary)) missing.push({ code: t.primary, detail: dep.detail });
      image.set(ReasonMeta[t.primary].color, pi * 3);
    } else {
      image.set([Math.round(t.rgb[0] * 255), Math.round(t.rgb[1] * 255), Math.round(t.rgb[2] * 255)], pi * 3);
    }
  }
  return {
    width: W, height: H, image, reasonMap,
    reasonAt: (pi) => (reasonMap[pi] ? indexReason[reasonMap[pi]] : ReasonCode.BACKGROUND),
    haltedCount: halted,
    missingDependencies: missing,
  };
}
