/**
 * LED 驱动效果集
 *
 * 每个效果都是 (buf, t, params) -> void，只写 buf，不做渲染。
 * 这样同一个效果既能实时预览，也能离线逐帧导出成视频/固件帧序列。
 */
import { LedBuffer } from './buffer.js';
import { drawText, renderMarquee, measureText, GLYPH_H } from './font.js';

const TAU = Math.PI * 2;

/** 正模（JS 的 % 对负数返回负值，时间轴回退时会把画面甩到屏外） */
export function mod(a, b) { return ((a % b) + b) % b; }

/* ================= 内置效果 ================= */

/** 滚动文字（点阵屏最经典的效果，也是车外屏最实用的） */
export const marquee = {
  id: 'marquee',
  name: '滚动文字',
  params: {
    text: { type: 'text', label: '文字', value: 'WELCOME TO OUR CAR  ' },
    scale: { type: 'range', label: '字号', min: 1, max: 4, value: 2 },
    speed: { type: 'range', label: '速度(格/秒)', min: 2, max: 60, value: 14 },
    color: { type: 'color', label: '颜色', value: '#FFA300' },
    rainbow: { type: 'bool', label: '彩虹色', value: false },
    bg: { type: 'color', label: '底色', value: '#000000' },
  },
  init(state, p, buf) {
    state.strip = null;
    state.key = '';
  },
  render(buf, t, p, state) {
    const txt = String(p.text || ' ');
    const key = `${txt}|${p.scale}|${p.color}|${p.rainbow}`;
    if (state.key !== key || !state.strip) {
      // 开彩虹时用白色做"遮罩"：颜色由 blitScrolling 按列上色。
      // 否则 color 选成黑色就会把遮罩判空（r+g+b<0.01），彩虹也一起没了。
      const mask = p.rainbow ? [1, 1, 1] : hexToRgb(p.color);
      state.strip = renderMarquee(txt, p.scale, mask, 8);
      // 文字实宽（不含尾部留白）：彩虹一圈正好铺满一条文字，跨屏滚动时不会突然断色
      state.hueCols = Math.max(1, measureText(txt, p.scale));
      state.key = key;
    }
    fillBg(buf, p.bg);
    // 从右边缘滚到完全离开左侧
    const total = state.strip.cols + buf.cols;
    const x0 = Math.round(buf.cols - (mod(t * p.speed, total)));
    blitScrolling(buf, state.strip, x0, Math.floor((buf.rows - state.strip.rows) / 2), p.rainbow, state.hueCols || state.strip.cols);
  },
};

/** 图片/视频内容循环滚动（跑马灯效果，用于长图） */
export const imgScroll = {
  id: 'imgScroll',
  name: '内容横向滚动',
  params: {
    speed: { type: 'range', label: '速度(格/秒)', min: 1, max: 60, value: 10 },
    bg: { type: 'color', label: '底色', value: '#000000' },
  },
  render(buf, t, p, state, content) {
    fillBg(buf, p.bg);
    if (!content) return;
    const off = Math.round(mod(t * p.speed, content.cols + buf.cols));
    const x0 = buf.cols - off;
    for (let y = 0; y < buf.rows; y++) {
      for (let x = 0; x < buf.cols; x++) {
        const sx = x - x0;
        if (sx < 0 || sx >= content.cols) continue;
        const [r, g, b] = content.get(sx, y % content.rows);
        buf.set(x, y, r, g, b);
      }
    }
  },
};

/** 直接铺满：图片/视频按屏尺寸采样后原样显示 */
export const fullscreen = {
  id: 'fullscreen',
  name: '全屏显示（图片/视频）',
  params: {},
  render(buf, t, p, state, content) {
    if (!content) { buf.clear(0, 0, 0); return; }
    buf.copyFrom(content);
  },
};

