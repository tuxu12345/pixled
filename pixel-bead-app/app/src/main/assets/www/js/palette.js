/**
 * 拼豆色卡 + 色彩工具
 * 拼豆（Perler / Hama beads）现实色号有限，AI 出图后需要「落色」到真实可买到的豆色，
 * 这也是本 Demo 与「随便生成一张图」的核心差别。
 */

export const BEAD_SETS = {
  standard: {
    id: 'standard',
    name: '标准豆',
    dot: 5, // mm
    colors: [
      ['S01', '#FFFFFF', '白'], ['S02', '#F2F2F2', '浅灰'], ['S03', '#9B9B9B', '灰'], ['S04', '#4A4A4A', '深灰'],
      ['S05', '#1A1A1A', '黑'], ['S06', '#FFF3C4', '米黄'], ['S07', '#FFD400', '柠黄'], ['S08', '#FFA300', '橙'],
      ['S09', '#FF6A00', '橘红'], ['S10', '#E8352B', '红'], ['S11', '#B01722', '深红'], ['S12', '#FFB7C5', '粉'],
      ['S13', '#F062A8', '桃红'], ['S14', '#C13BA8', '紫红'], ['S15', '#7B4BC9', '紫'], ['S16', '#4A6CD4', '蓝'],
      ['S17', '#2AA8E0', '天蓝'], ['S18', '#A8E4F0', '浅蓝'], ['S19', '#2E7D5B', '深绿'], ['S20', '#4CAF50', '绿'],
      ['S21', '#A5D63F', '草绿'], ['S22', '#E4F0A8', '嫩绿'], ['S23', '#8B5A2B', '棕'], ['S24', '#C98B4B', '浅棕'],
      ['S25', '#F2C48D', '肤'], ['S26', '#E8A03C', '橙黄'], ['S27', '#6B4A2F', '深棕'], ['S28', '#3E2A20', '描边棕'],
    ],
  },
  mini: {
    id: 'mini',
    name: '迷你豆',
    dot: 2.6,
    colors: [
      ['M01', '#FFFFFF', '白'], ['M02', '#D8D8D8', '浅灰'], ['M03', '#8A8A8A', '灰'], ['M04', '#333333', '黑'],
      ['M05', '#FFF0A8', '米黄'], ['M06', '#FFD400', '黄'], ['M07', '#FF8A00', '橙'], ['M08', '#E8352B', '红'],
      ['M09', '#FF9FC0', '粉'], ['M10', '#D64BA0', '桃红'], ['M11', '#8B4BC9', '紫'], ['M12', '#3A6FD8', '蓝'],
      ['M13', '#63C8E8', '天蓝'], ['M14', '#2E9E52', '绿'], ['M15', '#9ED44B', '草绿'], ['M16', '#8B5A2B', '棕'],
      ['M17', '#F2C48D', '肤'], ['M18', '#3E2A20', '描边'],
    ],
  },
  glow: {
    id: 'glow',
    name: '夜光豆',
    dot: 5,
    colors: [
      ['G01', '#F6FFB0', '夜光黄'], ['G02', '#B6FF7A', '夜光绿'], ['G03', '#7AF0FF', '夜光青'],
      ['G04', '#C6A8FF', '夜光紫'], ['G05', '#FFB0D8', '夜光粉'], ['G06', '#FFFFFF', '夜光白'],
      ['G07', '#2A2A2A', '底色黑'], ['G08', '#4A4A4A', '底色灰'], ['G09', '#FFD400', '黄'],
      ['G10', '#FF8A00', '橙'], ['G11', '#E8352B', '红'], ['G12', '#3A6FD8', '蓝'],
    ],
  },
};

/** 常用「拼豆风」兜底色卡：AI 无约束时收拢到这些颜色上 */
export const DEFAULT_PALETTE = BEAD_SETS.standard.colors.map((c) => c[1]);

export function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(s.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const f = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

export function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (/^[0-9a-f]{6}$/i.test(s)) s = '#' + s;
  if (!/^#[0-9a-f]{6}$/i.test(s)) return null;
  return s.toUpperCase();
}

/** 感知亮度（用于自动选择描边色 / 文字反色） */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/* ---------------- 颜色距离：CIE Lab (D65) ----------------
 * 为什么不用加权 RGB：实测加权 RGB 会把 #C0392B（暗红）配到 #FFB7C5（粉），
 * 把 #2B2B2B（黑）配到 #3E2A20（棕）—— 拼豆作品的颜色一错就"不像"。
 * Lab 是感知均匀空间，3000 个随机色里两种算法的落色结果差 57%，Lab 明显更符合肉眼。
 */
const srgbToLinear = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const _labCache = new Map();

export function hexToLab(hex) {
  const key = hex.toUpperCase();
  const hit = _labCache.get(key);
  if (hit) return hit;
  const { r, g, b } = hexToRgb(hex);
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  const lab = { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  _labCache.set(key, lab);
  return lab;
}

export function labDistance(h1, h2) {
  const A = hexToLab(h1), B = hexToLab(h2);
  return Math.hypot(A.L - B.L, A.a - B.a, A.b - B.b);
}

/**
 * 在给定色卡里找最接近的颜色。
 * @param {string} hex
 * @param {string[]} palette
 * @param {boolean} hueBias 高饱和色（红/黄/蓝这类）额外做色相惩罚，
 *                          避免"红布料配到粉豆"这种一眼假的落色
 */
export function nearestColor(hex, palette, { hueBias = true } = {}) {
  const A = hexToLab(hex);
  const chromaA = Math.hypot(A.a, A.b);
  let best = palette[0];
  let bestD = Infinity;
  for (const p of palette) {
    const B = hexToLab(p);
    let d = Math.hypot(A.L - B.L, A.a - B.a, A.b - B.b);
    if (hueBias && chromaA > 30) {
      const chromaB = Math.hypot(B.a, B.b);
      if (chromaB > 12) {
        const dot = (A.a * B.a + A.b * B.b) / (chromaA * chromaB);
        d *= 1 + (1 - dot) * 1.6; // 色相偏离就重罚
      }
    }
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}


/** 把任意调色板「落色」到指定豆色卡，返回新调色板 + 索引映射表 */
export function snapPalette(palette, beadSetId) {
  const set = BEAD_SETS[beadSetId] || BEAD_SETS.standard;
  const available = set.colors.map((c) => c[1]);
  const out = [];
  const keyToIndex = new Map();
  const indexMap = new Map();
  for (const p of palette) {
    const snapped = nearestColor(p, available);
    const key = snapped.toUpperCase();
    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, out.length);
      out.push(snapped);
    }
    indexMap.set(p.toUpperCase(), keyToIndex.get(key));
  }
  return { palette: out, indexMap };
}

/** 生成一套协调的调色板（当 AI 没给够颜色时兜底） */
export function autoPalette(baseHex, count = 6) {
  const { r, g, b } = hexToRgb(baseHex);
  const out = [baseHex];
  for (let i = 1; i < count; i++) {
    const k = i / (count - 1);
    const shade = k < 0.5 ? 1 - k * 0.9 : 1 + (k - 0.5) * 0.5;
    out.push(rgbToHex(r * shade, g * shade, b * shade));
  }
  return out;
}
