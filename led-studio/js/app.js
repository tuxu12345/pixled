/* LED Studio —— 虚拟点阵屏 + 驱动效果 + 任意图片/视频上屏 */
import { LedBuffer, COLOR_MODES, quantize, toIndexedFrame, rleEncode565 } from './buffer.js';
import { LedDisplay } from './display.js';
import { sourceToBuffer, VideoSampler, beadGridToBuffer } from './pipeline.js';
import {
  EFFECTS, EFFECT_BY_ID, defaultParams, hexToRgb, fillBg, hsv,
} from './effects.js';

window.__LED_STUDIO_BOOTED__ = true;

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.add('show');
const hide = (id) => $(id).classList.remove('show');

/* ================= 状态 ================= */
const state = {
  cols: 64, rows: 64,
  colorMode: 'rgb565',
  brightness: 1.0,
  gamma: 2.2,
  paused: false,
  t: 0,                 // 虚拟时间（秒）—— 暂停时冻结，保证导出可复现
  lastWall: 0,
  effectId: 'marquee',
  params: {},
  effectState: {},
  content: null,        // LedBuffer：当前素材采样结果
  contentSource: null,  // 'image' | 'video' | 'bead' | null
  rawSource: null,      // Image 或 Video 元素
  videoSampler: null,
  videoMode: 'fullscreen',
  videoEl: null,
  frameCount: 0,
  rec: null,
};

let display = null;
let outBuf = null;

/* ================= 初始化 ================= */
function boot() {
  display = new LedDisplay($('led'));
  outBuf = new LedBuffer(state.cols, state.rows);

  buildEffectGrid();
  selectEffect('marquee');
  bindUI();
  bindDrop();
  applyPanelSize();
  syncDisplayOpts();

  requestAnimationFrame(loop);

  // 支持 ?t=秒数 跳到指定时刻（无头环境 rAF 几乎不跑，靠这个才能截到想要的画面；
  // 真实浏览器里也方便做"定格分享"）
  const qs = new URLSearchParams(location.search);
  if (qs.has('t')) {
    const t = Number(qs.get('t')) || 0;
    state.t = t;
    // 等各模块就绪后按指定时刻渲染一帧
    setTimeout(() => { renderAt(t); $('timeline').value = Math.round((t % 10) * 100); $('timelineVal').textContent = (t % 10).toFixed(1) + 's'; }, 80);
  }

  // 首次给个好看的开场
  $('stageMeta').textContent = '点阵屏最经典的效果 · 也可以导入图片或视频上屏';
}

/* ================= 效果 ================= */
function buildEffectGrid() {
  const grid = $('fxGrid');
  grid.innerHTML = '';
  EFFECTS.forEach((fx) => {
    const b = document.createElement('button');
    b.dataset.fx = fx.id;
    b.textContent = fx.name;
    b.onclick = () => selectEffect(fx.id);
    grid.appendChild(b);
  });
}

function selectEffect(id) {
  const fx = EFFECT_BY_ID[id];
  if (!fx) return;
  state.effectId = id;
  state.params = defaultParams(fx);
  state.effectState = {};
  if (fx.init) fx.init(state.effectState, state.params, outBuf);

  [...$('fxGrid').children].forEach((b) => b.classList.toggle('on', b.dataset.fx === id));
  $('stageTitle').textContent = fx.name;
  buildParamUI(fx);
  updateMeta();
}

function buildParamUI(fx) {
  const wrap = $('fxParams');
  wrap.innerHTML = '';
  const defs = fx.params || {};
  if (!Object.keys(defs).length) {
    wrap.innerHTML = '<p class="tiny muted">这个效果没有可调参数。</p>';
    return;
  }
  for (const [key, def] of Object.entries(defs)) {
    const label = document.createElement('label');
    label.className = 'mini';
    const span = document.createElement('span');
    span.textContent = def.label;
    label.appendChild(span);

    let input;
    if (def.type === 'range') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = def.min; input.max = def.max; input.value = state.params[key];
      const b = document.createElement('b');
      b.textContent = state.params[key];
      input.oninput = () => {
        state.params[key] = Number(input.value);
        b.textContent = input.value;
        state.effectState = {};
        if (fx.init) fx.init(state.effectState, state.params, outBuf);
        updateMeta();
      };
      label.appendChild(input); label.appendChild(b);
    } else if (def.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = state.params[key];
      input.oninput = () => { state.params[key] = input.value; };
      label.appendChild(input);
    } else if (def.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!state.params[key];
      input.style.flex = 'none';
      input.oninput = () => { state.params[key] = input.checked; };
      label.appendChild(input);
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = state.params[key];
      input.oninput = () => {
        state.params[key] = input.value;
        state.effectState = {};
        if (fx.init) fx.init(state.effectState, state.params, outBuf);
      };
      label.appendChild(input);
    }
    wrap.appendChild(label);
  }
}

