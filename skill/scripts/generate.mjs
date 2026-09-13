#!/usr/bin/env node
/**
 * 拼豆图案生成器 CLI
 *
 *   node generate.mjs art <spec.mjs>      --cols 20 --preview out.png
 *   node generate.mjs code <art.mjs>      --cols 48 --rows 48
 *   node generate.mjs image <photo.png>   --cols 29
 *   node generate.mjs check <pattern.json>
 *
 * 三条路径的统一出口都是一个"图案 JSON"：
 *   { cols, rows, palette: ['#RRGGBB'], rows_art: ['0123..', ...], stats }
 * 行字符串格式的好处：git diff 看得懂，人工能直接改，也能被 chars.mjs 编回来。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, basename, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compileArt, decompileArt, auditArt, installIntoArtJs } from './lib/chars.mjs';
import { canvas, toBeads } from './lib/art.mjs';
import { renderPreview, asciiPreview } from './lib/preview.mjs';
import { loadImage, imageToRaster } from './lib/trace.mjs';
import { quantizeToBeads, addOutline, PALETTES, getPalette, paletteHexes } from './lib/palette.mjs';
import { encodeIndexedPNG } from './lib/png.mjs';

const IDX_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/* ---------------- 参数解析 ---------------- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const num = (v, d) => (v === undefined ? d : Number(v));
const bool = (v) => v === true || v === '1' || v === 'true' || v === 'yes';

/* ---------------- 图案 JSON 读写 ---------------- */

function gridToJSON(grid, extra = {}) {
  let maxIdx = -1;
  for (const v of grid.idx) if (v > maxIdx) maxIdx = v;
  if (maxIdx >= 36) throw new Error(`颜色数 ${maxIdx + 1} 超过 36，行字符串格式放不下`);

  const rowsArt = [];
  for (let y = 0; y < grid.rows; y++) {
    let s = '';
    for (let x = 0; x < grid.cols; x++) {
      const v = grid.idx[y * grid.cols + x];
      s += v < 0 ? '.' : IDX_CHARS[v];
    }
    rowsArt.push(s);
  }

  return {
    format: 'pixel-bead-pattern/v1',
    name: grid.name || extra.name || 'untitled',
    source: extra.source || 'unknown',
    cols: grid.cols,
    rows: grid.rows,
    palette: grid.palette,
    rows_art: rowsArt,
    stats: {
      filled: grid.stats.filled,
      empty: grid.stats.empty,
      colors: grid.stats.colors,
      hours: grid.stats.hours,
      sizeMm: grid.stats.sizeMm || null,
      beadSet: grid.beadSet || null,
    },
    generatedAt: new Date().toISOString(),
  };
}

function jsonToGrid(json) {
  const cols = json.cols, rows = json.rows;
  const idx = new Int16Array(cols * rows).fill(-1);
  json.rows_art.forEach((line, y) => {
    [...line].forEach((ch, x) => {
      const v = IDX_CHARS.indexOf(ch.toLowerCase());
      if (v >= 0 && x < cols && y < rows) idx[y * cols + x] = v;
    });
  });
  const counts = new Array(json.palette.length).fill(0);
  let filled = 0;
  for (const v of idx) if (v >= 0) { counts[v]++; filled++; }
  return {
    cols, rows, idx, palette: json.palette.slice(), name: json.name,
    beadSet: json.stats?.beadSet || null,
    stats: {
      filled, empty: cols * rows - filled,
      colors: counts.filter((c) => c > 0).length,
      counts,
      hours: Number(((filled * 6) / 3600).toFixed(2)),
      sizeMm: json.stats?.sizeMm || null,
    },
  };
}

export { gridToJSON, jsonToGrid };

/* ---------------- 输出 ---------------- */

async function writeOut(path, data) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, data);
}

