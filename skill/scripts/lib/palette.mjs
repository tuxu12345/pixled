/**
 * 拼豆色卡 与 颜色落色
 *
 * 拼豆的现实约束：真实能买到的豆色是有限的一套（Hama/Perler/Artkal 加起来也就几十色）。
 * 所以任何图案生成完都必须"落色"到色卡上，否则生成的画拼不出来。
 *
 * 落色用 CIE Lab 距离而不是加权 RGB —— 加权 RGB 会把暗红配成粉、把黑配成棕，
 * 一眼就假（这个坑在 pixel-bead-studio 里踩过）。
 */

/* ---------------- 内置色卡 ---------------- */

export const PALETTES = {
  hama_standard: {
    name: '标准拼豆（Hama 风格）',
    dot: 5,
    colors: [
      ['H01', '#FFFFFF', '白'], ['H02', '#F2F2F2', '浅灰'], ['H03', '#9B9B9B', '灰'], ['H04', '#4A4A4A', '深灰'],
      ['H05', '#1A1A1A', '黑'], ['H06', '#FFF3C4', '米黄'], ['H07', '#FFD400', '柠黄'], ['H08', '#FFA300', '橙'],
      ['H09', '#FF6A00', '橘红'], ['H10', '#E8352B', '红'], ['H11', '#B01722', '深红'], ['H12', '#FFB7C5', '粉'],
      ['H13', '#F062A8', '桃红'], ['H14', '#C13BA8', '紫红'], ['H15', '#7B4BC9', '紫'], ['H16', '#4A6CD4', '蓝'],
      ['H17', '#2AA8E0', '天蓝'], ['H18', '#A8E4F0', '浅蓝'], ['H19', '#2E7D5B', '深绿'], ['H20', '#4CAF50', '绿'],
      ['H21', '#A5D63F', '草绿'], ['H22', '#E4F0A8', '嫩绿'], ['H23', '#8B5A2B', '棕'], ['H24', '#C98B4B', '浅棕'],
      ['H25', '#F2C48D', '肤'], ['H26', '#E8A03C', '橙黄'], ['H27', '#6B4A2F', '深棕'], ['H28', '#3E2A20', '描边棕'],
    ],
  },
  hama_mini: {
    name: '迷你豆（2.6mm）',
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
    name: '夜光豆',
    dot: 5,
    colors: [
      ['G01', '#F6FFB0', '夜光黄'], ['G02', '#B6FF7A', '夜光绿'], ['G03', '#7AF0FF', '夜光青'],
      ['G04', '#C6A8FF', '夜光紫'], ['G05', '#FFB0D8', '夜光粉'], ['G06', '#FFFFFF', '夜光白'],
      ['G07', '#2A2A2A', '底色黑'], ['G08', '#4A4A4A', '底色灰'], ['G09', '#FFD400', '黄'],
      ['G10', '#FF8A00', '橙'], ['G11', '#E8352B', '红'], ['G12', '#3A6FD8', '蓝'],
    ],
  },
  gray16: {
    name: '16 级灰阶（做单色图案用）',
    dot: 5,
    colors: Array.from({ length: 16 }, (_, i) => {
      const v = Math.round((i / 15) * 255).toString(16).padStart(2, '0').toUpperCase();
      return ['R' + String(i + 1).padStart(2, '0'), '#' + v + v + v, '灰' + (i + 1)];
    }),
  },
};

export function getPalette(id) {
  const p = PALETTES[id];
  if (!p) throw new Error(`未知色卡 "${id}"，可选：${Object.keys(PALETTES).join(' / ')}`);
  return p;
}

export function paletteHexes(id) {
  return getPalette(id).colors.map((c) => c[1]);
}

/* ---------------- 颜色空间 ---------------- */

export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const f = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

const srgbToLinear = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const _labCache = new Map();

