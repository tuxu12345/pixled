/**
 * 点阵数据模型：{ cols, rows, palette: [hex], grid: [Int8 | -1] }
 * 与 AI 输出的「字符串行 + 索引字符」结构互转，并做健壮性校正。
 */

export class PixelGrid {
  constructor(cols = 20, rows = 20) {
    this.cols = cols;
    this.rows = rows;
    this.palette = [];
    this.grid = new Int8Array(cols * rows).fill(-1);
  }

  static create(cols, rows, palette = []) {
    const g = new PixelGrid(cols, rows);
    g.palette = palette.slice(0, 127);
    return g;
  }

  clone() {
    const g = new PixelGrid(this.cols, this.rows);
    g.palette = this.palette.slice();
    g.grid = Int8Array.from(this.grid);
    return g;
  }

  idx(x, y) { return y * this.cols + x; }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return -1;
    return this.grid[y * this.cols + x];
  }

  set(x, y, v) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    this.grid[y * this.cols + x] = v;
  }

  /** 增删颜色：返回该颜色在调色板中的索引 */
  ensureColor(hex) {
    const i = this.palette.findIndex((c) => c.toUpperCase() === hex.toUpperCase());
    if (i >= 0) return i;
    if (this.palette.length >= 127) return 0;
    this.palette.push(hex.toUpperCase());
    return this.palette.length - 1;
  }

  /** 统计每种颜色的豆子数量 */
  counts() {
    const c = new Array(this.palette.length).fill(0);
    let filled = 0;
    for (const v of this.grid) { if (v >= 0) { c[v] = (c[v] || 0) + 1; filled++; } }
    return { counts: c, filled, colors: c.filter((n) => n > 0).length };
  }

  /** 单色字符编码：0-9a-z 表示索引，'.' 表示空 —— 让模型少写 token */
  static CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

  toRowStrings() {
    const out = [];
    for (let y = 0; y < this.rows; y++) {
      let s = '';
      for (let x = 0; x < this.cols; x++) {
        const v = this.get(x, y);
        s += v < 0 ? '.' : PixelGrid.CHARS[v] || '.';
      }
      out.push(s);
    }
    return out;
  }

  resize(cols, rows) {
    const g = new PixelGrid(cols, rows);
    g.palette = this.palette.slice();
    const ox = Math.floor((cols - this.cols) / 2);
    const oy = Math.floor((rows - this.rows) / 2);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const v = this.get(x, y);
        if (v >= 0) g.set(x + ox, y + oy, v);
      }
    }
    return g;
  }

  trimTransparent() {
    let x0 = this.cols, y0 = this.rows, x1 = -1, y1 = -1;
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (this.get(x, y) >= 0) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return this.clone();
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const g = PixelGrid.create(w, h, this.palette);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.set(x, y, this.get(x + x0, y + y0));
    return g;
  }

  /** 水平镜像（"左右对称"约束的自动修复手段） */
  mirrorX() {
    const g = this.clone();
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.cols; x++)
        g.set(this.cols - 1 - x, y, this.get(x, y));
    return g;
  }

  /** 强制左右对称：取左半边与右半边的"多数票" */
  symmetrize() {
    const g = this.clone();
    const half = Math.floor(this.cols / 2);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < half; x++) {
        const a = this.get(x, y);
        const b = this.get(this.cols - 1 - x, y);
        const pick = a < 0 ? b : b < 0 ? a : a;
        g.set(x, y, pick);
        g.set(this.cols - 1 - x, y, pick);
      }
    }
    return g;
  }

  /** 给实心主体加一圈描边（拼豆作品的典型视觉） */
  addOutline(colorIndex = -2) {
    const g = this.clone();
    const outline = colorIndex >= 0 ? colorIndex : (() => {
      // 自动找一个深色，没有就补一个
      let best = -1, bestL = 2;
      this.palette.forEach((c, i) => {
        const l = (0.299 * parseInt(c.slice(1, 3), 16) + 0.587 * parseInt(c.slice(3, 5), 16) + 0.114 * parseInt(c.slice(5, 7), 16)) / 255;
        if (l < bestL) { bestL = l; best = i; }
      });
      return best >= 0 && bestL < 0.45 ? best : g.ensureColor('#3E2A20');
    })();
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (this.get(x, y) >= 0) continue;
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => this.get(x + dx, y + dy) >= 0);
        if (near) g.set(x, y, outline);
      }
    }
    return g;
  }

  /** 压缩连续同色 -> 适合 MCU 传输的 RLE */
  toRLE() {
    const out = [];
    let cur = this.grid[0], run = 0;
    for (let i = 0; i < this.grid.length; i++) {
      const v = this.grid[i];
      if (v === cur) { run++; } else { out.push([v + 1, run]); cur = v; run = 1; }
    }
    out.push([cur + 1, run]);
    return out;
  }
}