async function emit(grid, args, source) {
  const json = gridToJSON(grid, { source, name: args.name });
  const outJson = args.out || null;
  const report = { ...json };

  console.log(`\n图案：${json.name}  ${grid.cols}×${grid.rows}  ${grid.stats.colors} 色  ${grid.stats.filled} 颗豆`);
  if (grid.stats.sizeMm) console.log(`成品尺寸约：${grid.stats.sizeMm.w} × ${grid.stats.sizeMm.h} mm`);
  console.log(`预计耗时：约 ${grid.stats.hours} 小时`);
  console.log('调色板：' + grid.palette.join(' '));

  const issues = auditArt(grid);
  if (issues.length) {
    console.log('\n质量自检提示：');
    issues.forEach((s) => console.log('  ! ' + s));
  } else {
    console.log('\n质量自检：未发现明显问题');
  }

  if (outJson) {
    await writeOut(outJson, JSON.stringify(json, null, 2));
    console.log(`\n图案 JSON → ${outJson}`);
  }

  if (args.preview) {
    const style = args.style || 'bead';
    const r = renderPreview(grid, {
      style,
      gap: num(args.gap, style === 'led' ? 0.18 : 0.16),
      glow: num(args.glow, 0.55),
      label: args.label === undefined ? json.name : args.label,
      ledShape: args.ledShape,
      cellPx: num(args.cell, undefined),
    });
    await writeOut(args.preview, r.png);
    console.log(`预览图(${style}) → ${args.preview}  ${r.width}×${r.height}`);
    if (r.labelDropped) {
      console.log(`  （预览图左上角的标签只支持 ASCII，已去掉 ${r.labelDropped} 个非 ASCII 字符 —— 图案本身不受影响）`);
    }
  }

  if (args.png) {
    // 索引色 PNG：体积最小，也是固件友好的格式
    const png = encodeIndexedPNG(grid.cols, grid.rows, grid.idx, grid.palette);
    await writeOut(args.png, png);
    console.log(`索引色 PNG → ${args.png}  ${png.length} 字节`);
  }

  if (args.ascii) {
    console.log('\n点阵预览（0-9a-z = 调色板下标，· = 空）：');
    console.log(asciiPreview(grid));
  }

  if (args.json) console.log('\n' + JSON.stringify(report, null, 2));

  return json;
}

/* ---------------- 三条路径 ---------------- */

async function cmdArt(args) {
  const file = args._[1];
  if (!file) throw new Error('用法：generate.mjs art <spec.mjs>');
  const mod = await import(pathToFileURL(resolve(file)).href);
  const spec = mod.default || mod.art || mod;
  const grid = compileArt(spec, { allowRagged: bool(args.allowRagged) });
  for (const w of grid.warnings) console.log('[警告] ' + w);
  return emit(grid, args, 'art:' + basename(file));
}

async function cmdCode(args) {
  const file = args._[1];
  if (!file) throw new Error('用法：generate.mjs code <art.mjs> --cols N --rows N');
  const mod = await import(pathToFileURL(resolve(file)).href);
  const fn = mod.default || mod.art;
  if (typeof fn !== 'function') {
    throw new Error('code 路径的模块必须默认导出一个函数（参数是 { canvas, hsl, mix, shade }）');
  }
  const cols = num(args.cols, 48);
  const rows = num(args.rows, 48);
  const scale = num(args.scale, 8);

  // ★ 注意别把 canvas() 直接命名为 canvas 传进去：调用方写
  //   export default function ({ canvas }) {...} 时会和外面的 canvas 撞名。
  //   所以这里同时给一个 mc（make canvas）别名，SKILL.md 里教大家用 mc。
  const artLib = await import('./lib/art.mjs');
  const cvs = artLib.canvas({ w: cols, h: rows, scale, background: args.bg || null });
  await fn({
    mc: artLib.canvas,
    canvas: artLib.canvas,
    cr: cvs,
    c: cvs,
    hsl: artLib.hsl,
    mix: artLib.mix,
    shade: artLib.shade,
    cols, rows,
  });
  if (args.debugBounds) cvs.debugBounds();

  const grid = toBeads(cvs, {
    cols, rows,
    palette: args.palette || 'hama_standard',
    maxColors: num(args.maxColors, 0),
    dither: args.dither === undefined ? true : bool(args.dither),
    outline: args.outline && !args.outlineColor ? true : false,
    outlineColor: args.outlineColor || null,
    alphaThreshold: num(args.alphaThreshold, 0.5),
    transparent: args.transparent === undefined ? true : bool(args.transparent),
  });
  return emit(grid, args, 'code:' + basename(file));
}

