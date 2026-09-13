/**
 * 零依赖 PNG 编码器
 *
 * 为什么要自己写：这个 skill 要能在任何机器上直接跑，不装 canvas/sharp/pngjs。
 * 只用 node:zlib 的 deflate，其余全部手写。
 *
 * 支持两种输出，都是为了拼豆场景：
 *   - 索引色（colorType=3）：调色板 + tRNS 透明。体积最小，也是固件最喜欢的格式
 *   - RGB（colorType=2）+ Alpha（colorType=6）：给带抗锯齿的预览图用
 */
import { deflateSync, inflateSync } from 'node:zlib';

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 索引色 PNG
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} idx   w*h 个索引，值 0..palette.length-1，或 -1 表示透明
 * @param {string[]} palette ['#RRGGBB', ...]
 */
export function encodeIndexedPNG(w, h, idx, palette) {
  const padIndex = palette.length;
  const total = palette.length + 1;

  const plte = Buffer.alloc(total * 3);
  palette.forEach((hex, i) => {
    const n = parseInt(String(hex).replace('#', ''), 16);
    plte[i * 3] = (n >> 16) & 255;
    plte[i * 3 + 1] = (n >> 8) & 255;
    plte[i * 3 + 2] = n & 255;
  });
  const trns = Buffer.alloc(total, 255);
  trns[padIndex] = 0;

  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;                     // filter: None
    for (let x = 0; x < w; x++) {
      const v = idx[y * w + x];
      raw[y * (w + 1) + 1 + x] = v < 0 ? padIndex : Math.min(v, palette.length - 1);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * RGBA PNG（colorType=6）。用于带抗锯齿的预览图。
 * @param {Uint8ClampedArray} rgba  w*h*4
 */
export function encodeRGBAPNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = rgba[y * stride + i];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 最小 PNG 解码器：只处理我们自己产出的两种格式（8bit 索引色 / 8bit RGBA）。
 * 用途是"自检" —— 编码完再解回来逐像素比对，确保编码器没写错。
 */
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let p = 8;
  const out = { idat: [], palette: null, trns: null };
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      out.width = data.readUInt32BE(0);
      out.height = data.readUInt32BE(4);
      out.bitDepth = data[8];
      out.colorType = data[9];
    } else if (type === 'PLTE') out.plte = data;
    else if (type === 'tRNS') out.trns = data;
    else if (type === 'IDAT') out.idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (out.bitDepth !== 8) throw new Error('只支持 8bit，实际 ' + out.bitDepth);
  const raw = inflateSync(Buffer.concat(out.idat));
  const { width: w, height: h, colorType } = out;

  if (colorType === 3) {
    const stride = w + 1;
    const idx = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      if (raw[y * stride] !== 0) throw new Error('不支持 filter ' + raw[y * stride]);
      raw.copy(idx, y * w, y * stride + 1, y * stride + 1 + w);
    }
    const palette = [];
    for (let i = 0; i + 2 < out.plte.length; i += 3) {
      palette.push('#' + [out.plte[i], out.plte[i + 1], out.plte[i + 2]]
        .map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase());
    }
    return { width: w, height: h, colorType, idx, palette, alpha: out.trns ? [...out.trns] : palette.map(() => 255) };
  }

  if (colorType === 6) {
    const stride = w * 4 + 1;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      if (raw[y * stride] !== 0) throw new Error('不支持 filter ' + raw[y * stride]);
      raw.copy(rgba, y * w * 4, y * stride + 1, y * stride + 1 + w * 4);
    }
    return { width: w, height: h, colorType, rgba };
  }

  throw new Error('不支持的 colorType ' + colorType);
}