/** 雪花飘落：粒子系统 + 随机风 */
export const snow = {
  id: 'snow',
  name: '雪花',
  params: {
    count: { type: 'range', label: '雪花数', min: 10, max: 400, value: 120 },
    speed: { type: 'range', label: '下落速度', min: 1, max: 30, value: 8 },
    wind: { type: 'range', label: '风力', min: -10, max: 10, value: 2 },
    color: { type: 'color', label: '颜色', value: '#FFFFFF' },
    bg: { type: 'color', label: '底色', value: '#000820' },
  },
  init(state, p, buf) {
    state.parts = Array.from({ length: p.count }, () => ({
      x: Math.random() * buf.cols,
      y: Math.random() * buf.rows,
      v: 0.6 + Math.random() * 0.8,
      s: Math.random() < 0.25 ? 2 : 1,
      ph: Math.random() * TAU,
    }));
    state.count = p.count;
  },
  render(buf, t, p, state) {
    fillBg(buf, p.bg);
    if (!state.parts || state.count !== p.count) snow.init(state, p, buf);
    const dt = stepDt(state, t);
    const [r, g, b] = hexToRgb(p.color);
    for (const s of state.parts) {
      s.y += s.v * p.speed * dt;
      s.x += (Math.sin(t * 1.3 + s.ph) * 0.6 + p.wind * 0.1) * dt * 3;
      if (s.y >= buf.rows) { s.y = -1; s.x = Math.random() * buf.cols; }
      if (s.x < 0) s.x += buf.cols;
      if (s.x >= buf.cols) s.x -= buf.cols;
      const px = Math.round(s.x), py = Math.round(s.y);
      if (s.s === 2) {
        // 大雪花带一点光晕
        buf.add(px, py, r, g, b);
        buf.add(px + 1, py, r * 0.4, g * 0.4, b * 0.4);
      } else {
        buf.set(px, py, r, g, b);
      }
    }
  },
};

/** 等离子：经典 demo 效果，用来展示色彩深度 */
export const plasma = {
  id: 'plasma',
  name: '等离子',
  params: {
    speed: { type: 'range', label: '速度', min: 0, max: 40, value: 12 },
    scale: { type: 'range', label: '纹理密度', min: 1, max: 12, value: 4 },
  },
  render(buf, t, p) {
    const k = p.scale * 0.35;
    for (let y = 0; y < buf.rows; y++) {
      for (let x = 0; x < buf.cols; x++) {
        const v = Math.sin(x * k + t * p.speed * 0.08)
          + Math.sin(y * k * 1.3 - t * p.speed * 0.06)
          + Math.sin((x + y) * k * 0.7 + t * p.speed * 0.1)
          + Math.sin(Math.hypot(x - buf.cols / 2, y - buf.rows / 2) * k * 0.9 - t * p.speed * 0.12);
        const a = (v / 4) * 0.5 + 0.5;
        buf.set(x, y,
          0.5 + 0.5 * Math.sin(a * TAU),
          0.5 + 0.5 * Math.sin(a * TAU + 2.1),
          0.5 + 0.5 * Math.sin(a * TAU + 4.2));
      }
    }
  },
};

/** 雨/流星斜扫 */
export const rain = {
  id: 'rain',
  name: '流星雨',
  params: {
    count: { type: 'range', label: '数量', min: 5, max: 120, value: 40 },
    speed: { type: 'range', label: '速度', min: 5, max: 80, value: 30 },
    len: { type: 'range', label: '拖尾长度', min: 1, max: 10, value: 4 },
    color: { type: 'color', label: '颜色', value: '#66D9FF' },
    bg: { type: 'color', label: '底色', value: '#000000' },
  },
  init(state, p, buf) {
    state.drops = Array.from({ length: p.count }, () => spawnDrop(buf));
    state.count = p.count;
  },
  render(buf, t, p, state) {
    fillBg(buf, p.bg);
    if (!state.drops || state.count !== p.count) rain.init(state, p, buf);
    const dt = stepDt(state, t);
    const [r, g, b] = hexToRgb(p.color);
    for (const d of state.drops) {
      d.x += d.vx * p.speed * dt;
      d.y += d.vy * p.speed * dt;
      if (d.y >= buf.rows || d.x < -2) Object.assign(d, spawnDrop(buf, true));
      for (let i = 0; i < p.len; i++) {
        const f = 1 - i / p.len;
        buf.add(Math.round(d.x - d.vx * i * 0.6), Math.round(d.y - d.vy * i * 0.6), r * f, g * f, b * f);
      }
    }
  },
};

function spawnDrop(buf, fromTop = false) {
  return {
    x: Math.random() * (buf.cols + 8) - 4,
    y: fromTop ? -Math.random() * 4 : Math.random() * buf.rows,
    vx: -0.6 - Math.random() * 0.5,
    vy: 1.5 + Math.random() * 1.2,
  };
}

/**
 * 粒子效果的时间步长。
 * 必须夹到 [0, 0.1]：时间轴往左拖（或 renderAt 传了更小的 t）时 dt 是负的，
 * 雪花会被"倒着吸"回天上、流星往回飞 —— 拖动时间轴时看得很明显。
 */
function stepDt(state, t) {
  const dt = state.lastT === undefined ? 0 : Math.max(0, Math.min(0.1, t - state.lastT));
  state.lastT = t;
  return dt;
}

