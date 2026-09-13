/**
 * Mini-LED 背光分区调光 Demo
 *
 * 核心模型：
 *    最终画面 = LCD 透光率(像素级) × 背光亮度(分区级，被扩散糊开)
 *
 * 这个 demo 想让人看清三件事（都是实测得出的结论，不是想当然）：
 *
 *  1. 分区调光的真正收益是【还原精度 + 省电】，不是"黑得更黑"。
 *     实测：夜景窗户场景 重建误差 0.0293 → 0.0059（准了近 5×），
 *           同时背光功耗 100% → 13.7%（只用 1/7 的电）。
 *     原因：每块区域只给自己需要的背光，多余的一点都不给。
 *
 *  2. 光晕（blooming）是物理必然，根因是背光没法像素级精确 ——
 *     背光板有导光板和扩散膜，光会横向串到相邻分区。
 *     分区越多 → 光晕越小；扩散越大 → 边界越柔和。
 *
 *  3. max / mean 两种分区取值算法的取舍：
 *     max  保住高光（不裁切），但功耗高
 *     mean 省电，但含高光的分区会被平均低 → 高光被吃掉
 */
import {
  extractZones, diffuseBacklight, composeFrame, globalBacklight,
  effectiveContrast, processFrame, ZONE_PRESETS, perceptualLuma,
} from './pipeline.js';
import { PATTERNS, makePattern } from './patterns.js';
import {
  computeLayout, paintRGB, paintField, paintZoneOverlay, measureBlooming,
  estimatePower, measureGridArtifact,
} from './render.js';

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.add('show');

// 启动标记：index.html 的兜底面板靠它判断脚本有没有跑起来
window.__MINILED_BOOTED__ = true;

/* ================= 状态 ================= */
const state = {
  patternId: 'window',
  source: null,          // Float32Array RGB（原图，低分辨率）
  w: 0, h: 0,
  zoneCols: 32, zoneRows: 18,
  method: 'hybrid',
  hybridWeight: 0.65,
  minBoost: 0.02,
  boost: 1.0,
  spread: 6,
  gamma: 2.2,
  leak: 0.0015,
  panelContrast: 5000,
  showZones: false,
  showBacklight: true,
  view: 'compare',       // compare | global | zoned
  results: {},
  uploading: false,
};

/* ================= 素材 ================= */
const srcCanvas = document.createElement('canvas');

function loadPattern(id) {
  state.patternId = id;
  state.source = makePattern(id, state.w, state.h);
  render();
}

/** 从用户上传的图片生成源数据 */
function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const c = srcCanvas;
    c.width = state.w; c.height = state.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    // 等比 cover 裁切
    const s = Math.max(state.w / img.naturalWidth, state.h / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.clearRect(0, 0, state.w, state.h);
    ctx.drawImage(img, (state.w - dw) / 2, (state.h - dh) / 2, dw, dh);
    const px = ctx.getImageData(0, 0, state.w, state.h).data;
    const buf = new Float32Array(state.w * state.h * 3);
    for (let i = 0; i < state.w * state.h; i++) {
      buf[i * 3] = px[i * 4] / 255;
      buf[i * 3 + 1] = px[i * 4 + 1] / 255;
      buf[i * 3 + 2] = px[i * 4 + 2] / 255;
    }
    state.source = buf;
    state.patternId = null;
    $('srcInfo').textContent = `已载入图片：${file.name}（${img.naturalWidth}×${img.naturalHeight} → ${state.w}×${state.h}）`;
    $('srcInfo').classList.add('on');
    render();
    URL.revokeObjectURL(url);
  };
  img.onerror = () => toast('这张图片打不开', 'err');
  img.src = url;
}

/* ================= 计算 + 渲染 ================= */
function currentParams(overrides = {}) {
  return {
    zoneCols: state.zoneCols, zoneRows: state.zoneRows,
    method: state.method, hybridWeight: state.hybridWeight,
    minBoost: state.minBoost, boost: state.boost,
    spread: state.spread, gamma: state.gamma, leak: state.leak,
    panelContrast: state.panelContrast,
    ...overrides,
  };
}

/**
 * 重建误差（MAE）—— demo 的主指标
 * 用"输出亮度 vs 原图亮度"的平均绝对误差，直接反映还原准不准。
 * 比对比度更适合做主指标：对比度会被单个极值点带偏，MAE 反映整幅画面的还原度。
 */
