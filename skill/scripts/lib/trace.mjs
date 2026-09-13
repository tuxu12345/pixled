/**
 * 照片 / 图片 → 拼豆（路径 C）
 *
 * 作用：给一张图（照片、AI 生成图、截图、logo），自动采样成拼豆格子。
 * 这是"快速出草稿"的路径，但注意：**照片转点阵几乎一定需要人工再修**，
 * 因为拼豆格子太少（20×20 就 400 格），细节必然会丢。
 *
 * 解码策略（不装任何依赖）：
 *   1. 自己实现的 PNG 解码器（支持 8bit 灰度/RGB/索引/RGBA + 非隔行）
 *   2. 遇到其他格式（JPEG/WebP/隔行 PNG）→ 退回头less 浏览器解码
 *      （环境里通常有 Edge；没有就明确报错，不静默失败）
 */
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Raster } from './raster.mjs';

/* ---------------- PNG 解码 ---------------- */

export function decodePNGFile(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let p = 8;
  const idat = [];
  let ihdr = null, plte = null, trns = null;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0), h: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], compression: data[10],
        filter: data[11], interlace: data[12],
      };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  if (ihdr.interlace !== 0) throw new Error('暂不支持隔行 PNG（interlace=1），请另存为非隔行');
  if (ihdr.depth !== 8) throw new Error(`只支持 8bit PNG，实际 ${ihdr.depth}bit`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error('不支持的 PNG colorType ' + ihdr.colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = ihdr.w * bpp;
  const out = Buffer.alloc(stride * ihdr.h);

  // 逐行反滤波（PNG 的 5 种滤波器）
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.h; y++) {
    const ft = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(row);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (ft) {
        case 0: break;
        case 1: cur[i] = (cur[i] + a) & 255; break;
        case 2: cur[i] = (cur[i] + b) & 255; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
          cur[i] = (cur[i] + pr) & 255;
          break;
        }
        default: throw new Error('未知滤波器 ' + ft);
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }

  // 转成 RGBA
  const rgba = new Uint8ClampedArray(ihdr.w * ihdr.h * 4);
  const n = ihdr.w * ihdr.h;
  if (ihdr.colorType === 3) {
    if (!plte) throw new Error('索引色 PNG 缺少 PLTE');
    for (let i = 0; i < n; i++) {
      const pi = out[i];
      rgba[i * 4] = plte[pi * 3];
      rgba[i * 4 + 1] = plte[pi * 3 + 1];
      rgba[i * 4 + 2] = plte[pi * 3 + 2];
      rgba[i * 4 + 3] = trns && pi < trns.length ? trns[pi] : 255;
    }
  } else if (ihdr.colorType === 0) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = out[i];
      rgba[i * 4 + 3] = 255;
    }
  } else if (ihdr.colorType === 4) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = out[i * 2];
      rgba[i * 4 + 3] = out[i * 2 + 1];
    }
  } else if (ihdr.colorType === 2) {
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = out[i * 3]; rgba[i * 4 + 1] = out[i * 3 + 1];
      rgba[i * 4 + 2] = out[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
  } else {
    rgba.set(out);
  }
  return { width: ihdr.w, height: ihdr.h, rgba };
}

/* ---------------- 浏览器兜底解码 ---------------- */

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser() {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) || null;
}

/**
 * 用无头浏览器解码任意浏览器支持的图片格式（JPEG/WebP/隔行 PNG…）。
 * 做法：本地起一个极小服务，页面把图画到 canvas 再 getImageData，
 * 把结果写成 JSON 输出到 DOM，然后 dump-dom 取回。
 */
