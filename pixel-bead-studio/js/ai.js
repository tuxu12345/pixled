/**
 * AI 生成模块：自然语言 -> 像素点阵
 *
 * 关键工程点（都是实测踩出来的，值得写进架构方案）：
 * 1. 不要用文生图模型。像素屏要的是「离散、可编辑、能落到真实可买豆色」的格点数据，
 *    生图模型给的是位图，还得反推网格；让 LLM 输出结构化数据更准也更省。
 * 2. reasoning 模型会把 max_tokens 全烧在思考上，content 返回空串 —— 实测的坑。
 *    解决：thinking:{type:'disabled'}，20×20 网格约 2s 返回。
 * 3. 两条生成路径（实测质量对比后定的默认值）：
 *    - spec  ：模型只出「形状 + 配色」分镜，像素由本地渲染器铺 —— 稳、好看、省 token，大画布首选
 *    - direct：模型直出网格 —— 20×20 这种小画布够用，像素级可控
 * 4. AI 输出必须过「校验 + 修复」管线：尺寸对齐、索引越界、调色板缺失、
 *    左右不对称、缺少描边，全部自动兜住，前端永远拿到能渲染的数据。
 */
import { PixelGrid, normalizeGrid, extractJson } from './grid.js';
import { snapPalette, nearestColor, BEAD_SETS } from './palette.js';
import { normalizeSpec, rasterizeSpec, buildSpecPrompt } from './spec.js';

export const AI_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  apiKey: '',
  temperature: 0.7,
  maxTokens: 2600,
};

const SIZES = {
  '16x16': [16, 16], '20x20': [20, 20], '29x29': [29, 29],
  '32x32': [32, 32], '48x48': [48, 48], '96x48': [96, 48],
};

export const SIZE_OPTIONS = Object.keys(SIZES);

/**
 * 生成模式（实测对比后的结论）：
 *  - 'spec'   语义分镜 -> 本地光栅化。稳、好看、省 token。大画布推荐。
 *  - 'direct' 让模型直出网格，20×20 这种小画布够用，胜在像素级可控。
 */
export const GEN_MODES = { SPEC: 'spec', DIRECT: 'direct' };

/**
 * 直接出网格时的提示词。
 * 用「行字符串 + 单字符索引」而不是嵌套数组：token 省 3~5 倍，且模型不易漏行。
 */
function buildPrompt(desc, cols, rows, maxColors, beadSetName) {
  return [
    '你是拼豆（Perler beads）图案设计师。把用户描述转成像素点阵数据，只输出 JSON，不要 markdown，不要解释。',
    '',
    `用户描述：${desc}`,
    '',
    '输出结构：',
    `{"title":"四字以内作品名","cols":${cols},"rows":${rows},"palette":["#RRGGBB"],"grid":["...",...]}`,
    `- grid 是 ${rows} 个字符串，每个字符串长度恰好 ${cols}`,
    '- grid 里每个字符是 palette 的下标，用 0-9 和 a-z 表示 0-35，"." 表示该格不放豆（透明）',
    `- palette 最多 ${maxColors} 色，数量越少越好，颜色要能对应到现实中的${beadSetName}`,
    '',
    '画法要求：',
    '- 风格：扁平、纯色填充、深色描边、主体居中、尽量左右对称',
    '- 背景必须用 "." 透明，不要画背景',
    '- 形状比细节重要：宁可少画细节，也要让轮廓一眼能认出来',
  ].join('\n');
}

