/* 拼豆工坊 —— UI 控制器（简化版：一条主线，其余收进「更多选项」和「编辑」） */
import { PixelGrid } from './grid.js';
import { BEAD_SETS } from './palette.js';
import { AI_CONFIG, generateFromText, mockGenerate } from './ai.js';
import { paintGridToCanvas, exportPNG, drawGrid, drawChecker } from './render.js';
import { toCHeader, toJSON, toBinaryFrame, toHexDump, download, downloadDataUrl, copyText } from './export.js';
import { buildTheme, imageLayer, datetimeLayer, themeReport, initThemePack } from './themepack.js';
import { LIBRARY, artToGrid } from './art.js';

window.__PBS_BOOTED__ = true;

const $ = (id) => document.getElementById(id);
const PANEL = { cols: 96, rows: 48 };
const LS_KEY = 'pbs.key';

/* 覆盖层统一用 .show 控制显隐（不能用 hidden 属性，见 css 里的说明） */
const show = (id) => $(id).classList.add('show');
const hide = (id) => $(id).classList.remove('show');
const isShown = (id) => $(id).classList.contains('show');

const state = {
  grid: null,
  title: '',
  desc: '',
  size: '20x20',
  tool: 'pen',
  color: '#FF8A00',
  editing: false,
  history: [],
  drag: null,
  last: null,
  preview: null,
  lastFrame: null,
  exportKind: 'png',
  libPick: 'owl',
};

/* ============================ 小工具 ============================ */

let toastTimer = 0;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

function status(msg, kind = '') {
  $('status').textContent = msg;
  $('status').className = 'status ' + kind;
}

function setAiPill(mode, text) {
  $('aiState').textContent = text;
  $('aiState').className = 'pill' + (mode ? ' ' + mode : '');
}

/* ============================ 渲染 ============================ */

