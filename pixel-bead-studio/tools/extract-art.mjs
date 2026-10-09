#!/usr/bin/env node
/**
 * 图纸截图 → art.js 图案条目
 * =====================================================================
 * 用 puppeteer 打开一张「拼豆图纸截图」，逐格取**中心 60% 区域**的**众数色**，
 * 近白的判成空格，再把颜色**落色到标准豆色卡**（CIE Lab + 色相惩罚，和网页
 * 里 js/palette.js 的 nearestColor 是同一套），最后删掉孤立浅色噪点，
 * 产出一条能直接粘进 pixel-bead-studio/js/art.js 的条目。
 *
 * 怎么找到"哪一块是图纸"
 * ---------------------------------------------------------------------
 * 截图通常带页眉标题、页脚色卡、四周留白，直接按内容外接框切会整体错位。
 * 所以先检测**网格线**（低饱和的浅灰长直线），再用"最均匀的 cols+1 / rows+1
 * 条线"拟合出格距和原点 —— 图纸的格线就是这个 lattice。
 * 检测不到格线（比如纯照片）再退回内容外接框。
 * 拿不准的时候：--crop-debug 会导出带框选标记的图，看一眼就知道对不对。
 *
 * 用法
 * ---------------------------------------------------------------------
 *   node tools/extract-art.mjs 图纸.png --cols 52 --rows 52 \
 *        --id luoxiaohei --name "罗小黑" --tags "标准豆,7色,约2.5小时" --hot \
 *        --out art-luoxiaohei.js --preview luoxiaohei.png --crop-debug crop.png
 *
 *   加 --install 就直接插到 js/art.js 的 ART 数组头部（先做语法自检 + 加载自检，失败回滚）
 *
 * 常用参数
 * ---------------------------------------------------------------------
 *   --cols/--rows      网格列数/行数（必填）
 *   --inset 0.20       每格四边各内缩多少（默认 0.20 → 取中心 60%）
 *   --white 0.90       纸白判定阈值（相对亮度）
 *   --sat 0.10         纸白还要低饱和才算（避免把浅黄/浅蓝误判成空）
 *   --ink 0.10         整格里"画上去的"像素占比低于此值 + 中心是纸白 → 判空
 *                      白豆子（线条小狗的身子）靠这一条保住：豆子边缘那圈浅灰算 ink
 *   --strict-empty     回到最朴素的规则：中心近白即判空（图案内部有真空洞时用）
 *   --crop x,y,w,h     手动指定图纸区域（最可靠，自动检测不对时用这个）
 *   --no-autocrop      完全不裁，整张图当图纸
 *   --margin 0         检测出的区域再往外放几像素
 *   --maxColors 10     最多保留几种颜色（按用量砍，砍掉的并到最近的保留色）
 *   --denoise 1        孤立浅色噪点清理遍数（0 = 关）
 *   --keep-bg          保留背景（默认把近白背景判成空格）
 *   --palette standard|mini|glow
 *   --preview x.png    渲染一张预览，方便"看一眼再决定装不装"
 *   --crop-debug x.png 导出框选调试图（原图 + 区域矩形 + 每格中心点）
 *   --install          直接写进 js/art.js
 *
 * 依赖：npm i -D puppeteer-core   （浏览器用系统已装的 Chrome / Edge / playwright 缓存）
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve, join, extname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BEAD_SETS, nearestColor, hexToRgb, rgbToHex, luminance } from '../js/palette.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, '..');
const ART_JS = join(STUDIO, 'js', 'art.js');
const CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const require = createRequire(import.meta.url);

/* ============================ 参数 ============================ */

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { a[key] = true; continue; }
    a[key] = next; i++;
  }
  return a;
}

const argv = parseArgs(process.argv.slice(2));
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