/** 单次 API 调用，返回 { text, usage, ms } */
async function callDeepSeek(prompt, { signal, maxTokens, temperature } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${AI_CONFIG.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_CONFIG.apiKey}`,
    },
    body: JSON.stringify({
      model: AI_CONFIG.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: temperature ?? AI_CONFIG.temperature,
      max_tokens: maxTokens ?? AI_CONFIG.maxTokens,
      response_format: { type: 'json_object' },
      // ★ 关键：关掉思考链，否则 token 全被 reasoning 吃掉，content 为空
      thinking: { type: 'disabled' },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`API ${res.status}: ${json.error.message || JSON.stringify(json.error)}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const msg = json.choices?.[0]?.message ?? {};
  return {
    text: msg.content || '',
    reasoning: msg.reasoning_content || '',
    finish: json.choices?.[0]?.finish_reason,
    usage: json.usage,
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * 主流程：文生点阵
 * @param {string} desc 自然语言描述
 * @param {object} opts { mode:'spec'|'direct', size, maxColors, beadSet, ... }
 * @returns {Promise<{grid, meta, trace}>}
 */
export async function generateFromText(desc, opts = {}) {
  const mode = opts.mode || GEN_MODES.SPEC;
  return mode === GEN_MODES.SPEC ? generateViaSpec(desc, opts) : generateDirect(desc, opts);
}

/* ---------- 方案 B：语义分镜 + 本地光栅化（默认，大画布稳且好看） ---------- */
async function generateViaSpec(desc, opts = {}) {
  const {
    size = '20x20', maxColors = 8, beadSet = 'standard', beadSetName = '标准拼豆色卡',
    autoOutline = true, snap = true, signal, onStage = () => {},
  } = opts;

  const [cols, rows] = SIZES[size] || SIZES['20x20'];
  const prompt = buildSpecPrompt(desc, cols, rows, maxColors, beadSetName);
  const trace = { prompt, mode: 'spec', stages: [], usage: null, ms: 0, repaired: [] };

  onStage('让模型做分镜（形状 + 配色）…');
  let r = await callDeepSeek(prompt, { signal, maxTokens: 2200, temperature: Math.min(AI_CONFIG.temperature, 0.55) });
  trace.usage = r.usage;
  trace.ms += r.ms;
  trace.stages.push({ name: 'LLM 出分镜规格', ms: r.ms, tokens: r.usage?.completion_tokens ?? 0, ok: !!r.text });

  let raw = extractJson(r.text);
  if (!raw || !Array.isArray(raw.shapes) || !raw.shapes.length) {
    onStage('分镜为空，重试一次…');
    r = await callDeepSeek(prompt, { signal, maxTokens: 3000 });
    trace.ms += r.ms;
    trace.usage = r.usage;
    const okRetry = !!extractJson(r.text)?.shapes?.length;
    trace.stages.push({ name: '重试分镜', ms: r.ms, tokens: r.usage?.completion_tokens ?? 0, ok: okRetry });
    raw = extractJson(r.text);
    if (!raw?.shapes?.length) throw new Error('模型没有给出可用的形状清单');
  }

  onStage('本地渲染器铺格…');
  const spec = normalizeSpec(raw, cols, rows);
  trace.repaired.push(...spec.notes);
  trace.spec = spec;
  trace.shapes = spec.shapes.length;

  const set = BEAD_SETS[beadSet];
  const grid = rasterizeSpec(spec, cols, rows, {
    outline: autoOutline,
    snapTo: snap && set ? set.colors.map((c) => c[1]) : null,
  });
  trace.stages.push({ name: '本地光栅化', ms: 0, tokens: 0, ok: true, note: `${spec.shapes.length} 个形状` });
  if (autoOutline) trace.repaired.push('已按拼豆风自动补深色描边');

  const stat = grid.counts();
  return {
    grid,
    meta: {
      title: tidyTitle(raw.title, desc),
      desc, ms: trace.ms,
      tokens: trace.usage?.total_tokens ?? null,
      reasoningTokens: trace.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      colors: stat.colors, beads: stat.filled,
      mode: 'spec', shapes: spec.shapes.length,
    },
    trace,
  };
}

/* ---------- 方案 A：模型直出网格（20×20 这类小画布够用） ---------- */
async function generateDirect(desc, opts = {}) {
  const {
    size = '20x20', maxColors = 8, beadSet = 'standard', beadSetName = '标准拼豆色卡',
    autoSymmetry = true, autoOutline = true, snap = true, signal, onStage = () => {},
  } = opts;

  const [cols, rows] = SIZES[size] || SIZES['20x20'];
  const prompt = buildPrompt(desc, cols, rows, maxColors, beadSetName);
  const trace = { prompt, mode: 'direct', stages: [], usage: null, ms: 0, repaired: [] };

  // 大画布需要的输出 token 明显更多，否则会被截断成空串
  const budget = Math.max(2600, Math.round(cols * rows * 3.4));
  onStage('调用大模型直接生成点阵…');
  let r = await callDeepSeek(prompt, { signal, maxTokens: budget });
  trace.usage = r.usage;
  trace.ms += r.ms;
  trace.stages.push({ name: 'LLM 直出点阵', ms: r.ms, tokens: r.usage?.completion_tokens ?? 0, ok: !!r.text });

  // 兜底：万一思考链没关干净 / 被截断，放宽额度重试一次
  if (!r.text || r.finish === 'length') {
    onStage('首次返回为空或被截断，放宽额度重试…');
    r = await callDeepSeek(prompt, { signal, maxTokens: Math.round(budget * 1.8) });
    trace.ms += r.ms;
    trace.usage = r.usage;
    trace.stages.push({ name: '重试（放宽 token）', ms: r.ms, tokens: r.usage?.completion_tokens ?? 0, ok: !!r.text });
  }

  const raw = extractJson(r.text);
  if (!raw) throw new Error('模型没有返回可解析的 JSON' + (r.text ? `：${r.text.slice(0, 120)}` : '（内容为空）'));

  onStage('校验并修复点阵…');
  let { grid, notes } = normalizeGrid(raw, { cols, rows });
  trace.repaired.push(...notes);

  // 修复 1：左右对称
  if (autoSymmetry) {
    const before = diffSymmetry(grid);
    if (before > 0.18) {
      grid = grid.symmetrize();
      trace.repaired.push(`左右不对称度 ${(before * 100).toFixed(0)}%，已自动对称化`);
    }
  }

  // 修复 2：主体太小 / 贴边 -> 重新居中放大
  const trimmed = grid.trimTransparent();
  if (trimmed.cols < grid.cols * 0.5 || trimmed.rows < grid.rows * 0.5) {
    trace.repaired.push('主体偏小，已重新居中放大');
    grid = centerScale(trimmed, cols, rows);
  }

  // 修复 3：描边
  if (autoOutline) {
    const hasDark = grid.palette.some((c) => luminanceOf(c) < 0.45);
    if (hasDark) {
      grid = grid.addOutline();
      trace.repaired.push('已自动加一圈深色描边（拼豆风关键视觉）');
    }
  }

  // 落色到真实豆色卡
  if (snap && grid.palette.length) {
    const { palette } = snapPalette(grid.palette, beadSet);
    const remap = new Int8Array(grid.grid.length);
    for (let i = 0; i < grid.grid.length; i++) {
      const v = grid.grid[i];
      if (v < 0) { remap[i] = -1; continue; }
      const hex = grid.palette[v] || '#000000';
      const target = nearestColor(hex, palette);
      remap[i] = palette.findIndex((c) => c.toUpperCase() === target.toUpperCase());
    }
    const snapped = PixelGrid.create(grid.cols, grid.rows, palette);
    snapped.grid = remap;
    grid = snapped;
    trace.repaired.push(`已落色到${beadSetName}（${palette.length} 色可购买）`);
  }

  const stat = grid.counts();
  return {
    grid,
    meta: {
      title: tidyTitle(raw.title, desc),
      desc,
      ms: trace.ms,
      tokens: trace.usage?.total_tokens ?? null,
      reasoningTokens: trace.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      colors: stat.colors,
      beads: stat.filled,
      mode: 'direct',
    },
    trace,
  };
}

/** 图生点阵：多模态输入（图片 dataURL） */
export async function generateFromImage(imageDataUrl, opts = {}) {
  const { size = '20x20', maxColors = 8, signal, onStage = () => {} } = opts;
  const [cols, rows] = SIZES[size] || SIZES['20x20'];
  onStage('上传图片并请求转像素…');
  const t0 = performance.now();
  const res = await fetch(`${AI_CONFIG.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_CONFIG.apiKey}` },
    body: JSON.stringify({
      model: AI_CONFIG.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt('把这张图转成拼豆图案（保留主体轮廓与主要配色）', cols, rows, maxColors, '标准拼豆色卡') },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      }],
      max_tokens: Math.max(2600, Math.round(cols * rows * 3.4)),
      temperature: 0.4,
      thinking: { type: 'disabled' },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`API ${res.status}: ${json.error.message}`);
  const text = json.choices?.[0]?.message?.content || '';
  const raw = extractJson(text);
  if (!raw) throw new Error('模型没有返回可解析的 JSON（图生点阵需要多模态模型支持）');
  const { grid, notes } = normalizeGrid(raw, { cols, rows });
  return { grid, meta: { title: tidyTitle(raw.title, '图片图案'), ms: Math.round(performance.now() - t0), notes } };
}

