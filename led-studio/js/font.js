/**
 * 5×7 点阵字库 —— 用「笔画定义」生成，不再手抄 # 图案
 *
 * 为什么改写法：之前每个字用 7 行字符串手写，结果 Y 抄错了（第 3 列写成 1111000），
 * 显示成 "BYD" 时 Y 底部糊成一坨、和 D 之间还空了列 —— 而且手抄错误很难靠肉眼发现。
 * 现在改成定义「笔画的起止点」，由程序算出每个格子，这类错误在结构上就不可能发生。
 *
 * 坐标：col 0..4 从左到右，row 0..6 从上到下。
 */

export const GLYPH_W = 5;
export const GLYPH_H = 7;

/** 把一组笔画画进 5×7 的位图（每列一个字节，bit0 = 最上面一行） */
function strokes(lines) {
  const g = new Uint8Array(5);
  const put = (c, r) => { if (c >= 0 && c < 5 && r >= 0 && r < 7) g[c] |= (1 << r); };
  for (const [c0, r0, c1, r1] of lines) {
    const dc = c1 - c0, dr = r1 - r0;
    const steps = Math.max(Math.abs(dc), Math.abs(dr), 1);
    for (let i = 0; i <= steps; i++) {
      put(Math.round(c0 + (dc * i) / steps), Math.round(r0 + (dr * i) / steps));
    }
  }
  return g;
}
/** 单点 */
function dots(list) { return strokes(list.map(([c, r]) => [c, r, c, r])); }

/* 大写字母：统一 7 行高，笔画端点明确 */
const UPPER = {
  A: strokes([[2, 0, 0, 5], [2, 0, 4, 5], [0, 6, 4, 6], [1, 3, 3, 3]]),
  B: strokes([[0, 0, 0, 6], [0, 0, 3, 0], [4, 1, 4, 2], [0, 3, 3, 3], [4, 4, 4, 5], [0, 6, 3, 6]]),
  C: strokes([[4, 0, 1, 0], [0, 1, 0, 5], [1, 6, 4, 6]]),
  D: strokes([[0, 0, 0, 6], [0, 0, 3, 0], [4, 1, 4, 5], [0, 6, 3, 6]]),
  E: strokes([[4, 0, 0, 0], [0, 0, 0, 6], [0, 3, 3, 3], [0, 6, 4, 6]]),
  F: strokes([[4, 0, 0, 0], [0, 0, 0, 6], [0, 3, 3, 3]]),
  G: strokes([[4, 0, 1, 0], [0, 1, 0, 5], [1, 6, 4, 6], [4, 6, 4, 3], [2, 3, 4, 3]]),
  H: strokes([[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]]),
  I: strokes([[1, 0, 3, 0], [2, 0, 2, 6], [1, 6, 3, 6]]),
  J: strokes([[1, 0, 4, 0], [3, 0, 3, 5], [2, 6, 0, 5]]),
  K: strokes([[0, 0, 0, 6], [4, 0, 0, 3], [0, 3, 4, 6]]),
  L: strokes([[0, 0, 0, 6], [0, 6, 4, 6]]),
  M: strokes([[0, 6, 0, 0], [0, 0, 2, 3], [2, 3, 4, 0], [4, 0, 4, 6]]),
  N: strokes([[0, 6, 0, 0], [0, 0, 4, 6], [4, 6, 4, 0]]),
  O: strokes([[1, 0, 3, 0], [0, 1, 0, 5], [1, 6, 3, 6], [4, 1, 4, 5]]),
  P: strokes([[0, 0, 0, 6], [0, 0, 3, 0], [4, 1, 4, 2], [0, 3, 3, 3]]),
  Q: strokes([[1, 0, 3, 0], [0, 1, 0, 5], [1, 6, 3, 6], [4, 1, 4, 5], [2, 4, 4, 6]]),
  R: strokes([[0, 0, 0, 6], [0, 0, 3, 0], [4, 1, 4, 2], [0, 3, 3, 3], [1, 4, 4, 6]]),
  S: strokes([[4, 0, 1, 0], [0, 1, 0, 2], [1, 3, 3, 3], [4, 4, 4, 5], [1, 6, 3, 6]]),
  T: strokes([[0, 0, 4, 0], [2, 0, 2, 6]]),
  U: strokes([[0, 0, 0, 5], [1, 6, 3, 6], [4, 0, 4, 5]]),
  V: strokes([[0, 0, 0, 3], [0, 3, 2, 6], [2, 6, 4, 3], [4, 3, 4, 0]]),
  W: strokes([[0, 0, 0, 5], [0, 5, 1, 6], [1, 6, 2, 3], [2, 3, 3, 6], [3, 6, 4, 5], [4, 5, 4, 0]]),
  X: strokes([[0, 0, 4, 6], [4, 0, 0, 6]]),
  Y: strokes([[0, 0, 2, 3], [4, 0, 2, 3], [2, 3, 2, 6]]),
  Z: strokes([[0, 0, 4, 0], [4, 1, 0, 6], [0, 6, 4, 6]]),
};