const opt = {
  file: argv._[0],
  cols: int(argv.cols, 0),
  rows: int(argv.rows, 0),
  inset: num(argv.inset, 0.20),
  white: num(argv.white, 0.90),
  sat: num(argv.sat, 0.10),
  ink: num(argv.ink, 0.10),   // 整格里"画上去的"像素占比低于这个值 + 中心是纸白 → 判空
  crop: argv.crop ? String(argv.crop).split(',').map(Number) : null,
  autocrop: argv['no-autocrop'] ? false : true,
  margin: int(argv.margin, 0),
  maxColors: int(argv.maxColors, 10),
  denoise: int(argv.denoise, 1),
  keepBg: !!argv['keep-bg'],
  palette: String(argv.palette || 'standard'),
  id: argv.id ? String(argv.id) : null,
  name: argv.name ? String(argv.name) : null,
  tags: argv.tags ? String(argv.tags) : null,
  hot: !!argv.hot,
  out: argv.out ? resolve(String(argv.out)) : null,
  preview: argv.preview ? resolve(String(argv.preview)) : null,
  cropDebug: argv['crop-debug'] ? resolve(String(argv['crop-debug'])) : null,
  strictEmpty: !!argv['strict-empty'],
  install: !!argv.install,
  bucket: int(argv.bucket, 3),   // 众数分桶：每通道右移位数（3 → 32 级）
};

if (!opt.file || !opt.cols || !opt.rows || argv.help || argv.h) {
  console.log(`
图纸截图 → art.js 条目

  node tools/extract-art.mjs <图纸.png> --cols 52 --rows 52 --id xxx --name "中文名"

必填：图纸路径、--cols、--rows
自动找不到图纸区域时，用 --crop x,y,w,h 手动指定，或者 --crop-debug 导图看一眼。
`);
  process.exit(opt.file && opt.cols && opt.rows ? 0 : 2);
}