export function hexToLab(hex) {
  if (hex && typeof hex === 'object' && 'L' in hex && 'a' in hex && 'b' in hex) return hex;
  const key = String(hex).toUpperCase();
  if (!/^#[0-9a-fA-F]{6}$/.test(key)) {
    throw new Error(`hexToLab 需要 #RRGGBB 格式的颜色，收到 ${JSON.stringify(hex)}。` +
      `如果你想传 hexToLab() 的结果（Lab 对象），labDistance 直接支持，不用再走这里。`);
  }
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

/**
 * 两个颜色的 Lab 距离。
 *
 * 参数可以是 hex 字符串，也可以**直接传 hexToLab 的结果**（Lab 对象）——
 * 传对象时不再重复转换。之前只接受字符串，把 Lab 对象传进来会变成
 * String({}) = "[object Object]"，缓存命中同一个键 → **距离恒为 0**，
 * 表现为"所有颜色都落到色卡第一项"。这个坑很难发现，所以显式支持两种输入。
 */
export function labDistance(c1, c2) {
  const A = (c1 && typeof c1 === 'object') ? c1 : hexToLab(c1);
  const B = (c2 && typeof c2 === 'object') ? c2 : hexToLab(c2);
  return Math.hypot(A.L - B.L, A.a - B.a, A.b - B.b);
}

/**
 * 找色卡里最接近的颜色
 * @param {string} hex
 * @param {string[]} palette
 * @param {object} opts { hueBias: 高饱和色额外做色相惩罚，避免"红布料配到粉豆" }
 */
export function nearestColor(hex, palette, opts = {}) {
  const { hueBias = true } = opts;
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
        d *= 1 + (1 - dot) * 1.6;
      }
    }
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/* ---------------- 抖动 ---------------- */

const BAYER8 = (() => {
  // 8×8 Bayer 矩阵，标准递推构造
  let m = [[0]];
  for (let n = 1; n <= 3; n++) {
    const size = m.length, next = [];
    for (let y = 0; y < size * 2; y++) next.push(new Array(size * 2).fill(0));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + size] = v + 2;
        next[y + size][x] = v + 3;
        next[y + size][x + size] = v + 1;
      }
    }
    m = next;
  }
  return m;
})();

export function bayer(x, y) {
  return BAYER8[y & 7][x & 7] / 64 - 0.5;   // -0.5 .. +0.5
}

/* ---------------- 落色 ---------------- */

/**
 * 把采样结果落色到色卡
 * @param {{cols,rows,pixels:Float32Array}} sampled  sample() 的输出（r,g,b,a 都是 0..1）
 * @param {string} paletteId
 * @param {object} opts { alphaThreshold, dither, maxColors, transparent }
 * @returns {{cols,rows,idx:Int16Array,palette:string[],stats:object}}
 */