/** 横向扫描线（呼吸感的扫掠） */
export const scanline = {
  id: 'scanline',
  name: '扫描线',
  params: {
    speed: { type: 'range', label: '速度', min: 1, max: 60, value: 18 },
    width: { type: 'range', label: '宽度', min: 1, max: 12, value: 4 },
    color: { type: 'color', label: '颜色', value: '#00D8FF' },
    bg: { type: 'color', label: '底色', value: '#000000' },
  },
  render(buf, t, p, state, content) {
    if (content) buf.copyFrom(content); else fillBg(buf, p.bg);
    const [r, g, b] = hexToRgb(p.color);
    const total = buf.rows + p.width * 2;
    const cy = mod(t * p.speed, total) - p.width;
    for (let y = 0; y < buf.rows; y++) {
      const d = Math.abs(y - cy);
      if (d > p.width) continue;
      const a = (1 - d / p.width) ** 2;
      for (let x = 0; x < buf.cols; x++) {
        const [cr, cg, cb] = buf.get(x, y);
        buf.set(x, y, cr + r * a, cg + g * a, cb + b * a);
      }
    }
  },
};

/** 色带测试图：验收屏的色深和灰阶（真实装机第一步就该放这个） */
export const colorBars = {
  id: 'colorBars',
  name: '彩条 / 灰阶测试',
  params: {},
  render(buf) {
    const bars = [
      [1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0],
      [1, 0, 1], [1, 0, 0], [0, 0, 1], [0, 0, 0],
    ];
    const n = bars.length;
    const topH = Math.floor(buf.rows * 0.6);
    for (let y = 0; y < buf.rows; y++) {
      for (let x = 0; x < buf.cols; x++) {
        if (y < topH) {
          // 按比例分配，而不是 "每根 ceil(cols/8) 格再夹到最后一条"。
          // 旧写法在 cols=9/10/20 这类宽度下只会画出 5~7 根，蓝条和黑条直接被吞掉 ——
          // 而这张图就是用来验色深的，少一根条等于验不了。
          const [r, g, b] = bars[Math.min(n - 1, Math.floor((x * n) / buf.cols))];
          buf.set(x, y, r, g, b);
        } else {
          const t = x / Math.max(1, buf.cols - 1);
          buf.set(x, y, t, t, t);
        }
      }
    }
  },
};

/** 彩虹渐变滚动 */
export const rainbow = {
  id: 'rainbow',
  name: '彩虹波',
  params: {
    speed: { type: 'range', label: '速度', min: 0, max: 40, value: 10 },
    freq: { type: 'range', label: '波长', min: 1, max: 20, value: 6 },
  },
  render(buf, t, p) {
    for (let y = 0; y < buf.rows; y++) {
      for (let x = 0; x < buf.cols; x++) {
        const h = ((x / buf.cols) * p.freq + y / buf.rows * 0.5 + t * p.speed * 0.05) % 1;
        const [r, g, b] = hsv(h, 0.9, 1);
        buf.set(x, y, r, g, b);
      }
    }
  },
};

/**
 * 呼吸灯中间文字与底色的最小亮度差。
 * 这个下限是有意义的：原来文字颜色写成 color*b + 0.9*(1-b)，b=1（呼吸到最亮）时
 * 正好等于底色，WELCOME 每个周期都会整个消失一次（实测 Δlum 从 0.427 掉到 0.000）。
 */
export const TEXT_MIN_CONTRAST = 0.25;

/** 心跳/呼吸（车门欢迎灯效最常用） */
export const breathe = {
  id: 'breathe',
  name: '呼吸灯',
  params: {
    period: { type: 'range', label: '周期(秒)', min: 1, max: 10, value: 3 },
    min: { type: 'range', label: '最暗', min: 0, max: 100, value: 5 },
    color: { type: 'color', label: '颜色', value: '#00D8FF' },
    text: { type: 'text', label: '中间文字(可空)', value: '' },
    textScale: { type: 'range', label: '文字字号', min: 1, max: 4, value: 1 },
  },
  render(buf, t, p) {
    const k = (Math.sin((t / p.period) * TAU) * 0.5 + 0.5);
    const b = p.min / 100 + (1 - p.min / 100) * k;
    const [r, g, bl] = hexToRgb(p.color);
    const bgr = r * b, bgg = g * b, bgb = bl * b;
    buf.clear(bgr, bgg, bgb);
    const txt = String(p.text || '').trim();
    if (!txt) return;
    const scale = Math.max(1, Math.round(p.textScale || 1));
    const w = measureText(txt, scale);
    const bgLum = 0.299 * bgr + 0.587 * bgg + 0.114 * bgb;
    // 底色暗 -> 文字偏白；底色已经亮到"再怎么加白也不够对比" -> 改用暗字（反白）
    const lift = 0.70 + 0.24 * (1 - b);
    let tr, tg, tb;
    if ((1 - bgLum) * lift >= TEXT_MIN_CONTRAST) {
      tr = bgr + (1 - bgr) * lift;
      tg = bgg + (1 - bgg) * lift;
      tb = bgb + (1 - bgb) * lift;
    } else {
      const m = 0.45;   // 此时 bgLum >= 0.64，乘 0.45 至少拉开 0.35 的亮度差
      tr = bgr * m; tg = bgg * m; tb = bgb * m;
    }
    drawText(buf, txt, Math.floor((buf.cols - w) / 2), Math.floor((buf.rows - GLYPH_H * scale) / 2),
      scale, [tr, tg, tb]);
  },
};

