/**
 * 「几何代码绘图」引擎
 *
 * 这是三条生成路径里最强的一条：把画面用几何图元描述出来，高分辨率栅格化后
 * 采样成拼豆格子。适合结构复杂的画面（自行车、机器、logo、有透视的东西）——
 * 手写字符画根本画不出那些细长结构。
 *
 * 配套用法见 SKILL.md 的「路径 B」。
 */
import { Raster, parseColor } from './raster.mjs';
import { quantizeToBeads, addOutline, rgbToHex } from './palette.mjs';

/**
 * 建一个画布。所有用户坐标都在 [0,w]×[0,h] 空间里，内部自动乘 scale。
 * @param {object} o { w, h, scale, background }
 */
export function canvas({ w, h, scale = 8, background = null }) {
  const W = Math.round(w * scale);
  const H = Math.round(h * scale);
  const r = new Raster(W, H);
  if (background) {
    const c = parseColor(background);
    r.clear(c.r, c.g, c.b, c.a);
  }

  const S = (v) => v * scale;
  const api = {
    raster: r,
    w, h, scale,

    /* ---- 图元（坐标是逻辑坐标 0..w / 0..h） ---- */

    /** 圆：cx,cy 是圆心，rad 是半径 */
    circle(cx, cy, rad, style = {}) {
      return r.circle(S(cx), S(cy), S(rad), scaleStyle(style, scale)), api;
    },

    /** 椭圆 */
    ellipse(cx, cy, rx, ry, style = {}) {
      return r.ellipse(S(cx), S(cy), S(rx), S(ry), scaleStyle(style, scale)), api;
    },

    /** 圆弧：a0/a1 单位是度，0° 指向右，顺时针为正（屏幕坐标 y 向下） */
    arc(cx, cy, rx, ry, a0, a1, style = {}) {
      return r.arc(S(cx), S(cy), S(rx), S(ry), (a0 * Math.PI) / 180, (a1 * Math.PI) / 180, scaleStyle(style, scale)), api;
    },

    /** 矩形；style.rx 给圆角 */
    rect(x, y, rw, rh, style = {}) {
      return r.rect(S(x), S(y), S(rw), S(rh), scaleStyle(style, scale)), api;
    },

    /** 多边形：[ [x,y], ... ]，自动闭合 */
    poly(points, style = {}) {
      return r.poly(points.map(([x, y]) => [S(x), S(y)]), scaleStyle(style, scale)), api;
    },

    /** 直线 */
    line(x1, y1, x2, y2, style = {}) {
      return r.line(S(x1), S(y1), S(x2), S(y2), scaleStyle(style, scale)), api;
    },

    /** 折线（不自动闭合） */
    path(points, style = {}) {
      return r.polyline(points.map(([x, y]) => [S(x), S(y)]), scaleStyle(style, scale)), api;
    },

    /** 梯形/胶囊等常用形状的快捷方式：沿 A→B 画一条粗线（带圆头） */
    capsule(x1, y1, x2, y2, thickness, style = {}) {
      return r.line(S(x1), S(y1), S(x2), S(y2), scaleStyle({ ...style, strokeWidth: thickness }, scale)), api;
    },

    /* ---- 格子对齐辅助（拼豆是格子的，有些形状按格画更整齐） ---- */

    /** 把逻辑坐标吸附到最近的格中心（用于"一格一只眼睛"这种精确控制） */
    cell(cx, cy) {
      return [cx + 0.5, cy + 0.5];
    },

    /** 画一个占满 n×m 格的方块（格子坐标） */
    cellRect(gx, gy, gw, gh, style = {}) {
      return api.rect(gx, gy, gw, gh, style);
    },

    /** 画一个占 n 格直径的圆（格子坐标中心） */
    cellCircle(gx, gy, n, style = {}) {
      return api.circle(gx + n / 2, gy + n / 2, n / 2, style);
    },

    /* ---- 混合：把别的 raster 贴进来 ---- */
    drawImage(srcRaster, dx, dy) {
      r.drawImage(srcRaster, Math.round(S(dx)), Math.round(S(dy)));
      return api;
    },

    /** 图片外框（便于检查构图是否超出画布） */
    debugBounds(color = '#ff00ff') {
      return r.rect(0, 0, W - 1, H - 1, { stroke: color, strokeWidth: 1 }), api;
    },
  };

  return api;
}

function scaleStyle(style, scale) {
  const out = { ...style };
  if (style.strokeWidth != null) out.strokeWidth = style.strokeWidth * scale;
  if (style.rx != null) out.rx = style.rx * scale;
  return out;
}

/* ---------------- 采样 + 落色 ---------------- */

/**
 * 把画布采样成拼豆格子并落色
 * @param {object} cvs  canvas() 的返回值
 * @param {object} opts {
 *   cols, rows,              目标格子数
 *   palette: 'hama_standard', 色卡
 *   maxColors, dither, outline, alphaThreshold, transparent
 * }
 */
export function toBeads(cvs, opts = {}) {
  const {
    cols, rows,
    palette = 'hama_standard',
    maxColors = 0,
    dither = true,
    outline = false,
    outlineColor = null,
    alphaThreshold = 0.5,
    transparent = true,
  } = opts;
  if (!cols || !rows) throw new Error('toBeads 需要 cols 和 rows');
  const sampled = cvs.raster.sample(cols, rows);
  let bead = quantizeToBeads(sampled, palette, { maxColors, dither, alphaThreshold, transparent });
  if (outline || outlineColor) {
    // 描边要画在"透明的轮廓格"上，否则没地方落笔。
    // 底填了色（比如整片天空）时轮廓格是实的，描边就无处可画 —— 这是设计上的取舍：
    // 想要描边就让主体周围留透明。
    bead = addOutline(bead, outlineColor ? { color: outlineColor } : {});
  }
  return bead;
}

/* ---------------- 颜色工具（写图时好用） ---------------- */

export function hsl(h, s, l) {
  // h: 0..360, s/l: 0..1
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** 两个颜色之间插值，t 0..1 */
export function mix(hexA, hexB, t) {
  const A = parseColor(hexA), B = parseColor(hexB);
  const lerp = (a, b) => a + (b - a) * t;
  return rgbToHex(lerp(A.r, B.r, t) * 255, lerp(A.g, B.g, t) * 255, lerp(A.b, B.b, t) * 255);
}

/** 压暗 / 提亮 */
export function shade(hex, k) {
  const c = parseColor(hex);
  const f = (v) => Math.max(0, Math.min(255, v * 255 * k));
  return rgbToHex(f(c.r), f(c.g), f(c.b));
}
