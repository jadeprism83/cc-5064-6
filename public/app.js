import { buildScene, updateTransforms, buildBatches } from './scene.js';
import { buildGlobalTables } from './data-tables.js';
import { VisibilityRenderer } from './renderer.js';
import { perspective, lookAt, multiply } from './math.js';
import { makeTexture, publishEdit } from './materials.js';

const VIEW_W = 480, VIEW_H = 360;
const BACKGROUND = [0.05, 0.07, 0.1];

async function loadShaders() {
  const files = {
    visVS: 'shaders/visibility.vert', visFS: 'shaders/visibility.frag',
    fullVS: 'shaders/fullscreen.vert',
    resolveFS: 'shaders/resolve.frag',
    fwdVS: 'shaders/forward.vert', fwdFS: 'shaders/forward.frag',
    blitFS: 'shaders/blit.frag', diffFS: 'shaders/diff.frag',
    dbgIdentityFS: 'shaders/debug-identity.frag', dbgBaryFS: 'shaders/debug-bary.frag',
  };
  const out = {};
  for (const [k, path] of Object.entries(files)) {
    out[k] = await fetch(path).then((r) => {
      if (!r.ok) throw new Error('Missing shader ' + path);
      return r.text();
    });
  }
  return out;
}

// Hidden WebGL canvas that owns the real render targets.
const hidden = document.createElement('canvas');
hidden.width = VIEW_W; hidden.height = VIEW_H;
hidden.style.position = 'fixed';
hidden.style.left = '-10000px';
document.body.appendChild(hidden);

const views = {
  identity: document.getElementById('cIdentity'),
  bary: document.getElementById('cBary'),
  resolve: document.getElementById('cResolve'),
  forward: document.getElementById('cForward'),
  diff: document.getElementById('cDiff'),
  probe: document.getElementById('cProbe'),
};
for (const c of Object.values(views)) { c.width = VIEW_W; c.height = VIEW_H; }
const ctx2d = Object.fromEntries(Object.entries(views).map(([k, c]) => [k, c.getContext('2d')]));

const state = {
  run: true, reorder: false, perspective: true,
  materialMode: 0, outputMode: 0, ampDiff: false,
  freezeSnapshot: false,
  selectedMaterial: 0,
};

let renderer, scene, tables, camera;
let frame = 0, tokenCounter = 0;
const alertsEl = document.getElementById('alerts');

function present(webglCanvas, ctx2) {
  ctx2.clearRect(0, 0, VIEW_W, VIEW_H);
  // Flip vertically because canvas 2D is top-left origin and GL is bottom-left.
  ctx2.save();
  ctx2.translate(0, VIEW_H);
  ctx2.scale(1, -1);
  ctx2.drawImage(webglCanvas, 0, 0, VIEW_W, VIEW_H);
  ctx2.restore();
}

function setAlert(kind, msg) {
  const div = document.createElement('div');
  div.className = 'alert ' + kind;
  div.textContent = msg;
  alertsEl.appendChild(div);
}
function clearAlerts() { alertsEl.innerHTML = ''; }

function buildMaterialList() {
  const el = document.getElementById('matList');
  el.innerHTML = '';
  scene.materials.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'matrow';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    const d = m.texture.data;
    const px = [d[0], d[1], d[2]];
    sw.style.background = `rgb(${px[0]},${px[1]},${px[2]})`;
    const lab = document.createElement('span');
    lab.textContent = `${m.name} v${m.version}`;
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'mat'; radio.checked = i === state.selectedMaterial;
    radio.onchange = () => { state.selectedMaterial = i; };
    row.append(sw, lab, radio);
    el.appendChild(row);
  });
}

function refreshAlerts() {
  clearAlerts();
  let mismatch = 0;
  scene.materials.forEach((m, i) => {
    if (renderer.snapshotVersions[i] !== renderer.liveVersions[i]) mismatch++;
  });
  if (mismatch > 0) {
    if (state.materialMode === 0) {
      setAlert('warn', `检测到 ${mismatch} 个材质版本错配：快照策略仍使用捕获时的描述符（黄色提示叠加）。`);
    } else {
      setAlert('ok', `检测到 ${mismatch} 个材质更新：重绑策略已按当前版本重新绑定。`);
    }
  } else {
    setAlert('ok', '可见性缓冲与材质描述符版本一致，无身份异常。');
  }
  // Stats-driven anomaly flags.
  if (renderer.stats.maxDiff8 > 24 && state.perspective) {
    setAlert('err', `逐像素差异偏大 max=${renderer.stats.maxDiff8}，请检查属性恢复。`);
  }
  if (!state.perspective) {
    setAlert('warn', '当前为仿射恢复控制路径：与前向透视路径存在预期差异。');
  }
}

function updateStatsUI() {
  const s = renderer.stats;
  document.getElementById('stCovered').textContent = s.coveredPixels.toLocaleString();
  document.getElementById('stInvalid').textContent = s.invalidPixels.toLocaleString();
  document.getElementById('stMean').textContent = s.meanDiff8.toFixed(3);
  document.getElementById('stMax').textContent = s.maxDiff8.toString();
  document.getElementById('stCovPct').textContent = (s.coverage * 100).toFixed(1) + '%';
}

