import { makeCube, makeSphere, makeTorus, makeDegeneratePatch } from './geometry.js';
import { makeTexture, createMaterial } from './materials.js';
import { composeModel } from './math.js';

// Geometry index table: meshes are uploaded once and referenced by stable id.
// Instance transform table and material identity table are kept SEPARATE so a
// draw-batch reorder can never make a fragment read another instance's data:
// the visibility pass writes the global instance id, and the shading pass
// indexes the transform/material tables directly with that id.
export function buildScene() {
  const geometries = [
    { id: 0, name: 'cube', mesh: makeCube(1.4) },
    { id: 1, name: 'sphere', mesh: makeSphere(32, 18, 1) },
    { id: 2, name: 'torus', mesh: makeTorus(1, 0.38, 32, 16) },
    { id: 3, name: 'degenerate-patch', mesh: makeDegeneratePatch() },
  ];
  const geometryById = new Map(geometries.map((g) => [g.id, g]));

  const materialSpecs = [
    { name: 'checker-red', texture: makeTexture('checker'), baseColor: [1, 0.85, 0.7] },
    { name: 'stripe-blue', texture: makeTexture('stripes'), baseColor: [0.7, 0.85, 1] },
    { name: 'rings-green', texture: makeTexture('rings'), baseColor: [0.8, 1, 0.85] },
    { name: 'grid-violet', texture: makeTexture('grid'), baseColor: [0.9, 0.8, 1] },
    { name: 'noise-amber', texture: makeTexture('noise'), baseColor: [1, 0.9, 0.6] },
  ];
  // 材质 id 显式等于表下标，使实例的 materialId 外键在多次构建场景后仍稳定。
  const materials = materialSpecs.map((spec, i) => createMaterial({ ...spec, id: i }));

  // Instances: geometryId / materialId are foreign keys into separate tables.
  // Non-uniform scales are intentional to exercise the inverse-transpose
  // normal transform and perspective-correct attribute recovery.
  const instances = [
    { id: 0, name: 'cube A', geometryId: 0, materialId: 0, pos: [-3.0, 0.2, 0], rot: [0.3, 0.6, 0], scl: [1.0, 1.6, 0.7], dynamic: false },
    { id: 1, name: 'sphere B', geometryId: 1, materialId: 1, pos: [-0.6, 0.0, 0.4], rot: [0, 0, 0], scl: [1.3, 0.8, 1.3], dynamic: true, spinAxis: 'y' },
    { id: 2, name: 'torus C', geometryId: 2, materialId: 2, pos: [1.7, 0.1, -0.3], rot: [0.5, 0, 0.2], scl: [0.9, 1.5, 0.6], dynamic: true, spinAxis: 'z' },
    { id: 3, name: 'cube D', geometryId: 0, materialId: 3, pos: [3.6, -0.4, 0.6], rot: [0.2, -0.4, 0.1], scl: [0.7, 0.7, 1.8], dynamic: false },
    { id: 4, name: 'sphere E', geometryId: 1, materialId: 4, pos: [0.6, 1.7, -1.6], rot: [0, 0, 0], scl: [0.7, 0.7, 0.7], dynamic: true, spinAxis: 'x' },
    { id: 5, name: 'degenerate F', geometryId: 3, materialId: 4, pos: [-1.8, -1.4, 1.2], rot: [0, 0.4, 0], scl: [0.8, 0.8, 0.8], dynamic: false },
  ];

  return { geometries, geometryById, materials, instances };
}

// Compute per-frame model matrices. Dynamic models rotate over time.
export function updateTransforms(instances, timeSec) {
  for (const ins of instances) {
    const rot = ins.rot.slice();
    if (ins.dynamic) {
      const axis = ins.spinAxis === 'x' ? 0 : ins.spinAxis === 'z' ? 2 : 1;
      rot[axis] += timeSec * 0.9;
    }
    ins.model = composeModel(ins.pos, rot, ins.scl);
  }
}

// Build draw batches. A batch is just (instance, geometry). `reorder` shuffles
// submission order to prove the shader resolves identity from the explicit
// instance id, never from submission order or gl draw sequence.
export function buildBatches(instances, reorder) {
  let batches = instances.map((ins) => ({ instanceId: ins.id, geometryId: ins.geometryId }));
  if (reorder) {
    // Deterministic reverse + rotate shuffle, not random, for reproducibility.
    batches = batches.slice().reverse();
    batches = [...batches.slice(1), batches[0]];
  }
  return batches;
}

// 删除一个实例并把它的编号复用到一个新物体上。可见性缓冲里保留的是删除前
// 写入的旧 packed 身份；重放该单帧时，实例号现在指向新物体——这正是"重放
// 物体删除后复用编号"的场景。诊断必须凭三角标识与材质版本指出首次读到旧
// 属性的阶段（material-binding），而不是把新物体的属性静默当成旧像素。
//
// 返回 { removed, replacement }。replacement 继承同一 id，但几何/材质不同，
// 且 materialVersion 推进，便于诊断区分旧绑定与当代绑定。
export function deleteAndReuseInstanceId(scene, oldInstanceId, replacementSpec) {
  const idx = scene.instances.findIndex((i) => i.id === oldInstanceId);
  if (idx < 0) throw new Error(`instance ${oldInstanceId} not found`);
  const removed = scene.instances[idx];
  const replacement = {
    id: oldInstanceId, // 编号被复用
    name: replacementSpec.name,
    geometryId: replacementSpec.geometryId,
    materialId: replacementSpec.materialId,
    pos: replacementSpec.pos || removed.pos,
    rot: replacementSpec.rot || [0, 0, 0],
    scl: replacementSpec.scl || [1, 1, 1],
    dynamic: false,
    reusedFrom: removed.id,
    reusedAtVersion: (scene.materials[replacementSpec.materialId]?.version ?? 0) + 1,
  };
  scene.instances[idx] = replacement;
  return { removed, replacement };
}

// 把实例表恢复到删除/复用之前的编排（用于界面复位）。
export function restoreInstances(scene, snapshot) {
  scene.instances.splice(0, scene.instances.length, ...snapshot);
}