/* ---------------- 本地兜底生成（没填 API Key 也能把流程演示完） ---------------- */

const MOCK_BANK = [
  { key: ['柴', '狗', '犬', 'dog', 'shiba'], art: 'SHIBA' },
  { key: ['猫', '喵', 'cat', 'owl', '猫头鹰'], art: 'CAT' },
  { key: ['鸭', 'duck', '鸟'], art: 'DUCK' },
  { key: ['蘑菇', 'mushroom', '马力', 'mario'], art: 'MUSHROOM' },
  { key: ['车', 'car', '车标'], art: 'CAR' },
  { key: ['心', 'heart', '爱心'], art: 'HEART' },
];

const MOCK_ARTS = {
  SHIBA: {
    title: '柴犬围巾',
    palette: ['#3E2A20', '#E8A03C', '#FFF3C4', '#E8352B', '#1A1A1A'],
    grid: [
      '.......000000.......',
      '.....00cccccc00.....',
      '....0cccccccccc0....',
      '...0cc0cccc0cccc0...',
      '...0cc0cccc0cccc0...',
      '...0ccccccccccc0....',
      '....0c1cccc1cc0.....',
      '....0cccaacccc0.....',
      '...0cccaaaaccc0.....',
      '..0cccccaacccc0.....',
      '..0ccccccccccc0.....',
      '...0ccccccccc0......',
      '....03333330........',
      '...0333333330.......',
      '..034444444330......',
      '..033444444330......',
      '..033333333330......',
      '...0333333330.......',
      '....00000000........',
      '....................',
    ],
  },
  CAT: {
    title: '橘猫',
    palette: ['#3E2A20', '#FF8A00', '#FFF3C4', '#FFB7C5'],
    grid: [
      '..00............00..',
      '.0110..........0110.',
      '.01110........01110.',
      '.011111000000111110.',
      '.011111111111111110.',
      '.011311111111311110.',
      '.011111111111111110.',
      '.011111222221111110.',
      '.011111123211111110.',
      '.011111111111111110.',
      '.011111133311111110.',
      '..0111111111111110..',
      '..0111111111111110..',
      '...01111111111110...',
      '....011111111110....',
      '.....0000000000.....',
      '....................',
      '....................',
      '....................',
      '....................',
    ],
  },
  DUCK: {
    title: '小黄鸭',
    palette: ['#3E2A20', '#FFD400', '#FF8A00', '#E8352B'],
    grid: [
      '.......0000.........',
      '.....00cccc00.......',
      '....0ccccccc0.......',
      '....0c0cc0cc0.......',
      '....0ccccccc0.......',
      '....0cc3333c0.......',
      '.....0ccccc0........',
      '...00ccccccc00......',
      '..0ccccccccccc0.....',
      '.0ccccccccccccc0....',
      '.0cccc11ccccccc0....',
      '.0ccccccccccccc0....',
      '..0ccccccccccc0.....',
      '...00ccccccc00......',
      '.....0c0..0c0.......',
      '.....0c0..0c0.......',
      '....03330.03330.....',
      '....................',
      '....................',
      '....................',
    ],
  },
  MUSHROOM: {
    title: '小蘑菇',
    palette: ['#3E2A20', '#E8352B', '#FFFFFF', '#FFF3C4', '#4CAF50'],
    grid: [
      '.......000000.......',
      '....000111111000....',
      '..0011111111111100..',
      '.011112211112211110.',
      '.011222211122221110.',
      '01111122111122111110',
      '01111111111111111110',
      '00111111111111111100',
      '..0000000000000000..',
      '....0dddddddd0......',
      '....0d3dddd3d0......',
      '....0dddddddd0......',
      '....0dddddddd0......',
      '....0dddddddd0......',
      '....0000000000......',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
    ],
  },
  CAR: {
    title: '自画像',
    palette: ['#3E2A20', '#D8D8D8', '#63C8E8', '#1A1A1A', '#FFD400'],
    grid: [
      '....................',
      '....................',
      '.......0000.........',
      '....0001111000......',
      '..00111111111100....',
      '.0111222222211110...',
      '011111111111111110..',
      '0111111111111111110.',
      '0111111111111111110.',
      '0000000000000000000.',
      '..0330.......0330...',
      '..0330.......0330...',
      '...00.........00....',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
    ],
  },
  HEART: {
    title: '爱心',
    palette: ['#B01722', '#E8352B', '#FF6A8A'],
    grid: [
      '..0000....0000......',
      '.012210..012210.....',
      '0122221001222210....',
      '01222222122222210...',
      '01222222222222210...',
      '.0122222222222210...',
      '..01222222222210....',
      '...012222222210.....',
      '....0122222210......',
      '.....01222210.......',
      '......012210........',
      '.......0110.........',
      '........00..........',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
    ],
  },
};

