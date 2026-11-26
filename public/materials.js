// Procedural textures + material definitions with explicit version tracking.
// A material is an immutable descriptor once published; mutating a material
// bumps its version and produces a new descriptor id, so a visibility buffer
// captured before the edit can still be resolved against the matching snapshot.

let TEX_SEED = 1;

export function makeTexture(kind, size = 128) {
  const data = new Uint8Array(size * size * 4);
  const seed = TEX_SEED++;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let r = 0, g = 0, b = 0;
      if (kind === 'checker') {
        const ck = (Math.floor(u * 8) + Math.floor(v * 8)) % 2;
        r = ck ? 235 : 40; g = ck ? 220 : 90; b = ck ? 60 : 200;
      } else if (kind === 'stripes') {
        const s = Math.floor(u * 16) % 2;
        r = s ? 240 : 30; g = s ? 240 : 30; b = s ? 240 : 120;
      } else if (kind === 'rings') {
        const d = Math.hypot(u - 0.5, v - 0.5);
        const ring = Math.floor(d * 16 + seed) % 2;
        r = ring ? 60 : 200; g = ring ? 180 : 70; b = ring ? 120 : 210;
      } else if (kind === 'grid') {
        const line = (u * 10) % 1 < 0.08 || (v * 10) % 1 < 0.08;
        r = line ? 255 : 20; g = line ? 255 : 20; b = line ? 255 : 60;
      } else { // noise
        const n = (Math.sin(x * 12.9898 + y * 78.233 + seed * 37.7) * 43758.5453) % 1;
        const q = Math.floor((n - Math.floor(n)) * 255);
        r = q; g = (q * 7) % 255; b = (q * 13) % 255;
      }
      const i = (y * size + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { kind, size, data };
}

let MAT_ID = 0;

export function createMaterial({ name, texture, baseColor, roughness = 0.6, metalness = 0.0, id }) {
  return {
    // 显式 id 由调用方按表位置给出；缺省时回退到模块计数，保证独立调用仍唯一。
    id: id ?? MAT_ID++,
    version: 0,
    name,
    texture,            // {kind,size,data}
    baseColor,          // [r,g,b]
    roughness,
    metalness,
    // Descriptor snapshot token: a new token is minted on every published edit.
    descriptorToken: 0,
  };
}

// Publish an edited material. The identity (id) is retained so geometry keeps
// referencing the same material, but version + descriptorToken advance,
// letting the resolver detect stale vs current bindings.
export function publishEdit(material, patch) {
  Object.assign(material, patch);
  material.version += 1;
  material.descriptorToken += 1;
  return material;
}

// 标记材质卸载：保留旧编号与版本记录，但纹理/描述符资源不再可用。
// 封存帧重放遇到它时，诊断器必须报 MATERIAL_UNLOADED 并停在那次绘制。
export function unloadMaterial(material) {
  material.unloaded = true;
  material._unloadedTexture = material.texture;
  material.texture = { kind: 'unloaded', size: 0, data: new Uint8Array(0) };
  return material;
}

// 重新装载材质（当代资源），实时视口可据此重新生成可见缓冲。
export function reloadMaterial(material, texture) {
  material.unloaded = false;
  if (material._unloadedTexture && !texture) material.texture = material._unloadedTexture;
  else if (texture) material.texture = texture;
  material._unloadedTexture = null;
  return material;
}

// A frozen per-frame snapshot table: visibility pass stores its index so the
// shading pass can resolve exactly the descriptor set used at capture time.
export class DescriptorSnapshotTable {
  constructor() { this.snapshots = []; }
  capture(materials) {
    const entry = {
      frameToken: this.snapshots.length,
      materials: materials.map((m) => ({
        id: m.id,
        version: m.version,
        descriptorToken: m.descriptorToken,
        ref: m,
      })),
    };
    this.snapshots.push(entry);
    if (this.snapshots.length > 8) this.snapshots.shift();
    return entry.frameToken;
  }
  resolve(frameToken, materialId) {
    const snap = this.snapshots.find((s) => s.frameToken === frameToken)
      || this.snapshots[this.snapshots.length - 1];
    const d = snap.materials.find((m) => m.id === materialId);
    return { snapshot: snap, descriptor: d };
  }
}
