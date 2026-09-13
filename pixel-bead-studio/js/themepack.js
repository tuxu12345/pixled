/**
 * Clockwise「Canvas」主题打包器（浏览器 / Node 双端可用）
 *
 * 把点阵图案打成 firmware 能直接吃的东西：
 *   - 索引色 PNG（colorType=3 + 调色板）：Clockwise 的 PNGdec 走调色板路径最省，
 *     而且能让 base64 体积控制在 firmware 的 1KB decodedArray 缓冲之内
 *   - clock-club 主题 JSON：颜色用 RGB565 整数，图片用内嵌 base64 PNG
 *
 * 实现约束（都是踩过的坑）：
 *   ★ 不用 Buffer —— 浏览器里没有这个全局，用了就是 "Buffer is not defined"，
 *     整个模块连带 app.js 一起挂掉。全程 Uint8Array。
 *   ★ 不静态 import 'node:zlib' —— 同理会直接加载失败。动态 import，失败就退回
 *     自带的 STORED 块（合法 zlib 流，只是不压缩）。
 */

/* ================= 字节工具 ================= */

function utf8(s) {
  return new TextEncoder().encode(s);
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function u32be(v) {
  return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}

function readU32be(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

/** Uint8Array -> base64（双端可用） */
export function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  // Node
  return globalThis.Buffer.from(bytes).toString('base64');
}

/* ================= CRC32 ================= */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = utf8(type);
  return concat([u32be(data.length), t, data, u32be(crc32(concat([t, data])))]);
}

/* ================= zlib（动态，带兜底） ================= */

let _deflateSync = null;
let _tried = false;
let _mode = 'STORED(未压缩)';

async function loadZlib() {
  if (_tried) return _deflateSync;
  _tried = true;
  try {
    const zlib = await import('node:zlib');
    _deflateSync = (bytes) => new Uint8Array(zlib.deflateSync(bytes, { level: 9 }));
    _mode = 'zlib/deflate';
  } catch {
    _deflateSync = null;
    _mode = 'STORED(未压缩)';
  }
  return _deflateSync;
}

/** 启动时 await 一次：Node 下走最优压缩，浏览器下自动退回 STORED */
export async function initThemePack() {
  await loadZlib();
  return { compression: _mode };
}

export function compressionMode() { return _mode; }

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** 合法 zlib 流：2 字节头 + STORED 块 + adler32 */
function zlibStored(raw) {
  const MAX = 65535;
  const parts = [new Uint8Array([0x78, 0x01])];
  let off = 0;
  for (;;) {
    const len = Math.min(MAX, raw.length - off);
    const last = off + len >= raw.length ? 1 : 0;
    const hdr = new Uint8Array(5);
    hdr[0] = last;
    hdr[1] = len & 255; hdr[2] = (len >>> 8) & 255;
    const nl = (~len) & 0xffff;
    hdr[3] = nl & 255; hdr[4] = (nl >>> 8) & 255;
    parts.push(hdr, raw.subarray(off, off + len));
    off += len;
    if (last) break;
  }
  parts.push(u32be(adler32(raw)));
  return concat(parts);
}

function deflateRaw(raw) {
  return _deflateSync ? _deflateSync(raw) : zlibStored(raw);
}

/* ================= 颜色（复用 clock-club 自己的高质量公式） ================= */

/** #RRGGBB -> RGB565 整数（Clockwise 的 JSON 用的就是整数） */
export function rgb888To565(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const r5 = (r * 249 + 1014) >> 11;
  const g6 = (g * 253 + 505) >> 10;
  const b5 = (b * 249 + 1014) >> 11;
  return ((r5 << 11) | (g6 << 5) | b5) >>> 0;
}

