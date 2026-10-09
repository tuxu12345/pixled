/**
 * 渲染层：
 *  - 编辑器画布（小方块 LED 灯珠质感）
 *  - 🔥 熨烫预览（豆子熔合成圆角方块、粘连、无孔、熔面光泽）
 *  - 车内 LED 屏预览（96×48 点阵）
 *  - PNG 导出（和屏幕同一种质感）
 *
 * 设计约定（重要，别改回去）：
 *  1) 点阵 LED / 拼豆的单元是**矩形**，不是圆豆。原来那种 arc() 圆豆 + 中心孔
 *     看起来像"珠子"，和 96×48 点阵屏以及熨烫后的实物都对不上。
 *  2) roundedRect() 是自己写的 —— 部分 Android WebView / 老 Chrome 没有
 *     ctx.roundRect()，直接调会抛 TypeError，整个渲染就白屏了。
 */
import { hexToRgb, rgbToHex } from './palette.js';

/* ==================================================================
   roundedRect —— 自写圆角矩形路径（ctx.roundRect 的 polyfill）
   ================================================================== */

/**
 * 在当前路径上追加一个圆角矩形子路径（不自动 beginPath）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {number|number[]} r 单个半径，或 [左上, 右上, 右下, 左下]（熨烫粘连要用逐角半径）
 */
export function roundedRect(ctx, x, y, w, h, r = 0) {
  const max = Math.min(w, h) / 2;
  const fix = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : 0;
  };
  const tl = fix(Array.isArray(r) ? r[0] : r);
  const tr = fix(Array.isArray(r) ? r[1] : r);
  const br = fix(Array.isArray(r) ? r[2] : r);
  const bl = fix(Array.isArray(r) ? r[3] : r);

  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  if (tl) ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/**
 * 给没有原生 roundRect 的环境补上（Android WebView 上这一步是保命的）。
 * 返回 true 表示本来就有原生实现。
 */
export function installRoundRectPolyfill() {
  if (typeof CanvasRenderingContext2D === 'undefined') return false;
  const proto = CanvasRenderingContext2D.prototype;
  if (typeof proto.roundRect === 'function') return true;
  proto.roundRect = function (x, y, w, h, r) { roundedRect(this, x, y, w, h, r); return this; };
  return false;
}
installRoundRectPolyfill();

/* ==================================================================
   风格常量
   ================================================================== */

/** 小方块 LED 灯珠：圆角瓷砖 + 上亮下暗渐变 + 左上高光 */
export const LED_STYLE = {
  gap: 0.07,      // 瓷砖之间的缝（占格子比例）
  radius: 0.24,   // 圆角（占瓷砖边长比例）
  top: 0.34,      // 顶部提亮量
  bottom: 0.44,   // 底部压暗量
  gloss: 0.30,    // 左上高光强度
  glossMinCell: 7,// 格子太小时不画高光（会糊）
};

/** 熨烫：豆子熔合 → 圆角方块粘连、无孔、熔面光泽 */
export const IRON_STYLE = {
  radius: 0.17,     // 熔合后的圆角（比 LED 瓷砖略小，看着更"软"）
  innerRadius: 0,   // 相邻同片区域内部转角 = 直角（这就是"粘连、无缝"的来源）
  sheen: 0.20,      // 整片熔面的顶部反光
  shade: 0.18,      // 底部压暗
  dome: 0.11,       // 每颗豆残留的微凸高光（熨过也有，只是很弱）
  edge: 0.34,       // 熔合片的外轮廓描边（暗）
  edgeMinCell: 5,
};

/** 兼容旧参数：bead:false 等价于纯色方块 */
export const BEAD_STYLE = { bead: true, gap: LED_STYLE.gap, radius: LED_STYLE.radius, glowMinCell: 18 };

const STYLES = { led: 'led', iron: 'iron', flat: 'flat' };
export const RENDER_STYLES = STYLES;

function resolveStyle(opts) {
  if (opts.style && STYLES[opts.style]) return opts.style;
  if (opts.bead === false) return 'flat';
  return 'led';
}

/* ==================================================================
   颜色小工具
   ================================================================== */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function lighten(hex, k) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(clamp255(r + (255 - r) * k), clamp255(g + (255 - g) * k), clamp255(b + (255 - b) * k));
}

function darken(hex, k) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(clamp255(r * (1 - k)), clamp255(g * (1 - k)), clamp255(b * (1 - k)));
}

/* ==================================================================
   主绘制
   ================================================================== */

