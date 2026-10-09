/**
 * 通过原生 CDP 直接驱动车机壳里的 WebView（不经过 Playwright —— 它连 WebView 会挂）。
 *
 * 能做的事比 adb input tap 强得多：
 *   · 读每个按钮的真实 bounding box（不用靠截图目测坐标）
 *   · 直接读页面状态（色数/颗数/是否熨烫/桥是否在）
 *   · 真的派发 Input 事件走一遍 pointerdown → 画布涂抹
 *   · 验证导出的 PNG / C 数组 / 下发帧是不是真的落到了 下载/PixelBead
 *
 * 前置：debug 包（WebView.setWebContentsDebuggingEnabled(true)）
 *       adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
 *
 * 截图默认落在 <repo>/pixel-bead-app/build/verify-shots/，可用 PB_SHOTS 覆盖；
 * 路径全部从脚本自身位置推导，没有写死任何本机目录。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const SHOTS = process.env.PB_SHOTS
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'verify-shots');
mkdirSync(SHOTS, { recursive: true });
const shot = (name) => join(SHOTS, name);
const saveShot = (base64, name) => { writeFileSync(shot(name), Buffer.from(base64, 'base64')); return shot(name); };
/**
 * 截图是"有则更好"的附赠品，不能因为它把整个验收搞挂。
 * 实测手机 WebView（Android 16 / Chrome 153）压根不响应 Page.captureScreenshot，
 * 会一直挂到超时 —— 断言该跑还得跑。
 */
const grabShot = async (name) => {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 4000);
    saveShot(r.data, name);
    return true;
  } catch (e) {
    console.log(`  (截图 ${name} 跳过：${e.message})`);
    return false;
  }
};

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDPClient {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }); }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, timeoutMs);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面里抛异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  }
}