function reconstructionMAE(srcRGB, outRGB, w, h) {
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    const a = perceptualLuma(srcRGB[i * 3], srcRGB[i * 3 + 1], srcRGB[i * 3 + 2]);
    const b = perceptualLuma(outRGB[i * 3], outRGB[i * 3 + 1], outRGB[i * 3 + 2]);
    sum += Math.abs(a - b);
  }
  return w * h ? sum / (w * h) : 0;
}

function render() {
  const { w, h } = state;
  const src = state.source;
  if (!src) return;

  // ---- 逐像素亮度 ----
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = perceptualLuma(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);

  // ---- 传统侧光式基线：整屏一个背光 ----
  const gField = globalBacklight(lum, w, h);
  const gOut = composeFrame(src, w, h, gField, { gamma: state.gamma, leak: state.leak, backlightFloor: state.minBoost });

  // ---- Mini-LED 分区调光 ----
  const ext = extractZones(lum, w, h, state.zoneCols, state.zoneRows, {
    method: state.method, hybridWeight: state.hybridWeight,
    minBoost: state.minBoost, boost: state.boost,
  });
  const zField = diffuseBacklight(ext.zones, state.zoneCols, state.zoneRows, w, h, state.spread);
  const zOut = composeFrame(src, w, h, zField, { gamma: state.gamma, leak: state.leak, backlightFloor: state.minBoost });

  // ---- 指标 ----
  const gPower = estimatePower(gField), zPower = estimatePower(zField);
  const gErr = reconstructionMAE(src, gOut.rgb, w, h);
  const zErr = reconstructionMAE(src, zOut.rgb, w, h);
  const gCon = effectiveContrast(gOut.rgb, w, h, state.panelContrast);
  const zCon = effectiveContrast(zOut.rgb, w, h, state.panelContrast);
  const gBloom = measureBlooming(src, gOut.rgb, w, h);
  const zBloom = measureBlooming(src, zOut.rgb, w, h);
  const grid = measureGridArtifact(zField, w, h, state.zoneCols, state.zoneRows);

  state.results = { gOut, zOut, gField, zField, ext, lum, gPower, zPower, gErr, zErr, gCon, zCon, gBloom, zBloom, grid };

  // ---- 画三张图 ----
  paintRGB($('cvSrc'), src, w, h);
  paintRGB($('cvGlobal'), gOut.rgb, w, h);
  paintRGB($('cvZoned'), zOut.rgb, w, h);

  if (state.showZones) {
    paintZoneOverlay($('cvZoned'), ext.zones, state.zoneCols, state.zoneRows, w, h, { showValues: true });
  }
  if (state.showBacklight) {
    paintField($('cvBacklight'), zField, w, h, { heat: true });
    $('backlightWrap').hidden = false;
  } else {
    $('backlightWrap').hidden = true;
  }

  // ---- 视图切换 ----
  applyView();

  // ---- 数字 ----
  updateStats({ gPower, zPower, gErr, zErr, gCon, zCon, gBloom, zBloom, grid });
}

function applyView() {
  const v = state.view;
  const cards = [
    { el: 'cardSrc', show: true },
    { el: 'cardGlobal', show: v === 'compare' || v === 'global' },
    { el: 'cardZoned', show: v === 'compare' || v === 'zoned' },
  ];
  for (const c of cards) $(c.el).style.display = c.show ? '' : 'none';
  const n = v === 'compare' ? 3 : 2;
  $('compareGrid').style.gridTemplateColumns = `repeat(${n}, 1fr)`;
}

