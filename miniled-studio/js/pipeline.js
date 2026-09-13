/**
 * Mini-LED 背光分区调光 —— 核心算法管线
 *
 * 显示器的成像模型（这是理解 Mini-LED 的全部关键）：
 *
 *     最终像素 = LCD 透光率(像素级) × 背光亮度(分区级 → 被扩散糊开)
 *
 * 传统侧光式(edge-lit)：背光是一整片，全屏一个亮度 → 暗场里没法真的黑
 * Mini-LED：背光切成几百~几千个分区，各自独立调亮度 → 暗的地方真压暗
 *
 * 分区调光带来的两个必然结果：
 *   好处：对比度大幅提升（黑场真的黑）
 *   代价：亮暗交界出现光晕 blooming（背光糊开了，但 LCD 只能按像素挡光）
 *
 * 这个文件只做数学，不碰 DOM；所有函数都是纯函数，方便单测。
 */

/* ================= 色域 / 亮度 ================= */

/** sRGB 相对亮度（Rec.709 权重），输入输出都是 0..1 */
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 感知亮度：显示器观感更接近这条曲线，用于"背光该给多少"更符合肉眼 */
export function perceptualLuma(r, g, b) {
  return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b);
}

/* ================= 分区提取 ================= */

/**
 * 把画面按 zoneCols × zoneRows 切成区块，每块算出"这个分区的背光该多亮"
 *
 * @param {Float32Array} lum   逐像素亮度（长度 w*h）
 * @param {number} w @param {number} h
 * @param {number} zoneCols @param {number} zoneRows
 * @param {object} opts
 *   method: 分区取值算法，这是各厂商画质差异的核心
 *     'max'   取区块内最亮像素 —— 保高光细节不裁切，但暗部压不下去（光晕最重）
 *     'mean'  取平均值 —— 对比度最高，但高光会被压暗（亮部细节丢）
 *     'rms'   均方根 —— 折中，业界常用
 *     'hybrid' max 与 mean 加权 —— 厂商最爱，可调
 *   hybridWeight: hybrid 模式下 max 的权重
 *   minBoost: 分区最低亮度下限（0 = 允许完全关灯）
 *   boost: 整体提亮系数（背光压暗后，用 LCD 补偿，但背光留点余量能减少光晕）
 * @returns {{cols, rows, zones: Float32Array, method: string}}
 */
export function extractZones(lum, w, h, zoneCols, zoneRows, opts = {}) {
  const {
    method = 'hybrid',
    hybridWeight = 0.65,
    minBoost = 0.0,
    boost = 1.0,
  } = opts;

  const zones = new Float32Array(zoneCols * zoneRows);
  const zx = w / zoneCols;      // 每个分区覆盖多少像素（可以是小数）
  const zy = h / zoneRows;

  for (let zr = 0; zr < zoneRows; zr++) {
    for (let zc = 0; zc < zoneCols; zc++) {
      const px0 = Math.floor(zc * zx), px1 = Math.min(w, Math.ceil((zc + 1) * zx));
      const py0 = Math.floor(zr * zy), py1 = Math.min(h, Math.ceil((zr + 1) * zy));

      let sum = 0, sumSq = 0, mx = 0, n = 0;
      for (let y = py0; y < py1; y++) {
        const row = y * w;
        for (let x = px0; x < px1; x++) {
          const v = lum[row + x];
          sum += v; sumSq += v * v;
          if (v > mx) mx = v;
          n++;
        }
      }
      if (n === 0) { zones[zr * zoneCols + zc] = 0; continue; }

      const mean = sum / n;
      const rms = Math.sqrt(sumSq / n);
      let v;
      switch (method) {
        case 'max': v = mx; break;
        case 'mean': v = mean; break;
        case 'rms': v = rms; break;
        case 'hybrid':
        default: v = hybridWeight * mx + (1 - hybridWeight) * mean; break;
      }
      zones[zr * zoneCols + zc] = Math.min(1, Math.max(minBoost, v * boost));
    }
  }
  return { cols: zoneCols, rows: zoneRows, zones, method };
}

/* ================= 背光扩散（上采样 + 模糊） ================= */

/**
 * 把分区级的背光图扩散成像素级的背光场
 *
 * 为什么要扩散而不是简单双线性放大：真实背光板有导光板/扩散膜，
 * 光线会横向串到相邻区域 —— 这正是 blooming 的物理来源，必须模拟。
 *
 * @param {Float32Array} zones  分区亮度
 * @param {number} zoneCols @param {number} zoneRows
 * @param {number} w @param {number} h  目标像素尺寸
 * @param {number} spread  扩散程度（像素）。0 = 硬边界（不真实），越大光晕越明显
 * @returns {Float32Array} 像素级背光场（长度 w*h）
 */
