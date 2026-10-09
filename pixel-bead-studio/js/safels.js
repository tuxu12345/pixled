/**
 * localStorage 保险丝 —— 必须在 app.js 的**第一个** import。
 *
 * 踩过的坑：安卓 WebView 如果没设 domStorageEnabled(true)，`window.localStorage`
 * 要么是 null、要么一访问就抛 SecurityError。app.js 里任何一处裸用
 * （读 API Key、存作品）都会让整个 boot() 抛异常 —— 现象是"页面出来了但点什么都没反应"。
 *
 * 安卓壳那边已经开了 domStorageEnabled(true)（见 MainActivity），这里再兜一层：
 * 真的不可用就换成内存实现，功能降级但不白屏。
 */
(function installSafeStorage() {
  if (typeof window === 'undefined') return;

  const probe = () => {
    try {
      const s = window.localStorage;
      if (!s) return null;
      const k = '__pbs_probe__';
      s.setItem(k, '1');
      if (s.getItem(k) !== '1') return null;
      s.removeItem(k);
      return s;
    } catch {
      return null;
    }
  };

  if (probe()) return;   // 原生可用，什么都不用做

  const mem = new Map();
  const shim = {
    get length() { return mem.size; },
    key(i) { return Array.from(mem.keys())[i] ?? null; },
    getItem(k) { const s = String(k); return mem.has(s) ? mem.get(s) : null; },
    setItem(k, v) { mem.set(String(k), String(v)); },
    removeItem(k) { mem.delete(String(k)); },
    clear() { mem.clear(); },
  };

  let installed = false;
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => shim });
    installed = true;
  } catch {
    try { window.localStorage = shim; installed = true; } catch { /* 只读，认了 */ }
  }
  console.warn('[拼豆工坊] localStorage 不可用（WebView 需要 domSettings.domStorageEnabled(true)），'
    + (installed ? '已降级为内存存储：本次会话内的设置还有效，关掉就没了。' : '内存降级也装不上，设置将不会保存。'));
})();

export const SAFE_STORAGE = true;
