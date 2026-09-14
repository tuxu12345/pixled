/**
 * LED 点阵帧缓冲
 *
 * 和拼豆的关系：两者都是「离散格子 + 有限色板」。拼豆的每个格子是一颗塑料豆，
 * LED 屏的每个格子是一颗灯珠。所以拼豆图案可以直接当 LED 帧用，反过来也一样。
 * 区别在颜色：LED 屏的色板是硬件决定的（RGB565 / RGB888 / 单色），
 * 而且要把「亮度」送到屏的 BCM/PWM 上，所以这里用 float 存、渲染时才量化。
 */

export const COLOR_MODES = {
  rgb888: { id: 'rgb888', name: 'RGB888 · 24bit', bits: 24 },
  rgb666: { id: 'rgb666', name: 'RGB666 · 18bit', bits: 18 },
  rgb565: { id: 'rgb565', name: 'RGB565 · 16bit', bits: 16 },
  rgb332: { id: 'rgb332', name: 'RGB332 · 8bit', bits: 8 },
  mono: { id: 'mono', name: '单色 amber · 1bit', bits: 1 },
  mono_blue: { id: 'mono_blue', name: '单色蓝 · 1bit', bits: 1 },
};

export class LedBuffer {
  constructor(cols = 64, rows = 32) {
    this.cols = cols;
    this.rows = rows;
    this.n = cols * rows;
    // 每像素 3 个 float（0..1 线性色）。float 存是为了让亮度/伽马/量化分开做，
    // 一旦提前量化成 8bit 再调亮度就会丢层级。
    this.data = new Float32Array(this.n * 3);
  }

  resize(cols, rows) {
    const next = new LedBuffer(cols, rows);
    // 尽量保留原内容（左上角对齐）
    const w = Math.min(cols, this.cols), h = Math.min(rows, this.rows);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = (y * this.cols + x) * 3, d = (y * cols + x) * 3;
        next.data[d] = this.data[s];
        next.data[d + 1] = this.data[s + 1];
        next.data[d + 2] = this.data[s + 2];
      }
    }
    return next;
  }

  clear(r = 0, g = 0, b = 0) {
    for (let i = 0; i < this.n; i++) {
      this.data[i * 3] = r; this.data[i * 3 + 1] = g; this.data[i * 3 + 2] = b;
    }
    return this;
  }

  /** 0..1 浮点写入 */
  set(x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const i = (y * this.cols + x) * 3;
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b;
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return [0, 0, 0];
    const i = (y * this.cols + x) * 3;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  /** 按 0..1 强度叠加（用于辉光/粒子） */
  add(x, y, r, g, b) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const i = (y * this.cols + x) * 3;
    this.data[i] += r; this.data[i + 1] += g; this.data[i + 2] += b;
  }

  clone() {
    const b = new LedBuffer(this.cols, this.rows);
    b.data.set(this.data);
    return b;
  }

  copyFrom(other) {
    if (other.cols === this.cols && other.rows === this.rows) {
      this.data.set(other.data);
    } else {
      const t = other.resize(this.cols, this.rows);
      this.data.set(t.data);
    }
    return this;
  }
}

/* ================= 颜色量化 ================= */

/** 把 0..1 值按指定位深量化：取最近的量化级，再归一回 0..1 */
function quantizeChannel(v, bits) {
  const x = Math.min(1, Math.max(0, v));
  if (bits >= 8) return x;
  const levels = (1 << bits) - 1;
  return Math.round(x * levels) / levels;
}

/**
 * 量化整个缓冲到目标色彩模式，返回 Uint8Array（RGB888 排列，便于直接画到 canvas）
 * @param {LedBuffer} buf
 * @param {string} modeId
 * @param {object} opts { brightness, gamma }
 */