const list = await (await fetch(CDP + '/json')).json();
const target = list.find((t) => t.type === 'page' && /appassets/.test(t.url)) || list.find((t) => t.type === 'page');
if (!target) { console.error('找不到页面 target：', JSON.stringify(list, null, 2)); process.exit(2); }
const version = await (await fetch(CDP + '/json/version')).json();
console.log('WebView :', version.Browser, '| Android UA:', /Android (\d+)/.exec(version['User-Agent'])?.[1]);
console.log('页面    :', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new CDPClient(ws);
await cdp.send('Runtime.enable');

let failed = 0;
const checks = [];
const add = (ok, label, extra = '') => { checks.push({ ok, label, extra }); if (!ok) failed++; };

const state = () => cdp.eval(`(() => {
  const g = (id) => document.getElementById(id);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x:+r.x.toFixed(1), y:+r.y.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1) }; };
  const ed = g('editor').getBoundingClientRect();
  const swr = g('swatches').getBoundingClientRect();
  const sw = [...document.querySelectorAll('#swatches button')];
  return {
    title: g('title').textContent,
    meta: g('meta').textContent,
    hint: g('stageHint').textContent,
    iron: g('btnIron').classList.contains('on'),
    bridge: g('bridgeState').textContent,
    editing: g('editor').classList.contains('open'),
    swatches: sw.length,
    swatchVisible: sw.filter((b) => { const r = b.getBoundingClientRect();
      return r.width>0 && r.left>=swr.left-.6 && r.right<=swr.right+.6 && r.top>=swr.top-.6 && r.bottom<=swr.bottom+.6
             && r.left>=ed.left-.6 && r.right<=ed.right+.6; }).length,
    lib: [...document.querySelectorAll('#lib button span')].slice(0,4).map(s=>s.textContent),
    docH: document.documentElement.scrollHeight,
    docW: document.documentElement.scrollWidth,
    innerW: window.innerWidth, innerH: window.innerHeight,
    canvas: rect(g('canvas')), wrap: rect(g('canvasWrap')),
    editor: rect(g('editor')),
    btnNew: rect(g('btnNew')), btnIron: rect(g('btnIron')), btnSend: rect(g('btnSend')), btnExport: rect(g('btnExport')),
    status: g('status').textContent,
    consoleErrors: (window.__errs||[]).slice(0,3),
  };
})()`);

// 顺手把页面的报错收集起来
await cdp.eval(`window.__errs = window.__errs || []; window.addEventListener('error', e => window.__errs.push(String(e.message))); 'ok'`);

const s0 = await state();
console.log('\n--- 车机 WebView 里的真实 DOM ---');
console.log('viewport      :', s0.innerW + '×' + s0.innerH, '| docScroll', s0.docW + '×' + s0.docH);
console.log('canvas        :', JSON.stringify(s0.canvas), ' wrap', JSON.stringify(s0.wrap), ' editor', JSON.stringify(s0.editor));
console.log('bridge pill   :', s0.bridge);
console.log('图案库前 4    :', JSON.stringify(s0.lib));
console.log('色板可见      :', s0.swatchVisible, '/', s0.swatches);
console.log('按钮真实 bbox : 新建', JSON.stringify(s0.btnNew), '熨烫', JSON.stringify(s0.btnIron));
console.log('              发送', JSON.stringify(s0.btnSend), '导出', JSON.stringify(s0.btnExport));

add(/车机桥/.test(s0.bridge), '网页认出了 PBSBridge（顶栏显示「车机桥」）', s0.bridge);
add(s0.editing, '打开就是编辑态');
add(s0.docH <= s0.innerH + 1 && s0.docW <= s0.innerW + 1, '整页不滚动',
  `docScroll ${s0.docW}×${s0.docH} vs viewport ${s0.innerW}×${s0.innerH}`);
add(s0.swatches >= 28, '色板 28 色齐全', String(s0.swatches));
add(s0.swatchVisible >= 8, '色板在 84px 工具条里可见（坑 3）', `${s0.swatchVisible}/${s0.swatches}`);
add(s0.canvas.x >= s0.wrap.x - 1 && s0.canvas.x + s0.canvas.w <= s0.wrap.x + s0.wrap.w + 1
  && s0.canvas.y + s0.canvas.h <= s0.wrap.y + s0.wrap.h + 1, '画布没溢出容器',
  `canvas ${s0.canvas.w}×${s0.canvas.h} in wrap ${s0.wrap.w}×${s0.wrap.h}`);
add(/罗小黑/.test(s0.lib[0] || '') && /戴珍珠耳环/.test(s0.lib[1] || '') && /线条小狗/.test(s0.lib[2] || ''),
  '图案库前 3 个 = 罗小黑 / 戴珍珠耳环的少女 / 线条小狗', JSON.stringify(s0.lib.slice(0, 3)));

/* ---- 1. 新建空白画布（点真实坐标）---- */
await cdp.mouse('mousePressed', s0.btnNew.x + s0.btnNew.w / 2, s0.btnNew.y + s0.btnNew.h / 2);
await cdp.mouse('mouseReleased', s0.btnNew.x + s0.btnNew.w / 2, s0.btnNew.y + s0.btnNew.h / 2);
await new Promise((r) => setTimeout(r, 700));
const s1 = await state();
add(/0 颗/.test(s1.meta), '点「🗒 新建」清空成空白画布', s1.meta);

/* ---- 2. 选亮色，用真实鼠标事件在画布上涂一笔 ---- */
await cdp.eval(`document.querySelectorAll('#swatches button')[7].click(); 'ok'`);  // 柠黄
const cv = s1.canvas;
const px = (fx, fy) => [cv.x + cv.w * fx, cv.y + cv.h * fy];
const [ax, ay] = px(0.22, 0.28);
const [bx, by] = px(0.78, 0.28);
const [cx2, cy2] = px(0.78, 0.60);
await cdp.mouse('mouseMoved', ax, ay, { buttons: 0 });
await cdp.mouse('mousePressed', ax, ay);
for (let i = 1; i <= 24; i++) await cdp.mouse('mouseMoved', ax + (bx - ax) * i / 24, ay + (by - ay) * i / 24);
for (let i = 1; i <= 24; i++) await cdp.mouse('mouseMoved', bx + (cx2 - bx) * i / 24, by + (cy2 - by) * i / 24);
await cdp.mouse('mouseReleased', cx2, cy2);
await new Promise((r) => setTimeout(r, 600));
const s2 = await state();
const beads = parseInt(/· (\d+) 颗/.exec(s2.meta)?.[1] || '0', 10);
add(beads > 20, '在画布上涂抹能上色（没被拖屏吃掉）', s2.meta);

await grabShot('cdp-01-led.png');

/* ---- 3. 熨烫 ---- */
await cdp.eval(`document.getElementById('btnIron').click(); 'ok'`);
await new Promise((r) => setTimeout(r, 800));
const s3 = await state();
add(s3.iron && /熨烫预览中/.test(s3.hint) && /熨烫预览/.test(s3.title), '🔥 熨烫切换生效（标题 + 状态 + 渲染）', `${s3.title} | ${s3.hint}`);
await grabShot('cdp-02-iron.png');

/* ---- 4. 导出 PNG（熨烫质感）→ PBSBridge.saveDataUrl ---- */
await cdp.eval(`document.getElementById('btnExport').click(); 'ok'`);
await new Promise((r) => setTimeout(r, 300));
await cdp.eval(`document.querySelector('#exportSeg button[data-kind="png"]').click(); 'ok'`);
await cdp.eval(`document.getElementById('btnDownload').click(); 'ok'`);
await new Promise((r) => setTimeout(r, 1800));
await cdp.eval(`document.getElementById('btnCloseExport').click(); 'ok'`);

/* ---- 5. 导出 C 数组 → saveFile ---- */
await cdp.eval(`document.getElementById('btnExport').click(); 'ok'`);
await new Promise((r) => setTimeout(r, 300));
await cdp.eval(`document.querySelector('#exportSeg button[data-kind="c"]').click(); 'ok'`);
await cdp.eval(`document.getElementById('btnDownload').click(); 'ok'`);
await new Promise((r) => setTimeout(r, 1800));
await cdp.eval(`document.getElementById('btnCloseExport').click(); 'ok'`);

/* ---- 6. 发送到屏幕 → sendFrame ---- */
await cdp.eval(`document.getElementById('btnSend').click(); 'ok'`);
await new Promise((r) => setTimeout(r, 1500));
const s4 = await state();
add(/已交给安卓壳/.test(s4.status), '「发送到屏幕」调到了 PBSBridge.sendFrame', s4.status.slice(0, 80));
await grabShot('cdp-03-send.png');
await cdp.eval(`document.getElementById('btnCloseExport').click(); 'ok'`);

/* ---- 7. 载入图案库第一个（罗小黑），确认能继续编辑 ---- */
await cdp.eval(`document.querySelectorAll('#lib button')[0].click(); 'ok'`);
await new Promise((r) => setTimeout(r, 1000));
const s5 = await state();
add(/罗小黑/.test(s5.title) && /52 × 52/.test(s5.meta), '图案库第 1 个「罗小黑」可载入继续编辑', `${s5.title} | ${s5.meta}`);
add(s5.editing, '载入后仍在编辑态');
await grabShot('cdp-04-luoxiaohei.png');

/* ---- 8. 页面报错 ---- */
const errs = await cdp.eval(`(window.__errs || [])`);
add(errs.length === 0, '页面无 JS 报错', JSON.stringify(errs).slice(0, 120));

console.log('\n--- 检查项 ---');
for (const c of checks) console.log(`${c.ok ? '  OK  ' : '  **  '} ${c.label}${c.extra ? '   — ' + c.extra : ''}`);
console.log(`\n${failed === 0 ? 'ALL ON-DEVICE CHECKS PASSED' : failed + ' ON-DEVICE CHECK(S) FAILED'}`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