function render() {
  const time = state.run ? performance.now() / 1000 : 0;
  updateTransforms(scene.instances, time);
  const batches = buildBatches(scene.instances, state.reorder);
  tokenCounter++;
  renderer.visToken = tokenCounter;
  renderer.curToken = tokenCounter;

  const stats = renderer.renderFrame(camera, batches, {
    perspective: state.perspective,
    materialMode: state.materialMode,
    outputMode: state.outputMode,
    freezeSnapshot: state.freezeSnapshot,
  });

  // Present each GPU view into its 2D panel.
  renderer.renderDebug('identity', BACKGROUND);
  present(hidden, ctx2d.identity);
  renderer.renderDebug('bary', BACKGROUND);
  present(hidden, ctx2d.bary);
  renderer.blit(renderer.resolveTex, 0);
  present(hidden, ctx2d.resolve);
  renderer.blit(renderer.forwardTex, 0);
  present(hidden, ctx2d.forward);
  renderer.blit(renderer.diffTex, state.ampDiff ? 1 : 0);
  present(hidden, ctx2d.diff);
  present(hidden, ctx2d.probe); // probe panel mirrors resolve until hover

  updateStatsUI();
  refreshAlerts();
  frame++;
  requestAnimationFrame(render);
}

function wireControls() {
  document.getElementById('run').onchange = (e) => { state.run = e.target.checked; };
  document.getElementById('reorder').onchange = (e) => { state.reorder = e.target.checked; };
  document.getElementById('persp').onchange = (e) => { state.perspective = e.target.checked; };
  document.getElementById('matMode').onchange = (e) => { state.materialMode = parseInt(e.target.value, 10); };
  document.getElementById('outMode').onchange = (e) => {
    state.outputMode = parseInt(e.target.value, 10);
    document.getElementById('tagResolve').textContent =
      ['最终着色（重建属性）', '重建世界坐标', '重建法线', '重建 UV', '反照率', '可见性标识'][state.outputMode];
  };
  document.getElementById('ampDiff').onchange = (e) => { state.ampDiff = e.target.checked; };
  document.getElementById('freezeSnap').onchange = (e) => { state.freezeSnapshot = e.target.checked; };
  document.getElementById('recapSnap').onclick = () => { renderer.captureSnapshot(); };

  document.getElementById('editTex').onclick = () => {
    const i = state.selectedMaterial;
    const kinds = ['checker', 'stripes', 'rings', 'grid', 'noise'];
    const next = kinds[(kinds.indexOf(scene.materials[i].texture.kind) + 1) % kinds.length];
    publishEdit(scene.materials[i], { texture: makeTexture(next) });
    renderer.refreshMaterial(i);
    buildMaterialList();
  };
  document.getElementById('editColor').onclick = () => {
    const i = state.selectedMaterial;
    const c = [Math.random(), Math.random(), Math.random()];
    publishEdit(scene.materials[i], { baseColor: c });
    renderer.refreshMaterial(i);
    buildMaterialList();
  };

  // Pixel probe: report identity + reconstructed/forward colors at the cursor.
  const probeInfo = document.getElementById('probeInfo');
  function attachProbe(canvas) {
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - rect.left) / rect.width * VIEW_W);
      const y = Math.floor((e.clientY - rect.top) / rect.height * VIEW_H);
      const id = renderer.readIdentityAt(x, y);
      const rc = renderer.readColorAt(renderer.resolveFB, x, y);
      const fc = renderer.readColorAt(renderer.forwardFB, x, y);
      if (!id.valid) {
        probeInfo.innerHTML = `像素 <code>(${x},${y})</code>：<b>无效/背景</b>（有效位为 0，未当作零号三角形）`;
        return;
      }
      const ins = scene.instances[id.instanceId];
      const g = scene.geometryById.get(ins.geometryId);
      const totalDelta = Math.abs(rc[0] - fc[0]) + Math.abs(rc[1] - fc[1]) + Math.abs(rc[2] - fc[2]);
      probeInfo.innerHTML =
        `像素 <code>(${x},${y})</code><br>` +
        `实例 <b>#${id.instanceId} ${ins.name}</b> · 几何 <b>${g.name}</b><br>` +
        `图元 <b>#${id.primitiveId}</b>（共 ${g.mesh.indices.length / 3}）· packed=0x${id.packed.toString(16).padStart(8, '0')}<br>` +
        `解析 RGB=(${rc[0]},${rc[1]},${rc[2]}) 前向 RGB=(${fc[0]},${fc[1]},${fc[2]}) Δ=${totalDelta}`;
      // Mark the probe location on the probe panel.
      const c = ctx2d.probe;
      c.clearRect(0, 0, VIEW_W, VIEW_H);
      c.save(); c.translate(0, VIEW_H); c.scale(1, -1);
      c.drawImage(hidden, 0, 0, VIEW_W, VIEW_H); c.restore();
      c.strokeStyle = '#fff'; c.lineWidth = 1;
      c.strokeRect(x - 4, y - 4, 9, 9);
    });
  }
  Object.values(views).forEach(attachProbe);
}

async function main() {
  const shaders = await loadShaders();
  scene = buildScene();
  tables = buildGlobalTables(scene.geometries);
  updateTransforms(scene.instances, 0);
  const aspect = VIEW_W / VIEW_H;
  const proj = perspective(Math.PI / 4, aspect, 0.1, 100);
  const view = lookAt([0, 1.5, 9], [0, 0, 0], [0, 1, 0]);
  const viewProj = multiply(proj, view);
  camera = { view, viewProj, camPos: [0, 1.5, 9], background: BACKGROUND };

  renderer = new VisibilityRenderer(hidden, tables, scene, shaders);
  buildMaterialList();
  wireControls();
  render();
}

main().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:20px;color:#f85149">初始化失败：${err.message}</div>`);
  console.error(err);
});
