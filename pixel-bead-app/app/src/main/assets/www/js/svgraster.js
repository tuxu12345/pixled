/**
 * SVG 光栅化 -> 拼豆点阵
 *
 * 为什么需要它：语义分镜路径只会画椭圆/矩形/三角，遇到"骑自行车的鹈鹕"这种
 * 有结构、有细长线条（车架、辐条、嘴）的画面就崩成色块。
 * 换成「用 SVG 把画面画准 → 按格取样」就能得到像素级可控的成品，
 * 再落色到真实豆色卡，就能直接拼、直接上屏。
 */
import { PixelGrid } from './grid.js';
import { nearestColor } from './palette.js';

/** 解析 #RGB / #RRGGBB / rgb() */
function parseColor(c) {
  if (!c || c === 'none' || c === 'transparent') return null;
  let m = /^#([0-9a-f]{3})$/i.exec(c.trim());
  if (m) return '#' + m[1].split('').map((x) => x + x).join('').toUpperCase();
  m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (m) return '#' + m[1].toUpperCase();
  m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(c);
  if (m) {
    const h = (v) => Math.round(+v).toString(16).padStart(2, '0');
    return ('#' + h(m[1]) + h(m[2]) + h(m[3])).toUpperCase();
  }
  return null;
}

const NUM = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?';
const RE = {
  circle: new RegExp(`<circle\\b([^>]*)/?>`, 'g'),
  ellipse: new RegExp(`<ellipse\\b([^>]*)/?>`, 'g'),
  rect: new RegExp(`<rect\\b([^>]*)/?>`, 'g'),
  line: new RegExp(`<line\\b([^>]*)/?>`, 'g'),
  polyline: new RegExp(`<polyline\\b([^>]*)/?>`, 'g'),
  polygon: new RegExp(`<polygon\\b([^>]*)/?>`, 'g'),
  path: new RegExp(`<path\\b([^>]*)/?>`, 'g'),
  groupOpen: /<g\b([^>]*)>/g,
};

function attrs(s) {
  const o = {};
  // 注意属性名里带数字：x1 / y1 / x2 / y2。
  // 这里如果写成 [a-zA-Z-]+ 就会漏掉它们，坐标变 undefined -> 线条全画到 (0,0)，
  // 整幅图会被糊成一大块楔形（踩过）。
  const re = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"|([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(s))) o[m[1] || m[3]] = m[2] ?? m[4];
  return o;
}

const num = (v, d = 0) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

/**
 * 把 d 里的相对指令展开成绝对坐标。
 * 支持 M L H V C S Q T A Z 及小写相对形式（A 用圆心近似，够画辐条/圆弧了）。
 */
