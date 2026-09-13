/**
 * 导出层：把像素点阵变成真正能下载进车机 / ESP32 的东西。
 *
 *  - C 头文件（RGB565 / RGB888，含 RLE 版本）—— 微雪 ESP32-S3 RGB Matrix 板直接能吃
 *  - 二进制帧（自定义轻量协议，见协议说明）
 *  - JSON（车机前端 / 云端存自定义图案）
 *  - 内置 3×5 像素字库：让 96×48 的屏也能显示文字（架构图里"点阵即文字"的落地）
 */
import { PixelGrid } from './grid.js';

/* ---------------- 内置 3×5 像素字库 ---------------- */
const FONT5 = {
  A: [2, 5, 7, 5, 5], B: [7, 5, 7, 5, 7], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6],
  E: [7, 4, 7, 4, 7], F: [7, 4, 7, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [5, 7, 7, 7, 5], O: [2, 5, 5, 5, 2], P: [7, 5, 7, 4, 4],
  Q: [2, 5, 5, 7, 3], R: [7, 5, 7, 6, 5], S: [3, 4, 2, 1, 7], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 3, 1, 7],
  4: [5, 5, 7, 1, 1], 5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 1, 1, 1],
  8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7],
  ' ': [0, 0, 0, 0, 0], '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], ':': [0, 2, 0, 2, 0],
  '!': [2, 2, 2, 0, 2], '?': [7, 1, 3, 0, 2], '%': [5, 1, 2, 4, 5], '+': [0, 2, 7, 2, 0],
};

/** 把文本渲染进点阵（就地写入，越界自动裁掉） */
export function stampText(grid, text, { x = 0, y = 0, colorIndex = 0, spacing = 1, scale = 1 } = {}) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const glyph = FONT5[ch] || FONT5['?'];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (!(glyph[gy] & (4 >> gx))) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            grid.set(cx + gx * scale + sx, y + gy * scale + sy, colorIndex);
          }
        }
      }
    }
    cx += (3 + spacing) * scale;
  }
  return cx;
}

/* ---------------- 尺寸适配 ---------------- */

/**
 * 把任意点阵适配到屏幕分辨率（96×48 默认）：
 * 等比缩放居中，背景填充指定色（LED 屏没有"透明"，必须给底色）
 */
export function fitToPanel(grid, panel, { bgIndex = -1 } = {}) {
  const { cols: PW, rows: PH } = panel;
  // 返回真正的 PixelGrid，保证 counts()/get()/clone() 等能力一致
  const out = PixelGrid.create(PW, PH, grid.palette.slice());
  out.grid.fill(bgIndex);
  const s = Math.min(PW / grid.cols, PH / grid.rows);
  const w = Math.max(1, Math.round(grid.cols * s));
  const h = Math.max(1, Math.round(grid.rows * s));
  const ox = Math.floor((PW - w) / 2), oy = Math.floor((PH - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(grid.cols - 1, Math.floor((x / w) * grid.cols));
      const sy = Math.min(grid.rows - 1, Math.floor((y / h) * grid.rows));
      const v = grid.get(sx, sy);
      if (v >= 0) out.grid[(y + oy) * PW + (x + ox)] = v;
    }
  }
  return out;
}

/* ---------------- 颜色打包 ---------------- */