/**
 * 在任意 canvas 2d context 上绘制点阵。
 * @param {object} opts
 *   cell, ox, oy      每个格子的像素尺寸与原点
 *   style             'led'（默认，小方块灯珠）| 'iron'（熨烫）| 'flat'
 *   bead              兼容旧参数：false = 纯方块
 *   showGrid          是否画网格线
 *   bg                底色，null = 透明（棋盘格由外部画）
 *   glow              是否加发光（LED 屏预览用）
 *   brightness        整体明暗倍率
 */
export function drawGrid(ctx, grid, opts = {}) {
  const {
    cell = 24,
    ox = 0, oy = 0,
    bead = true,
    showGrid = true,
    bg = null,
    glow = false,
    brightness = 1,
  } = opts;

  const style = resolveStyle({ ...opts, bead });
  const { cols, rows } = grid;
  const W = cols * cell, H = rows * cell;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(ox, oy, W, H); }

  if (style === 'iron') drawIron(ctx, grid, { cell, ox, oy, brightness, glow });
  else if (style === 'flat') drawFlat(ctx, grid, { cell, ox, oy, brightness, glow });
  else drawLed(ctx, grid, { cell, ox, oy, brightness, glow });

  if (showGrid) {
    // 网格线要克制：格子小的时候线会盖过格子本身
    ctx.strokeStyle = `rgba(255,255,255,${cell >= 16 ? 0.08 : 0.045})`;
    ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath(); ctx.moveTo(ox + x * cell + 0.5, oy); ctx.lineTo(ox + x * cell + 0.5, oy + H); ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath(); ctx.moveTo(ox, oy + y * cell + 0.5); ctx.lineTo(ox + W, oy + y * cell + 0.5); ctx.stroke();
    }
  }
  ctx.restore();
}

/** 整体明暗缩放 */
function scale(hex, k) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(clamp255(r * k), clamp255(g * k), clamp255(b * k));
}

/* ---------------- 小方块 LED 灯珠 ---------------- */

