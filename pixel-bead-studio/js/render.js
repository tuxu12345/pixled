/**
 * 渲染层：
 *  - 编辑器画布（带网格、拼豆质感）
 *  - 车内 LED 屏预览（96×48 点阵，模拟 HUB75 面板的发光质感）
 *  - PNG 导出
 */
import { hexToRgb, luminance, rgbToHex } from './palette.js';

export const BEAD_STYLE = {
  bead: true,        // 画成圆形豆子（带孔）
  gap: 0.12,         // 豆子间缝隙比例
  holeRatio: 0.22,   // 中心孔
  glowMinCell: 18,   // 只有格子足够大才开发光，否则会糊成一片
};

/**
 * 在任意 canvas 2d context 上绘制点阵
 */
export function drawGrid(ctx, grid, opts = {}) {
  const {
    cell = 24,
    ox = 0, oy = 0,
    bead = true,
    showGrid = true,
    bg = null,            // 背景色，null = 透明（棋盘格在外部画）
    glow = false,         // LED 发光质感
    brightness = 1,
  } = opts;

  const { cols, rows } = grid;
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  if (bg) { ctx.fillStyle = bg; ctx.fillRect(ox, oy, cols * cell, rows * cell); }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = grid.get(x, y);
      if (v < 0) continue;
      const hex = grid.palette[v] || '#000000';
      const { r, g, b } = hexToRgb(hex);
      const cx = ox + x * cell + cell / 2;
      const cy = oy + y * cell + cell / 2;
      const rad = (cell / 2) * (1 - BEAD_STYLE.gap);
      const col = rgbToHex(r * brightness, g * brightness, b * brightness);
      // 发光只在格子够大时开：小格子上 shadowBlur 会互相糊成一片，看起来像脏点
      const useGlow = glow && cell >= BEAD_STYLE.glowMinCell;

      if (useGlow) {
        ctx.shadowColor = col;
        ctx.shadowBlur = cell * 0.45;
      }
      ctx.fillStyle = col;

      if (bead) {
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        // 中心孔：做成"同色更暗"而不是透明。
        // 之前用 destination-out 打透明孔，结果从每个豆子里透出背景棋盘格，整片糊掉。
        if (rad >= 3) {
          const dim = rgbToHex(r * brightness * 0.62, g * brightness * 0.62, b * brightness * 0.62);
          ctx.fillStyle = dim;
          ctx.beginPath();
          ctx.arc(cx, cy, rad * BEAD_STYLE.holeRatio, 0, Math.PI * 2);
          ctx.fill();
        }
        // 高光（左上角一点）
        if (rad >= 4) {
          ctx.fillStyle = `rgba(255,255,255,${0.22 * brightness})`;
          ctx.beginPath();
          ctx.arc(cx - rad * 0.32, cy - rad * 0.36, Math.max(1, rad * 0.26), 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        const s = cell * (1 - BEAD_STYLE.gap);
        ctx.fillRect(ox + x * cell + (cell - s) / 2, oy + y * cell + (cell - s) / 2, s, s);
        ctx.shadowBlur = 0;
      }
    }
  }

  if (showGrid) {
    // 网格线要克制：格子小的时候线会盖过豆子本身
    ctx.strokeStyle = `rgba(255,255,255,${cell >= 16 ? 0.08 : 0.045})`;
    ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath(); ctx.moveTo(ox + x * cell + 0.5, oy); ctx.lineTo(ox + x * cell + 0.5, oy + rows * cell); ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath(); ctx.moveTo(ox, oy + y * cell + 0.5); ctx.lineTo(ox + cols * cell, oy + y * cell + 0.5); ctx.stroke();
    }
  }
  ctx.restore();
}

/** 棋盘格透明底（对比度压低，别抢豆子的视觉） */
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
  const { bead = true, showGrid = true, checker = true, glow = false, padding = 0, brightness = 1 } = opts;
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
  drawGrid(ctx, grid, { cell, ox, oy, bead, showGrid, glow, brightness });
  return { cell, ox, oy, w, h };
}

/** 导出 PNG（可指定放大倍数与是否带豆孔质感） */
export function exportPNG(grid, { scale = 24, bead = true, transparent = true } = {}) {
  const pad = 0;
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols * scale + pad * 2;
  canvas.height = grid.rows * scale + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!transparent) { ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  drawGrid(ctx, grid, { cell: scale, ox: pad, oy: pad, bead, showGrid: false });
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
