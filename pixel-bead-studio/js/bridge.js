/**
 * PBSBridge —— 安卓壳（com.byd.pixelbead）注入的 JS 桥。
 *
 * 铁律：**每一次桥调用都要 typeof 判断**。
 * 纯网页版（node server.mjs / Vercel）里根本没有 window.PBSBridge，
 * 直接 `window.PBSBridge.saveFile(...)` 会抛 TypeError，整个按钮变哑巴。
 * 所以这里所有导出函数都是"有桥走桥，没桥走浏览器下载"。
 *
 * Android 端（MainActivity.PBSBridge）暴露三个方法：
 *   sendFrame(String base64Frame, String metaJson)     存文件 + 转发到 96×48 屏（串口/BLE 待接）
 *   saveFile(String fileName, String base64Content, String mimeType)   存到 下载/PixelBead
 *   saveDataUrl(String fileName, String dataUrl)                       存到 下载/PixelBead
 */

/** 拿到桥对象（可能不存在） */
export function getBridge() {
  if (typeof window === 'undefined') return null;
  const b = window.PBSBridge;
  return b && typeof b === 'object' ? b : null;
}

export function hasBridge() {
  const b = getBridge();
  return !!(b && (typeof b.sendFrame === 'function' || typeof b.saveFile === 'function'));
}

/** 桥是否实现了某个具体方法（逐方法判断，别用整体真假） */
function fn(name) {
  const b = getBridge();
  return b && typeof b[name] === 'function' ? b[name].bind(b) : null;
}

/* ============================ base64 ============================ */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Uint8Array → base64（不依赖 btoa 的参数展开，几 MB 也不会爆栈） */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  let i = 0;
  for (; i + 2 < u8.length; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = u8.length - i;
  if (rest === 1) {
    const n = u8[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/** dataURL → 纯 base64（去掉 data:...;base64, 前缀） */
export function dataUrlToBase64(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 文本 → base64（UTF-8 安全，中文 meta 不会乱码） */
export function textToBase64(text) {
  const s = String(text == null ? '' : text);
  if (typeof TextEncoder !== 'undefined') return bytesToBase64(new TextEncoder().encode(s));
  const esc = unescape(encodeURIComponent(s));
  let out = '';
  for (let i = 0; i < esc.length; i++) out += String.fromCharCode(esc.charCodeAt(i));
  return btoa(out);
}

/* ============================ 浏览器兜底 ============================ */

function blobDownload(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ============================ 对外 API ============================ */

/**
 * 发送一帧到屏幕。
 * @param {Uint8Array} bytes 已经打包好的帧（见 export.js 的 toBinaryFrame）
 * @param {object} meta { title, cols, rows, colors, bytes, rle }
 * @returns {{ok:boolean, via:string, note:string}}
 */
export function sendFrame(bytes, meta = {}) {
  const b64 = bytesToBase64(bytes);
  const metaJson = JSON.stringify(meta);
  const call = fn('sendFrame');
  if (call) {
    try {
      call(b64, metaJson);
      return { ok: true, via: 'bridge', note: `已交给安卓壳转发（${bytes.length}B → base64 ${b64.length} 字符）` };
    } catch (e) {
      return { ok: false, via: 'bridge', note: 'PBSBridge.sendFrame 调用失败：' + (e && e.message ? e.message : e) };
    }
  }
  // 纯网页版：把帧丢成下载文件，方便手工再用串口工具发
  blobDownload(`frame-${(meta.title || 'art')}.bin`, bytes, 'application/octet-stream');
  console.info('[PBSBridge 缺席] sendFrame 回退为浏览器下载', meta, bytes.length, 'bytes');
  return { ok: true, via: 'web', note: `没有 JS 桥，已把 ${bytes.length}B 帧存成文件（浏览器下载）` };
}

/**
 * 保存文件到系统「下载/PixelBead」。
 * @param {string} fileName
 * @param {string|Uint8Array|Blob} content
 * @param {string} mime
 */
export function saveFile(fileName, content, mime = 'application/octet-stream') {
  const name = fileName || 'pixelbead.bin';
  let b64;
  let blobPart = content;
  if (typeof content === 'string') {
    b64 = textToBase64(content);
  } else if (content instanceof Uint8Array) {
    b64 = bytesToBase64(content);
  } else if (typeof Blob !== 'undefined' && content instanceof Blob) {
    // Blob 只能异步读；这里退回浏览器下载，走桥的路径不常用
    blobDownload(name, content, mime);
    return { ok: true, via: 'web', note: 'Blob 走浏览器下载' };
  } else {
    b64 = textToBase64(String(content == null ? '' : content));
  }
  const call = fn('saveFile');
  if (call) {
    try {
      call(name, b64, mime);
      return { ok: true, via: 'bridge', note: `已存到 下载/PixelBead/${name}` };
    } catch (e) {
      return { ok: false, via: 'bridge', note: 'PBSBridge.saveFile 调用失败：' + (e && e.message ? e.message : e) };
    }
  }
  blobDownload(name, content, mime);
  return { ok: true, via: 'web', note: `没有 JS 桥，已交给浏览器下载 ${name}` };
}

/** 保存一个 dataURL（PNG 导出走这条） */
export function saveDataUrl(fileName, dataUrl) {
  const name = fileName || 'pixelbead.png';
  const call = fn('saveDataUrl');
  if (call) {
    try {
      call(name, dataUrl);
      return { ok: true, via: 'bridge', note: `已存到 下载/PixelBead/${name}` };
    } catch (e) {
      return { ok: false, via: 'bridge', note: 'PBSBridge.saveDataUrl 调用失败：' + (e && e.message ? e.message : e) };
    }
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { ok: true, via: 'web', note: `没有 JS 桥，已交给浏览器下载 ${name}` };
}

/** 壳里弹个 toast（没有就静默） */
export function nativeToast(msg) {
  const call = fn('toast');
  if (!call) return false;
  try { call(String(msg)); return true; } catch { return false; }
}

/** 壳的版本号，用于界面显示"运行在车机壳里" */
export function bridgeInfo() {
  const call = fn('version');
  if (!call) return null;
  try { return String(call()); } catch { return null; }
}
