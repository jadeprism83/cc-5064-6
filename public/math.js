// Minimal column-major 4x4 matrix / vector math (WebGL convention).
// Matrices are Float32Array(16). Vectors are plain [x,y,z] or [x,y,z,w].

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

export function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a, b) {
  // returns a * b (column-major), applied to vectors as a*b*v
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export function translation(x, y, z) {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function scaling(x, y, z) {
  const m = identity();
  m[0] = x; m[5] = y; m[10] = z;
  return m;
}

export function rotationX(t) {
  const c = Math.cos(t), s = Math.sin(t), m = identity();
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}

export function rotationY(t) {
  const c = Math.cos(t), s = Math.sin(t), m = identity();
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}

export function rotationZ(t) {
  const c = Math.cos(t), s = Math.sin(t), m = identity();
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}

// Compose a model matrix from translation, Euler rotation, non-uniform scale.
export function composeModel(pos, rot, scl) {
  let m = translation(pos[0], pos[1], pos[2]);
  m = multiply(m, rotationY(rot[1]));
  m = multiply(m, rotationX(rot[0]));
  m = multiply(m, rotationZ(rot[2]));
  m = multiply(m, scaling(scl[0], scl[1], scl[2]));
  return m;
}

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function lookAt(eye, center, up) {
  const z = v3.normalize(v3.sub(eye, center));
  const x = v3.normalize(v3.cross(up, z));
  const y = v3.cross(z, x);
  const m = identity();
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -v3.dot(x, eye);
  m[13] = -v3.dot(y, eye);
  m[14] = -v3.dot(z, eye);
  return m;
}

// Inverse-transpose of the upper 3x3, used for transforming normals under
// non-uniform scale. Returns a Float32Array(9) normal matrix.
export function normalMatrix(model) {
  // Invert upper 3x3 then transpose.
  const a = [model[0], model[1], model[2],
             model[4], model[5], model[6],
             model[8], model[9], model[10]];
  const inv = new Float32Array(9);
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (!det) return identity3();
  det = 1 / det;
  // cofactor matrix; adjugate = transpose(cof); inverse = adjugate / det.
  const cof = [
    b01, (a12 * a20 - a22 * a10), (a21 * a10 - a11 * a20),
    b11, (a22 * a00 - a02 * a20), (a02 * a10 - a12 * a00),
    b21, (a02 * a21 - a21 * a00), (a11 * a00 - a01 * a10),
  ];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      inv[c * 3 + r] = cof[r * 3 + c] * det;
  return inv;
}

function identity3() {
  const m = new Float32Array(9);
  m[0] = m[4] = m[8] = 1;
  return m;
}

// Transform a point by a 4x4 (full perspective divide aware).
export function transformPoint(m, p) {
  const x = p[0], y = p[1], z = p[2], w = p[3] ?? 1;
  const nx = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  const ny = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  const nz = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  const nw = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return [nx / nw, ny / nw, nz / nw, nw];
}

export function transformDir3(nm, d) {
  return [
    nm[0] * d[0] + nm[3] * d[1] + nm[6] * d[2],
    nm[1] * d[0] + nm[4] * d[1] + nm[7] * d[2],
    nm[2] * d[0] + nm[5] * d[1] + nm[8] * d[2],
  ];
}
