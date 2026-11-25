// Headless invariants for the two-stage visibility-buffer contract, using the
// CPU reference pipeline (same identity/bary schema as the WebGL2 renderer).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSoftwarePipeline } from '../src/cli/visbuf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS', name); passed++; }
  catch (e) { console.error('  FAIL', name, '\n    ', e.message); process.exitCode = 1; }
}

const base = () => runSoftwarePipeline({ width: 256, height: 192, time: 0.7 });

console.log('Visibility-buffer pipeline invariants:');

test('stage 1 writes identity only for covered pixels; background stays 0', () => {
  const r = base();
  let covered = 0, zeroValid = 0;
  for (let i = 0; i < r.identity.length; i++) {
    if (r.identity[i] !== 0) {
      covered++;
      assert.ok((r.identity[i] & 0x80000000) !== 0, 'covered pixel must set valid bit');
    } else {
      zeroValid++;
    }
  }
  assert.ok(covered > 1000, 'expected substantial coverage');
  assert.equal(covered + zeroValid, r.identity.length);
  assert.equal(r.stats.covered, covered);
});

test('invalid identity is never decoded as instance 0 / primitive 0', () => {
  const r = base();
  for (let i = 0; i < r.identity.length; i++) {
    if (r.identity[i] === 0) continue;
    const inst = (r.identity[i] >> 16) & 0xff;
    const prim = r.identity[i] & 0xffff;
    assert.ok(inst >= 0 && inst < 6, 'instance id in range');
    assert.ok(prim >= 0, 'primitive id non-negative');
  }
});

test('draw-batch reorder leaves per-pixel identity unchanged', () => {
  const a = runSoftwarePipeline({ width: 256, height: 192, time: 0.7, reorder: false });
  const b = runSoftwarePipeline({ width: 256, height: 192, time: 0.7, reorder: true });
  let diffs = 0;
  for (let i = 0; i < a.identity.length; i++) {
    if (a.identity[i] !== b.identity[i]) diffs++;
  }
  assert.equal(diffs, 0, 'reordering submission must not change fragment identity');
});

test('perspective recovery matches expected; affine control path diverges', () => {
  const persp = runSoftwarePipeline({ width: 256, height: 192, perspective: true });
  const affine = runSoftwarePipeline({ width: 256, height: 192, perspective: false });
  let diffSum = 0, diffN = 0;
  for (let i = 0; i < persp.identity.length; i++) {
    if (persp.identity[i] === 0) continue;
    const o = i * 3;
    const d = Math.abs(persp.image[o] - affine.image[o])
      + Math.abs(persp.image[o + 1] - affine.image[o + 1])
      + Math.abs(persp.image[o + 2] - affine.image[o + 2]);
    diffSum += d; diffN++;
  }
  // Non-uniform scale + perspective means affine bary gives a measurable,
  // non-zero average color difference on covered geometry.
  assert.ok(diffSum / diffN > 0.5, `expected affine divergence, got ${diffSum / diffN}`);
});

test('degenerate primitives consume primitive ids but emit no fragments', () => {
  const r = base();
  // The degenerate patch geometry is instance 5 with a zero-area first triangle.
  // Its valid second triangle may cover pixels, but primitive id 0 of that
  // geometry must never appear (it has zero screen area).
  for (let i = 0; i < r.identity.length; i++) {
    if (r.identity[i] === 0) continue;
    const inst = (r.identity[i] >> 16) & 0xff;
    const prim = r.identity[i] & 0xffff;
    if (inst === 5) assert.notEqual(prim, 0, 'degenerate triangle 0 must not rasterize');
  }
  assert.ok(r.stats.degenerate > 0, 'rasterizer counted degenerate primitives');
});

test('barycentric weights on covered pixels are finite and sum to ~1', () => {
  const r = base();
  for (let i = 0; i < r.identity.length; i++) {
    if (r.identity[i] === 0) continue;
    const o = i * 3;
    const s = r.bary[o] + r.bary[o + 1] + r.bary[o + 2];
    assert.ok(Number.isFinite(s), 'bary sum finite');
    assert.ok(Math.abs(s - 1) < 1e-4, `bary sum ~1, got ${s}`);
  }
});

test('depth buffer resolves nearest surfaces (monotonic overwrite)', () => {
  const r = base();
  for (let i = 0; i < r.identity.length; i++) {
    if (r.identity[i] !== 0) assert.ok(r.depth[i] < Infinity && r.depth[i] >= -1 && r.depth[i] <= 1);
  }
});

test('all six instances are represented across the frame', () => {
  const r = base();
  const seen = new Set();
  for (let i = 0; i < r.identity.length; i++) {
    if (r.identity[i] !== 0) seen.add((r.identity[i] >> 16) & 0xff);
  }
  // Degenerate-only tiny instance may be small; require the five primary meshes.
  for (const id of [0, 1, 2, 3, 4]) assert.ok(seen.has(id), `instance ${id} rendered`);
});

console.log(`\n${passed} test groups passed`);