/* 数字 */
const DIGITS = {
  0: strokes([[1, 0, 3, 0], [0, 1, 0, 5], [1, 6, 3, 6], [4, 1, 4, 5], [3, 2, 1, 5]]),
  1: strokes([[1, 1, 2, 0], [2, 0, 2, 6], [1, 6, 3, 6]]),
  2: strokes([[1, 0, 3, 0], [4, 1, 4, 2], [3, 3, 1, 3], [0, 4, 0, 5], [0, 6, 4, 6]]),
  3: strokes([[0, 0, 4, 0], [4, 1, 4, 5], [1, 3, 4, 3], [0, 6, 4, 6]]),
  4: strokes([[3, 0, 0, 4], [0, 4, 4, 4], [3, 0, 3, 6]]),
  5: strokes([[4, 0, 0, 0], [0, 0, 0, 3], [0, 3, 3, 3], [4, 4, 4, 5], [1, 6, 3, 6]]),
  6: strokes([[4, 0, 1, 0], [0, 1, 0, 5], [1, 6, 3, 6], [4, 5, 4, 4], [0, 3, 3, 3]]),
  7: strokes([[0, 0, 4, 0], [4, 1, 2, 3], [2, 3, 1, 6]]),
  8: strokes([[1, 0, 3, 0], [0, 1, 0, 2], [4, 1, 4, 2], [1, 3, 3, 3], [0, 4, 0, 5], [4, 4, 4, 5], [1, 6, 3, 6]]),
  9: strokes([[1, 0, 3, 0], [0, 1, 0, 2], [4, 1, 4, 5], [1, 6, 3, 6], [0, 3, 3, 3]]),
};

/* 标点与符号 */
const SYMBOLS = {
  ' ': new Uint8Array(5),
  '.': dots([[2, 6]]),
  ',': strokes([[2, 5, 2, 6], [1, 6, 1, 6]]),
  ':': dots([[2, 2], [2, 5]]),
  ';': strokes([[2, 2, 2, 2], [2, 5, 2, 6], [1, 6, 1, 6]]),
  '!': strokes([[2, 0, 2, 4], [2, 6, 2, 6]]),
  '?': strokes([[0, 1, 1, 0], [2, 0, 4, 1], [4, 2, 2, 4], [2, 6, 2, 6]]),
  '-': strokes([[1, 3, 3, 3]]),
  '_': strokes([[0, 6, 4, 6]]),
  '+': strokes([[2, 1, 2, 5], [0, 3, 4, 3]]),
  '=': strokes([[0, 2, 4, 2], [0, 4, 4, 4]]),
  '*': strokes([[2, 1, 2, 5], [0, 2, 4, 4], [4, 2, 0, 4]]),
  '/': strokes([[4, 0, 0, 6]]),
  '\\': strokes([[0, 0, 4, 6]]),
  '|': strokes([[2, 0, 2, 6]]),
  '(': strokes([[3, 0, 1, 2], [1, 2, 1, 4], [1, 4, 3, 6]]),
  ')': strokes([[1, 0, 3, 2], [3, 2, 3, 4], [3, 4, 1, 6]]),
  '[': strokes([[3, 0, 1, 0], [1, 0, 1, 6], [1, 6, 3, 6]]),
  ']': strokes([[1, 0, 3, 0], [3, 0, 3, 6], [3, 6, 1, 6]]),
  '<': strokes([[3, 0, 1, 3], [1, 3, 3, 6]]),
  '>': strokes([[1, 0, 3, 3], [3, 3, 1, 6]]),
  "'": strokes([[2, 0, 2, 1]]),
  '"': strokes([[1, 0, 1, 1], [3, 0, 3, 1]]),
  '#': strokes([[1, 0, 1, 6], [3, 0, 3, 6], [0, 2, 4, 2], [0, 4, 4, 4]]),
  '%': strokes([[0, 0, 4, 6], [0, 0, 0, 0], [4, 6, 4, 6], [3, 0, 4, 0], [0, 6, 1, 6]]),
  '°': strokes([[1, 0, 3, 0], [0, 1, 0, 1], [3, 1, 3, 1], [0, 1, 3, 1]]),
  '@': strokes([[3, 0, 1, 0], [0, 1, 0, 5], [0, 6, 3, 6], [4, 5, 4, 3], [2, 3, 3, 3]]),
  '&': strokes([[4, 6, 1, 3], [1, 3, 1, 1], [1, 1, 2, 1], [2, 1, 2, 2], [2, 2, 0, 5], [0, 5, 1, 6], [1, 6, 4, 5]]),
  '^': strokes([[0, 2, 2, 0], [2, 0, 4, 2]]),
  '~': strokes([[0, 3, 1, 2], [1, 2, 3, 4], [3, 4, 4, 3]]),
};

const TABLE = { ...UPPER, ...DIGITS, ...SYMBOLS };

/** 缺字兜底：画一个空心方框，一眼能看出是缺字而不是空白 */
const FALLBACK = strokes([[0, 0, 4, 0], [0, 0, 0, 6], [4, 0, 4, 6], [0, 6, 4, 6]]);

/** 全角字符（中文等）占两个字宽 */
export function charWidth(ch) {
  return ch.codePointAt(0) > 0x2e80 ? 2 : 1;
}