async function decodeViaBrowser(filePath, maxSide = 256) {
  const browser = findBrowser();
  if (!browser) {
    throw new Error('需要解码这个格式但没有可用的浏览器（Edge/Chrome）。' +
      '请把图片另存为 8bit 非隔行 PNG 再试。');
  }
  const http = await import('node:http');
  const buf = await readFile(filePath);
  const ext = filePath.toLowerCase().endsWith('.png') ? 'image/png'
    : filePath.toLowerCase().match(/\.jpe?g$/) ? 'image/jpeg'
      : filePath.toLowerCase().endsWith('.webp') ? 'image/webp'
        : 'application/octet-stream';

  const PAGE = `<!DOCTYPE html><html><body><div id="o">working</div><script>
(async () => {
  try {
    const b64 = ${JSON.stringify(buf.toString('base64'))};
    const img = new Image();
    img.src = 'data:${ext};base64,' + b64;
    await img.decode();
    const maxSide = ${maxSide};
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s));
    const h = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let bin = '';
    for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i]);
    document.getElementById('o').textContent = 'OK:' + w + ':' + h + ':' + btoa(bin);
  } catch (e) {
    document.getElementById('o').textContent = 'ERR:' + e.message;
  }
})();
</script></body></html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  const port = 8199;
  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  try {
    const dom = await new Promise((resolve, reject) => {
      execFile(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--virtual-time-budget=15000', '--dump-dom',
        `http://127.0.0.1:${port}/`,
      ], { maxBuffer: 256 * 1024 * 1024, timeout: 120000 }, (err, stdout) => {
        if (err && !stdout) return reject(new Error(err.message));
        resolve(stdout || '');
      });
    });
    const m = /OK:(\d+):(\d+):([A-Za-z0-9+/=]+)/.exec(dom);
    if (!m) {
      const e = /ERR:([^<]*)/.exec(dom);
      throw new Error('浏览器解码失败：' + (e ? e[1] : '未知原因'));
    }
    const w = +m[1], h = +m[2];
    const bin = Buffer.from(m[3], 'base64');
    return { width: w, height: h, rgba: new Uint8ClampedArray(bin) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** 统一入口：自动选解码器 */
export async function loadImage(filePath, opts = {}) {
  const buf = await readFile(filePath);
  const isPNG = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (isPNG) {
    try {
      return decodePNGFile(buf);
    } catch (e) {
      // 隔行 / 16bit 等 → 走浏览器
      if (opts.verbose) console.error(`（内置 PNG 解码器不支持：${e.message}，改用浏览器）`);
      return decodeViaBrowser(filePath, opts.maxSide);
    }
  }
  return decodeViaBrowser(filePath, opts.maxSide);
}

/* ---------------- 采样 ---------------- */

/**
 * 把解码后的位图采样成点阵
 * @param {{width,height,rgba}} img
 * @param {object} opts {
 *   cols, rows, fit: 'cover'|'contain'|'stretch',
 *   brightness, contrast, saturation, invert, threshold,
 *   keyOut: {color:'#RRGGBB', tolerance:0~1}  抠掉某个背景色
 * }
 * @returns {Raster} 目标尺寸的 raster（供 toBeads 用）
 *
 * ★ fit 默认是 'contain' 而不是 'cover' —— 这一点很重要：
 *   上传的照片/截图通常比目标格子大很多，宽高比也往往和目标不一致。
 *   用 'cover'（铺满裁切）会把两边裁掉：实测一张 1800×600 的图转 48×48，
 *   左端的标记直接消失，用户看到的就是"图案不全"（这是实际反馈的问题）。
 *   'contain' 保证整张图都在，代价是短边方向留白（透明格）。
 *   要"零留白又完整"，正确做法是**按源图宽高比决定目标格子数**，
 *   见 generate.mjs 里 image 命令的自动 rows。
 */
export function imageToRaster(img, opts = {}) {
  const {
    cols, rows, fit = 'contain',
    brightness = 1, contrast = 1, saturation = 1,
    invert = false, threshold = 0, keyOut = null,
  } = opts;
  if (!cols || !rows) throw new Error('imageToRaster 需要 cols 和 rows');

  const r = new Raster(cols, rows);
  const { width: sw, height: sh, rgba } = img;

  let dx = 0, dy = 0, dw = cols, dh = rows;
  if (fit !== 'stretch') {
    const scale = fit === 'cover' ? Math.max(cols / sw, rows / sh) : Math.min(cols / sw, rows / sh);
    dw = sw * scale; dh = sh * scale;
    dx = (cols - dw) / 2; dy = (rows - dh) / 2;
  }

  // 盒式重采样（对每个目标格，把落在它里面的源像素平均）
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      // 目标格 [cx,cx+1) × [cy,cy+1) 映射回源坐标
      const sx0 = ((cx - dx) / dw) * sw;
      const sx1 = ((cx + 1 - dx) / dw) * sw;
      const sy0 = ((cy - dy) / dh) * sh;
      const sy1 = ((cy + 1 - dy) / dh) * sh;

      let r0 = 0, g0 = 0, b0 = 0, a0 = 0, n = 0;
      const x0 = Math.max(0, Math.floor(sx0)), x1 = Math.min(sw, Math.ceil(sx1));
      const y0 = Math.max(0, Math.floor(sy0)), y1 = Math.min(sh, Math.ceil(sy1));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          const al = rgba[i + 3] / 255;
          r0 += rgba[i] * al; g0 += rgba[i + 1] * al; b0 += rgba[i + 2] * al;
          a0 += al; n++;
        }
      }
      let R, G, B, A;
      if (n === 0) { R = G = B = 0; A = 0; }
      else if (a0 > 1e-6) {
        R = r0 / a0; G = g0 / a0; B = b0 / a0; A = a0 / n;
      } else { R = G = B = 0; A = 0; }

      // 调整
      let rr = R / 255, gg = G / 255, bb = B / 255;
      if (contrast !== 1) {
        rr = (rr - 0.5) * contrast + 0.5;
        gg = (gg - 0.5) * contrast + 0.5;
        bb = (bb - 0.5) * contrast + 0.5;
      }
      if (saturation !== 1) {
        const lum = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        rr = lum + (rr - lum) * saturation;
        gg = lum + (gg - lum) * saturation;
        bb = lum + (bb - lum) * saturation;
      }
      if (brightness !== 1) { rr *= brightness; gg *= brightness; bb *= brightness; }
      if (invert) { rr = 1 - rr; gg = 1 - gg; bb = 1 - bb; }

      // 抠背景色
      if (keyOut) {
        const kc = keyOut.color;
        const kr = parseInt(kc.slice(1, 3), 16) / 255;
        const kg = parseInt(kc.slice(3, 5), 16) / 255;
        const kb = parseInt(kc.slice(5, 7), 16) / 255;
        const dist = Math.hypot(rr - kr, gg - kg, bb - kb);
        if (dist <= (keyOut.tolerance ?? 0.15)) A = 0;
      }

      if (threshold > 0) {
        const lum = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        const on = lum >= threshold ? 1 : 0;
        rr = on; gg = on; bb = on;
      }

      const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
      const i = cy * cols + cx;
      r.data[i * 4] = clamp(rr);
      r.data[i * 4 + 1] = clamp(gg);
      r.data[i * 4 + 2] = clamp(bb);
      r.data[i * 4 + 3] = clamp(A);
    }
  }
  return r;
}