/* ============================ 找浏览器 ============================ */

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function safeReaddir(p) {
  try { return readdirSync(p); } catch { return []; }
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  const home = process.env.LOCALAPPDATA || process.env.HOME || '';
  for (const r of [join(home, 'ms-playwright'), join(home, 'Library', 'Caches', 'ms-playwright'), join(home, '.cache', 'ms-playwright')]) {
    if (!existsSync(r)) continue;
    for (const dir of safeReaddir(r)) {
      for (const sub of ['chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(r, dir, sub);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

async function loadPuppeteer() {
  for (const name of ['puppeteer-core', 'puppeteer']) {
    try { return await import(name); } catch { /* 换下一个 */ }
  }
  throw new Error(
    '没有找到 puppeteer。请在 pixel-bead-studio 目录执行：\n' +
    '    npm i -D puppeteer-core\n' +
    '（只装 puppeteer-core 就行，浏览器用系统已装的 Chrome / Edge）'
  );
}

/* ============================ 页内像素活 ============================ */

/**
 * 这段在浏览器里跑。返回每格代表色 + 检测到的图纸区域 (+ 可选的框选调试图)。
 * 只回传 cols*rows 个小数组，几十 KB，不会把 CDP 撑爆。
 */
const EXTRACT_FN = `
(async (o) => {
  const img = new Image();
  img.decoding = 'sync';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('图片解码失败')); img.src = o.dataUrl; });
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) throw new Error('图片是空的');

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;

  const lumOf = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const satOf = (r, g, b) => { const mx = Math.max(r, g, b); return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx; };
  const isBg = (r, g, b, a) => a < 40 || (r > 236 && g > 236 && b > 236);

  // ---------- A. 内容外接框（兜底用） ----------
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (isBg(px[i], px[i + 1], px[i + 2], px[i + 3])) continue;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  if (bx1 < bx0 || by1 < by0) { bx0 = 0; by0 = 0; bx1 = W - 1; by1 = H - 1; }
  const bbox = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };

  // ---------- B. 网格线检测 → lattice 拟合 ----------
  // 图纸的格线 = 低饱和、偏亮但不纯白的长直线。
  const isLine = (i) => {
    const a = px[i + 3]; if (a < 40) return false;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const l = lumOf(r, g, b);
    return satOf(r, g, b) < 0.12 && l > 0.58 && l < 0.970;
  };
  const colScore = new Int32Array(W), rowScore = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isLine((y * W + x) * 4)) continue;
      colScore[x]++; rowScore[y]++;
    }
  }
  const groupLines = (score, len) => {
    let max = 0;
    for (let i = 0; i < len; i++) if (score[i] > max) max = score[i];
    if (max < 8) return [];
    const th = max * 0.55;
    const out = [];
    let run = -1;
    for (let i = 0; i <= len; i++) {
      const on = i < len && score[i] >= th;
      if (on && run < 0) run = i;
      if (!on && run >= 0) { out.push((run + i - 1) / 2); run = -1; }
    }
    return out;
  };
  // 在候选线里挑最均匀的 n+1 条（图纸格线就是这个等差数列）
  const fitLattice = (lines, n) => {
    if (lines.length < n + 1) return null;
    const need = n + 1;
    let best = null;
    const near = (v) => {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < lines.length; k++) { const d = Math.abs(lines[k] - v); if (d < bd) { bd = d; bi = k; } }
      return lines[bi];
    };
    for (let i = 0; i + need - 1 < lines.length; i++) {
      for (let j = i + need - 1; j < lines.length; j++) {
        const pitch = (lines[j] - lines[i]) / n;
        if (pitch < 2.5) continue;
        let err = 0;
        for (let k = 1; k < n; k++) err += Math.abs(near(lines[i] + k * pitch) - (lines[i] + k * pitch));
        err /= (n - 1);
        if (err > pitch * 0.34) continue;
        const score = err + pitch * 0.002 * (j - i - n);   // 同等误差下优先"线更连贯"的解
        if (!best || score < best.score) best = { a: lines[i], b: lines[j], pitch, err, score };
      }
    }
    return best;
  };

  let region = null, how = 'bbox';
  if (o.autocrop) {
    const vLines = groupLines(colScore, W);
    const hLines = groupLines(rowScore, H);
    const fx = fitLattice(vLines, o.cols);
    const fy = fitLattice(hLines, o.rows);
    if (fx && fy) {
      region = { x: Math.round(fx.a), y: Math.round(fy.a), w: Math.round(fx.b - fx.a), h: Math.round(fy.b - fy.a) };
      how = 'gridlines';
    } else {
      region = { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
      how = 'bbox(' + (fx ? '' : '竖线没拟合上') + (fy ? '' : ' 横线没拟合上') + ')';
    }
  } else {
    region = { x: 0, y: 0, w: W, h: H };
    how = 'none';
  }
  if (o.crop) { region = { x: o.crop[0], y: o.crop[1], w: o.crop[2], h: o.crop[3] }; how = 'manual'; }
  if (o.margin) {
    region = {
      x: Math.max(0, region.x - o.margin), y: Math.max(0, region.y - o.margin),
      w: region.w + o.margin * 2, h: region.h + o.margin * 2,
    };
  }

  const cw = region.w / o.cols, ch = region.h / o.rows;

  // ---------- C. 逐格：中心区域众数色 ----------
  //
  // ---------- C. 逐格：中心区域众数色 + "这一格到底画没画豆子" ----------
  //
  // 判空不能只看"中心是不是白的"：白豆子（线条小狗整个身子都是白的）画在白纸上
  // 一点区别都没有，一刀切会把整只狗判没。
  //
  // 试过"纸面连通性"（从画布边缘洪水填充，只有连通到边的白才算空）—— 不行：
  // 图纸里的豆子常常是**一个个分开的圆**，圆与圆之间留的缝就是白纸，深色描边
  // 因此不是一堵连续的墙，白色区域照样漏到外面去，整只狗还是被判没。
  //
  // 最后用的判据是"这一格里有没有画东西"：
  //   ink = 既不是纸白、也不是格线灰的像素
  //   空格  → 除了格线什么都没有，ink 占比 ≈ 0
  //   白豆子 → 圆的边缘有渐变/描边（比格线暗），ink 占比很高
  // 判空 = 中心区域是纸白 且 整格 ink 占比 < 阈值。
  const paperWhite = new Uint8Array(W * H);   // 纸白（判空 + 统计众数时参考）
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (px[i + 3] < 40) { paperWhite[p] = 1; continue; }
    if (o.strictEmpty) continue;
    const l = lumOf(px[i], px[i + 1], px[i + 2]);
    if (l < o.white) continue;
    if (satOf(px[i], px[i + 1], px[i + 2]) > o.sat) continue;
    paperWhite[p] = 1;
  }
  // 这一格"到底画没画豆子"的判据：把格子**去掉一圈边界带**（格线就在边界上），
  // 看里面还有多少像素不是纸白。
  //   空格  → 里面全是纸 → ink ≈ 0
  //   白豆子 → 圆的边缘那圈渐变比纸暗 → ink 很高
  // 一开始想按"这像素是不是格线灰"来排除格线，结果白豆子的渐变正好穿过格线灰
  // 那个亮度区间，白豆子被当成格线，整只线条小狗还是判没。改成"挖掉边界带"后
  // 就干净了：格线本来就在边界上，挖掉即可，格内像素一律按"是不是纸白"算。
  const borderPx = Math.max(1, Math.round(Math.min(cw, ch) * 0.12));

  const mode = new Array(o.cols * o.rows).fill(null);
  const inkRatio = new Float32Array(o.cols * o.rows);
  const whiteRatio = new Float32Array(o.cols * o.rows);
  for (let gy = 0; gy < o.rows; gy++) {
    for (let gx = 0; gx < o.cols; gx++) {
      const x0 = Math.round(region.x + gx * cw);
      const x1 = Math.round(region.x + (gx + 1) * cw);
      const y0 = Math.round(region.y + gy * ch);
      const y1 = Math.round(region.y + (gy + 1) * ch);
      const ix = Math.max(1, Math.round((x1 - x0) * o.inset));
      const iy = Math.max(1, Math.round((y1 - y0) * o.inset));
      const idx = gy * o.cols + gx;

      // C1) 格内（挖掉边界带）的 ink 占比
      let ink = 0, cellN = 0, white = 0;
      for (let y = y0 + borderPx; y < y1 - borderPx; y++) {
        if (y < 0 || y >= H) continue;
        for (let x = x0 + borderPx; x < x1 - borderPx; x++) {
          if (x < 0 || x >= W) continue;
          const p = y * W + x, i = p * 4;
          cellN++;
          if (px[i + 3] < 40) continue;
          if (paperWhite[p]) { white++; continue; }
          ink++;
        }
      }
      inkRatio[idx] = cellN ? ink / cellN : 0;
      whiteRatio[idx] = cellN ? white / cellN : 0;

      // C2) 中心 60% 的众数色
      const bins = new Map();
      let opaque = 0;
      for (let y = y0 + iy; y < y1 - iy; y++) {
        if (y < 0 || y >= H) continue;
        for (let x = x0 + ix; x < x1 - ix; x++) {
          if (x < 0 || x >= W) continue;
          const i = (y * W + x) * 4;
          if (px[i + 3] < 40) continue;
          opaque++;
          const r = px[i], g = px[i + 1], b = px[i + 2];
          const key = ((r >> o.bucket) << 10) | ((g >> o.bucket) << 5) | (b >> o.bucket);
          let e = bins.get(key);
          if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, e); }
          e.n++; e.r += r; e.g += g; e.b += b;
        }
      }
      if (!opaque) continue;
      let best = null;
      for (const e of bins.values()) if (!best || e.n > best.n) best = e;
      mode[idx] = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
    }
  }

  // ---------- D. 框选调试图 ----------
  let debug = null;
  if (o.cropDebug) {
    const s = Math.min(1, 1100 / Math.max(W, H));
    const dw = Math.round(W * s), dh = Math.round(H * s);
    const dc = document.createElement('canvas');
    dc.width = dw; dc.height = dh;
    const d = dc.getContext('2d');
    d.drawImage(cv, 0, 0, dw, dh);
    d.strokeStyle = '#ff2d55'; d.lineWidth = 2;
    d.strokeRect(region.x * s, region.y * s, region.w * s, region.h * s);
    d.fillStyle = 'rgba(0,216,255,.85)';
    for (let gy = 0; gy < o.rows; gy++) {
      for (let gx = 0; gx < o.cols; gx++) {
        const cx = (region.x + (gx + .5) * cw) * s, cy = (region.y + (gy + .5) * ch) * s;
        d.fillRect(cx - 0.6, cy - 0.6, 1.6, 1.6);
      }
    }
    debug = dc.toDataURL('image/png').split(',')[1];
  }

  return {
    W, H, bbox, region, how, mode, debug, pitchX: cw, pitchY: ch,
    inkRatio: Array.from(inkRatio),
    whiteRatio: Array.from(whiteRatio),
    paperPx: paperWhite.reduce((a, b) => a + b, 0),
  };
})
`;

/* ============================ 主流程 ============================ */

const puppeteer = await loadPuppeteer();
const exe = findChrome();
if (!exe) throw new Error('找不到 Chrome / Edge，可用 PUPPETEER_EXECUTABLE_PATH 指定');

console.log(`[1/6] 打开图纸 ${basename(opt.file)}`);
const bytes = await readFile(resolve(opt.file));
const dataUrl = `data:${mimeOf(opt.file)};base64,${bytes.toString('base64')}`;

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
});
let raw;
try {
  const page = await browser.newPage();
  raw = await page.evaluate(`${EXTRACT_FN}(${JSON.stringify({
    dataUrl, cols: opt.cols, rows: opt.rows, inset: opt.inset,
    autocrop: opt.autocrop, margin: opt.margin, crop: opt.crop,
    bucket: opt.bucket, cropDebug: !!opt.cropDebug,
    white: opt.white, sat: opt.sat, strictEmpty: opt.strictEmpty,
  })})`);
} finally {
  await browser.close();
}

const { W, H, bbox, region, how, mode, debug, pitchX, pitchY, inkRatio, whiteRatio, paperPx } = raw;
console.log(`[2/6] 图片 ${W}×${H}　内容框 x=${bbox.x} y=${bbox.y} w=${bbox.w} h=${bbox.h}`);
console.log(`      纸白像素 ${paperPx} / ${W * H}（${((paperPx / (W * H)) * 100).toFixed(1)}%）`);
console.log(`      图纸区域 x=${region.x} y=${region.y} w=${region.w} h=${region.h}　(来源: ${how})`);
console.log(`      格距 ${pitchX.toFixed(2)} × ${pitchY.toFixed(2)} px　→ ${opt.cols}×${opt.rows} 格，每格取中心 ${((1 - opt.inset * 2) * 100).toFixed(0)}%`);

if (opt.cropDebug && debug) {
  await mkdir(dirname(opt.cropDebug), { recursive: true });
  await writeFile(opt.cropDebug, Buffer.from(debug, 'base64'));
  console.log(`      框选调试图 ${opt.cropDebug}（红框 = 采样区域，青点 = 每格中心）`);
}

/* ---- 3) 判空 + 落色 ---- */

const card = (BEAD_SETS[opt.palette] || BEAD_SETS.standard).colors.map((c) => c[1]);
let keptWhite = 0;
const cells = mode.map((rgb, idx) => {
  if (!rgb) return { empty: true, reason: '透明' };
  const hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
  const blankish = isNearWhite(rgb, opt.white, opt.sat) || whiteRatio[idx] >= 0.6;
  // 空格 = 中心（或整格）是纸白，并且这一格里几乎没有"画上去的东西"
  if (!opt.keepBg && blankish && (opt.strictEmpty || inkRatio[idx] < opt.ink)) {
    return { empty: true, reason: opt.strictEmpty ? '近白' : `空格(ink=${(inkRatio[idx] * 100).toFixed(1)}%)` };
  }
  if (blankish) keptWhite++;
  return { empty: false, hex, snapped: nearestColor(hex, card) };
});

const emptyN = cells.filter((c) => c.empty).length;
console.log(`[3/6] 判空 ${emptyN} 格 / 共 ${cells.length} 格`
  + `（纸白阈值 ${opt.white}/${opt.sat}，ink 阈值 ${opt.ink}${opt.strictEmpty ? '，strict-empty' : ''}）`);
if (keptWhite > 0) {
  console.log(`      其中 ${keptWhite} 格虽然是白的、但格子里有豆子的边缘 —— 按白豆子保留`);
}

/* ---- 4) 删孤立浅色噪点 ---- */

if (opt.denoise > 0) {
  let total = 0;
  for (let pass = 0; pass < opt.denoise; pass++) total += denoise(cells, opt.cols, opt.rows);
  console.log(`[4/6] 删掉孤立浅色噪点 ${total} 个（${opt.denoise} 遍）`);
} else {
  console.log('[4/6] 跳过降噪');
}

/* ---- 5) 压色数 ---- */

const counts = new Map();
for (const c of cells) if (!c.empty) counts.set(c.snapped, (counts.get(c.snapped) || 0) + 1);
let kept = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
if (opt.maxColors > 0 && kept.length > opt.maxColors) {
  const keepSet = kept.slice(0, opt.maxColors);
  console.log(`[5/6] 色数 ${kept.length} > ${opt.maxColors}，把用得最少的 ${kept.length - keepSet.length} 色并到最近的保留色`);
  for (const c of cells) {
    if (c.empty || keepSet.includes(c.snapped)) continue;
    c.snapped = nearestColor(c.snapped, keepSet, { hueBias: false });
  }
  kept = keepSet;
} else {
  console.log(`[5/6] 用色 ${kept.length} 种`);
}

const palette = kept;
const rowsArt = [];
const usage = new Array(palette.length).fill(0);
for (let y = 0; y < opt.rows; y++) {
  let s = '';
  for (let x = 0; x < opt.cols; x++) {
    const c = cells[y * opt.cols + x];
    if (c.empty) { s += '.'; continue; }
    const i = palette.indexOf(c.snapped);
    if (i < 0) { s += '.'; continue; }
    usage[i]++;
    s += CHARS[i];
  }
  rowsArt.push(s);
}
const filled = usage.reduce((a, b) => a + b, 0);

const entry = {
  id: opt.id || slug(basename(opt.file)),
  name: opt.name || opt.id || slug(basename(opt.file)),
  bead: opt.palette === 'mini' ? 'mini' : opt.palette === 'glow' ? 'glow' : 'standard',
  size: `${opt.cols}x${opt.rows}`,
  tags: opt.tags ? opt.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [opt.palette === 'mini' ? '迷你豆' : '标准豆', `${palette.length}色`, `约${((filled * 6) / 3600).toFixed(1)}小时`],
  ...(opt.hot ? { hot: true } : {}),
  palette,
  art: rowsArt,
};

/* ---- 6) 输出 ---- */

const entryText = toEntrySource(entry);
if (opt.out) {
  await mkdir(dirname(opt.out), { recursive: true });
  await writeFile(opt.out, entryText + '\n', 'utf8');
  console.log(`[6/6] 条目已写到 ${opt.out}`);
}
if (opt.preview) {
  await mkdir(dirname(opt.preview), { recursive: true });
  await writeFile(opt.preview, Buffer.from(await previewPng(entry), 'base64'));
  console.log(`      预览图 ${opt.preview}`);
}
if (!opt.out && !opt.install && !opt.preview) console.log('\n' + entryText + '\n');

console.log(`
—— 结果 ——
  画布      ${opt.cols} × ${opt.rows}
  有效格    ${filled} / ${opt.cols * opt.rows}（${((filled / (opt.cols * opt.rows)) * 100).toFixed(1)}%）
  颜色      ${palette.length} 种
${palette.map((h, i) => `            ${h}  × ${String(usage[i]).padStart(5)}`).join('\n')}
`);

if (opt.install) {
  const ok = await installIntoArt(entryText);
  if (!ok) process.exit(1);
}

/* ============================ 实现细节 ============================ */

/** 近白判空：亮 + 低饱和。只看亮度会把浅黄/浅蓝的豆子一起清掉。 */
function isNearWhite([r, g, b], whiteThreshold, satThreshold) {
  const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (l < whiteThreshold) return false;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  return sat <= satThreshold;
}

/**
 * 孤立浅色噪点：8 邻域里有豆的邻居 ≤ 1，且自己偏亮 → 图纸上的反光 / 网格线残留。
 * 不删深色孤立点 —— 那可能是眼睛高光、鼻尖这类真实细节。
 */
function denoise(cells, cols, rows) {
  const kill = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const c = cells[i];
      if (c.empty) continue;
      if (luminance(c.snapped) < 0.72) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          if (!cells[ny * cols + nx].empty) n++;
        }
      }
      if (n <= 1) kill.push(i);
    }
  }
  for (const i of kill) cells[i] = { empty: true, reason: '孤立浅色噪点' };
  return kill.length;
}