function rgb565(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function rgb888(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* ---------------- C 头文件 ---------------- */

/**
 * 生成 ESP32 固件可直接 include 的头文件。
 * 布局：palette 表 + 索引帧（1 字节/像素，0xFF = 灭）
 * 固件侧只需 index -> RGB565 查表，省 RAM 又便于换色/做动效。
 */
export function toCHeader(grid, { name = 'pixel_art', panel = null, packed = true } = {}) {
  const g = panel ? fitToPanel(grid, panel, { bgIndex: -1 }) : grid;
  const guard = `__${name.toUpperCase()}_H__`;
  const pal565 = g.palette.map((c) => '0x' + rgb565(c).toString(16).toUpperCase().padStart(4, '0'));
  const pal888 = g.palette.map((c) => rgb888(c));

  const lines = [];
  lines.push('/*');
  lines.push(' * 自动生成 | 拼豆工坊 · Pixel Bead Studio');
  lines.push(` * 画布 ${g.cols}x${g.rows} | ${g.palette.length} 色 | 生成时间 ${new Date().toISOString()}`);
  lines.push(' * 用法：把本文件放进 ESP32-S3 RGB Matrix 工程，直接索引查表刷屏');
  lines.push(' */');
  lines.push(`#ifndef ${guard}`);
  lines.push(`#define ${guard}`);
  lines.push('');
  lines.push('#include <stdint.h>');
  lines.push('');
  lines.push(`#define ${name.toUpperCase()}_W ${panel ? panel.cols : g.cols}`);
  lines.push(`#define ${name.toUpperCase()}_H ${panel ? panel.rows : g.rows}`);
  lines.push(`#define ${name.toUpperCase()}_COLORS ${g.palette.length}`);
  lines.push('');
  lines.push(`// 调色板：RGB565 与 RGB888 两套，按驱动方式取用`);
  lines.push(`static const uint16_t ${name}_palette565[${Math.max(1, g.palette.length)}] = { ${pal565.join(', ') || '0'} };`);
  lines.push(`static const uint8_t ${name}_palette888[${Math.max(1, g.palette.length)}][3] = {`);
  for (const c of pal888) lines.push(`  { ${String(c.r).padStart(3)}, ${String(c.g).padStart(3)}, ${String(c.b).padStart(3)} },`);
  if (!pal888.length) lines.push('  { 0, 0, 0 },');
  lines.push('};');
  lines.push('');

  if (packed) {
    // RLE：每 2 字节一组 [颜色索引+1, 重复次数]，0 表示透明
    const raw = Array.from(g.grid);
    const rle = [];
    let cur = raw[0], run = 0;
    for (const v of raw) {
      if (v === cur && run < 255) run++;
      else { rle.push([cur + 1, run]); cur = v; run = 1; }
    }
    rle.push([cur + 1, run]);
    const bytes = rle.flatMap(([c, n]) => [c & 0xff, n & 0xff]);
    lines.push(`// RLE 帧数据：每 2 字节 = [颜色索引+1, 连续像素数]，索引 0 表示灭`);
    lines.push(`// 压缩率 ${(100 - (bytes.length / raw.length) * 100).toFixed(0)}%（原始 ${raw.length} 字节 -> ${bytes.length} 字节）`);
    lines.push(`static const uint8_t ${name}_frame_rle[${bytes.length}] = {`);
    for (let i = 0; i < bytes.length; i += 24) {
      lines.push('  ' + bytes.slice(i, i + 24).map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ') + ',');
    }
    lines.push('};');
    lines.push('');
    lines.push(`static inline void ${name}_draw_rle(uint8_t *fb) {`);
    lines.push('  uint32_t p = 0;');
    lines.push(`  for (uint32_t i = 0; i < sizeof(${name}_frame_rle); i += 2) {`);
    lines.push(`    uint8_t ci = ${name}_frame_rle[i];`);
    lines.push(`    uint8_t n  = ${name}_frame_rle[i + 1];`);
    lines.push('    for (uint8_t k = 0; k < n; k++) {');
    lines.push('      fb[p++] = (ci == 0) ? 0 : (uint8_t)(ci - 1);');
    lines.push('    }');
    lines.push('  }');
    lines.push('}');
  } else {
    lines.push(`// 1 字节/像素索引，0xFF 表示该点不亮`);
    lines.push(`static const uint8_t ${name}_frame[${g.grid.length}] = {`);
    for (let y = 0; y < g.rows; y++) {
      const row = [];
      for (let x = 0; x < g.cols; x++) {
        const v = g.get(x, y);
        row.push(v < 0 ? '0xFF' : '0x' + v.toString(16).padStart(2, '0'));
      }
      lines.push('  ' + row.join(', ') + ',');
    }
    lines.push('};');
  }
  lines.push('');
  lines.push(`#endif // ${guard}`);
  return lines.join('\n');
}

/* ---------------- 二进制帧 + 轻量协议 ---------------- */
/*
 * 帧格式（车机 -> ESP32，串口/BLE/WiFi 通用）：
 *   offset 0  : magic  0xA5 0x5A
 *   offset 2  : version u8 = 1
 *   offset 3  : cmd     u8 (1=静态图 2=动画 3=文字 4=亮度)
 *   offset 4  : cols    u8
 *   offset 5  : rows    u8
 *   offset 6  : colorCount u8
 *   offset 7  : flags   u8 (bit0=RLE, bit1=RGB565调色板)
 *   offset 8  : palette  colorCount * 2 字节 RGB565
 *   offset 8+N: payload  RLE 或原始索引
 *   末 2 字节 : CRC16-CCITT
 */
export function toBinaryFrame(grid, { cmd = 1, panel = null, rle = true } = {}) {
  const g = panel ? fitToPanel(grid, panel, { bgIndex: -1 }) : grid;
  const palBytes = g.palette.length * 2;
  const before = g.grid.length;
  let payload;
  if (rle) {
    const raw = Array.from(g.grid);
    const out = [];
    let cur = raw[0], run = 0;
    for (const v of raw) {
      if (v === cur && run < 255) run++;
      else { out.push(cur + 1, run); cur = v; run = 1; }
    }
    out.push(cur + 1, run);
    payload = Uint8Array.from(out);
  } else {
    payload = Uint8Array.from(Array.from(g.grid).map((v) => (v < 0 ? 0xff : v)));
  }

  const head = [0xa5, 0x5a, 1, cmd, g.cols, g.rows, g.palette.length, (rle ? 1 : 0) | 2];
  const buf = new Uint8Array(head.length + palBytes + payload.length + 2);
  buf.set(head, 0);
  let p = head.length;
  for (const c of g.palette) {
    const v = rgb565(c);
    buf[p++] = (v >> 8) & 0xff;
    buf[p++] = v & 0xff;
  }
  buf.set(payload, p);
  p += payload.length;
  const crc = crc16(buf.subarray(0, p));
  buf[p++] = (crc >> 8) & 0xff;
  buf[p++] = crc & 0xff;

  return {
    bytes: buf,
    stats: { raw: before, payload: payload.length, total: buf.length, saved: (100 - (payload.length / before) * 100).toFixed(0) },
  };
}

export function crc16(data) {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/* ---------------- 其他文本格式 ---------------- */

export function toJSON(grid, meta = {}) {
  return JSON.stringify({
    format: 'pixel-bead-studio/v1',
    title: meta.title || 'untitled',
    desc: meta.desc || '',
    cols: grid.cols,
    rows: grid.rows,
    palette: grid.palette,
    grid: grid.toRowStrings(),
    stats: grid.counts(),
    generatedAt: new Date().toISOString(),
  }, null, 2);
}

export function toArduinoArray(grid, { name = 'art' } = {}) {
  const rows = grid.toRowStrings();
  const out = [];
  out.push(`const char* ${name}[${grid.rows}] = {`);
  rows.forEach((r) => out.push(`  "${r}",`));
  out.push('};');
  return out.join('\n');
}

export function toHexDump(bytes, perLine = 16) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const chunk = Array.from(bytes.slice(i, i + perLine));
    lines.push(
      i.toString(16).padStart(4, '0') + '  ' +
      chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ') +
      '  |' + chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('') + '|',
    );
  }
  return lines.join('\n');
}

/* ---------------- 动效（给 LED 屏用） ---------------- */

/**
 * 生成一组动画帧：换色循环 / 呼吸 / 追逐 / 打字机
 * 每一帧都是同尺寸的点阵，可直接按时间轴推给屏幕。
 */
export function buildAnimation(grid, { kind = 'cycle', frames = 16 } = {}) {
  const list = [];
  const base = grid;
  for (let f = 0; f < frames; f++) {
    const t = f / frames;
    if (kind === 'cycle') {
      const g = base.clone();
      const n = Math.max(1, g.palette.length);
      const shift = Math.round(t * n);
      const remap = new Int8Array(g.grid.length);
      for (let i = 0; i < g.grid.length; i++) {
        const v = g.grid[i];
        remap[i] = v < 0 ? -1 : (v + shift) % n;
      }
      g.grid = remap;
      list.push(g);
    } else if (kind === 'breathe') {
      const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.cos(t * Math.PI * 2));
      const g = base.clone();
      g.palette = base.palette.map((hex) => {
        const n = parseInt(hex.slice(1), 16);
        const r = Math.round(((n >> 16) & 255) * k);
        const gg = Math.round(((n >> 8) & 255) * k);
        const b = Math.round((n & 255) * k);
        return '#' + [r, gg, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      });
      list.push(g);
    } else if (kind === 'chase') {
      const g = base.clone();
      const lit = new Int8Array(g.grid.length).fill(-1);
      const band = Math.max(3, Math.round(g.rows * 0.22));
      const center = Math.round(t * (g.rows + band * 2)) - band;
      for (let y = 0; y < g.rows; y++) {
        const on = Math.abs(y - center) < band / 2;
        for (let x = 0; x < g.cols; x++) {
          const v = g.get(x, y);
          if (v < 0) continue;
          lit[g.idx(x, y)] = on ? v : -1;
        }
      }
      g.grid = lit;
      list.push(g);
    } else if (kind === 'wave') {
      const g = base.clone();
      for (let y = 0; y < g.rows; y++) {
        for (let x = 0; x < g.cols; x++) {
          const v = g.get(x, y);
          if (v < 0) continue;
          const s = Math.sin((x / g.cols) * Math.PI * 4 + t * Math.PI * 2);
          if (s < -0.45) g.set(x, y, -1);
        }
      }
      list.push(g);
    }
  }
  return list;
}

/* ---------------- 下载 / 复制 ---------------- */

export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function downloadDataUrl(filename, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