function updateMeta() {
  const fx = EFFECT_BY_ID[state.effectId] || { name: state.effectId };
  const bits = (COLOR_MODES[state.colorMode] || {}).bits || 16;
  $('stageMeta').textContent = `${fx.name} · ${state.cols}×${state.rows} · ${bits}bit 色深`;
  $('panelInfo').textContent = `${state.cols} × ${state.rows}`;
}

/* ================= 主循环 ================= */
function loop(now) {
  requestAnimationFrame(loop);
  const dt = state.lastWall ? Math.min(0.1, (now - state.lastWall) / 1000) : 0;
  state.lastWall = now;
  if (!state.paused) state.t += dt;

  const fx = EFFECT_BY_ID[state.effectId];
  if (!fx) return;

  // 1) 取内容：视频逐帧采样 / 图片采样一次 / 拼豆图案
  if (state.rawSource) {
    if (state.contentSource === 'video' && state.videoSampler) {
      state.content = state.videoSampler.sample();
    } else if (state.contentSource === 'image' && !state.content) {
      state.content = sampleRaw();
    }
  }

  // 2) 让效果把内容选出来（有些效果自己生成画面，不用 content）
  const content = pickContentForEffect();

  // 3) 渲染到缓冲
  const t0 = performance.now();
  try {
    fx.render(outBuf, state.t, state.params, state.effectState, content);
  } catch (e) {
    // 单个效果出错不能让整个页面挂掉
    fillBg(outBuf, '#200000');
    console.error('effect render failed', e);
  }

  // 4) 量化 + 上屏
  presentFrame();
  updateStatsThrottled(now);
}

/** 把当前缓冲量化后画到虚拟屏（抽出来是为了导出时能确定性地渲染指定帧） */
function presentFrame() {
  const rgba = quantize(outBuf, state.colorMode, { brightness: state.brightness, gamma: state.gamma });
  display.render(rgba, state.cols, state.rows);
  return rgba;
}

/**
 * 按指定时间渲染一帧（不推进虚拟时间）。
 * 导出一致性、自测、以及"冻结某一帧截图"都靠它 —— 不依赖 rAF 是否在跑。
 */
function renderAt(t) {
  window.__LED_TRACE__ = (window.__LED_TRACE__ || []).concat('enter t=' + t);
  const fx = EFFECT_BY_ID[state.effectId];
  if (!fx) { window.__LED_TRACE__.push('no effect ' + state.effectId); return null; }
  if (state.rawSource && state.contentSource === 'video' && state.videoSampler) {
    state.content = state.videoSampler.sample();
  } else if (state.rawSource && state.contentSource === 'image' && !state.content) {
    state.content = sampleRaw();
  }
  const content = pickContentForEffect();
  window.__LED_TRACE__.push('content=' + (content ? countLit(content) : 'null') + ' fx=' + fx.id);
  const t0 = performance.now();
  try {
    fx.render(outBuf, t, state.params, state.effectState, content);
    window.__LED_TRACE__.push('rendered, outBuf.lit=' + countLit(outBuf));
  } catch (e) {
    window.__LED_TRACE__.push('render threw: ' + e.message);
    console.error('effect render failed', e);
  }
  state.lastFrameMs = performance.now() - t0;
  presentFrame();
  return outBuf;
}

function updateStatsThrottled(now) {
  state.frameCount++;
  // 第一帧就先刷一次统计，别等到半秒后（后台标签页/无头环境里定时器可能被冻住）
  if (state.fpsAt === undefined || now - state.fpsAt > 500) {
    const elapsed = state.fpsAt === undefined ? 0 : now - state.fpsAt;
    const fps = elapsed > 0 ? Math.round((state.frameCount * 1000) / elapsed) : 0;
    state.fps = fps;
    state.frameCount = 0;
    state.fpsAt = now;
    updateStats();
    // 无头/后台标签页里定时器会被停掉，此时别显示 "0 FPS" 这种误导信息
    $('fps').textContent = fps > 0 ? fps + ' FPS' : '-- FPS';
    $('fps').className = 'pill ' + (fps >= 50 ? 'good' : fps >= 25 ? '' : fps > 0 ? 'warn' : '');
    if (fps > 0) {
      $('timeline').value = Math.round((state.t % 10) * 100);
      $('timelineVal').textContent = (state.t % 10).toFixed(1) + 's';
    }
  }
}