/** 生成 art.js 里的条目源码（格式和现有条目完全一致） */
function toEntrySource(e) {
  const q = (s) => (/'/.test(s) ? JSON.stringify(s) : `'${s}'`);
  const lines = [];
  lines.push('  {');
  lines.push(`    id: ${q(e.id)}, name: ${q(e.name)}, bead: ${q(e.bead)}, size: ${q(e.size)}, tags: [${e.tags.map(q).join(', ')}]${e.hot ? ', hot: true' : ''},`);
  lines.push(`    palette: [${e.palette.map(q).join(', ')}],`);
  lines.push('    art: [');
  for (const r of e.art) lines.push(`      ${q(r)},`);
  lines.push('    ],');
  lines.push('  },');
  return lines.join('\n');
}

/** 插到 ART 数组头部（同 id 幂等替换），写完做语法 + 加载双重自检，失败回滚 */
async function installIntoArt(source) {
  const before = await readFile(ART_JS, 'utf8');
  const anchor = 'const ART = [';
  const at = before.indexOf(anchor);
  if (at < 0) { console.error('art.js 里找不到 `const ART = [`，已放弃写入'); return false; }

  let next = before;
  const id = /id:\s*'([^']+)'/.exec(source)?.[1];
  if (id) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\n  \\{\\n    id: '${safe}',[\\s\\S]*?\\n  \\},`);
    if (re.test(next)) { next = next.replace(re, ''); console.log(`       art.js 里原有 id='${id}' 的条目已移除（幂等替换）`); }
  }
  next = next.replace(anchor, `${anchor}\n${source}`);

  const tmp = join(STUDIO, `.art-check-${process.pid}.mjs`);
  await writeFile(tmp, next, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (err) {
    console.error('语法自检失败，已回滚，art.js 没被动过：\n' + String(err.stderr || err.message));
    await unlink(tmp).catch(() => {});
    return false;
  }
  await unlink(tmp).catch(() => {});
  await writeFile(ART_JS, next, 'utf8');

  try {
    const mod = await import(pathToFileURL(ART_JS).href + '?t=' + Date.now());
    const item = mod.LIBRARY.find((x) => x.id === id);
    if (!item) throw new Error('写进去了但 LIBRARY 里找不到这个 id');
    const st = item.grid.counts();
    console.log(`       已装入 art.js：${item.name} ${item.grid.cols}×${item.grid.rows} · ${st.colors} 色 · ${st.filled} 颗`);
    return true;
  } catch (err) {
    await writeFile(ART_JS, before, 'utf8');
    console.error('装入后加载失败，已回滚：' + err.message);
    return false;
  }
}

/* ---- 预览 PNG：手写 PNG，不依赖 canvas ---- */

async function previewPng(e) {
  const { deflateSync } = await import('node:zlib');
  const cell = Math.max(4, Math.floor(900 / Math.max(e.art[0].length, e.art.length)));
  const W = e.art[0].length * cell, H = e.art.length * cell;
  const rgba = Buffer.alloc(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = (((x / 12) | 0) + ((y / 12) | 0)) % 2 === 0 ? 245 : 232;
      rgba[i] = t; rgba[i + 1] = t; rgba[i + 2] = t; rgba[i + 3] = 255;
    }
  }
  e.art.forEach((row, gy) => {
    [...row].forEach((ch, gx) => {
      const ci = CHARS.indexOf(ch);
      if (ci < 0 || ci >= e.palette.length) return;
      const { r, g, b } = hexToRgb(e.palette[ci]);
      const pad = Math.max(1, Math.round(cell * 0.07));
      for (let y = gy * cell + pad; y < (gy + 1) * cell - pad; y++) {
        for (let x = gx * cell + pad; x < (gx + 1) * cell - pad; x++) {
          const i = (y * W + x) * 4;
          rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
        }
      }
    });
  });

  const stride = W * 4 + 1;
  const raw = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

/** CRC 表挂在函数自身上：这样 previewPng 在模块中段被调用时不会撞上 let 的 TDZ */
function crc32(buf) {
  if (!crc32.table) {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    crc32.table = t;
  }
  const table = crc32.table;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function mimeOf(p) {
  const e = extname(p).toLowerCase();
  return e === '.jpg' || e === '.jpeg' ? 'image/jpeg'
    : e === '.webp' ? 'image/webp'
      : e === '.gif' ? 'image/gif'
        : e === '.bmp' ? 'image/bmp'
          : 'image/png';
}

function slug(s) {
  return String(s).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'art';
}
