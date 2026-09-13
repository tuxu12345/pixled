/**
 * 手绘像素画（字符画）编译器
 *
 * 这是「路径 A」：直接写出每个格子的颜色。现有图案库（猫头鹰/狐狸/蘑菇…）就是这么来的。
 * 适合形象明确、不需要复杂几何的图案。
 *
 * 格式（单字符 = 单个格子，所以能直接"看见"画）：
 *   palette: ['#3E2A20', '#C98B4B', ...]   // 0-9 a-z 共 36 色上限
 *   art: [
 *     '..001100..',
 *     '.01122110.',
 *   ]
 *   '.' 或 ' ' = 不放豆（透明）
 *
 * 之所以要严格校验：字符画最容易犯的错就是**某一行少打或多打一个字符**，
 * 肉眼看不出，但整幅图会错位。这个编译器把这类错误全部拦下来。
 */

const IDX_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * @param {object} spec { name?, palette: string[], art: string[] }
 * @param {object} opts { allowRagged: 允许行宽不一致（默认不允许） }
 * @returns {{cols,rows,idx:Int16Array,palette:string[],stats:object,warnings:string[]}}
 */
export function compileArt(spec, opts = {}) {
  const { allowRagged = false } = opts;
  if (!spec || typeof spec !== 'object') throw new Error('art 定义必须是对象');
  const { palette, art } = spec;
  if (!Array.isArray(palette) || !palette.length) throw new Error('缺少 palette（至少一个颜色）');
  if (!Array.isArray(art) || !art.length) throw new Error('缺少 art（至少一行）');
  if (palette.length > 36) throw new Error(`palette 最多 36 色，给了 ${palette.length}`);

  // 校验调色板格式
  palette.forEach((hex, i) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(hex))) {
      throw new Error(`palette[${i}] = "${hex}" 不是合法颜色，必须是 #RRGGBB`);
    }
  });

  const widths = art.map((r) => String(r).length);
  const cols = Math.max(...widths);
  const rows = art.length;

  const warnings = [];
  const ragged = art.map((r, i) => (String(r).length !== cols ? i : -1)).filter((i) => i >= 0);
  if (ragged.length) {
    const detail = ragged.slice(0, 5).map((i) => `第 ${i + 1} 行宽 ${widths[i]}（应为 ${cols}）`).join('，');
    if (!allowRagged) {
      throw new Error(`字符画行宽不一致：${detail}${ragged.length > 5 ? ` 等 ${ragged.length} 行` : ''}。` +
        `这是最常见的错误 —— 每一行必须一样长（用 '.' 补齐）。`);
    }
    warnings.push(`行宽不一致，已按左侧对齐并用透明补齐：${detail}`);
  }

  const idx = new Int16Array(cols * rows).fill(-1);
  const usedColors = new Map();

  for (let y = 0; y < rows; y++) {
    const line = String(art[y]);
    for (let x = 0; x < cols; x++) {
      const ch = x < line.length ? line[x] : '.';
      if (ch === '.' || ch === ' ' || ch === '_' || ch === '-') continue;
      const vi = IDX_CHARS.indexOf(ch.toLowerCase());
      if (vi < 0) {
        throw new Error(`第 ${y} 行第 ${x} 列出现非法字符 "${ch}"。` +
          `只允许 0-9 a-z（表示 palette 下标）和 . 空格（透明）。`);
      }
      if (vi >= palette.length) {
        throw new Error(`第 ${y} 行第 ${x} 列用了下标 ${vi}（字符 "${ch}"），` +
          `但 palette 只有 ${palette.length} 个颜色（合法下标 0..${palette.length - 1}）。`);
      }
      idx[y * cols + x] = vi;
      usedColors.set(vi, (usedColors.get(vi) || 0) + 1);
    }
  }

  const filled = [...usedColors.values()].reduce((a, b) => a + b, 0);
  if (filled === 0) warnings.push('整幅画没有任何豆子（全是透明），确认是不是写错了？');

  // 检查有没有定义但没用到的颜色（提示一下，不算错）
  const unused = palette.map((_, i) => i).filter((i) => !usedColors.has(i));
  if (unused.length) warnings.push(`palette 里有 ${unused.length} 个颜色没被用到：${unused.join(',')}`);

  // 收拢调色板到实际用到的颜色
  const keep = [...usedColors.keys()].sort((a, b) => a - b);
  const remap = new Map(keep.map((old, i) => [old, i]));
  const finalIdx = Int16Array.from(idx, (v) => (v >= 0 ? remap.get(v) : -1));
  const finalPalette = keep.map((i) => palette[i].toUpperCase());

  const counts = new Array(finalPalette.length).fill(0);
  for (const v of finalIdx) if (v >= 0) counts[v]++;

  return {
    cols, rows,
    idx: finalIdx,
    palette: finalPalette,
    beadSet: spec.beadSet || null,
    dot: null,
    stats: {
      filled,
      empty: cols * rows - filled,
      colors: finalPalette.length,
      counts,
      hours: Number(((filled * 6) / 3600).toFixed(2)),
      boundingBox: bbox(finalIdx, cols, rows),
    },
    warnings,
    name: spec.name,
  };
}