export function mockGenerate(desc, { size = '20x20' } = {}) {
  const lower = String(desc).toLowerCase();
  const hit = MOCK_BANK.find((b) => b.key.some((k) => lower.includes(k.toLowerCase())));
  const art = MOCK_ARTS[hit?.art || 'HEART'];
  const [cols, rows] = SIZES[size] || SIZES['20x20'];
  const { grid, notes } = normalizeGrid(
    { title: art.title, cols: 20, rows: 20, palette: art.palette, grid: art.grid },
    { cols, rows },
  );
  const stat = grid.counts();
  return {
    grid,
    meta: { title: art.title, desc, ms: 0, tokens: 0, mock: true, mode: 'mock', colors: stat.colors, beads: stat.filled },
    trace: {
      prompt: '(本地兜底图案，未调用 API)', mode: 'mock',
      stages: [{ name: '本地兜底', ms: 0, ok: true }], repaired: notes, mock: true,
    },
  };
}

/* ---------------- 小工具 ---------------- */

function luminanceOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function diffSymmetry(grid) {
  let diff = 0, total = 0;
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols >> 1; x++) {
      total++;
      if (grid.get(x, y) !== grid.get(grid.cols - 1 - x, y)) diff++;
    }
  }
  return total ? diff / total : 0;
}

