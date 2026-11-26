import { buildScene, updateTransforms, buildBatches, deleteAndReuseInstanceId, restoreInstances } from './scene.js';
import { buildGlobalTables } from './data-tables.js';
import { VisibilityRenderer } from './renderer.js';
import { perspective, lookAt, multiply } from './math.js';
import { makeTexture, publishEdit, unloadMaterial, reloadMaterial } from './materials.js';
import { ReasonCode, ReasonMeta } from './visibility-diagnostics.js';

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
  diag: document.getElementById('cDiag'),
};
for (const c of Object.values(views)) { c.width = VIEW_W; c.height = VIEW_H; }
const ctx2d = Object.fromEntries(Object.entries(views).map(([k, c]) => [k, c.getContext('2d')]));

const state = {
  run: true, reorder: false, perspective: true,
  materialMode: 0, outputMode: 0, ampDiff: false,
  freezeSnapshot: false,
  selectedMaterial: 0,
  // diagView: 'live' 显示当代可见缓冲；'snapshot' 显示封存/重放结果。
  diagView: 'live',
};

let renderer, scene, tables, camera;
let frame = 0, tokenCounter = 0;
let archivedFrame = null;      // 封存的取证快照
let diagResult = null;         // 最近一次整帧诊断
let replayResult = null;       // 最近一次封存重放（含原因图）
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

