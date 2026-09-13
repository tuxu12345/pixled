/**
 * 零依赖 2D 光栅化器
 *
 * 用途：把「几何代码」渲染成像素，再采样成拼豆格子。
 *
 * 为什么自己写：环境里没有 canvas / sharp / pngjs，而 skill 必须自包含。
 * 手写一个"够用"的子集，可控性反而比库更好。
 *
 * 关键设计：**不在这里抗锯齿**。
 * 先按 cell×scale 的高分辨率栅格化（默认 scale=8），再从这块高分辨率图上
 * 采样到 cols×rows —— 平均一格的采样天然就是抗锯齿，而且采样权重可控。
 * 这就是"几何代码 → 拼豆"出图干净的原因。
 */

/** 颜色解析：#RGB / #RRGGBB / #RRGGBBAA / rgb() / rgba() */
export function parseColor(c) {
  if (c == null) return null;
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (s === 'none' || s === 'transparent') return null;

  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    const n = parseInt(h, 16);
    return {
      r: ((n >>> 24) & 255) / 255,
      g: ((n >>> 16) & 255) / 255,
      b: ((n >>> 8) & 255) / 255,
      a: (n & 255) / 255,
    };
  }

  m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,\s/]\s*([\d.%]+))?\s*\)$/i.exec(s);
  if (m) {
    let a = 1;
    if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a };
  }

  // 常用颜色名（够用即可）
  const NAMED = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
    blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
    gray: '#808080', grey: '#808080', cyan: '#00ffff', magenta: '#ff00ff',
    brown: '#8b4513', pink: '#ffc0cb', navy: '#000080', teal: '#008080',
  };
  if (NAMED[s.toLowerCase()]) return parseColor(NAMED[s.toLowerCase()]);
  return null;
}

export class Raster {
  /** @param {number} w  @param {number} h */
  constructor(w, h) {
    this.w = w;
    this.h = h;
    // RGBA float32，0..1，预乘不做（合成时按 source-over 算）
    this.data = new Float32Array(w * h * 4);
  }

  clear(r = 0, g = 0, b = 0, a = 0) {
    for (let i = 0; i < this.w * this.h; i++) {
      this.data[i * 4] = r; this.data[i * 4 + 1] = g;
      this.data[i * 4 + 2] = b; this.data[i * 4 + 3] = a;
    }
    return this;
  }

