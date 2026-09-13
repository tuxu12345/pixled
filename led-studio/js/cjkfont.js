/**
 * 中文（CJK）字形栅格化
 *
 * 为什么不能用现成字库：LED Studio 原有的 5×7 点阵字库是手写笔画生成的，
 * 只覆盖 ASCII（95 个字形）。中日韩汉字有 2 万+，不可能手写点阵。
 *
 * 零依赖前提下唯一可行的路：**用浏览器自带的系统中文字体实时栅格化**。
 *   1. 用离屏 canvas 的 fillText 画字
 *   2. 读像素，按覆盖率阈值转成 1-bit 点阵
 *   3. 按 (字, 像素高, 字体) 缓存 —— 同一个字反复画只栅格化一次
 *
 * 好处：覆盖全 Unicode、不用打包字体文件、不增加依赖。
 * 代价：字形依赖用户机器上的字体（同 Windows 上都是雅黑，跨平台会有差异）。
 *
 * 注意：中文笔画多，**16px 以下会糊**（横竖笔画会粘连）。
 * 所以这里给了一个"最小可读高度"的概念，太小时会提示用户换大尺寸屏幕或缩小字号。
 */

/** 优先使用的中文字体栈（按覆盖率和观感排序） */
const CJK_FONT_STACK = [
  '"Microsoft YaHei"', '"PingFang SC"', '"Hiragino Sans GB"', '"Noto Sans CJK SC"',
  '"Source Han Sans SC"', '"WenQuanYi Micro Hei"', '"SimHei"', '"Heiti SC"',
  'sans-serif',
].join(',');

/** 缓存：key = `${font}\u0000${size}\u0000${ch}` */
const cache = new Map();

/** 复用的离屏 canvas（避免每个字都建一个） */
let off = null;
let ctxBroken = false;

/**
 * 能不能栅格化？
 * 无头环境（Node）没有 document；浏览器里也可能因为 canvas 被禁用而拿不到 context。
 * 拿不到就降级成"画占位框"，这样不会让整个应用崩掉 —— 而且 Node 侧的字库测试
 * 也不用为了跑通去模拟整个 DOM。
 */
function canRasterize() {
  if (ctxBroken) return false;
  if (typeof document === 'undefined') return false;
  try {
    if (!off) {
      off = document.createElement('canvas');
      off.width = 256; off.height = 256;
    }
    return !!off.getContext('2d');
  } catch { ctxBroken = true; return false; }
}

/** 降级：画一个空心方框，明确表示"这个字渲染不出来" */
function fallbackGlyph(size) {
  const s = Math.max(4, Math.round(size));
  const bits = new Uint8Array(s * s);
  for (let i = 0; i < s; i++) {
    bits[i] = 1; bits[(s - 1) * s + i] = 1;
    bits[i * s] = 1; bits[i * s + s - 1] = 1;
  }
  // 墨迹就是整个方框，所以 w/h = s，绘制时 1 像素 = 1 格
  return { w: s, h: s, bits, advance: s, ink: true };
}

function getCtx() {
  if (!canRasterize()) return null;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, off.width, off.height);
  return ctx;
}

/**
 * 判断是不是需要走中文渲染的字符。
 * ASCII / 拉丁扩展 / 常用符号仍交给原来的 5×7 点阵字库（更锐利、更省空间）。
 */
export function isWideChar(ch) {
  const cp = ch.codePointAt(0);
  // CJK 统一表意文字、扩展区、兼容区、假名、谚文、全角形式
  return (cp >= 0x1100 && cp <= 0x11ff) ||   // 谚文字母
    (cp >= 0x2e80 && cp <= 0x2fdf) ||        // CJK 部首
    (cp >= 0x3000 && cp <= 0x303f) ||        // CJK 标点
    (cp >= 0x3040 && cp <= 0x30ff) ||        // 平假名 / 片假名
    (cp >= 0x3100 && cp <= 0x312f) ||        // 注音
    (cp >= 0x3130 && cp <= 0x318f) ||        // 谚文兼容
    (cp >= 0x3400 && cp <= 0x4dbf) ||        // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) ||        // CJK 基本区
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||        // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) ||        // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) ||        // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xffef) ||        // 全角形式
    (cp >= 0x20000 && cp <= 0x2ffff);        // 扩展 B~
}

