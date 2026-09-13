/**
 * 预览渲染：把点阵画成"看起来真的像拼豆"的图
 *
 * 为什么必须有它：agent 生成图案后必须能"看见"，靠 ASCII 点阵是看不出好坏的。
 * 之前做鹈鹕那次的教训就是 —— 盲写几何代码、不渲染，改了 8 版都不对。
 * 有了这个渲染器，才能形成 **生成 → 渲染 → 看图 → 改** 的闭环。
 *
 * 两种观感：
 *   bead  —— 白底拼豆板（珠子留缝、中心有孔、左上高光），像真的摆在拼豆板上
 *   led   —— 黑底发光（加辉光），像点阵屏
 */
import { Raster, parseColor } from './raster.mjs';
import { encodeRGBAPNG } from './png.mjs';
import { hexToRgb } from './palette.mjs';

/**
 * @param {object} grid  quantizeToBeads 的输出 { cols, rows, idx, palette }
 * @param {object} opts
 *   style: 'bead' | 'led'
 *   cellPx: 每格像素（默认 24/32）
 *   gap: 灯珠间隙比例
 *   glow: led 模式的辉光强度 0..1
 *   grid: 是否画浅网格
 *   bg: 底色（覆盖默认）
 *   label: 左上角文字（用内置 5×7 点阵字，便于批量出图时辨认）
 */
export function renderPreview(grid, opts = {}) {
  const {
    style = 'bead',
    gap = 0.16,
    glow = 0.55,
    grid: drawGrid = true,
    bg,
    label = '',
  } = opts;
  const { cols, rows, idx, palette } = grid;
  const cellPx = opts.cellPx || (style === 'led' ? Math.max(4, Math.min(14, Math.floor(900 / Math.max(cols, rows)))) : 22);

  // 标签只支持 ASCII，中文先过滤掉（见 sanitizeLabel 的说明）
  const lbl = sanitizeLabel(label);
  const labelText = lbl.text.trim();
  const labelH = labelText ? Math.ceil(cellPx * 1.4) : 0;
  const W = cols * cellPx;
  const H = rows * cellPx + labelH;

  const defaultBg = style === 'led' ? '#04060a' : '#f2f4f6';
  const bgCol = parseColor(bg || defaultBg);

  const r = new Raster(W, H);
  r.clear(bgCol.r, bgCol.g, bgCol.b, 1);

  const y0 = labelH;
  const inset = cellPx * gap * 0.5;
  const size = cellPx - inset * 2;
  const radius = size / 2;

  // ---- 1) 珠子本体 ----
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = idx[y * cols + x];
      if (v < 0) continue;
      const { r: cr, g: cg, b: cb } = hexToRgb(palette[v]);
      const cr1 = cr / 255, cg1 = cg / 255, cb1 = cb / 255;

      if (style === 'bead') {
        // 珠身：主色
        r.circle(x * cellPx + cellPx / 2, y0 + y * cellPx + cellPx / 2, radius,
          { fill: `rgb(${cr},${cg},${cb})` });
        // 中心孔：同色压暗（不是打透明 —— 打透明会透出底板，整片看起来又脏又糊）
        if (radius >= 2.5) {
          const k = 0.6;
          r.circle(x * cellPx + cellPx / 2, y0 + y * cellPx + cellPx / 2, radius * 0.24,
            { fill: `rgb(${Math.round(cr * k)},${Math.round(cg * k)},${Math.round(cb * k)})` });
        }
        // 左上高光
        if (radius >= 4) {
          r.circle(x * cellPx + cellPx / 2 - radius * 0.32, y0 + y * cellPx + cellPx / 2 - radius * 0.36,
            Math.max(1, radius * 0.24), { fill: 'rgba(255,255,255,0.42)' });
        }
      } else {
        // LED：方形或圆形的灯珠，纯色即可，靠辉光营造发光感
        if (opts.ledShape === 'square') {
          r.rect(x * cellPx + inset, y0 + y * cellPx + inset, size, size,
            { fill: `rgb(${cr},${cg},${cb})` });
        } else {
          r.circle(x * cellPx + cellPx / 2, y0 + y * cellPx + cellPx / 2, radius,
            { fill: `rgb(${cr},${cg},${cb})` });
        }
      }
      void cr1; void cg1; void cb1;
    }
  }

  // ---- 2) 网格线（拼豆板的分隔） ----
  if (drawGrid && style === 'bead' && cellPx >= 10) {
    const lineCol = 'rgba(0,0,0,0.07)';
    for (let x = 0; x <= cols; x++) r.line(x * cellPx, y0, x * cellPx, y0 + rows * cellPx, { stroke: lineCol, strokeWidth: 1 });
    for (let y = 0; y <= rows; y++) r.line(0, y0 + y * cellPx, W, y0 + y * cellPx, { stroke: lineCol, strokeWidth: 1 });
  }

  // ---- 3) LED 辉光 ----
  if (style === 'led' && glow > 0.01 && cellPx >= 3) {
    const bloom = new Raster(W, H);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = idx[y * cols + x];
        if (v < 0) continue;
        const { r: cr, g: cg, b: cb } = hexToRgb(palette[v]);
        // 只让够亮的灯珠产生辉光
        if (cr + cg + cb < 90) continue;
        bloom.circle(x * cellPx + cellPx / 2, y0 + y * cellPx + cellPx / 2, radius + 0.5,
          { fill: `rgb(${cr},${cg},${cb})` });
      }
    }
    bloom.blur(Math.max(2, cellPx * 1.1));
    bloom.scaleRGB(glow);
    r.addFrom(bloom, 1);
  }

  // ---- 4) 标签 ----
  if (labelText) drawLabel(r, labelText, 4, 2, Math.max(1, Math.floor(labelH / 9)));

  return { png: encodeRGBAPNG(W, H, r.toRGBA()), width: W, height: H, cellPx, labelDropped: lbl.dropped };
}