/* ================= 过渡效果（内容切换时用） ================= */

export const transitions = {
  /** 从黑淡入 */
  fadeIn(progress) { return { type: 'multiply', k: progress }; },
  /** 横向擦除 */
  wipe(progress) { return { type: 'wipe', k: progress }; },
  /** 像素随机点亮（很适合点阵屏） */
  randomDissolve(progress, cols, rows, seed = 1) {
    const mask = new Float32Array(cols * rows);
    for (let i = 0; i < mask.length; i++) {
      const h = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
      mask[i] = h - Math.floor(h);
    }
    return { type: 'mask', k: progress, mask };
  },
};

/** 把过渡应用到一帧上（dst = 目标内容） */
export function applyTransition(buf, dst, tr) {
  if (!tr) { buf.copyFrom(dst); return; }
  if (tr.type === 'multiply') {
    for (let i = 0; i < buf.n; i++) {
      buf.data[i * 3] = dst.data[i * 3] * tr.k;
      buf.data[i * 3 + 1] = dst.data[i * 3 + 1] * tr.k;
      buf.data[i * 3 + 2] = dst.data[i * 3 + 2] * tr.k;
    }
  } else if (tr.type === 'wipe') {
    const edge = Math.round(buf.cols * tr.k);
    for (let y = 0; y < buf.rows; y++) {
      for (let x = 0; x < buf.cols; x++) {
        if (x < edge) {
          const [r, g, b] = dst.get(x, y);
          buf.set(x, y, r, g, b);
        } else {
          buf.set(x, y, 0, 0, 0);
        }
      }
    }
  } else if (tr.type === 'mask') {
    for (let i = 0; i < buf.n; i++) {
      const on = tr.mask[i] < tr.k ? 1 : 0;
      buf.data[i * 3] = dst.data[i * 3] * on;
      buf.data[i * 3 + 1] = dst.data[i * 3 + 1] * on;
      buf.data[i * 3 + 2] = dst.data[i * 3 + 2] * on;
    }
  }
}

/* ================= 工具 ================= */

export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function fillBg(buf, hex) {
  const [r, g, b] = hexToRgb(hex || '#000000');
  buf.clear(r, g, b);
}

export function hsv(h, s, v) {
  // 先把色相绕回 [0,1)：h=1.5 应当等于 0.5（青色），直接算的话 i%6 会落到错误扇区
  const hh = mod(h, 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** 把一条长内容按偏移画进 buf，可选彩虹着色 */
function blitScrolling(buf, strip, x0, y0, rainbowOn, hueCols = strip.cols) {
  for (let sx = 0; sx < strip.cols; sx++) {
    const x = x0 + sx;
    if (x < 0 || x >= buf.cols) continue;
    for (let sy = 0; sy < strip.rows; sy++) {
      const y = y0 + sy;
      if (y < 0 || y >= buf.rows) continue;
      const [r, g, b] = strip.get(sx, sy);
      if (r + g + b < 0.01) continue;
      if (rainbowOn) {
        // 色相只沿 x 走。
        // 原来这里是 ((sx / strip.cols) + sy * 0.02)：字号 2 时一根竖笔画上下就差
        // 0.02*14 = 0.28 圈色相（红→黄绿），笔画自己糊成一条彩带，这就是"彩虹发浑"的来源。
        const [rr, gg, bb] = hsv(mod(sx / hueCols, 1), 0.85, 1);
        buf.set(x, y, rr, gg, bb);
      } else {
        buf.set(x, y, r, g, b);
      }
    }
  }
}

export const EFFECTS = [marquee, fullscreen, imgScroll, plasma, snow, rain, scanline, rainbow, breathe, colorBars];
export const EFFECT_BY_ID = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));

/** 按参数定义生成默认值对象 */
export function defaultParams(effect) {
  const out = {};
  for (const [k, d] of Object.entries(effect.params || {})) out[k] = d.value;
  return out;
}