/**
 * 栅格化一个字符。
 * @param {string} ch   单个字符
 * @param {number} px   目标像素高度（字号）
 * @param {object} opts { threshold 覆盖率阈值 0..1, font 字体栈, bold }
 * @returns {{w, h, bits: Uint8Array, advance: number, ink: boolean}}
 *          bits 是按行存的 0/1，长度 w*h
 */
export function rasterizeChar(ch, px, opts = {}) {
  const {
    threshold = 0.42,
    font = CJK_FONT_STACK,
    bold = false,
  } = opts;

  const size = Math.max(4, Math.round(px));
  const key = `${font}\u0000${size}\u0000${bold ? 'b' : 'n'}\u0000${ch}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const ctx = getCtx();
  if (!ctx) {
    // 无头 / canvas 不可用 → 降级成占位框
    const fb = fallbackGlyph(size);
    cache.set(key, fb);
    return fb;
  }

  ctx.font = `${bold ? 'bold ' : ''}${size}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';

  // 先量宽度（用单个汉字的 advance，比"画出来量墨迹"稳）
  const adv = ctx.measureText(ch).width;
  const boxW = Math.min(off.width, Math.max(4, Math.ceil(adv) + 4));
  const boxH = Math.min(off.height, size + Math.ceil(size * 0.5) + 4);
  const originY = Math.ceil(size * 1.15);   // 让上下都留出空间

  ctx.clearRect(0, 0, off.width, off.height);
  ctx.fillText(ch, 2, originY);

  // 读回像素，转 1-bit
  const img = ctx.getImageData(0, 0, boxW, boxH).data;
  const bits = new Uint8Array(boxW * boxH);
  let minX = boxW, maxX = -1, minY = boxH, maxY = -1;
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      const a = img[(y * boxW + x) * 4 + 3] / 255;
      if (a >= threshold) {
        bits[y * boxW + x] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  let result;
  if (maxX < 0) {
    // 全空白（空格、某些标点）—— 保留 advance，没有墨迹
    result = { w: 0, h: 0, bits: new Uint8Array(0), advance: Math.max(2, Math.round(adv)), ink: false };
  } else {
    // 裁到墨迹范围，省内存也让排版更紧
    const cw = maxX - minX + 1, chh = maxY - minY + 1;
    const crop = new Uint8Array(cw * chh);
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) crop[y * cw + x] = bits[(y + minY) * boxW + (x + minX)];
    }
    result = { w: cw, h: chh, bits: crop, advance: Math.max(2, Math.round(adv)), ink: true };
  }
  cache.set(key, result);
  return result;
}

/** 量一段文字的像素宽度 */
export function measureCjkText(text, px, opts = {}) {
  let total = 0;
  for (const ch of String(text)) {
    if (isWideChar(ch)) {
      total += rasterizeChar(ch, px, opts).advance;
    } else {
      total += Math.round(px * 0.6);   // 拉丁字符按等宽估算
    }
  }
  return total;
}

/**
 * 检查一个像素高度下中文是否可读。
 * 中文笔画密，太小的字号会糊成黑块 —— 这个检查用来给用户明确提示，
 * 而不是让他对着一团黑猜哪里出了问题。
 */
export function readabilityWarning(px) {
  if (px < 10) return `中文在 ${px}px 下会糊成一团（横竖笔画粘连），建议至少 12px，最好 16px 以上`;
  if (px < 12) return `中文在 ${px}px 下笔画容易粘连，建议再大一点`;
  if (px < 16) return null;   // 12~15px 可用，只是不算锐利
  return null;
}

/** 清缓存（换字体时用） */
export function clearCjkCache() { cache.clear(); }

/** 缓存统计，测试和调试用 */
export function cjkCacheStats() { return { size: cache.size, canvas: off ? `${off.width}x${off.height}` : null }; }

/** 让调用方知道用的是哪套字体栈 */
export function cjkFontStack() { return CJK_FONT_STACK; }