async function cmdImage(args) {
  const file = args._[1];
  if (!file) throw new Error('用法：generate.mjs image <photo.png> --cols 29');
  const img = await loadImage(file, { verbose: bool(args.verbose), maxSide: num(args.maxSide, 320) });
  console.log(`已解码：${img.width}×${img.height}`);
  const cols = num(args.cols, 29);
  const rows = num(args.rows, 0) || Math.max(1, Math.round((img.height / img.width) * cols));

  const keyOut = args.keyColor ? { color: args.keyColor, tolerance: num(args.keyTolerance, 0.15) } : null;
  const raster = imageToRaster(img, {
    cols, rows,
    fit: args.fit || 'cover',
    brightness: num(args.brightness, 1),
    contrast: num(args.contrast, 1),
    saturation: num(args.saturation, 1),
    invert: bool(args.invert),
    threshold: num(args.threshold, 0),
    keyOut,
  });

  let grid = quantizeToBeads(raster.sample(cols, rows), args.palette || 'hama_standard', {
    maxColors: num(args.maxColors, 0),
    dither: args.dither === undefined ? true : bool(args.dither),
    alphaThreshold: num(args.alphaThreshold, 0.5),
    transparent: args.transparent === undefined ? true : bool(args.transparent),
  });
  if (bool(args.outline)) grid = addOutline(grid);
  return emit(grid, args, 'image:' + basename(file));
}

async function cmdCheck(args) {
  const file = args._[1];
  if (!file) throw new Error('用法：generate.mjs check <pattern.json>');
  const json = JSON.parse(await readFile(file, 'utf8'));
  const grid = jsonToGrid(json);

  console.log(`图案：${json.name}  ${grid.cols}×${grid.rows}  ${grid.stats.colors} 色  ${grid.stats.filled} 颗`);

  // 行宽一致性
  const bad = json.rows_art.map((r, i) => (r.length !== grid.cols ? i : -1)).filter((i) => i >= 0);
  console.log(bad.length ? `✗ 有 ${bad.length} 行宽度不对：${bad.slice(0, 5).join(',')}` : '✓ 行宽一致');

  // 索引越界
  let oob = 0;
  json.rows_art.forEach((line) => [...line].forEach((ch) => {
    const v = IDX_CHARS.indexOf(ch.toLowerCase());
    if (v >= json.palette.length) oob++;
  }));
  console.log(oob ? `✗ 有 ${oob} 个格子索引越界` : '✓ 索引都在调色板范围内');

  const issues = auditArt(grid);
  if (issues.length) {
    console.log('质量提示：');
    issues.forEach((s) => console.log('  ! ' + s));
  } else {
    console.log('✓ 质量自检通过');
  }

  // 顺手生成预览
  if (args.preview) {
    const { png, width, height } = renderPreview(grid, { style: args.style || 'bead', label: json.name });
    await writeOut(args.preview, png);
    console.log(`预览图 → ${args.preview}  ${width}×${height}`);
  }
  return json;
}