function drawLed(ctx, grid, { cell, ox, oy, brightness = 1, glow = false }) {
  const { cols, rows } = grid;
  const S = LED_STYLE;
  const s = Math.max(1, cell * (1 - S.gap));           // 瓷砖边长
  const off = (cell - s) / 2;
  const rad = s * S.radius;
  const big = cell >= 5;                                // 小格子上做质感只会糊
  const grads = new Map();                              // 每种颜色只建一次渐变

  // 图案库缩略图这种 1-2px 一格的情况：渐变和圆角全是白费，直接铺色
  if (cell < 3) {
    if (brightness !== 1) ctx.globalAlpha = Math.max(0.05, Math.min(1, brightness));
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = grid.get(x, y);
        if (v < 0) continue;
        ctx.fillStyle = grid.palette[v] || '#000000';
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    }
    if (brightness !== 1) ctx.globalAlpha = 1;
    return;
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const raw = grid.get(x, y);
      if (raw < 0) continue;
      const hex = grid.palette[raw] || '#000000';
      const useGlow = glow && cell >= 18;

      let g = grads.get(hex);
      if (!g) {
        g = ctx.createLinearGradient(0, 0, 0, s);
        g.addColorStop(0, lighten(hex, S.top * 0.9));
        g.addColorStop(0.46, hex);
        g.addColorStop(1, darken(hex, S.bottom * 0.85));
        grads.set(hex, g);
      }

      const px = ox + x * cell + off;
      const py = oy + y * cell + off;

      ctx.save();
      ctx.translate(px, py);
      if (brightness !== 1) ctx.globalAlpha = Math.max(0.05, Math.min(1, brightness));

      if (useGlow) { ctx.shadowColor = hex; ctx.shadowBlur = cell * 0.42; }
      ctx.fillStyle = g;
      ctx.beginPath();
      roundedRect(ctx, 0, 0, s, s, rad);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (big) {
        // 左上高光：一条短促的斜向反光，比圆点更像"灯珠"
        ctx.fillStyle = `rgba(255,255,255,${S.gloss})`;
        ctx.beginPath();
        roundedRect(ctx, s * 0.15, s * 0.13, s * 0.44, s * 0.19, s * 0.095);
        ctx.fill();
        // 底部一道更暗的收边，强化"上亮下暗"
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.beginPath();
        roundedRect(ctx, s * 0.14, s * 0.80, s * 0.72, s * 0.10, s * 0.05);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}

/* ---------------- 熨烫：熔合成片 ---------------- */

/**
 * 熨烫的观感来自三件事：
 *   1. 相邻的豆子**粘连** —— 逐角圆角：只要某个角的两条正交邻居都有豆，
 *      这个角就是直角，于是整片区域融成一个连续外形（这才是"熨过"的样子）
 *   2. **无孔** —— 不画中心孔
 *   3. **熔面光泽** —— 整片区域统一打一层上亮下暗的反光，加每颗豆残留的微凸高光
 */
function drawIron(ctx, grid, { cell, ox, oy, brightness = 1, glow = false }) {
  const { cols, rows } = grid;
  const S = IRON_STYLE;
  const full = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && grid.get(x, y) >= 0;

  // 1) 先量出实际有豆的范围，光泽只铺这一块（不然小图案上反光是断的）
  let x0 = cols, y0 = rows, x1 = -1, y1 = -1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!full(x, y)) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return;

  const rad = cell * S.radius;
  const bboxX = ox + x0 * cell, bboxY = oy + y0 * cell;
  const bboxW = (x1 - x0 + 1) * cell, bboxH = (y1 - y0 + 1) * cell;

  // 2) 把整片熔合区域做成一条路径（后面同时用于 clip 和描边）
  ctx.beginPath();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!full(x, y)) continue;
      const rtl = (full(x - 1, y) && full(x, y - 1)) ? S.innerRadius : rad;
      const rtr = (full(x + 1, y) && full(x, y - 1)) ? S.innerRadius : rad;
      const rbr = (full(x + 1, y) && full(x, y + 1)) ? S.innerRadius : rad;
      const rbl = (full(x - 1, y) && full(x, y + 1)) ? S.innerRadius : rad;
      roundedRect(ctx, ox + x * cell, oy + y * cell, cell, cell, [rtl, rtr, rbr, rbl]);
    }
  }

  ctx.save();
  ctx.clip();

  // 3) 底色：一格一个纯色方块（相邻同色自然连成片）
  if (brightness !== 1) ctx.globalAlpha = Math.max(0.05, Math.min(1, brightness));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = grid.get(x, y);
      if (v < 0) continue;
      ctx.fillStyle = grid.palette[v] || '#000000';
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }
  ctx.globalAlpha = 1;

  // 4) 熔面光泽：一整片统一的纵向反光（不是每格一套，那样会变成横条纹）
  if (cell >= 3) {
    const sheen = ctx.createLinearGradient(0, bboxY, 0, bboxY + bboxH);
    sheen.addColorStop(0, `rgba(255,255,255,${S.sheen})`);
    sheen.addColorStop(0.26, 'rgba(255,255,255,0.05)');
    sheen.addColorStop(0.62, 'rgba(0,0,0,0)');
    sheen.addColorStop(1, `rgba(0,0,0,${S.shade})`);
    ctx.fillStyle = sheen;
    ctx.fillRect(bboxX, bboxY, bboxW, bboxH);
  }

  // 5) 每颗豆残留的微凸高光（熨过也在，只是很弱）—— 这是"熨烫过"和"塑料板"的区别
  if (cell >= 9) {
    ctx.fillStyle = `rgba(255,255,255,${S.dome})`;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!full(x, y)) continue;
        const px = ox + x * cell, py = oy + y * cell;
        ctx.beginPath();
        roundedRect(ctx, px + cell * 0.26, py + cell * 0.18, cell * 0.44, cell * 0.30, cell * 0.15);
        ctx.fill();
      }
    }
  }
  ctx.restore();

  // 6) 外轮廓：熨过的片子边缘会有一圈压暗的圆角，让它从棋盘底上"立"起来
  if (cell >= IRON_STYLE.edgeMinCell) {
    ctx.strokeStyle = `rgba(0,0,0,${S.edge})`;
    ctx.lineWidth = Math.max(1, cell * 0.07);
    ctx.stroke();
  }
}

/* ---------------- 纯色方块（图案库缩略图等） ---------------- */

function drawFlat(ctx, grid, { cell, ox, oy, brightness = 1, glow = false }) {
  const { cols, rows } = grid;
  const s = Math.max(1, cell * (1 - LED_STYLE.gap));
  const off = (cell - s) / 2;
  if (brightness !== 1) ctx.globalAlpha = Math.max(0.05, Math.min(1, brightness));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = grid.get(x, y);
      if (v < 0) continue;
      const hex = grid.palette[v] || '#000000';
      if (glow && cell >= 18) { ctx.shadowColor = hex; ctx.shadowBlur = cell * 0.4; }
      ctx.fillStyle = hex;
      ctx.fillRect(ox + x * cell + off, oy + y * cell + off, s, s);
      ctx.shadowBlur = 0;
    }
  }
  if (brightness !== 1) ctx.globalAlpha = 1;
}