export function diffuseBacklight(zones, zoneCols, zoneRows, w, h, spread = 0) {
  // 1) 双线性上采样到像素尺寸
  const field = new Float32Array(w * h);
  const zx = w / zoneCols, zy = h / zoneRows;

  for (let y = 0; y < h; y++) {
    // 分区中心对齐：像素 y 对应分区坐标 (y + 0.5)/zy - 0.5
    const fy = Math.min(zoneRows - 1, Math.max(0, (y + 0.5) / zy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(zoneRows - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(zoneCols - 1, Math.max(0, (x + 0.5) / zx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(zoneCols - 1, x0 + 1);
      const tx = fx - x0;

      const a = zones[y0 * zoneCols + x0], b = zones[y0 * zoneCols + x1];
      const c = zones[y1 * zoneCols + x0], d = zones[y1 * zoneCols + x1];
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      field[y * w + x] = top + (bot - top) * ty;
    }
  }

  // 2) 扩散：两次 box blur 近似高斯（O(n)，与半径无关）
  if (spread >= 1) {
    const r = Math.max(1, Math.round(spread));
    boxBlur(field, w, h, r);
    boxBlur(field, w, h, r);
  }
  return field;
}

function boxBlur(field, w, h, r) {
  const tmp = new Float32Array(field.length);
  const win = r * 2 + 1;

  // 横向
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += field[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += field[row + Math.min(w - 1, x + r + 1)] - field[row + Math.max(0, x - r)];
    }
  }
  // 纵向
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      field[y * w + x] = sum / win;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

/* ================= 成像 ================= */

/**
 * 按显示模型算出最终画面
 *
 *   最终 = LCD 透光率 × 背光 + 漏光
 *
 * ★ 漏光(leak)必须是**加性**的，不能当除数。
 *   物理上：LCD 关不严，背光再暗也有极少量光透过来 ——
 *   所以黑场亮度 = leak（一个常数），跟背光无关。
 *   这正是"面板原生对比度"的根源，也是 Mini-LED 再好也越不过去的天花板。
 *
 * LCD 透光率怎么来：面板要把"原图亮度 L"在背光 B 的条件下还原出来，
 * 需要 T = L / B（上限 1）。B 越小 → T 越大 → 暗部越接近真的黑。
 * 这就是分区调光提升对比度的数学本质。
 *
 * 如果 T 截断到 1 还不够（B 给低了），高光就丢了 —— 这是 mean 算法的典型缺陷，
 * 所以这里把"裁切量"统计出来，方便对比不同算法的取舍。
 *
 * @returns {{rgb: Float32Array, lcd: Float32Array, clipped: number, clipAmount: number}}
 */
export function composeFrame(src, w, h, backlight, opts = {}) {
  const { gamma = 2.2, leak = 0, backlightFloor = 0 } = opts;
  const n = w * h;
  const rgb = new Float32Array(n * 3);
  const lcd = new Float32Array(n);
  let clipped = 0, clipSum = 0;

  for (let i = 0; i < n; i++) {
    const r = src[i * 3], g = src[i * 3 + 1], b = src[i * 3 + 2];
    // 原图的感知亮度（用于决定 LCD 开度）
    const L = perceptualLuma(r, g, b);
    // 背光最低不会低于 floor（真实面板不会把分区完全关死）
    const B = Math.max(backlight[i], backlightFloor, 1e-4);

    // 需要的透光率；超过 1 说明背光给低了 → 高光裁切
    let T = L / B;
    if (T > 1) { clipped++; clipSum += T - 1; T = 1; }

    // LCD 是乘性器件，且它自己的响应是非线性的
    const gain = Math.pow(T, 1 / gamma);
    // 漏光是加性的：即使 T=0，也有 leak 这么多光透出来
    const add = leak;
    rgb[i * 3] = Math.min(1, r * gain + add);
    rgb[i * 3 + 1] = Math.min(1, g * gain + add);
    rgb[i * 3 + 2] = Math.min(1, b * gain + add);
    lcd[i] = T;
  }
  return { rgb, lcd, clipped: n ? clipped / n : 0, clipAmount: n ? clipSum / n : 0 };
}

/* ================= 参考：无分区调光 ================= */

/**
 * 传统侧光式基线：整屏一个背光亮度
 *
 * ★ 关键建模决定：这里必须**自适应**，不能写死 1.0。
 *   真实侧光式电视会根据画面内容调全局背光（暗场画面会调低），
 *   写死 1.0 的话暗场画面会被冤枉 —— 对比就失去意义了。
 *   自适应规则：用全屏最亮的那个"分区级"亮度（也就是画面里最亮的区域），
 *   保证高光不丢；剩下的亮度分配交给 LCD。
 *
 *   注：即便自适应，全局模式下"暗区"拿到的背光依然等于全屏最大值，
 *   所以暗区无法进一步压暗 —— 这正是侧光式的根本局限。
 */
export function globalBacklight(lum, w, h, level = null) {
  const field = new Float32Array(w * h);
  if (level !== null) { field.fill(level); return field; }
  let mx = 0;
  for (let i = 0; i < lum.length; i++) if (lum[i] > mx) mx = lum[i];
  // 不让它低于一个下限（真实电视不会把背光调到 0）
  field.fill(Math.max(0.15, mx));
  return field;
}

/* ================= 对比度估算 ================= */

/**
 * 估算"有效对比度"：最亮像素 / 最暗像素的比值
 *
 * ⚠️ 这里有个反直觉的点（建模时必须想清楚）：
 *   如果纯黑区域的背光真的是 0、LCD 也关到 0，那算出来是"无限对比度" —— 不真实。
 *   真实面板黑不下去有两个原因，二者必须都建模：
 *     1. LCD 漏光（leak）—— 面板关不严，即使背光很暗也有底光
 *     2. 背光最低亮度（minBoost）—— 厂商不会把分区完全关死
 *   所以 blackLevel 由 leak/minBoost 决定，而**分区调光的价值在于：
 *   把"高亮区域对邻近暗区"的抬升压到最小**（blooming 更小 → 暗部更接近纯净）。
 *
 * 另外，最终对比度受面板原生对比度封顶：LCD 关不严，Mini-LED 再好也越不过去。
 */
export function effectiveContrast(rgb, w, h, panelContrast = 1000) {
  let mx = 0, mn = Infinity;
  for (let i = 0; i < w * h; i++) {
    const v = perceptualLuma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    if (v > mx) mx = v;
    if (v < mn) mn = v;
  }
  if (!isFinite(mn)) mn = 0;
  const raw = mn > 1e-7 ? mx / mn : Infinity;
  const finite = raw === Infinity ? panelContrast : raw;
  return {
    raw: finite,                                   // 未封顶的实际比值
    capped: Math.min(finite, panelContrast),       // 受面板限制后的对比度
    blackLevel: mn,
    peakLevel: mx,
    panelLimited: finite > panelContrast,
  };
}

/* ================= 方便的整条管线 ================= */

/**
 * 一次跑完：原图 → 分区 → 扩散 → 成像
 *
 * 名字叫 processFrame 而不是 process —— 后者会把 Node 的全局 `process` 遮蔽掉，
 * 导致 process.exit / process.argv 全部失效（踩过，报错是 "process.exit is not a function"）。
 *
 * @param {Float32Array} src  逐像素 RGB（0..1），长度 w*h*3
 */
export function processFrame(src, w, h, params) {
  const {
    zoneCols = 32, zoneRows = 18,
    method = 'hybrid', hybridWeight = 0.65,
    minBoost = 0.02,        // 分区最低亮度：真实面板不会把分区完全关死，留一点底光
    boost = 1,
    spread = 4,             // 背光扩散半径（像素），blooming 的物理来源
    gamma = 2.2,
    leak = 0.004,           // 面板漏光：LCD 关不严，这是"黑不下去"的根本原因
    panelContrast = 1000,
    zonesEnabled = true,
  } = params;

  // 逐像素亮度
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = perceptualLuma(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
  }

  const ext = extractZones(lum, w, h, zoneCols, zoneRows, { method, hybridWeight, minBoost, boost });
  const backlight = zonesEnabled
    ? diffuseBacklight(ext.zones, zoneCols, zoneRows, w, h, spread)
    : globalBacklight(lum, w, h);   // 自适应全局背光，作为侧光式基线

  const out = composeFrame(src, w, h, backlight, { gamma, leak, backlightFloor: minBoost });
  const contrast = effectiveContrast(out.rgb, w, h, panelContrast);

  return { ...out, backlight, zones: ext.zones, contrast, lum, lumSrc: lum };
}

export function zoneGridSize(zoneCols, zoneRows) {
  return { cols: zoneCols, rows: zoneRows, count: zoneCols * zoneRows };
}

/** 常见面板的分区数参考（帮用户选合理的值） */
export const ZONE_PRESETS = [
  { label: '96 分区（入门）', cols: 12, rows: 8, note: '约等于早期 Mini-LED 平板' },
  { label: '384 分区', cols: 24, rows: 16, note: '主流笔记本 / 显示器' },
  { label: '1152 分区', cols: 48, rows: 24, note: '高端 Mini-LED 显示器' },
  { label: '2304 分区', cols: 64, rows: 36, note: '接近消费级天花板' },
  { label: '9216 分区', cols: 128, rows: 72, note: '专业 HDR 监视器级别' },
];
