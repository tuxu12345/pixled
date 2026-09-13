/**
 * LED Studio 本地静态服务
 *
 * 服务根 = 工作区根（led-studio 的上一级），这样页面里的
 * `../../pixel-bead-studio/js/art.js` 才能取到拼豆图案库。
 * 根路径重定向到 /led-studio/。
 *
 * 跑法：node server.mjs [port]
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));   // .../led-studio/
const WORKSPACE = join(HERE, '..');                          // 工作区根
const PORT = Number(process.argv[2] || 8139);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let p = decodeURIComponent(url.pathname);

  // 根路径 -> LED Studio 首页
  if (p === '/' || p === '') p = '/led-studio/index.html';
  if (p === '/led-studio') p = '/led-studio/index.html';

  // 防目录穿越：解析后必须仍在工作区内
  const file = normalize(join(WORKSPACE, p));
  if (!file.startsWith(WORKSPACE + sep) && file !== WORKSPACE) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 越界');
    return;
  }

  try {
    let target = file;
    const s = await stat(target);
    if (s.isDirectory()) target = join(target, 'index.html');
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + p);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LED Studio        http://127.0.0.1:${PORT}/`);
  console.log(`拼豆工坊（隔壁）  http://127.0.0.1:${PORT}/pixel-bead-studio/`);
  console.log(`服务根 = ${WORKSPACE}`);
});