/** 哪些效果需要用素材内容 */
function pickContentForEffect() {
  if (!state.content) return null;
  if (state.effectId === 'fullscreen') return state.content;
  if (state.effectId === 'imgScroll') return state.content;
  if (state.effectId === 'scanline') return state.content;
  if (state.effectId === 'breathe') return state.content;
  return null;
}

function updateStats() {
  const n = state.cols * state.rows;
  const frameBytes = n * 2;
  const rle = estimateRLE(outBuf);
  const saved = 100 - (rle / frameBytes) * 100;
  // RLE 对"大片同色"友好，对等离子这种高频噪点画面反而会变大 —— 要如实说
  const rleNote = saved >= 0
    ? `省 ${saved.toFixed(0)}%`
    : `<b style="color:#ffb020">反而大 ${(-saved).toFixed(0)}%</b>（画面太碎，RLE 不适合）`;
  $('stats').innerHTML = [
    `灯珠总数 <b>${n.toLocaleString()}</b>`,
    `原始帧(RGB565) <b>${(frameBytes / 1024).toFixed(2)} KB</b>`,
    `RLE 估算 <b>${(rle / 1024).toFixed(2)} KB</b>（${rleNote}）`,
    `单帧渲染 <b>${(state.lastFrameMs || 0).toFixed(2)} ms</b>`,
    `等效下发带宽 <b>${((frameBytes * (state.fps || 0)) / 1024).toFixed(1)} KB/s</b> @ ${state.fps || 0}FPS`,
  ].join('<br>');
  const fx = EFFECT_BY_ID[state.effectId] || { name: state.effectId };
  $('fxHint').textContent = `${fx.name} · 画面缓冲 ${state.cols}×${state.rows} · 量化 ${state.colorMode}`;
}

/** 快速估算 RLE 后的大小（不真的打包，只统计游程） */
function estimateRLE(buf) {
  let runs = 0;
  let prev = null;
  for (let i = 0; i < buf.n; i++) {
    const key = `${Math.round(buf.data[i * 3] * 31)},${Math.round(buf.data[i * 3 + 1] * 63)},${Math.round(buf.data[i * 3 + 2] * 31)}`;
    if (key !== prev) { runs++; prev = key; }
  }
  return runs * 3;  // 每段约 3 字节（RGB565 2 字节 + 长度 1 字节）
}

/* ================= 素材 ================= */
function sampleRaw() {
  if (!state.rawSource) return null;
  return sourceToBuffer(state.rawSource, state.cols, state.rows, sampleOpts());
}

function sampleOpts() {
  return {
    fit: $('fit').value,
    dither: $('dither').value === '1',
    contrast: Number($('contrast').value) / 100,
    saturation: Number($('saturation').value) / 100,
    threshold: Number($('threshold').value) / 100,
    invert: $('invert').checked,
  };
}

function onImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.rawSource = img;
    state.contentSource = 'image';
    state.videoSampler = null;
    state.content = sampleRaw();
    $('srcInfo').textContent = `图片：${file.name}（${img.naturalWidth}×${img.naturalHeight}）→ 采样 ${state.cols}×${state.rows}`;
    $('srcInfo').classList.add('on');
    $('videoCtrl').hidden = true;
    // 图片自动切到全屏显示，否则看不到
    if (state.effectId !== 'fullscreen' && state.effectId !== 'imgScroll' && state.effectId !== 'scanline') {
      setVideoMode('fullscreen');
    }
    toast('图片已上屏', 'ok');
    URL.revokeObjectURL(url);
  };
  img.onerror = () => toast('这张图片打不开', 'err');
  img.src = url;
}

