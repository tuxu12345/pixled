/**
 * 本地静态服务 + DeepSeek 反向代理（可选）。
 * 用途：演示时避开浏览器跨域/密钥暴露问题；纯静态也能跑，直连 API（实测支持 CORS）。
 * 跑法：node pixel-bead-studio/server.mjs [port]
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] || 8137);
const UPSTREAM = 'https://api.deepseek.com';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 代理：/api/chat -> https://api.deepseek.com/chat/completions
  // 服务端持有 Key（环境变量 DEEPSEEK_API_KEY），前端不接触密钥
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const key = process.env.DEEPSEEK_API_KEY || req.headers['x-api-key'] || '';
    try {
      const up = await fetch(UPSTREAM + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body,
      });
      const text = await up.text();
      res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'proxy failed: ' + e.message } }));
    }
    return;
  }

  // 静态文件
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const filePath = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) throw new Error('dir');
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + p);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`拼豆工坊 Demo: http://127.0.0.1:${PORT}/`);
  console.log(`代理端点:      POST http://127.0.0.1:${PORT}/api/chat  (Key 走环境变量 DEEPSEEK_API_KEY)`);
});