/* ---------------- 内置 5×7 点阵字（只做标签用） ---------------- */

const FONT = {
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e], B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22], D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41], F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a], H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00], J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41], L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e], P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e], R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31], T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f], V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x7f, 0x20, 0x18, 0x20, 0x7f], X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x03, 0x04, 0x78, 0x04, 0x03], Z: [0x61, 0x51, 0x49, 0x45, 0x43],
  0: [0x3e, 0x51, 0x49, 0x45, 0x3e], 1: [0x00, 0x42, 0x7f, 0x40, 0x00],
  2: [0x42, 0x61, 0x51, 0x49, 0x46], 3: [0x21, 0x41, 0x45, 0x4b, 0x31],
  4: [0x18, 0x14, 0x12, 0x7f, 0x10], 5: [0x27, 0x45, 0x45, 0x45, 0x39],
  6: [0x3c, 0x4a, 0x49, 0x49, 0x30], 7: [0x01, 0x71, 0x09, 0x05, 0x03],
  8: [0x36, 0x49, 0x49, 0x49, 0x36], 9: [0x06, 0x49, 0x49, 0x29, 0x1e],
  ' ': [0, 0, 0, 0, 0], '-': [0x08, 0x08, 0x08, 0x08, 0x08],
  '.': [0, 0x60, 0x60, 0, 0], ':': [0, 0x36, 0x36, 0, 0], '/': [0x20, 0x10, 0x08, 0x04, 0x02],
  'x': [0x22, 0x14, 0x08, 0x14, 0x22], '=': [0x14, 0x14, 0x14, 0x14, 0x14],
  '#': [0x14, 0x7f, 0x14, 0x7f, 0x14], '+': [0x08, 0x08, 0x3e, 0x08, 0x08],
};

/**
 * 内置标签字库只有 ASCII（5×7 点阵）。
 * 中文标签会被渲染成一排"缺字方块"，所以这里先过滤掉非 ASCII，
 * 并明确告诉调用方"标签被降级了" —— 否则用户会以为是渲染坏了。
 */
export function sanitizeLabel(label) {
  const ascii = String(label || '').replace(/[^\x20-\x7E]/g, '');
  return { text: ascii, dropped: String(label || '').length - ascii.length };
}

function drawLabel(r, text, x, y, scale) {
  let cx = x;
  const col = { r: 0.35, g: 0.4, b: 0.45, a: 1 };
  for (const ch of String(text)) {
    const g = FONT[ch.toUpperCase()] || FONT['#'];
    for (let c = 0; c < 5; c++) {
      for (let row = 0; row < 7; row++) {
        if (!(g[c] & (1 << row))) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            r.blend(cx + c * scale + sx, y + row * scale + sy, col);
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

/** 终端 ASCII 预览（没有图片查看器时的后备） */
export function asciiPreview(grid, { maxCols = 100 } = {}) {
  const CH = '0123456789abcdefghijklmnopqrstuvwxyz';
  const step = Math.max(1, Math.ceil(grid.cols / maxCols));
  const lines = [];
  for (let y = 0; y < grid.rows; y += step) {
    let s = '';
    for (let x = 0; x < grid.cols; x += step) {
      const v = grid.idx[y * grid.cols + x];
      s += v < 0 ? '·' : (CH[v] || '#');
    }
    lines.push(s);
  }
  return lines.join('\n');
}