function flattenPath(d) {
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const subs = [];
  let cur = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  let px = 0, py = 0;
  let i = 0;
  let track = false; // 记录当前子路径是否闭合
  const push = (nx, ny) => { cur.push([nx, ny]); x = nx; y = ny; };
  // 新子路径必须从空数组开始：之前写成 cur = [[x, y]] 会给每条子路径塞一个 (0,0)，
  // 结果每个形状都被牵一条线到原点，整幅图糊成楔形（踩过，见 _probe/debug-flatten.mjs）
  const startSub = () => {
    if (cur.length > 1) subs.push({ pts: cur, closed: track });
    cur = [];
    track = false;
  };

  const read = () => {
    if (i >= toks.length) return NaN;
    return parseFloat(toks[i++]);
  };
  const peekIsCommand = () => i < toks.length && /^[MmLlHhVvCcSsQqTtAaZz]$/.test(toks[i]);

  while (i < toks.length) {
    let cmd = toks[i];
    if (!/^[MmLlHhVvCcSsQqTtAaZz]$/.test(cmd)) { cmd = 'L'; i--; } else i++;
    // 指令连写（如 "M56 5L57 8"）时下一个 token 是指令而不是参数，直接重来
    if (peekIsCommand()) continue;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    // 参数不够就收尾，绝不能让 index 越界读到 NaN —— 会污染坐标并死循环（踩过）
    const need = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[C] ?? 2;
    if (need && i + need > toks.length) break;

    if (C === 'M') { const nx = read() + ox, ny = read() + oy; startSub(); push(nx, ny); sx = nx; sy = ny; }
    else if (C === 'L') { push(read() + ox, read() + oy); }
    else if (C === 'H') { push(read() + ox, y); }
    else if (C === 'V') { push(x, read() + oy); }
    else if (C === 'C') {
      const c1x = read() + ox, c1y = read() + oy, c2x = read() + ox, c2y = read() + oy, ex = read() + ox, ey = read() + oy;
      const bx = x, by = y;
      for (let t = 1; t <= 12; t++) {
        const u = t / 12, v = 1 - u;
        cur.push([
          v * v * v * bx + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * ex,
          v * v * v * by + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * ey,
        ]);
      }
      x = ex; y = ey; px = c2x; py = c2y;
    }
    else if (C === 'S') {
      const c2x = read() + ox, c2y = read() + oy, ex = read() + ox, ey = read() + oy;
      const c1x = 2 * x - px, c1y = 2 * y - py;
      const bx = x, by = y;
      for (let t = 1; t <= 12; t++) {
        const u = t / 12, v = 1 - u;
        cur.push([v * v * v * bx + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * ex,
                  v * v * v * by + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * ey]);
      }
      x = ex; y = ey; px = c2x; py = c2y;
    }
    else if (C === 'Q') {
      const qx = read() + ox, qy = read() + oy, ex = read() + ox, ey = read() + oy;
      const bx = x, by = y;
      for (let t = 1; t <= 10; t++) {
        const u = t / 10, v = 1 - u;
        cur.push([v * v * bx + 2 * v * u * qx + u * u * ex, v * v * by + 2 * v * u * qy + u * u * ey]);
      }
      x = ex; y = ey; px = qx; py = qy;
    }
    else if (C === 'T') {
      const ex = read() + ox, ey = read() + oy;
      const qx = 2 * x - px, qy = 2 * y - py;
      const bx = x, by = y;
      for (let t = 1; t <= 10; t++) {
        const u = t / 10, v = 1 - u;
        cur.push([v * v * bx + 2 * v * u * qx + u * u * ex, v * v * by + 2 * v * u * qy + u * u * ey]);
      }
      x = ex; y = ey; px = qx; py = qy;
    }
    else if (C === 'A') {
      const rx = Math.abs(read()), ry = Math.abs(read()), rot = read() * Math.PI / 180, laf = read(), sf = read();
      const ex = read() + ox, ey = read() + oy;
      // 端点参数化：把 (x,y)->(ex,ey) 的弧按椭圆采样（拼豆分辨率下足够准）
      const bx = x, by = y;
      const mx = (bx + ex) / 2, my = (by + ey) / 2;
      const dx2 = (bx - ex) / 2, dy2 = (by - ey) / 2;
      const rr = Math.max(rx || 0, ry || 0, Math.hypot(dx2, dy2));
      const a0 = Math.atan2(by - my, bx - mx);
      let a1 = Math.atan2(ey - my, ex - mx);
      let delta = a1 - a0;
      if (sf && delta > 0) delta -= Math.PI * 2;
      if (!sf && delta < 0) delta += Math.PI * 2;
      if (laf === 0 && Math.abs(delta) > Math.PI) delta += delta > 0 ? -Math.PI * 2 : Math.PI * 2;
      const steps = Math.max(6, Math.ceil(Math.abs(delta) * rr));
      for (let t = 1; t <= steps; t++) {
        const a = a0 + delta * (t / steps);
        cur.push([
          mx + rr * Math.cos(a) * Math.cos(rot) - rr * Math.sin(a) * Math.sin(rot),
          my + rr * Math.cos(a) * Math.sin(rot) + rr * Math.sin(a) * Math.cos(rot),
        ]);
      }
      x = ex; y = ey;
    }
    else if (C === 'Z') {
      if (cur.length) { subs.push({ pts: cur.concat([[sx, sy]]), closed: true }); cur = []; }
      x = sx; y = sy; track = false;
    }
  }
  if (cur.length > 1) subs.push({ pts: cur, closed: track });
  return subs;
}

function insideSubpath(pts, px, py) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** stroke 采样：把线段加密成点，用于车架、辐条这类细线 */
function strokePoints(a, b, width) {
  const pts = [];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(1, Math.ceil(len * 2));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    const r = Math.max(0.5, width / 2);
    for (let oy = -Math.ceil(r); oy <= Math.ceil(r); oy++) {
      for (let ox = -Math.ceil(r); ox <= Math.ceil(r); ox++) {
        if (ox * ox + oy * oy <= r * r + 0.25) pts.push([x + ox, y + oy]);
      }
    }
  }
  return pts;
}

/**
 * 主入口：把 SVG 字符串渲染成点阵
 * @param {string} svg 含 viewBox 的 svg 文本
 * @param {object} opts { cols, rows, beadPalette, bg }
 */