function updateStats(r) {
  const pct = (v) => (v * 100).toFixed(1) + '%';
  $('stats').innerHTML = `
    <div class="stat-row"><span>重建误差 MAE（越小越准）</span>
      <b>${r.gErr.toFixed(4)}</b><i>→</i><b class="hi">${r.zErr.toFixed(4)}</b>
      <em>${r.zErr < r.gErr ? `准了 ${(r.gErr / r.zErr).toFixed(1)}×` : '变差了'}</em></div>
    <div class="stat-row"><span>背光功耗（相对整屏满亮）</span>
      <b>${pct(r.gPower)}</b><i>→</i><b class="hi">${pct(r.zPower)}</b>
      <em>${r.zPower < r.gPower ? `只剩 ${(r.zPower / r.gPower * 100).toFixed(0)}%` : '反而更高'}</em></div>
    <div class="stat-row"><span>估算对比度（受面板 ${state.panelContrast}:1 封顶）</span>
      <b>${Math.round(r.gCon.capped)}:1</b><i>→</i><b class="hi">${Math.round(r.zCon.capped)}:1</b>
      <em>${r.zCon.panelLimited || r.gCon.panelLimited ? '已撞面板上限' : ''}</em></div>
    <div class="stat-row"><span>暗部被抬亮（光晕，越小越好）</span>
      <b>${(r.gBloom.avgLift * 100).toFixed(3)}%</b><i>→</i><b class="hi">${(r.zBloom.avgLift * 100).toFixed(3)}%</b>
      <em>背光扩散的必然结果</em></div>
    <div class="stat-row"><span>分区边界梯度（格子感）</span>
      <b class="hi">${r.grid.edgeGrad.toFixed(5)}</b>
      <em>分区 ${state.zoneCols}×${state.zoneRows} = ${(state.zoneCols * state.zoneRows).toLocaleString()} 个 · 扩散 ${state.spread}px</em></div>
  `;
  $('panelInfo').textContent = `${state.zoneCols}×${state.zoneRows} 分区`;
  $('zoneCount').textContent = (state.zoneCols * state.zoneRows).toLocaleString();
}

/* ================= UI ================= */
function buildPatternList() {
  const wrap = $('patternList');
  wrap.innerHTML = '';
  for (const p of PATTERNS) {
    const b = document.createElement('button');
    b.dataset.pid = p.id;
    b.className = p.id === state.patternId ? 'on' : '';
    b.innerHTML = `<b>${p.name}</b><span>${p.desc}</span>`;
    b.onclick = () => {
      [...wrap.children].forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      loadPattern(p.id);
    };
    wrap.appendChild(b);
  }
}

function buildZonePresets() {
  const wrap = $('zonePresets');
  wrap.innerHTML = '';
  for (const z of ZONE_PRESETS) {
    const b = document.createElement('button');
    b.textContent = z.label;
    b.title = z.note;
    b.className = (z.cols === state.zoneCols && z.rows === state.zoneRows) ? 'on' : '';
    b.onclick = () => {
      state.zoneCols = z.cols; state.zoneRows = z.rows;
      $('zoneCols').value = z.cols; $('zoneRows').value = z.rows;
      [...wrap.children].forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      render();
    };
    wrap.appendChild(b);
  }
}

function bindUI() {
  $('patternList').addEventListener('click', () => {});

  $('btnUpload').onclick = () => $('fileImg').click();
  $('fileImg').onchange = (e) => { if (e.target.files[0]) loadImageFile(e.target.files[0]); e.target.value = ''; };

  const bindRange = (id, key, scale = 1, fmt = (v) => v) => {
    const el = $(id);
    const out = $(id + 'Val');
    el.oninput = () => {
      state[key] = Number(el.value) / scale;
      if (out) out.textContent = fmt(state[key]);
      render();
    };
    if (out) out.textContent = fmt(state[key]);
  };

  bindRange('zoneCols', 'zoneCols', 1, (v) => v);
  bindRange('zoneRows', 'zoneRows', 1, (v) => v);
  bindRange('spread', 'spread', 1, (v) => v + 'px');
  bindRange('minBoost', 'minBoost', 100, (v) => (v * 100).toFixed(0) + '%');
  bindRange('boost', 'boost', 100, (v) => v.toFixed(2) + '×');
  bindRange('hybridWeight', 'hybridWeight', 100, (v) => v.toFixed(2));
  bindRange('gamma', 'gamma', 10, (v) => v.toFixed(1));
  bindRange('leak', 'leak', 10000, (v) => (v * 10000).toFixed(1) + '‱');
  bindRange('panelContrast', 'panelContrast', 1, (v) => v.toLocaleString() + ':1');

  $('method').onchange = (e) => {
    state.method = e.target.value;
    $('hybridRow').style.display = state.method === 'hybrid' ? '' : 'none';
    render();
  };

  $('viewSeg').onclick = (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    [...$('viewSeg').children].forEach((x) => x.classList.toggle('on', x === b));
    applyView();
  };

  $('chkZones').onchange = (e) => { state.showZones = e.target.checked; render(); };
  $('chkBacklight').onchange = (e) => { state.showBacklight = e.target.checked; render(); };

  $('btnExport').onclick = exportReport;

  // 参数联动：改分区数时同步预设按钮状态
  ['zoneCols', 'zoneRows'].forEach((id) => {
    $(id).addEventListener('change', () => {
      [...$('zonePresets').children].forEach((b) => b.classList.remove('on'));
    });
  });
}