async function cmdInstall(args) {
  const file = args._[1];
  if (!file) throw new Error('用法：generate.mjs install <pattern.json> [--art <art.js 路径>]');
  const pattern = JSON.parse(await readFile(file, 'utf8'));

  // 默认目标：工作区里的 pixel-bead-studio/js/art.js
  const candidates = [
    args.art,
    join(process.cwd(), 'pixel-bead-studio', 'js', 'art.js'),
    join(process.cwd(), '..', 'pixel-bead-studio', 'js', 'art.js'),
  ].filter(Boolean);

  let target = null;
  for (const c of candidates) {
    if (existsSync(resolve(c))) { target = resolve(c); break; }
  }
  if (!target) {
    throw new Error('找不到 art.js。请用 --art 指定路径，或在 pixel-bead-studio 的上一级目录运行。\n'
      + '尝试过：\n  ' + candidates.map(resolve).join('\n  '));
  }

  const before = await readFile(target, 'utf8');

  // 允许在安装时改名/改标签 —— 图案 JSON 里的 name 常常是英文文件名，
  // 直接进图案库会显示成 "three-little-pigs-cutout" 这种机器名，很难看
  const patched = { ...pattern };
  if (args.name) patched.name = args.name;

  const { text, action, id, name } = installIntoArtJs(before, patched, {
    id: args.id,
    beadSet: args.beadSet,
    hot: bool(args.hot),
    tags: args.tags ? String(args.tags).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });

  // 写入前先验证产物语法正确 —— 宁可失败也不要污染图案库
  await writeFile(target, text, 'utf8');
  const check = runNodeCheck(target);
  if (!check.ok) {
    await writeFile(target, before, 'utf8');   // 回滚
    throw new Error(`写入后语法检查失败，已回滚。node --check 输出：\n${check.out}`);
  }

  const count = (text.match(/\n  \{\n    id: '/g) || []).length;
  console.log(`${action === 'added' ? '已添加' : '已替换'}图案 "${name}" (id: ${id})`);
  console.log(`目标文件：${target}`);
  console.log(`图案库现有 ${count} 个图案`);
  console.log('语法自检：通过');
  return { action, id, name, target };
}

function runNodeCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

async function cmdPalette(args) {
  const id = args._[1];
  if (id) {
    const p = getPalette(id);
    console.log(`${id} — ${p.name}（豆径 ${p.dot}mm，${p.colors.length} 色）`);
    p.colors.forEach(([code, hex, name]) => console.log(`  ${code}  ${hex}  ${name}`));
    if (args.preview) {
      // 把色卡本身画成一张图，方便肉眼比对实物豆色
      const cols = 7;
      const rows = Math.ceil(p.colors.length / cols);
      const idx = new Int16Array(cols * rows).fill(-1);
      p.colors.forEach((_, i) => { idx[i] = i; });
      const grid = { cols, rows, idx, palette: p.colors.map((c) => c[1]), stats: { filled: p.colors.length, colors: p.colors.length } };
      const { png } = renderPreview(grid, { style: 'bead', label: id, cellPx: 40 });
      await writeOut(args.preview, png);
      console.log(`色卡预览 → ${args.preview}`);
    }
  } else {
    console.log('可用色卡：');
    for (const [k, v] of Object.entries(PALETTES)) {
      console.log(`  ${k.padEnd(16)} ${v.name}  ${v.colors.length} 色  ${v.dot}mm`);
    }
  }
}

/* ---------------- 入口 ---------------- */

const HELP = `拼豆图案生成器

用法：node generate.mjs <命令> [参数]

命令：
  art <spec.mjs>        路径A：手绘字符画 → 图案
  code <art.mjs>        路径B：几何代码绘图 → 图案（适合复杂结构）
  image <图片>          路径C：照片/图片 → 图案
  check <pattern.json>  校验图案并出预览
  install <pattern.json>  把图案加进 pixel-bead-studio 的图案库（幂等）
  palette [色卡名]      列出色卡

install 参数：
  --art <path>          指定 art.js 路径（默认自动找 ./pixel-bead-studio/js/art.js）
  --id <id>             指定图案 id（默认由名字推导）
  --beadSet standard|mini|glow   标记用哪种豆（只影响标签）
  --hot                 在图案库里标记为推荐

通用参数：
  --out <json>          输出图案 JSON（强烈建议，后续可复现/手改）
  --preview <png>       输出预览图（agent 靠它"看图验收"）
  --style bead|led      预览观感，默认 bead
  --png <png>           输出索引色 PNG（体积最小，固件友好）
  --ascii               终端里打印点阵
  --name <名字>         图案名
  --palette <色卡>      默认 hama_standard

路径 A（art）：
  --allowRagged         允许行宽不一致（不推荐）

路径 B（code）：
  --cols N --rows N     目标格数
  --scale N             内部超采样倍数，默认 8（越大边缘越干净）
  --outline             自动加深色描边
  --maxColors N         限制颜色数
  --dither / --no-dither

路径 C（image）：
  --cols N --rows N     目标格数（rows 省略时按比例算）
  --fit cover|contain|stretch
  --brightness --contrast --saturation
  --threshold 0..1      二值化
  --invert
  --keyColor #RRGGBB --keyTolerance 0.15   抠掉背景色
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.help) { console.log(HELP); return; }
  switch (cmd) {
    case 'art': return cmdArt(args);
    case 'code': return cmdCode(args);
    case 'image': return cmdImage(args);
    case 'check': return cmdCheck(args);
    case 'install': return cmdInstall(args);
    case 'palette': return cmdPalette(args);
    default:
      console.error(`未知命令 "${cmd}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n错误：' + e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