function bbox(idx, cols, rows) {
  let x0 = cols, y0 = rows, x1 = -1, y1 = -1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (idx[y * cols + x] < 0) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * 把图案 JSON 安装进 pixel-bead-studio 的图案库（js/art.js）
 *
 * 为什么做成函数而不是让 agent 手工编辑：art.js 是手写风格的源码数组，
 * 手工插入很容易破坏缩进/逗号/编码。这里用文本插入并做语法自检。
 *
 * 幂等：同 id 已存在时替换掉旧条目，不会重复追加。
 *
 * @param {string} artJsText   art.js 的源码文本
 * @param {object} pattern     图案 JSON（pixel-bead-pattern/v1）
 * @param {object} opts        { id, beadSet, tags, hot }
 * @returns {{text: string, action: 'added'|'replaced', id: string}}
 */
export function installIntoArtJs(artJsText, pattern, opts = {}) {
  const { cols, rows, palette, rows_art: rowsArt } = pattern;
  if (!Array.isArray(palette) || !Array.isArray(rowsArt)) {
    throw new Error('图案 JSON 缺少 palette / rows_art');
  }
  if (palette.length > 36) throw new Error(`调色板 ${palette.length} 色，超过 36 色的上限`);

  const id = opts.id || slugId(pattern.name || 'pattern');
  const beadSet = opts.beadSet || 'standard';
  const beadName = { standard: '标准豆', mini: '迷你豆', glow: '夜光豆' }[beadSet] || beadSet;

  const colors = pattern.stats?.colors ?? new Set(rowsArt.join('').replace(/\./g, '')).size;
  const hours = pattern.stats?.hours;
  const tags = opts.tags || [
    beadName,
    `${colors}色`,
    ...(hours ? [`约${hours < 1 ? '1' : Math.round(hours)}小时`] : []),
  ];

  const entry = [
    '  {',
    `    id: '${id}', name: ${JSON.stringify(pattern.name || id)}, bead: '${beadSet}', `
      + `size: '${cols}x${rows}', tags: [${tags.map((t) => `'${t}'`).join(', ')}]`
      + `${opts.hot ? ', hot: true' : ''},`,
    `    palette: [${palette.map((c) => `'${c}'`).join(', ')}],`,
    '    art: [',
    ...rowsArt.map((r) => `      '${r}',`),
    '    ],',
    '  },',
  ].join('\n');

  // 定位 ART 数组：从 "const ART = [" 之后到第一个顶格的 "];"
  const startMatch = /const ART = \[\r?\n/.exec(artJsText);
  if (!startMatch) throw new Error('在 art.js 里找不到 `const ART = [`');
  const bodyStart = startMatch.index + startMatch[0].length;
  const endMatch = /\r?\n\];/.exec(artJsText.slice(bodyStart));
  if (!endMatch) throw new Error('在 art.js 里找不到 ART 数组的结束 `];`');

  const head = artJsText.slice(0, bodyStart);
  let body = artJsText.slice(bodyStart, bodyStart + endMatch.index);
  const tail = artJsText.slice(bodyStart + endMatch.index);

  // 幂等：同 id 的条目先删掉
  const idRe = new RegExp(`\\n  \\{\\r?\\n    id: '${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',[\\s\\S]*?\\n  \\},`);
  const action = idRe.test(body) ? 'replaced' : 'added';
  if (action === 'replaced') body = body.replace(idRe, '');

  // 追加到数组末尾（保持手写风格：前面有内容时补一个换行）
  const trimmed = body.replace(/\s*$/, '');
  const newBody = `${trimmed}\n${entry}`;

  return { text: `${head}${newBody}${tail}`, action, id, name: pattern.name || id };
}

function slugId(name) {
  const ascii = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (ascii) return ascii;
  // 中文名没有可用的 ASCII 时，用稳定哈希生成一个短 id
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'art-' + h.toString(36).slice(0, 6);
}

/** 反向：把 grid 导出成可读的字符画（便于手工微调后再编回来） */
export function decompileArt(grid) {
  const lines = [];
  for (let y = 0; y < grid.rows; y++) {
    let s = '';
    for (let x = 0; x < grid.cols; x++) {
      const v = grid.idx[y * grid.cols + x];
      s += v < 0 ? '.' : IDX_CHARS[v];
    }
    lines.push(s);
  }
  return { palette: grid.palette.slice(), art: lines };
}

/**
 * 图案质量自检 —— 这些是"一眼看出问题"的启发式规则，
 * 用来在 agent 看图之前先拦掉明显不合格的产物。
 */
export function auditArt(grid) {
  const issues = [];
  const { cols, rows, idx, stats } = grid;

  const fill = stats.filled / (cols * rows);
  if (fill < 0.1) issues.push(`豆子覆盖率只有 ${(fill * 100).toFixed(0)}%，画面太空`);
  if (fill > 0.95) issues.push(`豆子覆盖率高达 ${(fill * 100).toFixed(0)}%，几乎没有留白，形状可能糊成一团`);

  const bb = stats.boundingBox || bbox(idx, cols, rows);
  if (bb) {
    if (bb.w < cols * 0.4 || bb.h < rows * 0.4) {
      issues.push(`主体只占了 ${bb.w}×${bb.h}（画布 ${cols}×${rows}），太小了，建议放大或裁掉空白`);
    }
    if (bb.x === 0 && bb.y === 0 && (bb.x + bb.w === cols) && (bb.y + bb.h === rows)) {
      issues.push('主体四边都贴边，没有留白，可能被裁切了');
    }
  }

  // 左右对称度（动物/标志类图案通常希望对称）
  let diff = 0, tot = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols >> 1; x++) {
      tot++;
      if (idx[y * cols + x] !== idx[y * cols + cols - 1 - x]) diff++;
    }
  }
  const asym = tot ? diff / tot : 0;
  if (asym > 0.18 && asym < 0.82) {
    issues.push(`左右对称度 ${(100 - asym * 100).toFixed(0)}%，不上不下 —— 要么刻意对称，要么明显不对称，现在像手抖`);
  }

  // 孤立点（噪点）
  let lonely = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (idx[y * cols + x] < 0) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < cols && ny < rows && idx[ny * cols + nx] >= 0;
      }).length;
      if (n === 0) lonely++;
    }
  }
  if (lonely > stats.filled * 0.03) {
    issues.push(`有 ${lonely} 个孤立豆子（四周都没邻居），像是噪点`);
  }

  return issues;
}