function onVideoFile(file) {
  if (state.videoEl) { state.videoEl.pause(); state.videoEl.src = ''; }
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  v.onloadedmetadata = () => {
    state.videoEl = v;
    state.rawSource = v;
    state.contentSource = 'video';
    state.videoSampler = new VideoSampler(v, state.cols, state.rows, sampleOpts());
    state.content = state.videoSampler.sample(true);
    $('srcInfo').textContent = `视频：${file.name}（${v.videoWidth}×${v.videoHeight}, ${v.duration.toFixed(1)}s）→ 逐帧采样到 ${state.cols}×${state.rows}`;
    $('srcInfo').classList.add('on');
    $('videoCtrl').hidden = false;
    $('vidMeta').textContent = `${v.videoWidth}×${v.videoHeight} · ${v.duration.toFixed(1)}s`;
    v.play().catch(() => {});
    $('btnVidPlay').textContent = '暂停';
    setVideoMode('fullscreen');
    toast('视频开始上屏播放', 'ok');
  };
  v.onerror = () => toast('这个视频格式浏览器放不了（试试 MP4/H.264）', 'err');
}

function setVideoMode(mode) {
  state.videoMode = mode;
  [...$('videoModeSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.vmode === mode));
  if (!state.rawSource && !state.content) return;
  if (mode === 'fullscreen') selectEffect('fullscreen');
  else if (mode === 'imgScroll') selectEffect('imgScroll');
  else if (mode === 'scanline') selectEffect('scanline');
}

function loadBeadPattern() {
  // 从拼豆工坊借几张图案：两者都是「离散格 + 有限色板」，可以直接互通
  // 路径说明：服务根是工作区根，页面在 /led-studio/ 下，所以 ../../ 就能回到根
  import('../../pixel-bead-studio/js/art.js').then(({ LIBRARY, artToGrid }) => {
    const item = LIBRARY[Math.floor(Math.random() * LIBRARY.length)];
    const grid = artToGrid(item);
    state.content = beadGridToBuffer(grid, state.cols, state.rows);
    state.contentSource = 'bead';
    state.rawSource = null;
    state.videoSampler = null;
    $('srcInfo').textContent = `拼豆图案：「${item.name}」→ 采样 ${state.cols}×${state.rows}（拼豆和点阵本来就是同一件事）`;
    $('srcInfo').classList.add('on');
    $('videoCtrl').hidden = true;
    selectEffect('fullscreen');
    toast('已把拼豆图案投到 LED 屏上', 'ok');
  }).catch((err) => {
    console.warn('拼豆图案库导入失败', err);
    // 兜底：自己画一个，保证按钮永远有反应（不依赖隔壁目录存在）
    state.content = builtinBeadPattern();
    state.contentSource = 'bead';
    state.rawSource = null;
    state.videoSampler = null;
    $('srcInfo').textContent = '内置拼豆图案（没读到隔壁 pixel-bead-studio，用自带图案兜底）';
    $('srcInfo').classList.add('on');
    $('videoCtrl').hidden = true;
    selectEffect('fullscreen');
    toast('已用内置图案上屏', 'ok');
  });
}

/** 兜底图案：一个 12×12 的彩色小方块，证明"拼豆 → LED"这条链能通 */
function builtinBeadPattern() {
  const n = 12;
  const buf = new LedBuffer(state.cols, state.rows);
  const cellX = state.cols / n, cellY = state.rows / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [r, g, b] = hsv(((x + y) / (n * 2)) % 1, 0.85, 1);
      for (let sy = 0; sy < Math.ceil(cellY); sy++) {
        for (let sx = 0; sx < Math.ceil(cellX); sx++) {
          buf.set(Math.floor(x * cellX) + sx, Math.floor(y * cellY) + sy, r, g, b);
        }
      }
    }
  }
  return buf;
}

/* ================= 屏参数 ================= */
function applyPanelSize() {
  const cols = Math.max(8, Math.min(256, parseInt($('cols').value, 10) || 64));
  const rows = Math.max(8, Math.min(128, parseInt($('rows').value, 10) || 64));
  if (cols !== state.cols || rows !== state.rows) {
    state.cols = cols; state.rows = rows;
    outBuf = new LedBuffer(cols, rows);
    if (state.videoSampler) state.videoSampler.resize(cols, rows);
    if (state.rawSource) state.content = sampleRaw();
    state.effectState = {};
    const fx = EFFECT_BY_ID[state.effectId];
    if (fx && fx.init) fx.init(state.effectState, state.params, outBuf);
  }
  $('cols').value = state.cols;
  $('rows').value = state.rows;
  updateMeta();
  [...$('presets').children].forEach((b) =>
    b.classList.toggle('on', b.dataset.panel === `${state.cols}x${state.rows}`));
}