function centerScale(src, cols, rows) {
  const out = PixelGrid.create(cols, rows, src.palette);
  const scale = Math.min(cols / src.cols, rows / src.rows) * 0.92;
  const w = Math.max(1, Math.round(src.cols * scale));
  const h = Math.max(1, Math.round(src.rows * scale));
  const ox = Math.floor((cols - w) / 2), oy = Math.floor((rows - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.cols - 1, Math.floor((x / w) * src.cols));
      const sy = Math.min(src.rows - 1, Math.floor((y / h) * src.rows));
      const v = src.get(sx, sy);
      if (v >= 0) out.set(x + ox, y + oy, v);
    }
  }
  return out;
}

/** 常见主体词：命中它比正则裁剪可靠得多 */
const SUBJECTS = [
  '猫头鹰', '柴犬', '熊猫', '老虎', '狮子', '狐狸', '兔子', '仓鼠', '松鼠', '猴子', '企鹅', '海豚', '鲸鱼',
  '小狗', '小猫', '鸭子', '小鸡', '小鸟', '恐龙', '山羊', '河马', '大象', '青蛙', '乌龟', '金鱼',
  '蘑菇', '爱心', '星星', '彩虹', '太阳', '月亮', '云朵', '樱花', '四叶草', '玫瑰', '蛋糕', '冰淇淋',
  '赛车', '小汽车', '汽车', '摩托', '飞船', '火箭', '机器人', '像素狗', '像素鸭', '小狗',
];

/**
 * 从描述里抠一个像样的作品名。
 * 目标：把「一只戴红色围巾的柴犬，正面坐姿，笑脸」变成「柴犬」而不是「一只戴红」。
 */
function deriveTitle(desc) {
  const text = String(desc || '');
  // 1) 优先命中已知主体词（带「像素」前缀的优先，其次取最长匹配）
  let best = '';
  for (const w of SUBJECTS) {
    if (!text.includes(w)) continue;
    const cand = text.includes('像素' + w) ? '像素' + w : w;
    if (cand.length > best.length) best = cand;
  }
  if (best) return best.slice(0, 6);

  // 2) 退化为启发式裁剪
  let s = text.split(/[，,。.；;！!？?\n]/)[0].trim();
  s = s.replace(/^(请|帮我|给我|我要|画|绘制|生成|来个|做一个|做|设计)+/, '');
  s = s.replace(/^(一只|一个|一颗|一条|一头|一匹|个|只)/, '');
  const afterDe = s.split('的').filter(Boolean);
  if (afterDe.length > 1) {
    const cand = afterDe[afterDe.length - 1];
    if (cand.length >= 2 && cand.length <= 6) s = cand;
  }
  if (s.length > 6) s = s.slice(-4);
  return (s || '未命名').slice(0, 6);
}

/** 标题兜底：模型有时会把「一只戴红围巾的柴犬」整个当标题 */
export function tidyTitle(title, desc) {
  const t = String(title || '').trim().replace(/[。，,.!！\s]/g, '');
  if (!t || t.length > 6) return deriveTitle(desc);
  return t.slice(0, 6);
}
