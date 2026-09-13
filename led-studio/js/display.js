/**
 * 虚拟 LED 屏渲染器
 *
 * 真实感来自这几点，缺一个就"不像"：
 *   1. 每颗灯珠是圆形、之间留黑缝（方形贴满会像马赛克而不像 LED）
 *   2. 灯珠中心比边缘亮（做一点径向渐变）
 *   3. 辉光（bloom）：亮的灯珠会把周围照亮，这是 LED 和印刷品最大的观感差别
 *   4. 可选扫描线：真实屏是分组扫描的，PWM 下会有细微条纹
 *
 * 性能：辉光用"缩小→模糊→放大叠加"两遍法，而不是对每颗灯珠开 shadowBlur
 * （后者在 64×64=4096 颗灯珠时会卡死）。
 */

export class LedDisplay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bloom = document.createElement('canvas');
    this.bloomCtx = this.bloom.getContext('2d');
    this.cssW = 0;
    this.cssH = 0;
    this.geom = null;
    this.opts = {
      ledShape: 'round',     // round | square
      gap: 0.18,             // 灯珠间隙比例
      bloom: 0.55,           // 辉光强度 0..1
      scanlines: false,
      glowCenter: true,
    };
  }

  setOptions(o) { Object.assign(this.opts, o); }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssW = w;
    this.canvas.style.width = w + 'px';
    // 高度由调用方按比例设置
  }

  /**
   * @param {Uint8ClampedArray} rgba 量化后的像素（cols*rows*4）
   * @param {number} cols
   * @param {number} rows
   * @param {object} opts { cellPx, transparentBg }
   */
  render(rgba, cols, rows, opts = {}) {
    const { cellPx = null, transparentBg = false } = opts;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    // 计算格子像素大小：优先用给定的，否则按容器宽自适应
    const parent = this.canvas.parentElement;
    const availW = Math.max(120, parent.clientWidth - 2);
    const maxH = Math.max(120, Math.min(window.innerHeight * 0.58, 560));
    let cell = cellPx;
    if (!cell) cell = Math.max(2, Math.floor(Math.min(availW / cols, maxH / rows)));
    const w = cell * cols, h = cell * rows;

    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!transparentBg) {
      // 面板底板：比纯黑略亮一点，才像一块真实的 PCB
      ctx.fillStyle = '#05070a';
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    const shape = this.opts.ledShape;
    const gap = this.opts.gap;
    const inset = cell * gap * 0.5;
    const size = cell - inset * 2;

    // ---- 1) 画灯珠本体 ----
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        if (r + g + b < 6) continue;   // 灭的灯珠不画，保留底板颜色（真实屏就是这样）
        const px = x * cell + inset;
        const py = y * cell + inset;
        const col = `rgb(${r},${g},${b})`;

        if (shape === 'round') {
          const cx = px + size / 2, cy = py + size / 2, rad = size / 2;
          if (this.opts.glowCenter && size >= 3) {
            const grad = ctx.createRadialGradient(
              cx, cy, rad * 0.1, cx, cy, rad,
            );
            grad.addColorStop(0, `rgb(${Math.min(255, r * 1.15 + 20)},${Math.min(255, g * 1.15 + 20)},${Math.min(255, b * 1.15 + 20)})`);
            grad.addColorStop(0.72, col);
            grad.addColorStop(1, `rgb(${r * 0.72},${g * 0.72},${b * 0.72})`);
            ctx.fillStyle = grad;
          } else {
            ctx.fillStyle = col;
          }
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = col;
          ctx.fillRect(px, py, size, size);
        }
      }
    }

    // ---- 2) 辉光：缩小 -> 模糊 -> 放大叠加（两遍法，比逐点 shadowBlur 快几十倍） ----
    if (this.opts.bloom > 0.01 && cell >= 3) {
      const bScale = Math.max(1, Math.floor(cell / 2));
      const bw = cols * bScale, bh = rows * bScale;
      if (this.bloom.width !== bw || this.bloom.height !== bh) {
        this.bloom.width = bw; this.bloom.height = bh;
      }
      const bc = this.bloomCtx;
      bc.setTransform(1, 0, 0, 1, 0, 0);
      bc.clearRect(0, 0, bw, bh);
      const bInset = bScale * gap * 0.5;
      const bSize = bScale - bInset * 2;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4;
          const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
          if (r + g + b < 30) continue;   // 只让够亮的灯珠产生辉光
          bc.fillStyle = `rgb(${r},${g},${b})`;
          if (shape === 'round') {
            bc.beginPath();
            bc.arc(x * bScale + bScale / 2, y * bScale + bScale / 2, bSize / 2 + 0.6, 0, Math.PI * 2);
            bc.fill();
          } else {
            bc.fillRect(x * bScale + bInset, y * bScale + bInset, bSize, bSize);
          }
        }
      }
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, this.opts.bloom);
      ctx.filter = `blur(${Math.max(3, cell * 1.6)}px)`;
      ctx.drawImage(this.bloom, 0, 0, w, h);
      ctx.filter = 'none';
      ctx.restore();
    }

    // ---- 3) 扫描线（可选，模仿真实屏的分组扫描） ----
    if (this.opts.scanlines && cell >= 4) {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = '#000';
      for (let y = 0; y < rows; y += 2) {
        ctx.fillRect(0, y * cell, w, Math.max(1, cell * 0.25));
      }
      ctx.restore();
    }

    this.geom = { cell, w, h, cols, rows };
    return this.geom;
  }

  /** 屏幕坐标 -> 灯珠坐标（给鼠标点击用） */
  hitTest(clientX, clientY) {
    if (!this.geom) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) / this.geom.cell);
    const y = Math.floor((clientY - rect.top) / this.geom.cell);
    if (x < 0 || y < 0 || x >= this.geom.cols || y >= this.geom.rows) return null;
    return { x, y };
  }
}