  /** source-over 合成一个像素 */
  blend(x, y, col, cov = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const alpha = col.a * cov;
    if (alpha <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const na = alpha + d[i + 3] * (1 - alpha);
    if (na <= 0) {
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
      return;
    }
    d[i] = (col.r * alpha + d[i] * d[i + 3] * (1 - alpha)) / na;
    d[i + 1] = (col.g * alpha + d[i + 1] * d[i + 3] * (1 - alpha)) / na;
    d[i + 2] = (col.b * alpha + d[i + 2] * d[i + 3] * (1 - alpha)) / na;
    d[i + 3] = na;
  }

  /**
   * 通用图元绘制：只写一个"覆盖测试"，fill 与 stroke 都基于它。
   * @param {object} o { bbox, contains(px,py), edgeDist(px,py)?, fill, stroke, strokeWidth }
   *   坐标一律是像素空间（调用方负责把用户坐标乘上 scale）
   */
  shape(o) {
    const { bbox, contains, fill, strokeWidth = 0, stroke } = o;
    const x0 = Math.max(0, Math.floor(bbox[0] - strokeWidth - 1));
    const y0 = Math.max(0, Math.floor(bbox[1] - strokeWidth - 1));
    const x1 = Math.min(this.w - 1, Math.ceil(bbox[2] + strokeWidth + 1));
    const y1 = Math.min(this.h - 1, Math.ceil(bbox[3] + strokeWidth + 1));

    if (fill) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (contains(x + 0.5, y + 0.5)) this.blend(x, y, fill);
        }
      }
    }
    if (stroke && strokeWidth > 0) {
      const half = strokeWidth / 2;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = o.edgeDist ? o.edgeDist(x + 0.5, y + 0.5) : null;
          if (d == null) continue;
          if (d <= half) this.blend(x, y, stroke);
        }
      }
    }
    return this;
  }

  /* ---------------- 具体图元 ---------------- */

  circle(cx, cy, r, style = {}) {
    const fill = parseColor(style.fill);
    const stroke = parseColor(style.stroke);
    const sw = style.strokeWidth ?? 1;
    const d = (px, py) => Math.hypot(px - cx, py - cy);
    return this.shape({
      bbox: [cx - r, cy - r, cx + r, cy + r],
      contains: (px, py) => d(px, py) <= r,
      edgeDist: (px, py) => Math.abs(d(px, py) - r),
      fill, stroke, strokeWidth: sw,
    });
  }

  ellipse(cx, cy, rx, ry, style = {}) {
    const fill = parseColor(style.fill);
    const stroke = parseColor(style.stroke);
    const sw = style.strokeWidth ?? 1;
    const f = (px, py) => Math.hypot((px - cx) / rx, (py - cy) / ry);
    // 轮廓距离用近似法：径向归一化差 × 平均半径
    const rAvg = (rx + ry) / 2;
    return this.shape({
      bbox: [cx - rx, cy - ry, cx + rx, cy + ry],
      contains: (px, py) => f(px, py) <= 1,
      edgeDist: (px, py) => Math.abs(f(px, py) - 1) * rAvg,
      fill, stroke, strokeWidth: sw,
    });
  }

  /** 椭圆弧（做轮圈、月牙、眉毛这类曲线用） */
  arc(cx, cy, rx, ry, a0, a1, style = {}) {
    const stroke = parseColor(style.stroke);
    const sw = style.strokeWidth ?? 1;
    if (!stroke) return this;
    // 沿弧线采样成小圆点（够用且不会写错数学）
    const span = a1 - a0;
    const steps = Math.max(8, Math.ceil(Math.abs(span) * Math.max(rx, ry) * 2));
    const half = sw / 2;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + span * (i / steps);
      const px = cx + rx * Math.cos(a), py = cy + ry * Math.sin(a);
      this._dot(px, py, half, stroke);
    }
    return this;
  }

  rect(x, y, w, h, style = {}) {
    const fill = parseColor(style.fill);
    const stroke = parseColor(style.stroke);
    const sw = style.strokeWidth ?? 1;
    const r = Math.min(style.rx ?? 0, w / 2, h / 2);
    const inRect = (px, py) => {
      if (px < x || py < y || px > x + w || py > y + h) return false;
      if (r > 0) {
        const qx = Math.max(x + r, Math.min(x + w - r, px));
        const qy = Math.max(y + r, Math.min(y + h - r, py));
        return Math.hypot(px - qx, py - qy) <= r || (px >= x + r && px <= x + w - r) || (py >= y + r && py <= y + h - r);
      }
      return true;
    };
    const edge = (px, py) => {
      const dx = Math.max(x - px, 0, px - (x + w));
      const dy = Math.max(y - py, 0, py - (y + h));
      const outside = Math.hypot(dx, dy);
      const inside = Math.min(px - x, x + w - px, py - y, y + h - py);
      return Math.max(outside, -inside);
    };
    return this.shape({
      bbox: [x, y, x + w, y + h],
      contains: inRect,
      edgeDist: (px, py) => Math.abs(edge(px, py)),
      fill, stroke, strokeWidth: sw,
    });
  }

  poly(points, style = {}) {
    const fill = parseColor(style.fill);
    const stroke = parseColor(style.stroke);
    const sw = style.strokeWidth ?? 1;
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const distToEdges = (px, py) => {
      let best = Infinity;
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        best = Math.min(best, segDist(px, py, a[0], a[1], b[0], b[1]));
      }
      return best;
    };
    return this.shape({
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      contains: (px, py) => pointInPoly(points, px, py),
      edgeDist: distToEdges,
      fill, stroke, strokeWidth: sw,
    });
  }

  line(x1, y1, x2, y2, style = {}) {
    const stroke = parseColor(style.stroke || style.fill);
    const sw = style.strokeWidth ?? 1;
    if (!stroke) return this;
    const half = sw / 2;
    const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - half - 1));
    const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - half - 1));
    const x1c = Math.min(this.w - 1, Math.ceil(Math.max(x1, x2) + half + 1));
    const y1c = Math.min(this.h - 1, Math.ceil(Math.max(y1, y2) + half + 1));
    for (let y = y0; y <= y1c; y++) {
      for (let x = x0; x <= x1c; x++) {
        if (segDist(x + 0.5, y + 0.5, x1, y1, x2, y2) <= half) this.blend(x, y, stroke);
      }
    }
    return this;
  }

  /** 折线：连续的线段，末端圆头 */
  polyline(points, style = {}) {
    for (let i = 0; i + 1 < points.length; i++) {
      this.line(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], style);
    }
    const stroke = parseColor(style.stroke || style.fill);
    if (stroke && (style.lineCap === 'round' || style.lineCap === undefined)) {
      const half = (style.strokeWidth ?? 1) / 2;
      for (const [px, py] of points) this._dot(px, py, half, stroke);
    }
    return this;
  }

  _dot(cx, cy, r, col) {
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + r + 1));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) this.blend(x, y, col);
      }
    }
    return this;
  }

  /**
   * 高斯式模糊（给辉光用）。用两次 box blur 近似，O(n) 与半径无关。
   */
  blur(radius) {
    if (radius < 1) return this;
    const r = Math.round(radius);
    boxBlur(this, r);
    boxBlur(this, r);
    return this;
  }

  /** 全图亮度缩放（给辉光叠加用） */
  scaleRGB(k) {
    for (let i = 0; i < this.w * this.h; i++) {
      this.data[i * 4] *= k;
      this.data[i * 4 + 1] *= k;
      this.data[i * 4 + 2] *= k;
    }
    return this;
  }

  /** additive 叠加（辉光）：把 other 加到 this 上 */
  addFrom(other, k = 1) {
    const n = Math.min(this.data.length, other.data.length);
    for (let i = 0; i < n; i += 4) {
      this.data[i] = Math.min(1, this.data[i] + other.data[i] * k);
      this.data[i + 1] = Math.min(1, this.data[i + 1] + other.data[i + 1] * k);
      this.data[i + 2] = Math.min(1, this.data[i + 2] + other.data[i + 2] * k);
      this.data[i + 3] = Math.min(1, this.data[i + 3] + other.data[i + 3] * k);
    }
    return this;
  }

  /** 在 (dx,dy) 处贴一张图（简单覆盖，不缩放） */
  drawImage(src, dx, dy) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4;
        const col = { r: src.data[i], g: src.data[i + 1], b: src.data[i + 2], a: src.data[i + 3] };
        this.blend(dx + x, dy + y, col);
      }
    }
    return this;
  }

  toRGBA() {
    const out = new Uint8ClampedArray(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      out[i * 4] = Math.round(this.data[i * 4] * 255);
      out[i * 4 + 1] = Math.round(this.data[i * 4 + 1] * 255);
      out[i * 4 + 2] = Math.round(this.data[i * 4 + 2] * 255);
      out[i * 4 + 3] = Math.round(this.data[i * 4 + 3] * 255);
    }
    return out;
  }

  /**
   * 把高分辨率图采样成 cols×rows 的格子颜色
   * 每格取平均（含 alpha 加权），这就是抗锯齿的来源。
   * @returns {{cols,rows,pixels:Float32Array}} pixels 为 cols*rows*4（r,g,b,a）
   */
  sample(cols, rows) {
    const px = new Float32Array(cols * rows * 4);
    const sx = this.w / cols, sy = this.h / rows;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        const x0 = Math.floor(cx * sx), x1 = Math.min(this.w, Math.ceil((cx + 1) * sx));
        const y0 = Math.floor(cy * sy), y1 = Math.min(this.h, Math.ceil((cy + 1) * sy));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * this.w + x) * 4;
            const al = this.data[i + 3];
            r += this.data[i] * al; g += this.data[i + 1] * al; b += this.data[i + 2] * al;
            a += al; n++;
          }
        }
        const o = (cy * cols + cx) * 4;
        if (a > 1e-6) {
          px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a;
        }
        px[o + 3] = n ? a / n : 0;
      }
    }
    return { cols, rows, pixels: px };
  }
}

/* ---------------- 几何工具 ---------------- */

function pointInPoly(pts, px, py) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function boxBlur(img, r) {
  const { w, h, data } = img;
  const tmp = new Float32Array(data.length);
  const win = r * 2 + 1;
  // 横向
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += data[(y * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 4 + c] = sum / win;
        const add = data[(y * w + Math.min(w - 1, x + r + 1)) * 4 + c];
        const sub = data[(y * w + Math.max(0, x - r)) * 4 + c];
        sum += add - sub;
      }
    }
  }
  // 纵向
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        data[(y * w + x) * 4 + c] = sum / win;
        const add = tmp[(Math.min(h - 1, y + r + 1) * w + x) * 4 + c];
        const sub = tmp[(Math.max(0, y - r) * w + x) * 4 + c];
        sum += add - sub;
      }
    }
  }
}
