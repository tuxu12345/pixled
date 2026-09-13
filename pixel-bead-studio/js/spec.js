/**
 * 语义规格 -> 本地光栅化（方案 B）
 *
 * 为什么需要它（实测结论）：
 *   让大模型直接吐 48×48 的点阵网格，token 要 8000+、还经常截断成空图，
 *   出来的图像一坨糊，认不出主体。
 *   改成「模型只做分镜（部位 + 形状 + 配色），本地渲染器铺格」后：
 *   - 稳定：输出只有 16 个形状，~700 token，不再截断
 *   - 好看：形状是程序化画的，边缘干净、左右天然对称
 *   - 响应快：省下的 token 就是省下的时间
 *   代价：模型不懂"像素级细节"，所以五官靠形状列表表达（眼睛/鼻子/嘴各一个形状）。
 *
 * 坐标契约（关键，歧义会直接毁掉结果）：
 *   cx, cy ∈ 0~1 归一化中心点；w, h ∈ 0~1 归一化尺寸；mirror=true 时按中线镜像再画一遍。
 *   兼容模型偶尔写像素值（>1）或写成 x/y 的情况，这里全部自动兜住。
 */
import { PixelGrid } from './grid.js';
import { nearestColor } from './palette.js';

export const SHAPE_TYPES = ['ellipse', 'rect', 'capsule', 'triangle'];

/** 规整化模型给的 shapes：类型、坐标、颜色全部兜底 */
export function normalizeSpec(raw, cols, rows) {
  const notes = [];
  let palette = Array.isArray(raw?.palette) ? raw.palette.filter(Boolean).map((p) => String(p).trim().toUpperCase()) : [];
  palette = palette.map((p) => (/^#[0-9A-F]{6}$/.test(p) ? p : (/^[0-9A-F]{6}$/.test(p) ? '#' + p : null))).filter(Boolean);
  if (!palette.length) { palette = ['#3E2A20', '#E8A03C', '#FFF3C4', '#1A1A1A']; notes.push('规格里没有可用调色板，已套默认拼豆色'); }

  const shapes = [];
  for (const s of Array.isArray(raw?.shapes) ? raw.shapes : []) {
    const type = SHAPE_TYPES.includes(s?.type) ? s.type : 'ellipse';
    const norm = (v, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return n > 1.0001 ? n / 100 : n; // 模型偶尔直接给百分比
    };
    const cx = clamp01(norm(s?.cx ?? s?.x, 0.5));
    const cy = clamp01(norm(s?.cy ?? s?.y, 0.5));
    let w = norm(s?.w ?? s?.width, 0.2);
    let h = norm(s?.h ?? s?.height, 0.2);
    if (w <= 0.001) w = 0.2;
    if (h <= 0.001) h = 0.2;
    const color = Math.max(0, Math.min(palette.length - 1, Number.isFinite(s?.color) ? s.color | 0 : 0));
    shapes.push({ type, cx, cy, w: Math.min(1.4, w), h: Math.min(1.4, h), color, mirror: !!s?.mirror, flip: !!s?.flip });
  }
  if (!shapes.length) notes.push('规格里没有形状，画布会是空的');
  if (shapes.length > 40) { shapes.length = 40; notes.push('形状过多，已截断到 40 个'); }
  return { palette, shapes, notes };
}

function clamp01(v) { return Math.max(-0.2, Math.min(1.2, v)); }

function insideShape(type, nx, ny, flip) {
  switch (type) {
    case 'rect': return Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
    case 'capsule': return nx * nx + Math.pow(Math.max(0, Math.abs(ny) - 0.45) / 0.55, 2) <= 1;
    case 'triangle': {
      const yy = flip ? 1 - (ny + 1) / 2 : (ny + 1) / 2; // ny=-1(顶) -> 0
      return Math.abs(nx) <= yy;
    }
    case 'ellipse':
    default: return nx * nx + ny * ny <= 1;
  }
}

/**
 * 把规格渲染成点阵。
 * @param {object} spec normalizeSpec 的结果
 */
export function rasterizeSpec(spec, cols, rows, { outline = true, snapTo = null } = {}) {
  let palette = spec.palette.slice();
  const g = PixelGrid.create(cols, rows, palette);

  for (const s of spec.shapes) {
    const w = s.w * cols, h = s.h * rows;
    const plot = (cxNorm) => {
      const pxC = cxNorm * cols, pyC = s.cy * rows;
      const x0 = Math.floor(pxC - w / 2), x1 = Math.ceil(pxC + w / 2);
      const y0 = Math.floor(pyC - h / 2), y1 = Math.ceil(pyC + h / 2);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const nx = (x + 0.5 - pxC) / (w / 2);
          const ny = (y + 0.5 - pyC) / (h / 2);
          if (insideShape(s.type, nx, ny, s.flip)) g.set(x, y, s.color);
        }
      }
    };
    plot(s.cx);
    if (s.mirror) plot(1 - s.cx);
  }

  // 落色到真实豆色卡（如果指定）
  if (snapTo) {
    const remap = new Int8Array(g.grid.length);
    const outPal = [];
    const map = new Map();
    for (let i = 0; i < g.grid.length; i++) {
      const v = g.grid[i];
      if (v < 0) { remap[i] = -1; continue; }
      const target = nearestColor(g.palette[v], snapTo);
      if (!map.has(target)) { map.set(target, outPal.length); outPal.push(target); }
      remap[i] = map.get(target);
    }
    const out = PixelGrid.create(cols, rows, outPal);
    out.grid = remap;
    return outline ? out.addOutline() : out;
  }

  return outline ? g.addOutline() : g;
}