function render() {
  const g = state.grid;
  if (!g || !g.cols) return;
  const wrap = $('canvasWrap');
  const maxW = Math.max(220, wrap.clientWidth - 28);
  const maxH = Math.max(220, Math.min(520, window.innerHeight - 400));
  const cell = Math.max(3, Math.floor(Math.min(maxW / g.cols, maxH / g.rows)));
  const w = g.cols * cell, h = g.rows * cell;

  const cv = $('canvas');
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;

  drawChecker(ctx, w, h, 0, 0, Math.max(24, cell * 2));
  drawGrid(ctx, g, { cell, ox: 0, oy: 0, bead: cell >= 9, showGrid: !state.editing && cell >= 7 });

  if (state.preview && state.drag) {
    const p = state.preview;
    ctx.save();
    ctx.strokeStyle = '#00d8ff';
    ctx.lineWidth = 1.5;
    if (p.kind === 'rect') ctx.strokeRect(p.x0 * cell + .5, p.y0 * cell + .5, (p.x1 - p.x0 + 1) * cell, (p.y1 - p.y0 + 1) * cell);
    else {
      ctx.beginPath();
      ctx.moveTo(p.x0 * cell + cell / 2, p.y0 * cell + cell / 2);
      ctx.lineTo(p.x1 * cell + cell / 2, p.y1 * cell + cell / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  const st = g.counts();
  const set = BEAD_SETS[$('beadSet').value];
  const hours = (st.filled * 6) / 3600;
  $('title').textContent = state.title || '未命名';
  $('meta').textContent = `${g.cols} × ${g.rows} · ${st.colors} 色 · ${st.filled} 颗`
    + (set ? ` · ${set.dot}mm` : '')
    + (st.filled ? ` · 约 ${hours < 1 ? '<1' : hours.toFixed(1)} 小时` : '');
}

function renderSwatches() {
  const wrap = $('swatches');
  if (!state.grid) return;
  wrap.innerHTML = '';
  const set = BEAD_SETS[$('beadSet').value] || BEAD_SETS.standard;
  const list = set.colors.map((c) => c[1]);
  state.grid.palette.forEach((h) => { if (!list.includes(h)) list.push(h); });
  list.forEach((hex) => {
    const b = document.createElement('button');
    b.style.background = hex;
    b.title = hex;
    if (hex.toUpperCase() === state.color.toUpperCase()) b.className = 'on';
    b.onclick = () => { state.color = hex; $('customColor').value = hex; renderSwatches(); };
    wrap.appendChild(b);
  });
}

function renderLibrary(filter = '') {
  const wrap = $('lib');
  wrap.innerHTML = '';
  const items = LIBRARY.filter((i) => !filter || i.name.includes(filter) || i.tags.join().includes(filter));
  if (!items.length) {
    wrap.innerHTML = '<span class="muted small">没有匹配的图案</span>';
    return;
  }
  for (const item of items) {
    const b = document.createElement('button');
    if (item.id === state.libPick) b.className = 'on';
    const cv = document.createElement('canvas');
    const size = Math.max(2, Math.floor(78 / item.grid.cols));
    cv.width = item.grid.cols * size;
    cv.height = item.grid.rows * size;
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = false;
    drawGrid(c, item.grid, { cell: size, ox: 0, oy: 0, bead: size >= 4, showGrid: false });
    b.appendChild(cv);
    const s = document.createElement('span');
    s.textContent = item.name;
    b.appendChild(s);
    b.onclick = () => {
      snapshot();
      state.grid = artToGrid(item);
      state.title = item.name;
      state.desc = '';
      state.libPick = item.id;
      state.color = state.grid.palette[1] || state.grid.palette[0];
      renderSwatches(); render(); renderLibrary($('search').value.trim());
    };
    wrap.appendChild(b);
  }
}

/* ============================ 历史 ============================ */

function snapshot() {
  if (!state.grid) return;
  state.history.push({
    cols: state.grid.cols, rows: state.grid.rows,
    palette: state.grid.palette.slice(), grid: Int8Array.from(state.grid.grid), title: state.title,
  });
  if (state.history.length > 60) state.history.shift();
}

function undo() {
  const s = state.history.pop();
  if (!s) { toast('没有可撤销的操作'); return; }
  state.grid = PixelGrid.create(s.cols, s.rows, s.palette.slice());
  state.grid.grid = Int8Array.from(s.grid);
  state.title = s.title;
  renderSwatches(); render();
}

/* ============================ AI 生成 ============================ */

function apiKey() { return ($('apiKey').value || '').trim() || localStorage.getItem(LS_KEY) || ''; }

function applyConfig() {
  AI_CONFIG.apiKey = apiKey();
  AI_CONFIG.baseUrl = ($('apiBase').value.trim() || 'https://api.deepseek.com').replace(/\/$/, '');
  AI_CONFIG.model = $('model').value.trim() || 'deepseek-v4-flash';
  AI_CONFIG.temperature = 0.2 + (parseInt($('temp').value, 10) / 100) * 1.3;
  setAiPill(AI_CONFIG.apiKey ? 'on' : '', AI_CONFIG.apiKey ? 'AI 就绪' : '未配置 AI');
}

async function generate({ useMock = false } = {}) {
  const desc = $('prompt').value.trim();
  if (!desc) { toast('先写一句描述', 'err'); $('prompt').focus(); return; }

  applyConfig();
  if (!useMock && !apiKey()) {
    status('没填 API Key，先用内置图案把流程演示一遍。点右上角 ⚙ 可以填。', 'busy');
    toast('未配置 API Key，已切换为离线演示');
    useMock = true;
  }

  $('btnGo').disabled = true;
  setAiPill('busy', useMock ? '本地生成中' : 'AI 生成中…');
  status(useMock ? '生成中…' : 'AI 正在理解描述并构图…', 'busy');

  const beadSet = $('beadSet').value;
  const opts = {
    mode: $('mode').value,
    size: state.size,
    maxColors: parseInt($('maxColors').value, 10),
    beadSet,
    beadSetName: (BEAD_SETS[beadSet] || {}).name || '拼豆色卡',
    onStage: (t) => status(t, 'busy'),
  };

  try {
    const out = useMock ? mockGenerate(desc, { size: state.size }) : await generateFromText(desc, opts);
    snapshot();
    state.grid = out.grid;
    state.title = out.meta.title;
    state.desc = desc;
    state.libPick = '';
    state.color = out.grid.palette[1] || out.grid.palette[0] || '#FF8A00';
    renderSwatches(); render(); renderLibrary($('search').value.trim());

    const how = out.meta.mode === 'spec' ? `语义分镜 ${out.meta.shapes} 形状 → 本地渲染` : '大模型直出网格';
    status(out.meta.mock
      ? '离线演示完成（内置图案）。填了 API Key 后就是真实 AI 生成。'
      : `完成 · ${how} · ${(out.meta.ms / 1000).toFixed(1)}s · ${out.meta.tokens} token · ${out.meta.colors} 色 ${out.meta.beads} 颗`, 'ok');
    toast(`已生成「${state.title}」`, 'ok');
  } catch (e) {
    status('生成失败：' + e.message, 'err');
    toast('生成失败：' + e.message, 'err');
    console.error(e);
  } finally {
    $('btnGo').disabled = false;
    applyConfig();
  }
}

/* ============================ 编辑 ============================ */

function pos(ev) {
  const r = $('canvas').getBoundingClientRect();
  const cell = r.width / state.grid.cols;
  return {
    x: Math.max(0, Math.min(state.grid.cols - 1, Math.floor((ev.clientX - r.left) / cell))),
    y: Math.max(0, Math.min(state.grid.rows - 1, Math.floor((ev.clientY - r.top) / cell))),
  };
}

function paint(x, y, erase) { state.grid.set(x, y, erase ? -1 : state.grid.ensureColor(state.color)); }

function bresenham(x0, y0, x1, y1, cb) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cb(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

function flood(x0, y0, target, repl) {
  if (target === repl) return;
  const g = state.grid, stack = [[x0, y0]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= g.cols || y >= g.rows || g.get(x, y) !== target) continue;
    g.set(x, y, repl);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function bindCanvas() {
  const wrap = $('canvasWrap');

  wrap.addEventListener('pointerdown', (ev) => {
    if (!state.editing || !state.grid) return;
    const p = pos(ev);
    try { wrap.setPointerCapture(ev.pointerId); } catch { /* 某些浏览器不支持，忽略 */ }
    state.drag = p;

    if (state.tool === 'picker') {
      const v = state.grid.get(p.x, p.y);
      if (v >= 0) {
        state.color = state.grid.palette[v];
        $('customColor').value = state.color;
        renderSwatches();
        toast('已吸取 ' + state.color);
      }
      state.drag = null;
      return;
    }
    snapshot();
    if (state.tool === 'fill') {
      flood(p.x, p.y, state.grid.get(p.x, p.y), state.grid.ensureColor(state.color));
      render();
      return;
    }
    if (state.tool === 'line' || state.tool === 'rect') {
      state.preview = { kind: state.tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      render();
      return;
    }
    state.last = p;
    paint(p.x, p.y, state.tool === 'eraser');
    render();
  });

  wrap.addEventListener('pointermove', (ev) => {
    if (!state.editing || !state.grid) return;
    const p = pos(ev);
    const v = state.grid.get(p.x, p.y);
    const c = $('cursor');
    c.textContent = `${p.x},${p.y} ${v >= 0 ? state.grid.palette[v] : '空'}`;
    c.classList.add('on');
    if (!state.drag) return;
    if (state.tool === 'line' || state.tool === 'rect') {
      state.preview = { ...state.preview, x1: p.x, y1: p.y };
      render();
      return;
    }
    if (state.last) bresenham(state.last.x, state.last.y, p.x, p.y, (x, y) => paint(x, y, state.tool === 'eraser'));
    state.last = p;
    render();
  });

  const end = () => {
    if (!state.drag) { $('cursor').classList.remove('on'); return; }
    if (state.preview) {
      const p = state.preview;
      const idx = state.grid.ensureColor(state.color);
      if (p.kind === 'line') bresenham(p.x0, p.y0, p.x1, p.y1, (x, y) => state.grid.set(x, y, idx));
      else {
        for (let y = Math.min(p.y0, p.y1); y <= Math.max(p.y0, p.y1); y++)
          for (let x = Math.min(p.x0, p.x1); x <= Math.max(p.x0, p.x1); x++) state.grid.set(x, y, idx);
      }
      state.preview = null;
    }
    state.drag = null; state.last = null;
    renderSwatches(); render();
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('pointerleave', () => $('cursor').classList.remove('on'));
}

/* ============================ 导出 ============================ */

const FILE_NAME = { c: 'bead_art.h', json: 'bead_art.json', bin: 'bead_frame.bin', png: 'bead_art.png', theme: 'theme.json' };

/** 生成 Clockwise(clock-club) 主题 JSON；图片是内嵌的索引色 PNG（base64） */
function buildClockwiseTheme() {
  const g = state.grid;
  const theme = buildTheme({
    name: state.title || 'pixel-art',
    author: 'Pixel Bead Studio',
    bgColor: '#000000',
    delay: 250,
    setup: [
      imageLayer(g, 0, 0, state.desc || state.title),
      ...(g.rows <= 62 ? [datetimeLayer({ x: 20, y: Math.min(g.rows - 2, 62), content: 'H:i', fgColor: '#FFFFFF', bgColor: '#000000' })] : []),
    ],
    sprites: [],
    loop: [],
  });
  const pngLen = Math.ceil((theme.setup[0].image.length * 3) / 4);
  return { theme, text: JSON.stringify(theme, null, 2), pngLen: themeReport(theme).imageBytes };
}

function refreshExport() {
  if (!state.grid) return;
  const kind = state.exportKind;
  const out = $('code');

  if (kind === 'png') {
    $('exportHint').textContent = '3 倍放大的拼豆质感 PNG';
    out.textContent = '(PNG 是二进制图片，点「下载」保存文件)';
    return;
  }
  if (kind === 'c') {
    const fr = toBinaryFrame(state.grid, { panel: PANEL, rle: true });
    out.textContent = toCHeader(state.grid, { name: 'bead_art', panel: PANEL, packed: true });
    $('exportHint').textContent = `已适配 96×48 屏 · 原始帧 ${fr.stats.raw}B → RLE ${fr.stats.payload}B（省 ${fr.stats.saved}%）`;
    return;
  }
  if (kind === 'theme') {
    const th = buildClockwiseTheme();
    const rep = themeReport(th.theme);
    state.themeText = th.text;
    out.textContent = th.text;
    $('exportHint').textContent = `Clockwise「Canvas」主题 · 内嵌索引色 PNG ${rep.imageBytes}B `
      + (rep.fitsFirmwareBuffer ? '（固件 1KB 缓冲放得下 ✓）' : '（⚠ 超过固件 1KB 缓冲：减少颜色数或缩小画布）')
      + ` · 压缩 ${rep.compression}`;
    return;
  }
  if (kind === 'bin') {
    const fr = toBinaryFrame(state.grid, { panel: PANEL, rle: true });
    state.lastFrame = fr;
    out.textContent = [
      '/* 帧协议：A5 5A | ver | cmd | cols | rows | colors | flags | RGB565调色板 | RLE | CRC16 */',
      `/* 共 ${fr.stats.total} 字节，比原始省 ${fr.stats.saved}% */`,
      '',
      toHexDump(fr.bytes),
    ].join('\n');
    $('exportHint').textContent = '串口 / BLE / WiFi 都发这一份帧';
    return;
  }
  out.textContent = toJSON(state.grid, { title: state.title, desc: state.desc });
  $('exportHint').textContent = '车机前端、云端存储都吃这一份';
}

function doDownload() {
  if (!state.grid) return;
  const kind = state.exportKind;
  if (kind === 'png') { downloadDataUrl(`bead-${state.title || 'art'}.png`, exportPNG(state.grid, { scale: 24, bead: true })); return; }
  if (kind === 'bin' && state.lastFrame) { download(FILE_NAME.bin, state.lastFrame.bytes, 'application/octet-stream'); return; }
  if (kind === 'c') { download(FILE_NAME.c, toCHeader(state.grid, { name: 'bead_art', panel: PANEL, packed: true })); return; }
  if (kind === 'theme') { download(`theme-${state.title || 'art'}.json`, state.themeText || buildClockwiseTheme().text, 'application/json'); return; }
  download(FILE_NAME.json, toJSON(state.grid, { title: state.title, desc: state.desc }), 'application/json');
}

function openExport(kind = 'png') {
  state.exportKind = kind;
  [...$('exportSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  refreshExport();
  show('exportModal');
}

/* ============================ 事件绑定 ============================ */

function bindUI() {
  $('btnGo').onclick = () => generate();
  $('prompt').onkeydown = (e) => { if (e.key === 'Enter') generate(); };

  $('chips').onclick = (e) => {
    const b = e.target.closest('button[data-q]');
    if (!b) return;
    $('prompt').value = b.dataset.q;
    generate();
  };

  $('sizeSeg').onclick = (e) => {
    const b = e.target.closest('button[data-size]');
    if (!b) return;
    state.size = b.dataset.size;
    [...$('sizeSeg').children].forEach((x) => x.classList.toggle('on', x === b));
    const [c, r] = state.size.split('x').map(Number);
    if (state.grid && (state.grid.cols !== c || state.grid.rows !== r)) {
      snapshot();
      state.grid = state.grid.resize(c, r);
      render(); renderSwatches();
    }
  };

  $('beadSet').onchange = () => { renderSwatches(); render(); };
  $('btnMore').onclick = () => {
    const on = $('more').classList.toggle('open');
    $('btnMore').textContent = on ? '收起选项' : '更多选项';
  };
  $('maxColors').oninput = (e) => { $('maxColorsVal').textContent = e.target.value; };

  $('btnSettings').onclick = () => show('settings');
  $('btnCloseSettings').onclick = () => hide('settings');
  $('btnSave').onclick = () => {
    localStorage.setItem(LS_KEY, ($('apiKey').value || '').trim());
    applyConfig();
    hide('settings');
    toast('已保存到本机浏览器', 'ok');
    status(AI_CONFIG.apiKey ? 'AI 已就绪，写一句描述回车即生成。' : '还没填 Key，会继续用内置图案演示。');
  };
  $('btnTest').onclick = async () => {
    applyConfig();
    if (!AI_CONFIG.apiKey) { toast('先填 API Key', 'err'); return; }
    status('测试连通性…', 'busy');
    try {
      const r = await fetch(`${AI_CONFIG.baseUrl}/models`, { headers: { Authorization: 'Bearer ' + AI_CONFIG.apiKey } });
      const j = await r.json();
      const ids = (j.data || []).map((m) => m.id).join(', ') || '(返回空)';
      status('连通正常，可用模型：' + ids, 'ok');
      toast('API 正常：' + ids, 'ok');
    } catch (e) {
      status('连通失败：' + e.message, 'err');
      toast('连通失败：' + e.message, 'err');
    }
  };

  $('btnEdit').onclick = () => {
    state.editing = !state.editing;
    $('editor').classList.toggle('open', state.editing);
    $('canvasWrap').classList.toggle('edit', state.editing);
    $('btnEdit').textContent = state.editing ? '✎ 完成' : '✎ 编辑';
    render();
    if (state.editing) toast('左键上色，可切换铅笔/橡皮/油漆桶');
  };
  $('tools').onclick = (e) => {
    const b = e.target.closest('button[data-tool]');
    if (!b) return;
    state.tool = b.dataset.tool;
    [...$('tools').children].forEach((x) => x.classList.toggle('on', x === b));
  };
  $('btnUndo').onclick = undo;
  $('customColor').oninput = (e) => { state.color = e.target.value.toUpperCase(); renderSwatches(); };
  $('btnShuffle').onclick = () => {
    if (!state.grid) return;
    snapshot();
    const g = state.grid.clone();
    const n = Math.max(1, g.palette.length);
    for (let i = 0; i < g.grid.length; i++) if (g.grid[i] >= 0) g.grid[i] = Math.floor(Math.random() * n);
    state.grid = g;
    render(); renderSwatches();
    toast('换了一套配色');
  };

  $('btnExport').onclick = () => openExport('png');
  $('exportSeg').onclick = (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    state.exportKind = b.dataset.kind;
    [...$('exportSeg').children].forEach((x) => x.classList.toggle('on', x === b));
    refreshExport();
  };
  $('btnCloseExport').onclick = () => hide('exportModal');
  $('btnDownload').onclick = doDownload;
  $('btnCopy').onclick = async () => {
    if (state.exportKind === 'png') { doDownload(); return; }
    const ok = await copyText($('code').textContent);
    toast(ok ? '已复制' : '复制失败，请手动选择', ok ? 'ok' : 'err');
  };

  $('btnSend').onclick = () => {
    if (!state.grid) return;
    const fr = toBinaryFrame(state.grid, { panel: PANEL, rle: true });
    state.lastFrame = fr;
    openExport('bin');
    status(`帧已打包：${fr.stats.total} 字节（比原始省 ${fr.stats.saved}%）→ 串口 / BLE / WiFi 发给 ESP32`, 'ok');
    toast('下发帧已备好', 'ok');
  };

  $('search').oninput = (e) => renderLibrary(e.target.value.trim());

  // 点遮罩关弹窗
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hide('settings'); hide('exportModal'); }
    // 事件目标可能是 document / body，不一定有 matches
    if (e.target && typeof e.target.matches === 'function' && e.target.matches('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
    if (!state.editing) return;
    const map = { b: 'pen', e: 'eraser', g: 'fill', i: 'picker', l: 'line', r: 'rect' };
    const t = map[e.key.toLowerCase()];
    if (t) {
      state.tool = t;
      [...$('tools').children].forEach((x) => x.classList.toggle('on', x.dataset.tool === t));
    }
  });

  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 120); });
}

/* ============================ 启动 ============================ */

function boot() {
  bindUI();
  bindCanvas();

  const saved = localStorage.getItem(LS_KEY);
  if (saved) $('apiKey').value = saved;
  applyConfig();

  state.grid = artToGrid(LIBRARY[0]);
  state.title = LIBRARY[0].name;
  state.color = state.grid.palette[2] || state.grid.palette[0];
  $('customColor').value = state.color;

  renderSwatches();
  render();
  renderLibrary();
  status(apiKey()
    ? 'AI 已就绪。写一句描述，回车即生成。'
    : '写一句描述点「生成」即可（没配 API Key 会用内置图案演示）。点右上角 ⚙ 填 Key 开启真实 AI 生成。');
}

// 无论初始化出什么问题，都不能让按钮变成死的
try {
  boot();
} catch (e) {
  console.error(e);
  status('初始化出错：' + e.message + '（按钮仍可点，可尝试刷新）', 'err');
}

// 预加载压缩器：Node 下走 zlib 最优压缩，浏览器下自动退回 STORED
initThemePack().catch(() => {});