export function quantize(buf, modeId = 'rgb888', { brightness = 1, gamma = 2.2 } = {}) {
  const mode = COLOR_MODES[modeId] || COLOR_MODES.rgb888;
  const out = new Uint8ClampedArray(buf.n * 4);

  let rb, gb, bb;
  if (mode.id === 'mono' || mode.id === 'mono_blue') { rb = 0; gb = 0; bb = 0; }
  else if (mode.id === 'rgb332') { rb = 3; gb = 3; bb = 2; }
  else if (mode.id === 'rgb565') { rb = 5; gb = 6; bb = 5; }
  else if (mode.id === 'rgb666') { rb = 6; gb = 6; bb = 6; }
  else { rb = 8; gb = 8; bb = 8; }

  for (let i = 0; i < buf.n; i++) {
    let r = buf.data[i * 3], g = buf.data[i * 3 + 1], b = buf.data[i * 3 + 2];

    // ★ 先夹到 [0,1] 再做伽马。
    // add() 是叠加语义，粒子/辉光会把值推到 1 以上；
    // 如果先 pow 再夹，1.25^2.2 = 1.63 被截断到 255，叠加的层次就丢了（踩过）。
    r = r < 0 ? 0 : r > 1 ? 1 : r;
    g = g < 0 ? 0 : g > 1 ? 1 : g;
    b = b < 0 ? 0 : b > 1 ? 1 : b;

    r = Math.pow(r, gamma) * brightness;
    g = Math.pow(g, gamma) * brightness;
    b = Math.pow(b, gamma) * brightness;

    if (mode.id === 'mono' || mode.id === 'mono_blue') {
      // 单色屏：取感知亮度当灰度，再按灯珠颜色上色
      const lum = Math.min(1, 0.299 * r + 0.587 * g + 0.114 * b);
      const on = lum > 0.5 ? Math.min(1, lum) : 0;
      if (mode.id === 'mono') { r = on; g = on * 0.62; b = on * 0.18; }      // amber
      else { r = on * 0.2; g = on * 0.7; b = on; }                            // blue
    } else {
      r = quantizeChannel(r, rb); g = quantizeChannel(g, gb); b = quantizeChannel(b, bb);
    }

    out[i * 4] = r * 255;
    out[i * 4 + 1] = g * 255;
    out[i * 4 + 2] = b * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** 打包成 RGB565 大端字节流（固件下发用） */
export function toRGB565(buf, { brightness = 1, gamma = 2.2 } = {}) {
  const rgba = quantize(buf, 'rgb565', { brightness, gamma });
  const out = new Uint8Array(buf.n * 2);
  for (let i = 0; i < buf.n; i++) {
    const r = rgba[i * 4] >> 3, g = rgba[i * 4 + 1] >> 2, b = rgba[i * 4 + 2] >> 3;
    const v = (r << 11) | (g << 5) | b;
    out[i * 2] = (v >> 8) & 255;
    out[i * 2 + 1] = v & 255;
  }
  return out;
}

/** 三个 8bit 通道 → RGB565 值（各处共用同一套打包规则，避免两处写法漂移） */
export function pack565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/* ================= 导出：索引帧 + RLE ================= */
/*
 * 这两个函数原来埋在 app.js 里（一份算大小、一份真的打包，各写一遍），
 * 结果两边对不上：估算没算 255 的游程上限，纯色画面估算 3 字节、实际 387 字节。
 * 挪到 buffer.js 之后：UI 统计和下载的文件用的是同一个编码器，而且能在 Node 里直接测。
 */

/** 灭灯的索引（调色板里没有这个颜色，单独占一个哨兵值） */
export const PALETTE_OFF = 0xffff;

/**
 * 量化 → 调色板 + 索引帧（固件 C 数组用）
 *
 * ★ 索引宽度必须按颜色数自动选：颜色 > 255 时再写 Uint8Array 会静默回绕（256→0），
 * 导出的帧颜色全错，而头文件里还写着"N 色"。照片类素材很容易超过 255 色。
 */
export function toIndexedFrame(buf, { brightness = 1, gamma = 2.2, mode = 'rgb565' } = {}) {
  const rgba = quantize(buf, mode, { brightness, gamma });
  const lookup = new Map();
  const palette = [];            // RGB565 值
  const index = new Uint32Array(buf.n);
  let offCount = 0;
  for (let i = 0; i < buf.n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (r + g + b === 0) { index[i] = PALETTE_OFF; offCount++; continue; }
    const key = (r << 16) | (g << 8) | b;
    let v = lookup.get(key);
    if (v === undefined) { v = palette.length; lookup.set(key, v); palette.push(pack565(r, g, b)); }
    index[i] = v;
  }
  return {
    rgba, palette, index, offCount,
    bytesPerIndex: palette.length > 255 ? 2 : 1,
    fitsOneByte: palette.length <= 255,
  };
}

/**
 * RLE 编码：每 3 字节 = [RGB565 高字节, 低字节, 连续颗数(1..255)]
 * 游程超过 255 要拆段 —— 这一点是"估算"和"实际"曾经对不上的根源。
 */
export function rleEncode565(buf, { brightness = 1, gamma = 2.2, mode = 'rgb565' } = {}) {
  const rgba = quantize(buf, mode, { brightness, gamma });
  const bytes = [];
  let prev = -1, run = 0;
  const flush = () => { if (prev >= 0) bytes.push((prev >> 8) & 255, prev & 255, run); };
  for (let i = 0; i < buf.n; i++) {
    const v = pack565(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    if (v === prev && run < 255) run++;
    else { flush(); prev = v; run = 1; }
  }
  flush();
  return new Uint8Array(bytes);
}

/** RLE 解码（测试用；固件那边是同一套格式） */
export function rleDecode565(bytes, n) {
  const out = new Uint16Array(n);
  let p = 0;
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 8) | bytes[i + 1];
    const run = bytes[i + 2];
    for (let k = 0; k < run && p < n; k++) out[p++] = v;
  }
  return { values: out, filled: p };
}