function syncDisplayOpts() {
  display.setOptions({
    ledShape: $('ledShape').value,
    gap: Number($('gap').value) / 100,
    bloom: Number($('bloom').value) / 100,
    scanlines: $('scanlines').checked,
  });
}

/* ================= 导出 ================= */
function toCHeader() {
  // 索引宽度由颜色数决定（见 buffer.js 的 toIndexedFrame）：
  // 照片类素材动辄上千色，写死 1 字节/灯珠会把索引回绕成错色。
  const f = toIndexedFrame(outBuf, { brightness: state.brightness, gamma: state.gamma });
  const colors = f.palette;
  const wide = f.bytesPerIndex === 2;
  const off = wide ? '0xFFFF' : '0xFF';
  const pad = wide ? 4 : 2;
  const lines = [];
  lines.push('/*');
  lines.push(' * LED Studio 导出 · 单帧静态图');
  lines.push(` * 面板 ${state.cols}x${state.rows} | 色深 ${state.colorMode} | ${colors.length} 色`
    + `${f.offCount ? ` | 灭灯 ${f.offCount} 颗` : ''}`);
  lines.push(` * 生成时间 ${new Date().toISOString()}`);
  lines.push(' */');
  lines.push('#ifndef LED_FRAME_H');
  lines.push('#define LED_FRAME_H');
  lines.push('');
  lines.push('#include <stdint.h>');
  lines.push('');
  lines.push(`#define LED_W ${state.cols}`);
  lines.push(`#define LED_H ${state.rows}`);
  lines.push(`#define LED_OFF ${off}`);
  lines.push('');
  lines.push('// RGB565 调色板');
  lines.push(`static const uint16_t led_palette[${Math.max(1, colors.length)}] = {`);
  const pal565 = colors.map((v) => '0x' + v.toString(16).toUpperCase().padStart(4, '0'));
  for (let i = 0; i < pal565.length; i += 10) lines.push('  ' + pal565.slice(i, i + 10).join(', ') + ',');
  if (!pal565.length) lines.push('  0x0000,');
  lines.push('};');
  lines.push('');
  lines.push(`// 索引帧：${f.bytesPerIndex} 字节/灯珠（${wide ? '颜色 > 255，必须用 uint16_t' : '颜色 <= 255'}），${off} = 灭`);
  lines.push(`static const uint${wide ? 16 : 8}_t led_frame[${f.index.length}] = {`);
  for (let y = 0; y < state.rows; y++) {
    const row = [];
    for (let x = 0; x < state.cols; x++) {
      row.push('0x' + f.index[y * state.cols + x].toString(16).toUpperCase().padStart(pad, '0'));
    }
    lines.push('  ' + row.join(', ') + ',');
  }
  lines.push('};');
  lines.push('');
  lines.push('#endif');
  return { text: lines.join('\n'), colors: colors.length, idx: f.index.length, wide };
}