export function quantizeToBeads(sampled, paletteId, opts = {}) {
  const {
    alphaThreshold = 0.5,
    dither = true,
    maxColors = 0,          // >0 时把用到的颜色数压到这个上限
    transparent = true,      // false = 透明格采样卡里的白色
  } = opts;

  const set = getPalette(paletteId);
  const full = set.colors.map((c) => c[1]);
  const { cols, rows, pixels } = sampled;

  // 第一遍：逐格找最近色（带抖动）
  const idx = new Int16Array(cols * rows).fill(-1);
  const used = new Map();
  const ditherAmp = dither ? 26 : 0;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const o = (y * cols + x) * 4;
      const a = pixels[o + 3];
      if (a < alphaThreshold) {
        if (transparent) { idx[y * cols + x] = -1; continue; }
      }
      let r = pixels[o] * 255, g = pixels[o + 1] * 255, b = pixels[o + 2] * 255;
      if (ditherAmp) {
        const t = bayer(x, y) * ditherAmp;
        r += t; g += t; b += t;
      }
      const hex = rgbToHex(r, g, b);
      const near = nearestColor(hex, full);
      if (!used.has(near)) used.set(near, 0);
      used.set(near, used.get(near) + 1);
      idx[y * cols + x] = full.indexOf(near);
    }
  }

  // 可选：把颜色数压到上限（保留用得最多的那些，其余合并到最近的保留色）
  let palette = full;
  let keepSet = null;
  if (maxColors > 0 && used.size > maxColors) {
    const ranked = [...used.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxColors).map((e) => e[0]);
    keepSet = ranked;
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] < 0) continue;
      const hex = full[idx[i]];
      if (ranked.includes(hex)) continue;
      const near = nearestColor(hex, ranked);
      idx[i] = full.indexOf(near);
    }
    // 压完之后重新收拢调色板，只留真正用到的
    const usedNow = new Set();
    for (const v of idx) if (v >= 0) usedNow.add(full[v]);
    const compact = [...usedNow];
    const remap = new Map(compact.map((h, i) => [h, i]));
    for (let i = 0; i < idx.length; i++) if (idx[i] >= 0) idx[i] = remap.get(full[idx[i]]);
    palette = compact;
  } else {
    // 没压色：也要把调色板收拢到"实际用到的颜色"，否则导出的调色板有一堆没用的色
    const usedNow = new Set();
    for (const v of idx) if (v >= 0) usedNow.add(full[v]);
    if (usedNow.size !== full.length) {
      const compact = [...usedNow];
      const remap = new Map(compact.map((h, i) => [h, i]));
      for (let i = 0; i < idx.length; i++) if (idx[i] >= 0) idx[i] = remap.get(full[idx[i]]);
      palette = compact;
    }
  }

  // 统计
  const counts = new Array(palette.length).fill(0);
  let filled = 0;
  for (const v of idx) if (v >= 0) { counts[v]++; filled++; }

  const hours = (filled * 6) / 3600;   // 每颗豆约 6 秒（含摆盘）
  return {
    cols, rows, idx, palette,
    beadSet: set.name,
    dot: set.dot,
    stats: {
      filled,
      empty: cols * rows - filled,
      colors: palette.filter((_, i) => counts[i] > 0).length,
      counts,
      hours: Number(hours.toFixed(2)),
      sizeMm: { w: Math.round(cols * set.dot), h: Math.round(rows * set.dot) },
      keepSet,
    },
  };
}

/**
 * 给实心主体加一圈深色描边 —— 拼豆作品的关键视觉，缺了就像糊在一起的色块。
 * @param {object} grid quantizeToBeads 的输出
 * @param {object} opts { color: 描边色，默认自动挑最深的；onlyOutside: 只描外轮廓 }
 */
export function addOutline(grid, opts = {}) {
  const { cols, rows, idx, palette } = grid;
  const out = Int16Array.from(idx);

  let outlineHex = opts.color;
  if (!outlineHex) {
    // 自动挑调色板里最暗的
    let darkest = palette[0], minL = Infinity;
    for (const hex of palette) {
      const l = hexToLab(hex).L;
      if (l < minL) { minL = l; darkest = hex; }
    }
    outlineHex = minL < 45 ? darkest : null;
  }
  if (!outlineHex) return grid;

  let oi = palette.indexOf(outlineHex);
  let workPalette = palette;
  if (oi < 0) {
    workPalette = [...palette, outlineHex];
    oi = workPalette.length - 1;
    // 索引重映射不需要：新色追加在末尾，原索引不变
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (idx[y * cols + x] >= 0) continue;
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < cols && ny < rows && idx[ny * cols + nx] >= 0;
      });
      if (near) out[y * cols + x] = oi;
    }
  }

  const counts = new Array(workPalette.length).fill(0);
  let filled = 0;
  for (const v of out) if (v >= 0) { counts[v]++; filled++; }
  const usedNow = new Set();
  for (const v of out) if (v >= 0) usedNow.add(v);
  const compact = [...usedNow].sort((a, b) => a - b);
  const remap = new Map(compact.map((old, i) => [old, i]));
  const finalIdx = Int16Array.from(out, (v) => (v >= 0 ? remap.get(v) : -1));
  const finalPalette = compact.map((old) => workPalette[old]);

  return {
    ...grid,
    idx: finalIdx,
    palette: finalPalette,
    stats: {
      ...grid.stats,
      filled,
      empty: cols * rows - filled,
      colors: finalPalette.length,
      counts: finalPalette.map((_, i) => {
        let c = 0;
        for (const v of finalIdx) if (v === i) c++;
        return c;
      }),
      hours: Number(((filled * 6) / 3600).toFixed(2)),
    },
  };
}
