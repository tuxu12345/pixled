/**
 * 素材 → 点阵帧 的转换管线
 *
 * 核心只有一步：把任意尺寸的图/视频帧缩放采样到 cols×rows 的格子上。
 * 但"怎么采样"决定了观感，所以这里做了三种模式 + 有序抖动：
 *   - cover   ：等比铺满、裁掉溢出（最常用，主体够大）
 *   - contain ：等比装进去、留黑边（不裁内容）
 *   - stretch ：拉伸铺满（会变形，但适合做抽象动画素材）
 *
 * 抖动（dither）很重要：LED 屏色深只有 5~6 bit/通道，
 * 直接把渐变量化会出现明显色带（banding），加 Bayer 抖动能显著改善。
 */
import { LedBuffer } from './buffer.js';

/** 4×4 Bayer 有序抖动矩阵（值域 0..15） */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

let _scratch = null;
function scratch(w, h) {
  if (!_scratch) _scratch = document.createElement('canvas');
  if (_scratch.width !== w || _scratch.height !== h) {
    _scratch.width = w;
    _scratch.height = h;
  }
  return _scratch;
}

/**
 * 把任意可绘制源（Image / Video / Canvas）转成 LedBuffer
 * @param {CanvasImageSource} source
 * @param {number} cols
 * @param {number} rows
 * @param {object} opts { fit:'cover'|'contain'|'stretch', dither:boolean, brightness, contrast, saturation, invert }
 */
export function sourceToBuffer(source, cols, rows, opts = {}) {
  const {
    fit = 'cover', dither = true,
    brightness = 1, contrast = 1, saturation = 1,
    invert = false, threshold = 0,
  } = opts;

  const sw = source.videoWidth || source.naturalWidth || source.width || cols;
  const sh = source.videoHeight || source.naturalHeight || source.height || rows;

  const cv = scratch(cols, rows);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, cols, rows);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (fit === 'stretch') {
    ctx.drawImage(source, 0, 0, sw, sh, 0, 0, cols, rows);
  } else {
    const scale = fit === 'cover' ? Math.max(cols / sw, rows / sh) : Math.min(cols / sw, rows / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(source, 0, 0, sw, sh, (cols - dw) / 2, (rows - dh) / 2, dw, dh);
  }

  const px = ctx.getImageData(0, 0, cols, rows).data;
  const buf = new LedBuffer(cols, rows);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      let r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;

      // 对比度：以 0.5 为中心拉伸
      if (contrast !== 1) {
        r = (r - 0.5) * contrast + 0.5;
        g = (g - 0.5) * contrast + 0.5;
        b = (b - 0.5) * contrast + 0.5;
      }
      // 饱和度
      if (saturation !== 1) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = lum + (r - lum) * saturation;
        g = lum + (g - lum) * saturation;
        b = lum + (b - lum) * saturation;
      }
      if (brightness !== 1) { r *= brightness; g *= brightness; b *= brightness; }
      if (invert) { r = 1 - r; g = 1 - g; b = 1 - b; }

      // 抖动：把量化误差用有序噪声摊开，避免色带
      if (dither) {
        const t = (BAYER4[y & 3][x & 3] / 16 - 0.5) / 24;   // ±约 2% 的扰动
        r += t; g += t; b += t;
      }

      // 阈值（做单色/高反差风格时用）
      if (threshold > 0) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const on = lum >= threshold ? 1 : 0;
        r = on; g = on; b = on;
      }

      buf.set(x, y, clamp01(r), clamp01(g), clamp01(b));
    }
  }
  return buf;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 视频播放器：按 requestAnimationFrame 逐帧抓当前画面转点阵
 * （不预解码：视频可能很长，逐帧抓才不会被内存吃掉）
 */
export class VideoSampler {
  constructor(videoEl, cols, rows, opts = {}) {
    this.video = videoEl;
    this.cols = cols;
    this.rows = rows;
    this.opts = opts;
    this.lastTime = -1;
    this.lastBuf = null;
  }

  /** 只在视频确实有新帧时才重新采样，省掉重复计算 */
  sample(force = false) {
    const t = this.video.currentTime;
    if (!force && t === this.lastTime && this.lastBuf) return this.lastBuf;
    this.lastTime = t;
    this.lastBuf = sourceToBuffer(this.video, this.cols, this.rows, this.opts);
    return this.lastBuf;
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.lastTime = -1;
  }
}

/** 拼豆图案 → LED 帧（两者本来就是同一件事：离散格 + 有限色板） */
export function beadGridToBuffer(grid, cols, rows, { transparentAsBlack = true } = {}) {
  const buf = new LedBuffer(cols, rows);
  const sx = grid.cols / cols, sy = grid.rows / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = grid.get(Math.floor(x * sx), Math.floor(y * sy));
      if (v < 0) {
        if (transparentAsBlack) buf.set(x, y, 0, 0, 0);
        continue;
      }
      const hex = grid.palette[v] || '#000000';
      const n = parseInt(hex.slice(1), 16);
      buf.set(x, y, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    }
  }
  return buf;
}