function toRleFrame() {
  const bytes = rleEncode565(outBuf, { brightness: state.brightness, gamma: state.gamma });
  const raw = state.cols * state.rows * 2;
  const hex = [];
  for (let i = 0; i < bytes.length; i += 16) {
    hex.push('  ' + [...bytes.slice(i, i + 16)].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ') + ',');
  }
  return {
    bytes,
    text: [
      '/* RLE 帧：每 3 字节 = [RGB565 高字节, 低字节, 连续颗数(1..255)] */',
      `/* 原始 ${(raw / 1024).toFixed(2)}KB → RLE ${(bytes.length / 1024).toFixed(2)}KB（省 ${(100 - bytes.length / raw * 100).toFixed(0)}%） */`,
      `static const uint8_t led_rle[${bytes.length}] = {`,
      ...hex,
      '};',
    ].join('\n'),
  };
}

function toFrameJSON() {
  const rgba = quantize(outBuf, 'rgb888', { brightness: state.brightness, gamma: state.gamma });
  const rows = [];
  for (let y = 0; y < state.rows; y++) {
    const cols = [];
    for (let x = 0; x < state.cols; x++) {
      const i = (y * state.cols + x) * 4;
      cols.push('#' + [rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase());
    }
    rows.push(cols);
  }
  return JSON.stringify({ format: 'led-studio/frame', cols: state.cols, rows: state.rows, colorMode: state.colorMode, pixels: rows }, null, 1);
}

function recordWebM(seconds = 5) {
  const canvas = $('led');
  if (!canvas.captureStream) { toast('这个浏览器不支持 canvas 录制', 'err'); return; }
  const stream = canvas.captureStream(30);
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) { toast('这个浏览器不支持 WebM 录制', 'err'); return; }
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  state.rec = rec;
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `led-${state.effectId}-${Date.now()}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(`录制完成（${(blob.size / 1024).toFixed(0)}KB）`, 'ok');
    state.rec = null;
  };
  rec.start();
  toast(`开始录制 ${seconds} 秒…`);
  setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, seconds * 1000);
}

function downloadFrames(count = 60) {
  // 逐帧确定性渲染：冻结时间轴，按 1/30 秒步进
  const saved = state.t;
  const gap = 1 / 30;
  let i = 0;
  const step = () => {
    if (i >= count) {
      state.t = saved;
      toast(`已导出 ${count} 帧 PNG（浏览器会逐个下载）`, 'ok');
      return;
    }
    const fx = EFFECT_BY_ID[state.effectId];
    fx.render(outBuf, i * gap, state.params, state.effectState, pickContentForEffect());
    const rgba = quantize(outBuf, state.colorMode, { brightness: state.brightness, gamma: state.gamma });
    display.render(rgba, state.cols, state.rows);
    const a = document.createElement('a');
    a.href = $('led').toDataURL('image/png');
    a.download = `frame_${String(i).padStart(3, '0')}.png`;
    a.click();
    i++;
    setTimeout(step, 120);   // 给浏览器下载留时间
  };
  step();
}

/* ================= UI 绑定 ================= */
function bindUI() {
  $('btnPlay').onclick = () => {
    state.paused = !state.paused;
    $('paused').checked = state.paused;
    $('btnPlay').textContent = state.paused ? '▶ 继续' : '⏸ 暂停';
  };
  $('paused').onchange = (e) => {
    state.paused = e.target.checked;
    $('btnPlay').textContent = state.paused ? '▶ 继续' : '⏸ 暂停';
  };
  $('timeline').oninput = (e) => {
    state.t = Number(e.target.value) / 100;
    $('timelineVal').textContent = state.t.toFixed(1) + 's';
  };
  $('btnShot').onclick = () => {
    const a = document.createElement('a');
    a.href = $('led').toDataURL('image/png');
    a.download = `led-${state.effectId}-${Date.now()}.png`;
    a.click();
    toast('已保存截图', 'ok');
  };

  $('brightness').oninput = (e) => {
    state.brightness = Number(e.target.value) / 100;
    $('brightnessVal').textContent = e.target.value + '%';
  };
  $('gamma').oninput = (e) => {
    state.gamma = Number(e.target.value) / 10;
    $('gammaVal').textContent = state.gamma.toFixed(1);
  };
  $('colorMode').onchange = (e) => { state.colorMode = e.target.value; updateMeta(); };
  $('ledShape').onchange = syncDisplayOpts;
  $('gap').oninput = (e) => { $('gapVal').textContent = e.target.value + '%'; syncDisplayOpts(); };
  $('bloom').oninput = (e) => { $('bloomVal').textContent = e.target.value + '%'; syncDisplayOpts(); };
  $('scanlines').onchange = syncDisplayOpts;

  $('presets').onclick = (e) => {
    const b = e.target.closest('button[data-panel]');
    if (!b) return;
    const [c, r] = b.dataset.panel.split('x').map(Number);
    $('cols').value = c; $('rows').value = r;
    applyPanelSize();
  };
  $('cols').onchange = applyPanelSize;
  $('rows').onchange = applyPanelSize;

  ['contrast', 'saturation', 'threshold'].forEach((id) => {
    $(id).oninput = (e) => {
      const v = Number(e.target.value) / 100;
      $(id + 'Val').textContent = id === 'threshold' ? (v === 0 ? '关' : v.toFixed(2)) : v.toFixed(1);
      if (state.rawSource) state.content = sampleRaw();
      if (state.videoSampler) state.videoSampler.opts = sampleOpts();
    };
  });
  $('fit').onchange = () => { if (state.rawSource) state.content = sampleRaw(); if (state.videoSampler) state.videoSampler.opts = sampleOpts(); };
  $('dither').onchange = () => { if (state.rawSource) state.content = sampleRaw(); if (state.videoSampler) state.videoSampler.opts = sampleOpts(); };
  $('invert').onchange = () => { if (state.rawSource) state.content = sampleRaw(); if (state.videoSampler) state.videoSampler.opts = sampleOpts(); };

  $('btnImg').onclick = () => $('fileImg').click();
  $('btnVid').onclick = () => $('fileVid').click();
  $('btnBead').onclick = loadBeadPattern;
  $('fileImg').onchange = (e) => { if (e.target.files[0]) onImageFile(e.target.files[0]); e.target.value = ''; };
  $('fileVid').onchange = (e) => { if (e.target.files[0]) onVideoFile(e.target.files[0]); e.target.value = ''; };

  $('videoModeSeg').onclick = (e) => {
    const b = e.target.closest('button[data-vmode]');
    if (b) setVideoMode(b.dataset.vmode);
  };
  $('btnVidPlay').onclick = () => {
    const v = state.videoEl;
    if (!v) return;
    if (v.paused) { v.play(); $('btnVidPlay').textContent = '暂停'; }
    else { v.pause(); $('btnVidPlay').textContent = '播放'; }
  };
  $('btnVidLoop').onclick = () => {
    const v = state.videoEl;
    if (!v) return;
    v.loop = !v.loop;
    $('btnVidLoop').textContent = '循环:' + (v.loop ? '开' : '关');
  };
  $('vidVol').oninput = (e) => {
    const v = state.videoEl;
    if (v) { v.muted = Number(e.target.value) === 0; v.volume = Number(e.target.value) / 100; }
  };

  $('quick').onclick = (e) => {
    const b = e.target.closest('button[data-demo]');
    if (b) runDemo(b.dataset.demo);
  };

  // 导出
  $('btnOpenExport').onclick = () => { refreshExport('c'); show('exportModal'); };
  $('exportSeg').onclick = (e) => {
    const b = e.target.closest('button[data-kind]');
    if (b) refreshExport(b.dataset.kind);
  };
  $('btnCloseExport').onclick = () => hide('exportModal');
  $('btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('code').textContent); toast('已复制', 'ok'); }
    catch { toast('复制失败，请手动选择', 'err'); }
  };
  $('btnDownload').onclick = () => {
    if (state.exportKind === 'webm') { recordWebM(5); return; }
    if (state.exportKind === 'frames') { downloadFrames(60); return; }
    const name = { c: 'led_frame.h', bin: 'led_frame.rle', json: 'led_frame.json' }[state.exportKind] || 'led.txt';
    const mime = state.exportKind === 'json' ? 'application/json' : 'text/plain';
    const blob = state.exportKind === 'bin' && state.rleBytes
      ? new Blob([state.rleBytes], { type: 'application/octet-stream' })
      : new Blob([$('code').textContent], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('已下载 ' + name, 'ok');
  };

  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide('exportModal');
    if (e.target.matches && e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
  });

  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => display.render(
    quantize(outBuf, state.colorMode, { brightness: state.brightness, gamma: state.gamma }), state.cols, state.rows), 120); });
}

function refreshExport(kind) {
  state.exportKind = kind;
  [...$('exportSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  const out = $('code');
  const hint = $('exportHint');

  if (kind === 'c') {
    const r = toCHeader();
    out.textContent = r.text;
    hint.textContent = `单帧静态图 · ${r.colors} 色 · 面板 ${state.cols}×${state.rows}`;
  } else if (kind === 'bin') {
    const r = toRleFrame();
    state.rleBytes = r.bytes;
    out.textContent = r.text;
    hint.textContent = `RLE ${(r.bytes.length / 1024).toFixed(2)}KB`;
  } else if (kind === 'json') {
    out.textContent = toFrameJSON().slice(0, 20000) + '\n/* ...截断显示，下载得到完整文件... */';
    hint.textContent = '逐像素 hex，便于前端直接渲染';
  } else if (kind === 'webm') {
    out.textContent = '(WebM 是二进制视频，点「开始录制」)\n\n会录制当前虚拟屏 5 秒，30fps，导出 .webm 文件。';
    hint.textContent = '录制当前效果为视频';
  } else {
    out.textContent = '(帧序列会逐张下载 PNG)\n\n会按 30fps 逐帧确定性地渲染 60 帧，每帧一个 PNG 文件。\n适合拿去合成 GIF / 做逐帧对比。';
    hint.textContent = '导出 60 帧 PNG';
  }
}

/* ================= 一键演示 ================= */
function runDemo(name) {
  if (name === 'welcome') {
    selectEffect('breathe');
    state.params.color = '#00D8FF';
    state.params.text = 'WELCOME';
    state.params.period = 3;
    buildParamUI(EFFECT_BY_ID.breathe);
    $('stageMeta').textContent = '到车欢迎灯效：呼吸 + 中间文字（车外屏最实用的形态）';
  } else if (name === 'typhoon') {
    selectEffect('snow');
    state.params.count = 200;
    state.params.wind = 5;
    buildParamUI(EFFECT_BY_ID.snow);
  } else if (name === 'demo') {
    selectEffect('plasma');
    state.params.speed = 20;
    buildParamUI(EFFECT_BY_ID.plasma);
  } else if (name === 'test') {
    selectEffect('colorBars');
    $('stageMeta').textContent = '彩条 + 灰阶：真机装好第一件事就是放这个验收色深和灰阶';
  } else if (name === 'bars') {
    // 色深对比：同一个画面切不同色深，看得最直观
    selectEffect('rainbow');
    let i = 0;
    const modes = ['rgb888', 'rgb666', 'rgb565', 'rgb332', 'mono'];
    const tick = () => {
      if (i >= modes.length) return;
      state.colorMode = modes[i];
      $('colorMode').value = modes[i];
      updateMeta();
      toast('色深演示：' + COLOR_MODES[modes[i]].name);
      i++;
      setTimeout(tick, 2200);
    };
    tick();
  }
}

function bindDrop() {
  const drop = $('drop');
  const over = (e) => { e.preventDefault(); drop.classList.add('over'); };
  const leave = () => drop.classList.remove('over');
  ['dragenter', 'dragover'].forEach((ev) => {
    drop.addEventListener(ev, over);
    document.addEventListener(ev, (e) => e.preventDefault());
  });
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, leave));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (f.type.startsWith('video/')) onVideoFile(f);
    else if (f.type.startsWith('image/')) onImageFile(f);
    else toast('只支持图片或视频', 'err');
  });
}

let toastTimer = 0;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

try {
  boot();
} catch (e) {
  console.error(e);
  toast('初始化出错：' + e.message, 'err');
}

/**
 * 调试/自测钩子：直接暴露内部缓冲区的真实状态。
 * 为什么需要：从 canvas 像素反推"屏上有没有画面"不可靠 —— 辉光会让整屏都变亮，
 * 测出来永远是"满屏点亮"。要看真东西只能读缓冲。
 */
window.__LED_DEBUG__ = (opts = {}) => {
  // renderAt: 传 seconds 可以确定性地渲染任意时刻的一帧（不依赖 rAF 是否在跑）
  const trace = [];
  if (typeof opts.seconds === 'number') {
    trace.push('renderAt called with ' + opts.seconds);
    renderAt(opts.seconds);
    trace.push('after renderAt: outBuf.lit=' + countLit(outBuf));
  }
  const litOf = (b) => {
    let lit = 0, sum = 0;
    for (let i = 0; i < b.n; i++) {
      const v = b.data[i * 3] + b.data[i * 3 + 1] + b.data[i * 3 + 2];
      if (v > 0.05) lit++;
      sum += v;
    }
    return { lit, sum: Math.round(sum) };
  };
  return {
    booted: true,
    effectId: state.effectId,
    effectName: (EFFECT_BY_ID[state.effectId] || {}).name,
    cols: state.cols,
    rows: state.rows,
    colorMode: state.colorMode,
    hasContent: !!state.content,
    contentSource: state.contentSource,
    content: state.content ? litOf(state.content) : null,
    out: litOf(outBuf),
    fps: state.fps || 0,
    lastFrameMs: state.lastFrameMs || 0,
    paused: state.paused,
    t: state.t,
    videoReady: state.videoEl ? state.videoEl.readyState : -1,
    videoTime: state.videoEl ? state.videoEl.currentTime : -1,
    pickedContent: !!pickContentForEffect(),
    trace,
  };
};

function countLit(b) {
  let lit = 0;
  for (let i = 0; i < b.n; i++) {
    if (b.data[i * 3] + b.data[i * 3 + 1] + b.data[i * 3 + 2] > 0.05) lit++;
  }
  return lit;
}

/** 也直接暴露一个可调用入口：跨 iframe 传对象更可靠（避免 options 对象的 realm 问题） */
window.__LED_RENDER_AT__ = (t) => {
  renderAt(Number(t) || 0);
  return countLit(outBuf);
};
window.__LED_TRACE_GET__ = () => (window.__LED_TRACE__ || []).slice();