export function svgToGrid(svg, opts = {}) {
  const { cols = 48, rows = 48, beadPalette = null, bg = null, strokeWidth = 1.1, strokeScale = 0.7, debug = false } = opts;

  const vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(svg);
  const [vx, vy, vw, vh] = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 100, 100];

  // 收集所有图元，按文档顺序即绘制顺序
  const items = [];
  const all = new RegExp(`<(circle|ellipse|rect|line|polyline|polygon|path)\\b([^>]*)/?>`, 'g');
  let m;
  while ((m = all.exec(svg))) {
    const tag = m[1], a = attrs(m[2]);
    items.push({ tag, a });
  }

  const grid = PixelGrid.create(cols, rows, []);
  const put = (px, py, hex) => {
    // svg 用户坐标 -> 格坐标
    const gx = Math.round(((px - vx) / vw) * cols - 0.5);
    const gy = Math.round(((py - vy) / vh) * rows - 0.5);
    if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) return;
    grid.set(gx, gy, grid.ensureColor(hex));
  };

  const fillHex = (c) => parseColor(c);

  /** 形状的"内部点集"（用于 fill） */
  const fillPoints = ({ tag, a }) => {
    if (tag === 'circle') {
      const cx = num(a.cx), cy = num(a.cy), r = num(a.r);
      const pts = [];
      for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
        for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++)
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) pts.push([x + 0.5, y + 0.5]);
      return pts;
    }
    if (tag === 'ellipse') {
      const cx = num(a.cx), cy = num(a.cy), rx = num(a.rx), ry = num(a.ry);
      const pts = [];
      for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++)
        for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++)
          if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) pts.push([x + 0.5, y + 0.5]);
      return pts;
    }
    if (tag === 'rect') {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
      const rx = num(a.rx), pts = [];
      for (let yy = Math.floor(y); yy < Math.ceil(y + h); yy++)
        for (let xx = Math.floor(x); xx < Math.ceil(x + w); xx++) {
          const px = xx + 0.5, py = yy + 0.5;
          if (rx > 0) {
            const qx = Math.max(rx, Math.min(w - rx, px - x)), qy = Math.max(rx, Math.min(h - rx, py - y));
            if (Math.hypot(px - x - qx, py - y - qy) > rx) continue;
          }
          pts.push([px, py]);
        }
      return pts;
    }
    if (tag === 'polygon') {
      const v = (a.points || '').trim().split(/[\s,]+/).map(Number);
      const poly = [];
      for (let i = 0; i + 1 < v.length; i += 2) poly.push([v[i], v[i + 1]]);
      if (poly.length < 3) return [];
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      const pts = [];
      for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++)
        for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++)
          if (insideSubpath(poly, x + 0.5, y + 0.5)) pts.push([x + 0.5, y + 0.5]);
      return pts;
    }
    if (tag === 'path') {
      const subs = flattenPath(a.d || '');
      // 只有闭合子路径才参与填充；开放子路径（比如头顶的小冠羽）只描边。
      // 之前把开放子路径也拿去 point-in-polygon，bbox 会扫出一大片空白楔形（踩过）。
      const closed = subs.filter((s) => s.closed).map((s) => s.pts);
      if (!closed.length) return [];
      const box = closed.flat();
      const xs = box.map((p) => p[0]), ys = box.map((p) => p[1]);
      const pts = [];
      for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++)
        for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++)
          if (closed.some((s) => insideSubpath(s, x + 0.5, y + 0.5))) pts.push([x + 0.5, y + 0.5]);
      return pts;
    }
    return [];
  };

  /** 形状的"轮廓点集"（用于 stroke）—— 只取边界，不能把内部也算进去 */
  const strokePointsOf = ({ tag, a }) => {
    // 关键：在 96×48 这种低分辨率下，stroke 宽度 1 就已经占满一格，
    // 线一多就会把整幅图糊成黑色。所以把线宽压到描边"刚好一格"。
    const raw = num(a['stroke-width'], strokeWidth);
    const w = Math.max(0.85, Math.min(raw * strokeScale, 1.6));
    if (tag === 'line') return strokePoints([num(a.x1), num(a.y1)], [num(a.x2), num(a.y2)], w);
    if (tag === 'polyline' || tag === 'polygon') {
      const v = (a.points || '').trim().split(/[\s,]+/).map(Number);
      const out = [];
      for (let i = 0; i + 3 < v.length; i += 2) out.push(...strokePoints([v[i], v[i + 1]], [v[i + 2], v[i + 3]], w));
      if (tag === 'polygon' && v.length >= 4) out.push(...strokePoints([v[v.length - 2], v[v.length - 1]], [v[0], v[1]], w));
      return out;
    }
    if (tag === 'circle') {
      const cx = num(a.cx), cy = num(a.cy), r = num(a.r);
      const out = [];
      const steps = Math.max(16, Math.ceil(2 * Math.PI * r * 2));
      for (let s = 0; s < steps; s++) {
        const t0 = (s / steps) * Math.PI * 2, t1 = ((s + 1) / steps) * Math.PI * 2;
        out.push(...strokePoints([cx + r * Math.cos(t0), cy + r * Math.sin(t0)], [cx + r * Math.cos(t1), cy + r * Math.sin(t1)], w));
      }
      return out;
    }
    if (tag === 'ellipse') {
      const cx = num(a.cx), cy = num(a.cy), rx = num(a.rx), ry = num(a.ry);
      const out = [];
      const steps = 64;
      for (let s = 0; s < steps; s++) {
        const t0 = (s / steps) * Math.PI * 2, t1 = ((s + 1) / steps) * Math.PI * 2;
        out.push(...strokePoints([cx + rx * Math.cos(t0), cy + ry * Math.sin(t0)], [cx + rx * Math.cos(t1), cy + ry * Math.sin(t1)], w));
      }
      return out;
    }
    if (tag === 'rect') {
      const x = num(a.x), y = num(a.y), ww = num(a.width), h = num(a.height);
      const c = [[x, y], [x + ww, y], [x + ww, y + h], [x, y + h]];
      const out = [];
      for (let i = 0; i < 4; i++) out.push(...strokePoints(c[i], c[(i + 1) % 4], w));
      return out;
    }
    if (tag === 'path') {
      const subs = flattenPath(a.d || '');
      const out = [];
      for (const s of subs) {
        const sub = s.pts;
        for (let i = 0; i + 1 < sub.length; i++) out.push(...strokePoints(sub[i], sub[i + 1], w));
        if (s.closed && sub.length > 2) out.push(...strokePoints(sub[sub.length - 1], sub[0], w));
      }
      return out;
    }
    return [];
  };

  for (const item of items) {
    const before = grid.counts().filled;
    if (fillHex(item.a.fill)) {
      const hex = fillHex(item.a.fill);
      for (const [px, py] of fillPoints(item)) put(px, py, hex);
    }
    if (fillHex(item.a.stroke)) {
      const hex = fillHex(item.a.stroke);
      for (const [px, py] of strokePointsOf(item)) put(px, py, hex);
    }
    if (debug) {
      const fp = fillPoints(item), sp = strokePointsOf(item);
      const rng = (pts) => {
        if (!pts.length) return '空';
        const gx = pts.map(([x, y]) => Math.round(((x - vx) / vw) * cols - 0.5));
        const gy = pts.map(([x, y]) => Math.round(((y - vy) / vh) * rows - 0.5));
        return `svg[${Math.min(...pts.map((p) => p[0])).toFixed(0)},${Math.min(...pts.map((p) => p[1])).toFixed(0)}..${Math.max(...pts.map((p) => p[0])).toFixed(0)},${Math.max(...pts.map((p) => p[1])).toFixed(0)}] 格[${Math.min(...gx)},${Math.min(...gy)}..${Math.max(...gx)},${Math.max(...gy)}]`;
      };
      console.log(`  · ${item.tag.padEnd(8)} fill=${(item.a.fill || '-').padEnd(9)} 填充${fp.length}点 ${rng(fp)} | 描边${sp.length}点 ${rng(sp)} | 新增豆 ${grid.counts().filled - before}`);
    }
  }

  // 背景
  if (bg) {
    const hex = parseColor(bg);
    for (let i = 0; i < grid.grid.length; i++) if (grid.grid[i] < 0) grid.grid[i] = grid.ensureColor(hex);
  }

  // 落色到真实豆色卡
  let out = grid;
  if (beadPalette) {
    const map = new Map();
    const pal = [];
    const remap = new Int8Array(grid.grid.length);
    for (let i = 0; i < grid.grid.length; i++) {
      const v = grid.grid[i];
      if (v < 0) { remap[i] = -1; continue; }
      const target = nearestColor(grid.palette[v], beadPalette);
      if (!map.has(target)) { map.set(target, pal.length); pal.push(target); }
      remap[i] = map.get(target);
    }
    out = PixelGrid.create(cols, rows, pal);
    out.grid = remap;
  }
  return out;
}