/**
 * 把任意来源（AI / 文件）的松散对象规整成合法 PixelGrid。
 * 这是「AI 不可靠输出」与「稳定渲染」之间的关键防线。
 */
export function normalizeGrid(raw, { cols, rows, fallbackPalette = [] } = {}) {
  const notes = [];
  const W = cols || clampInt(raw?.cols, 8, 96, 20);
  const H = rows || clampInt(raw?.rows, 8, 96, 20);

  // 1) 调色板
  let palette = [];
  if (Array.isArray(raw?.palette)) {
    for (const p of raw.palette) {
      const hex = typeof p === 'string' ? p : (p?.hex || p?.color || null);
      const n = hex ? normalizeHexLoose(hex) : null;
      if (n) palette.push(n);
      if (palette.length >= 36) break;
    }
  }
  if (!palette.length) { palette = fallbackPalette.slice(0, 12); notes.push('AI 未给调色板，已用兜底色卡'); }

  // 2) 网格：支持 ['0123..', ...] / [[0,1,2], ...] / ["#ff0000", ...]
  let rowsRaw = raw?.grid;
  if (typeof rowsRaw === 'string') rowsRaw = rowsRaw.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(rowsRaw)) { rowsRaw = []; notes.push('AI 未给 grid，已生成空画布'); }

  // 把字符/数字/颜色统一成索引
  const idxOf = (cell) => {
    if (cell === null || cell === undefined) return -1;
    if (typeof cell === 'number') return Number.isFinite(cell) ? cell | 0 : -1;
    if (typeof cell === 'string') {
      const s = cell.trim();
      if (!s || s === '.' || s === '-' || s === '_' || s.toLowerCase() === 'null' || s.toLowerCase() === 'transparent') return -1;
      const ci = PixelGrid.CHARS.indexOf(s.toLowerCase());
      if (s.length === 1 && ci >= 0) return ci;
      const hex = normalizeHexLoose(s);
      if (hex) return palette.findIndex((c) => c.toUpperCase() === hex.toUpperCase());
      const n = parseInt(s, 10);
      if (Number.isFinite(n)) return n;
    }
    return -1;
  };

  const cells = (row) => {
    if (typeof row === 'string') return row.trim().split('');
    if (Array.isArray(row)) return row;
    return [];
  };

  const src = rowsRaw.map(cells);
  const out = PixelGrid.create(W, H, palette);
  const offX = Math.floor((W - (src[0]?.length || 0)) / 2);
  const offY = Math.floor((H - src.length) / 2);
  for (let y = 0; y < src.length; y++) {
    for (let x = 0; x < src[y].length; x++) {
      const v = idxOf(src[y][x]);
      if (v >= 0 && v < palette.length) out.set(x + offX, y + offY, v);
    }
  }
  if (src.length && (src.length !== H || src[0].length !== W)) {
    notes.push(`AI 给的画布是 ${src[0].length}×${src.length}，已自动适配到 ${W}×${H}`);
  }
  out.palette = palette;
  return { grid: out, notes };
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function normalizeHexLoose(v) {
  let s = String(v).trim().toLowerCase();
  const m = s.match(/#?([0-9a-f]{6}|[0-9a-f]{3})/);
  if (!m) return null;
  s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return '#' + s.toUpperCase();
}

/** 从可能夹带 markdown / 前后废话的文本里抠出 JSON 对象 */
export function extractJson(text) {
  if (!text) return null;
  const t = String(text).replace(/```json/gi, '```').trim();
  const fenced = t.match(/```([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { /* 继续用修复手段 */ }
  try {
    return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'));
  } catch { return null; }
}