// 把一张 RGB（顶行原点）图像写入诊断视窗。
function paintDiagImage(rgb, w, h) {
  const c = ctx2d.diag;
  const img = c.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = rgb[i * 3];
    img.data[i * 4 + 1] = rgb[i * 3 + 1];
    img.data[i * 4 + 2] = rgb[i * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}

// 实时诊断视窗：从真实可见缓冲回读并逐像素追踪，生成原因码叠加图。
function renderLiveDiagnosis() {
  const analysis = renderer.runVisibilityDiagnostics({
    perspectiveCorrect: state.perspective, stride: 2, maxPixels: 6000,
  });
  diagResult = analysis;
  const buf = renderer.readVisibilityBuffers();
  const out = new Uint8Array(buf.width * buf.height * 3);
  // 背景先填底色，覆盖像素按原因码颜色（clean 用低饱和绿，避免过亮）。
  for (let i = 0; i < buf.width * buf.height; i++) {
    if ((buf.identity[i] & 0x80000000) === 0) { out.set([13, 18, 26], i * 3); continue; }
    // 以右邻判定实例/材质边界，其余按整帧分析的原因映射近似着色。
    out.set(ReasonMeta[ReasonCode.CLEAN].color, i * 3);
  }
  for (const [code, pixels] of Object.entries(analysis.reasonPixels)) {
    const col = ReasonMeta[code].color;
    for (const [x, y] of pixels) out.set(col, (y * buf.width + x) * 3);
  }
  paintDiagImage(out, buf.width, buf.height);
  document.getElementById('tagDiag').textContent = '实时结果 · 原因码联动';
  document.getElementById('diagSummary').innerHTML = summarizeAnalysis(analysis);
}

function summarizeAnalysis(a) {
  const rows = Object.entries(a.counts)
    .sort((x, y) => y[1] - x[1])
    .map(([code, n]) => `<span class="pill${code === ReasonCode.CLEAN ? ' on' : ''}">${ReasonMeta[code].label} ×${n}</span>`)
    .join(' ');
  return `<div style="margin-bottom:6px">分析像素 <b>${a.analyzed}</b> · 中止 <b>${a.haltedCount}</b> · ` +
    `平均Δ <b>${a.meanPixelDelta.toFixed(4)}</b> · 最大Δ <b>${a.maxPixelDelta.toFixed(4)}</b></div>` +
    `<div>${rows}</div>` +
    `<div class="muted" style="margin-top:6px">日志事件 ${a.logEvents}/${a.logPixels} 像素` +
    (a.truncated ? '（已达有界上限并截断）' : '（未截断）') + '</div>';
}

// 封存/重放诊断视窗：直接绘制重放出的原因/着色图。
function renderReplayDiagnosis() {
  if (!replayResult) return;
  paintDiagImage(replayResult.image, replayResult.width, replayResult.height);
  document.getElementById('tagDiag').textContent = '历史快照 · 封存重放';
  const missing = replayResult.missingDependencies
    .map((m) => `<span class="pill">${ReasonMeta[m.code].label} ${JSON.stringify(m.detail)}</span>`).join(' ');
  document.getElementById('diagSummary').innerHTML =
    `<div>中止像素 <b>${replayResult.haltedCount}</b></div>` +
    (missing ? `<div style="margin-top:6px">缺失依赖：${missing}</div>` : '<div style="margin-top:6px">封存资源齐全，已还原原三角颜色。</div>');
}

function renderDiagPanel() {
  if (state.diagView === 'snapshot' && replayResult) renderReplayDiagnosis();
  else renderLiveDiagnosis();
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

  // 诊断视窗节流刷新：实时模式每 12 帧复跑一次（stride 抽样 + 有界预算），
  // 历史快照模式保持封存重放结果不变，避免取证日志拖慢动画。
  if (state.diagView === 'live' && frame % 12 === 0) renderLiveDiagnosis();
  else if (state.diagView === 'snapshot' && replayResult && frame % 12 === 0) renderReplayDiagnosis();

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

  // ---- Visibility forensic controls (all call the real implementation) ----
  document.getElementById('captureFrame').onclick = () => {
    archivedFrame = renderer.captureVisFrameArchive({ perspectiveCorrect: state.perspective });
    replayResult = null;
    state.diagView = 'snapshot';
    replayResult = renderer.replayVisFrameArchive(archivedFrame);
    renderDiagPanel();
    setAlert('ok', `已封存可见性帧 #${archivedFrame.frameToken}：身份/重心/相机/实例/几何/材质已冻结为取证快照。`);
  };

  document.getElementById('diagFrame').onclick = () => {
    state.diagView = 'live';
    renderDiagPanel();
    const a = diagResult;
    if (a.haltedCount > 0) setAlert('err', `诊断发现 ${a.haltedCount} 个中止像素，请查看原因码与证据链。`);
  };

  document.getElementById('replayArchive').onclick = () => {
    if (!archivedFrame) { setAlert('warn', '请先封存当前可见性帧。'); return; }
    replayResult = renderer.replayVisFrameArchive(archivedFrame);
    state.diagView = 'snapshot';
    renderDiagPanel();
  };

  document.getElementById('liveView').onclick = () => {
    state.diagView = 'live';
    renderer.setUnloaded([], []);
    renderDiagPanel();
    setAlert('ok', '已切回实时可见缓冲：用当代资源重新生成可见性与诊断。');
  };

  document.getElementById('simUnload').onclick = () => {
    if (!archivedFrame) { setAlert('warn', '请先封存当前可见性帧，再模拟资源卸载。'); return; }
    // 标记几何 0 与选中材质为已卸载：诊断器应报缺失依赖并停在那次绘制。
    const matId = state.selectedMaterial;
    unloadMaterial(scene.materials[matId]);
    renderer.setUnloaded([0], [matId]);
    replayResult = renderer.replayVisFrameArchive(archivedFrame, {
      unloadedGeometry: new Set([0]),
      unloadedMaterial: new Set([matId]),
    });
    state.diagView = 'snapshot';
    renderDiagPanel();
  };

  document.getElementById('simReuse').onclick = () => {
    if (!archivedFrame) { setAlert('warn', '请先封存当前可见性帧，再模拟编号复用。'); return; }
    // 删除实例 1 并把编号 1 复用到材质不同的新物体，再推进材质版本。
    if (!window.__instanceSnapshot) window.__instanceSnapshot = scene.instances.map((i) => ({ ...i }));
    deleteAndReuseInstanceId(scene, 1, { name: 'reused-1', geometryId: 0, materialId: 3 });
    updateTransforms(scene.instances, 0);
    publishEdit(scene.materials[1], { baseColor: [Math.random(), Math.random(), Math.random()] });
    renderer.refreshMaterial(1);
    buildMaterialList();
    // 用当代实时版本重放旧封存帧：旧像素仍引用捕获时材质，绑定阶段标陈旧。
    const liveVersions = Object.fromEntries(scene.materials.map((m) => [m.id, m.version]));
    replayResult = renderer.replayVisFrameArchive(archivedFrame, { liveVersions });
    state.diagView = 'snapshot';
    renderDiagPanel();
    setAlert('warn', '已删除实例 1 并复用其编号；重放旧帧在材质绑定阶段标出陈旧绑定（首次读旧属性）。');
  };

  document.getElementById('resetScene').onclick = () => {
    if (window.__instanceSnapshot) {
      restoreInstances(scene, window.__instanceSnapshot);
      window.__instanceSnapshot = null;
      updateTransforms(scene.instances, 0);
    }
    scene.materials.forEach((m) => reloadMaterial(m));
    renderer.setUnloaded([], []);
    replayResult = null;
    state.diagView = 'live';
    renderDiagPanel();
    clearAlerts();
  };

  // 诊断视窗悬停：回溯该像素实际被着色的三角形与完整原因。
  views.diag.addEventListener('mousemove', (e) => {
    const rect = views.diag.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / rect.width * VIEW_W);
    const y = Math.floor((e.clientY - rect.top) / rect.height * VIEW_H);
    const info = document.getElementById('diagInfo');
    if (state.diagView === 'snapshot' && replayResult) {
      const code = replayResult.reasonAt(y * VIEW_W + x);
      info.innerHTML = `封存像素 <code>(${x},${y})</code> · 原因 <b>${ReasonMeta[code].label}</b><br>` +
        `<span class="muted">阶段：${ReasonMeta[code].stage}</span>`;
      return;
    }
    const t = renderer.traceVisibilityPixel(x, y, { perspectiveCorrect: state.perspective });
    if (!t.valid) { info.innerHTML = `像素 <code>(${x},${y})</code>：背景/无效身份。`; return; }
    const chain = t.evidence
      .map((ev) => `<div>· [${ev.stage}] <b>${ReasonMeta[ev.code].label}</b></div>`).join('');
    info.innerHTML =
      `像素 <code>(${x},${y})</code> · 实例 <b>#${t.instanceId}</b> · 三角形 <b>${t.triangle || '—'}</b><br>` +
      (t.material ? `材质 <b>${t.material.name} v${t.material.version}</b> · ` : '') +
      `主因 <b>${ReasonMeta[t.primary].label}</b>` +
      (t.pixelDelta !== null ? ` · Δ=${t.pixelDelta.toFixed(4)}` : '') +
      `<div style="margin-top:6px">${chain}</div>`;
  });

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