/** 让模型出规格用的提示词 */
export function buildSpecPrompt(desc, cols, rows, maxColors, beadSetName) {
  return [
    '你是像素画分镜师。把描述拆成几何形状清单，交给渲染器去画，你不要直接画像素。',
    `描述：${desc}`,
    '',
    `坐标规则（严格遵守，全部用 0~1 的归一化坐标，0.5 就是画布正中间，画布 ${cols}×${rows}）：`,
    '- cx, cy = 形状中心点',
    '- w, h = 形状宽高（占整幅画的比例）',
    '- mirror:true 表示同一形状再镜像画到 cx\' = 1-cx（耳朵、眼睛、手臂等对称部位必须用它）',
    '',
    '只输出 JSON：',
    '{"palette":["#RRGGBB"],"shapes":[',
    ' {"type":"ellipse","color":0,"cx":0.5,"cy":0.45,"w":0.66,"h":0.62},',
    ' {"type":"triangle","color":0,"cx":0.30,"cy":0.19,"w":0.20,"h":0.26,"mirror":true},',
    ' {"type":"ellipse","color":3,"cx":0.38,"cy":0.42,"w":0.09,"h":0.09,"mirror":true}]}',
    '',
    '要求：',
    '- type 只能取 ellipse / rect / capsule / triangle',
    '- 10~16 个形状，按「从后到前」排序：先大轮廓，再五官细节（后面的会盖住前面的）',
    `- palette 最多 ${maxColors} 色，要能落到现实${beadSetName}；风格扁平纯色 + 一个深色描边色`,
    '',
    '结构要求（这几条最容易画崩，务必遵守）：',
    '- 主体轮廓要占满画面中部：大轮廓的 w、h 都在 0.6 以上，cx≈0.5',
    '- 耳朵 / 角 / 翅膀必须「长在头上」：它的 cy 要落在主体轮廓的上边缘（= 主体 cy - 主体 h/2）附近，'
      + '且 w、h 不要超过主体的 40%，不要画成孤立的三角形飘在外面',
    '- 五官必须画：眼睛用「深色椭圆 + 更小的浅色高光椭圆」两个形状叠出来（mirror:true）；'
      + '鼻子/嘴用一个小 triangle 或 capsule',
    '- 装饰元素（围巾 / 腮红 / 衣服）最多 2 个形状，不要用深色大色块盖住脸',
    '- 任何形状都不要超出 [0.02, 0.98] 之外',
  ].join('\n');
}