export function getGlyph(ch) {
  return TABLE[ch.toUpperCase()] || null;
}

function drawGlyphData(buf, glyph, x, y, scale, rgb) {
  const [r, g, b] = rgb;
  for (let col = 0; col < 5; col++) {
    const bits = glyph[col];
    for (let row = 0; row < 7; row++) {
      if (!(bits & (1 << row))) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          buf.set(x + col * scale + sx, y + row * scale + sy, r, g, b);
        }
      }
    }
  }
}

/**
 * 画一个字符，返回消耗的格宽（含 1 格字距）。
 *
 * ★ 返回的推进量必须乘 scale。
 * 这里原来写的是 `return (wide ? GLYPH_W*2+1 : GLYPH_W) + 1;`（漏了 * scale），
 * 而 measureText() 是乘了 scale 的 —— 两者不一致的后果是：字号 ≥ 2 时
 * 每个字只往前挪 6 格，但字本身有 5*scale 格宽，于是 B、Y、D 全部叠在一起
 * （scale=2 时 "BYD" 的墨迹连成一整段 [0,21]，正确应该是三段 [0,9][12,21][24,33]）。
 * 用户看到的"字号 2 很丑"就是这个叠字，跟字库抄没抄错无关。
 */
export function drawChar(buf, ch, x, y, scale, rgb) {
  const wide = charWidth(ch) === 2;
  const glyph = getGlyph(ch);
  if (glyph) {
    drawGlyphData(buf, glyph, x, y, scale, rgb);
  } else {
    drawGlyphData(buf, FALLBACK, x, y, scale, rgb);
    if (wide) drawGlyphData(buf, FALLBACK, x + (GLYPH_W + 1) * scale, y, scale, rgb);
  }
  return ((wide ? GLYPH_W * 2 + 1 : GLYPH_W) + 1) * scale;
}

/** 测量一段文字占多少格宽 */
export function measureText(text, scale = 1) {
  let w = 0;
  for (const ch of String(text)) w += (charWidth(ch) === 2 ? GLYPH_W * 2 + 1 : GLYPH_W) + 1;
  return w * scale;
}

/** 把文字直接画进缓冲（不滚动） */
export function drawText(buf, text, x, y, scale, rgb) {
  let cx = x;
  for (const ch of String(text)) cx += drawChar(buf, ch, cx, y, scale, rgb);
  return cx;
}

/** 生成滚动文字所需的长条缓冲 */
export function renderMarquee(text, scale, rgb, gapCols = 8) {
  const w = measureText(text, scale) + gapCols * scale;
  const h = GLYPH_H * scale;
  const strip = new LedBuffer(w, h);
  let cx = 0;
  for (const ch of String(text)) cx += drawChar(strip, ch, cx, 0, scale, rgb);
  return strip;
}

/* 需要 LedBuffer，放这里避免顶部循环引用 */
import { LedBuffer } from './buffer.js';

/* ---------------- 自检：字形密度必须在合理范围 ---------------- */
/**
 * 字形自检 —— 手写字库最容易出的问题是"某列抄错导致笔画糊掉"，
 * 密度异常是最灵敏的指标。之前 Y 就是被这类规则抓出来的。
 *
 * 注意：标点、窄符号天生就瘦/矮，不能拿字母的标准去卡它们，
 * 所以按类别给不同的阈值（我第一版没区分，结果满屏误报）。
 */
const PUNCT = new Set([' ', '.', ',', ':', ';', '!', '?', "'", '"', '-', '_', '+', '=', '*', '/', '\\', '|',
  '(', ')', '[', ']', '<', '>', '#', '%', '°', '@', '&', '^', '~']);
const FLAT = new Set(['.', ',', ':', ';', '-', '_', '+', '=', '*', "'", '"', '°', '^', '~', '<', '>']);

export function auditGlyphs() {
  const issues = [];
  for (const [ch, g] of Object.entries(TABLE)) {
    if (ch === ' ') continue;   // 空格本来就该是空的
    const isPunct = PUNCT.has(ch);
    let bits = 0, lastRow = -1;
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 7; r++) {
        if (g[c] & (1 << r)) { bits++; if (r > lastRow) lastRow = r; }
      }
    }
    const d = bits / 35;
    const minD = isPunct ? 0.02 : 0.20;
    const maxD = isPunct ? 0.75 : 0.62;
    if (d < minD) issues.push(`"${ch}" 太瘦（${(d * 100).toFixed(0)}% < ${(minD * 100).toFixed(0)}%），可能有笔画漏了`);
    if (d > maxD) issues.push(`"${ch}" 太糊（${(d * 100).toFixed(0)}% > ${(maxD * 100).toFixed(0)}%），可能有笔画串了`);
    // 高度：字母/数字要用满 7 行；扁平标点豁免
    if (!isPunct && lastRow < 5) issues.push(`"${ch}" 只画到第 ${lastRow + 1} 行，高度明显不足`);
    if (isPunct && !FLAT.has(ch) && lastRow < 3) issues.push(`"${ch}" 只画到第 ${lastRow + 1} 行，位置偏高`);
  }
  return issues;
}