/* ==================================================================
   画布 / 导出
   ================================================================== */

/** 棋盘格透明底（对比度压低，别抢主体的视觉） */
export function drawChecker(ctx, w, h, x0 = 0, y0 = 0, size = 12) {
  ctx.fillStyle = '#171c22';
  ctx.fillRect(x0, y0, w, h);
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      if (((x / size) + (y / size)) % 2 !== 0) continue;
      ctx.fillStyle = '#1b2128';
      ctx.fillRect(x0 + x, y0 + y, Math.min(size, w - x), Math.min(size, h - y));
    }
  }
}

/** 把点阵画到指定 canvas，自动缩放铺满（等比、居中） */
export function paintGridToCanvas(canvas, grid, opts = {}) {
  const { bead = true, showGrid = true, checker = true, glow = false, padding = 0, brightness = 1, style } = opts;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const availW = cssW - padding * 2;
  const availH = cssH - padding * 2;
  const cell = Math.max(1, Math.floor(Math.min(availW / grid.cols, availH / grid.rows)));
  const w = cell * grid.cols, h = cell * grid.rows;
  const ox = padding + Math.floor((availW - w) / 2);
  const oy = padding + Math.floor((availH - h) / 2);

  if (checker) drawChecker(ctx, w, h, ox, oy, Math.max(24, cell * 2));
  drawGrid(ctx, grid, { cell, ox, oy, bead, showGrid, glow, brightness, style });
  return { cell, ox, oy, w, h };
}

/**
 * 导出 PNG（可指定放大倍数与质感）
 * style: 'led'（默认灯珠）| 'iron'（熨烫，和屏幕所见完全一致）| 'flat'
 */
export function exportPNG(grid, { scale = 24, bead = true, transparent = true, style } = {}) {
  const pad = 0;
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols * scale + pad * 2;
  canvas.height = grid.rows * scale + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!transparent) { ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  drawGrid(ctx, grid, { cell: scale, ox: pad, oy: pad, bead, showGrid: false, style });
  return canvas.toDataURL('image/png');
}

/** 生成一份「拼豆摆盘图」：豆子按色号分堆 + 数量标注（对应真实手作准备） */
export function exportBeadPlan(grid, { scale = 18 } = {}) {
  const stat = grid.counts();
  const items = [];
  grid.palette.forEach((hex, i) => { if (stat.counts[i]) items.push({ hex, n: stat.counts[i], i }); });
  items.sort((a, b) => b.n - a.n);

  const cols = Math.min(8, Math.max(1, items.length));
  const rows = Math.ceil(items.length / cols);
  const swatch = scale * 4;
  const cellW = swatch + scale * 6;
  const cellH = swatch + scale * 2;

  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW + scale;
  canvas.height = rows * cellH + scale * 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#e6f7ff';
  ctx.font = `${scale * 1.2}px ui-monospace, monospace`;
  ctx.fillText(`豆子清单 · 共 ${stat.filled} 颗 · ${items.length} 色`, scale, scale * 1.6);

  items.forEach((it, k) => {
    const cx = scale + (k % cols) * cellW;
    const cy = scale * 3 + Math.floor(k / cols) * cellH;
    const g = { cols: 1, rows: 1, palette: [it.hex], grid: Int8Array.from([0]), get: () => 0 };
    drawGrid(ctx, g, { cell: swatch, ox: cx, oy: cy, bead: true, showGrid: false });
    ctx.fillStyle = '#cbd5e1';
    ctx.font = `${scale * 0.9}px ui-monospace, monospace`;
    ctx.fillText(`${it.hex}`, cx + swatch + scale * 0.4, cy + swatch * 0.45);
    ctx.fillStyle = '#67e8f9';
    ctx.font = `bold ${scale * 1.1}px ui-monospace, monospace`;
    ctx.fillText(`×${it.n}`, cx + swatch + scale * 0.4, cy + swatch * 0.95);
  });
  return canvas.toDataURL('image/png');
}

/** 亮度/对比处理：模拟 LED 面板的实际观感 */
export function ledPreviewFrame(grid, brightness = 1) {
  return { grid, brightness };
}