export function rgb565To888(v) {
  const R = (((v >> 11) & 0x1f) * 527 + 23) >> 6;
  const G = (((v >> 5) & 0x3f) * 259 + 33) >> 6;
  const B = ((v & 0x1f) * 527 + 23) >> 6;
  return '#' + [R, G, B].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* ================= 索引色 PNG 编码 ================= */

/**
 * @param {object} grid  { cols, rows, palette: [hex], grid: Int8Array, get? }
 * @returns {Uint8Array} PNG 字节
 */
export function encodeIndexedPNG(grid) {
  const { cols, rows, palette } = grid;
  const get = (x, y) => (typeof grid.get === 'function' ? grid.get(x, y) : (grid.grid[y * cols + x] ?? -1));

  // 调色板末尾追加一格当作"透明占位"，空像素都指向它
  const padIndex = palette.length;
  const totalColors = palette.length + 1;

  const plte = new Uint8Array(totalColors * 3);
  palette.forEach((hex, i) => {
    const n = parseInt(String(hex).replace('#', ''), 16);
    plte[i * 3] = (n >> 16) & 255;
    plte[i * 3 + 1] = (n >> 8) & 255;
    plte[i * 3 + 2] = n & 255;
  });
  const trns = new Uint8Array(totalColors).fill(255);
  trns[padIndex] = 0; // 占位色透明

  // 扫描线：每行 1 字节 filter(0) + cols 字节索引
  const raw = new Uint8Array(rows * (cols + 1));
  for (let y = 0; y < rows; y++) {
    const base = y * (cols + 1);
    raw[base] = 0;
    for (let x = 0; x < cols; x++) {
      const v = get(x, y);
      raw[base + 1 + x] = v < 0 ? padIndex : Math.min(v, palette.length - 1);
    }
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(cols), 0);
  ihdr.set(u32be(rows), 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 3;  // colorType 3 = indexed
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', deflateRaw(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** 只读 PNG 头部信息（给 UI 做体积/合规提示用） */
export function pngInfo(bytes) {
  if (readU32be(bytes, 0) !== 0x89504e47) return null;
  return {
    width: readU32be(bytes, 16),
    height: readU32be(bytes, 20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    bytes: bytes.length,
  };
}

/* ================= clock-club 主题 ================= */

export function buildTheme({ name, author = '', version = 1, bgColor = '#000000', delay = 250, setup = [], sprites = [], loop = [] }) {
  return {
    name,
    version,
    ...(author ? { author } : {}),
    bgColor: rgb888To565(bgColor),
    delay,
    setup,
    sprites,
    loop,
  };
}

const rid = () => Math.random().toString(36).slice(2, 8);

export function imageLayer(grid, x = 0, y = 0, comment = '') {
  const png = encodeIndexedPNG(grid);
  return {
    type: 'image',
    x, y,
    image: bytesToBase64(png),
    id: rid(),
    ...(comment ? { comment } : {}),
  };
}

export function datetimeLayer({ x = 20, y = 56, content = 'H:i', fgColor = '#FFFFFF', bgColor = '#000000', font = 'picopixel' }) {
  return {
    type: 'datetime', x, y, content, font,
    fgColor: rgb888To565(fgColor),
    bgColor: rgb888To565(bgColor),
    id: rid(),
  };
}

export function textLayer({ x = 0, y = 0, content = '', fgColor = '#FFFFFF', bgColor = '#000000', font = 'picopixel' }) {
  return {
    type: 'text', x, y, content, font,
    fgColor: rgb888To565(fgColor),
    bgColor: rgb888To565(bgColor),
    id: rid(),
  };
}

export function rectLayer({ x = 0, y = 0, width = 8, height = 8, color = '#FFFFFF', fill = false }) {
  return {
    type: fill ? 'fillrect' : 'rect', x, y, width, height,
    color: rgb888To565(color),
    id: rid(),
  };
}

/** 帧序列 -> 一组精灵帧 */
export function spriteFrames(grids, comments = []) {
  return grids.map((g, i) => {
    const o = { image: bytesToBase64(encodeIndexedPNG(g)), id: rid() };
    if (comments[i]) o.comment = comments[i];
    return o;
  });
}

export function spriteLoop({
  sprite = 0, x = 0, y = 0, frameDelay = 250, loopDelay = 4000,
  moveTargetX = -1, moveTargetY = -1, moveDuration = 0, moveStartTime = 1, shouldReturnToOrigin = false,
}) {
  const o = { type: 'sprite', x, y, sprite, frameDelay, loopDelay, id: rid() };
  if (moveTargetX > -1 || moveTargetY > -1) {
    Object.assign(o, { moveTargetX, moveTargetY, moveDuration, moveStartTime, shouldReturnToOrigin });
  }
  return o;
}

/** base64 字符串 -> 原始字节数（正确处理 '=' 填充） */
export function base64Bytes(b64) {
  const s = String(b64 || '').replace(/=+$/, '');
  return Math.floor((s.length * 3) / 4);
}

/** 固件侧 decodedArray 是 1024 字节，超了就静默失败 —— 这里给出预警 */
export const FIRMWARE_IMAGE_BUFFER = 1024;

export function themeReport(theme) {
  const first = (theme.setup || []).find((e) => e.type === 'image');
  const bytes = base64Bytes(first ? first.image : '');
  return {
    imageBytes: bytes,
    fitsFirmwareBuffer: bytes <= FIRMWARE_IMAGE_BUFFER,
    jsonBytes: JSON.stringify(theme).length,
    compression: compressionMode(),
  };
}