/* ================= 导出对比报告 ================= */
function exportReport() {
  const r = state.results;
  const lines = [
    'Mini-LED 背光分区调光 · 对比报告',
    '='.repeat(48),
    `画面: ${state.patternId || '上传图片'}  ${state.w}×${state.h}`,
    `分区: ${state.zoneCols} × ${state.zoneRows} = ${(state.zoneCols * state.zoneRows).toLocaleString()} 个`,
    `取值算法: ${state.method}${state.method === 'hybrid' ? `（max 权重 ${state.hybridWeight}）` : ''}`,
    `背光扩散: ${state.spread}px   最低背光: ${(state.minBoost * 100).toFixed(0)}%`,
    `面板漏光: ${(state.leak * 10000).toFixed(1)}‱   面板原生对比度: ${state.panelContrast}:1`,
    '',
    '                传统整屏背光      Mini-LED 分区调光      改善',
    '-'.repeat(48),
    `重建误差 MAE    ${r.gErr.toFixed(4).padStart(12)}      ${r.zErr.toFixed(4).padStart(12)}      ${(r.gErr / r.zErr).toFixed(1)}× 更准`,
    `背光功耗        ${(r.gPower * 100).toFixed(1).padStart(11)}%      ${(r.zPower * 100).toFixed(1).padStart(11)}%      ${(r.zPower / r.gPower * 100).toFixed(0)}%`,
    `估算对比度      ${String(Math.round(r.gCon.capped)).padStart(10)}:1      ${String(Math.round(r.zCon.capped)).padStart(10)}:1`,
    `暗部抬亮(光晕)  ${(r.gBloom.avgLift * 100).toFixed(3).padStart(10)}%      ${(r.zBloom.avgLift * 100).toFixed(3).padStart(10)}%`,
    '',
    '结论：',
    r.zErr < r.gErr
      ? `  · 分区调光把还原精度提升了 ${(r.gErr / r.zErr).toFixed(1)} 倍`
      : '  · 这个画面下分区调光没有提升精度（分区数可能太少）',
    r.zPower < r.gPower
      ? `  · 同时背光功耗只剩 ${(r.zPower / r.gPower * 100).toFixed(0)}%（省电是分区调光的第二个卖点）`
      : '  · 功耗没有优势',
    '  · 光晕是物理必然：背光经扩散膜会横向串到相邻分区，无法像素级精确',
    `  · 当前格子感（分区边界梯度）${r.grid.edgeGrad.toFixed(5)}，格子的可见度请直接看图判断`,
  ];
  const text = lines.join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `miniled-report-${Date.now()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('报告已导出', 'ok');
}

let toastTimer = 0;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ================= 启动 ================= */
function boot() {
  const layout = computeLayout(640, 360);
  state.w = layout.w; state.h = layout.h;

  buildPatternList();
  buildZonePresets();
  bindUI();
  loadPattern(state.patternId);

  $('srcInfo').textContent = '当前：内置测试图案（也可上传自己的图片）';
  $('hybridRow').style.display = '';
}

try {
  boot();
} catch (e) {
  console.error(e);
  toast('初始化出错：' + e.message, 'err');
}

/** 自测钩子 */
window.__MINILED_DEBUG__ = () => {
  const r = state.results;
  return {
    booted: true,
    pattern: state.patternId,
    size: `${state.w}x${state.h}`,
    zones: `${state.zoneCols}x${state.zoneRows}`,
    method: state.method,
    spread: state.spread,
    gErr: r.gErr, zErr: r.zErr,
    gPower: r.gPower, zPower: r.zPower,
    gContrast: r.gCon?.capped, zContrast: r.zCon?.capped,
    hasSrc: !!state.source,
  };
};
window.__MINILED_SET__ = (patch) => {
  Object.assign(state, patch);
  if (patch.zoneCols) $('zoneCols').value = patch.zoneCols;
  if (patch.zoneRows) $('zoneRows').value = patch.zoneRows;
  if (patch.spread !== undefined) $('spread').value = patch.spread;
  if (patch.method) $('method').value = patch.method;
  render();
  return window.__MINILED_DEBUG__();
};
window.__MINILED_PATTERN__ = (id) => { loadPattern(id); return window.__MINILED_DEBUG__(); };
