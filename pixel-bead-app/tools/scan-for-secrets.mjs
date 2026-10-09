#!/usr/bin/env node
/**
 * 发布前自检：扫一个压缩包或目录里有没有密钥、身份信息、本机路径、
 * 以及不该外发的文件。
 *
 *   node tools/scan-for-secrets.mjs dist/xxx.zip
 *   node tools/scan-for-secrets.mjs .
 *
 * 设计要点（踩过坑，别改回去）
 * ---------------------------------------------------------------------
 * **不要把"你自己的标识"写死在脚本里。**
 * 第一版为了"精确点名"，把用户名 / QQ 号 / 账号名硬编码成一个数组 —— 结果这个
 * 脚本本身被提交进仓库、又被打进发布包，扫描器自己成了泄露源（实测被自己的
 * 扫描结果抓了个正着）。正确做法是运行时从环境推导：git config、系统用户名、
 * 主机名、仓库路径的每一段、local.properties 里的 sdk.dir。
 * 这样脚本通用，而且永远不会把标识带进包里。
 *
 * 另外：通用数字正则会把 CSS 颜色（#202225）和字符画行（'7700000077'）当成 QQ 号，
 * 所以数字类命中只做提示，`--strict` 时才计为失败。
 *
 * 退出码：0 干净（或仅有提示项）；1 有硬性问题。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { userInfo, hostname } from 'node:os';

const TARGET = process.argv[2];
const STRICT = process.argv.includes('--strict');
if (!TARGET || !existsSync(TARGET)) {
  console.error('用法: node tools/scan-for-secrets.mjs <zip 或 目录> [--strict]');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');           // pixel-bead-app/

/* ==================== 1. 从环境推导身份标识 ==================== */

const sh = (cmd) => {
  try { return execFileSync(cmd, { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

const identity = new Map();   // 账号类标识：以"裸字符串"形式出现就算泄露
const addId = (v, why) => {
  const s = String(v || '').trim();
  if (s.length >= 3 && !identity.has(s)) identity.set(s, why);
};

addId(sh('git config user.name'), '本仓库 git user.name');
addId(sh('git config user.email'), '本仓库 git user.email');
addId(sh('git config --global user.name'), '全局 git user.name');
addId(sh('git config --global user.email'), '全局 git user.email');
addId(userInfo().username, '系统登录用户名');
addId(hostname(), '主机名');

// 远程仓库地址里的属主名
const remote = sh('git remote get-url origin');
if (remote) {
  const m = /github\.com[/:]([^/]+)\//.exec(remote);
  if (m) addId(m[1], 'git remote 属主名');
}

/* 本机路径：这里**整条路径**才算泄露。
   单独的路径片段（"Agent"、"pixel-bead-app"）不算 —— 它们是项目文档里的正常词汇，
   第一版按片段匹配，结果 navigator.userAgent 和 README 里的目录名全被误报。 */
const pathLeaks = new Map();
const addPath = (p, why) => {
  const s = String(p || '').trim();
  if (s.length < 6) return;
  for (const v of [s, s.replace(/\\/g, '/'), s.replace(/\//g, '\\')]) {
    if (!pathLeaks.has(v)) pathLeaks.set(v, why);
  }
};
addPath(REPO, '本仓库所在绝对路径');
const lp = join(REPO, 'local.properties');
if (existsSync(lp)) {
  for (const line of readFileSync(lp, 'utf8').split(/\r?\n/)) {
    const m = /^\s*sdk\.dir\s*=\s*(.+)$/.exec(line);
    if (m) addPath(m[1].trim(), 'local.properties 里的 sdk.dir');
  }
}

// 通用词不当身份用（否则满仓库都是"命中"）
const GENERIC = new Set(['users', 'program', 'files', 'programdata', 'home', 'root', 'sdk', 'tools',
  'app', 'src', 'main', 'assets', 'www', 'build', 'local', 'google', 'android', 'pixel', 'bead',
  'studio', 'pixelbead', 'pixled', 'documents', 'projects', 'code', 'dev', 'desktop', 'user',
  'agent', 'client', 'server', 'admin', 'test', 'demo', 'work', 'pc']);
for (const k of [...identity.keys()]) if (GENERIC.has(k.toLowerCase())) identity.delete(k);

/* ==================== 2. 读目标 ==================== */

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.xml',
  '.kts', '.java', '.pro', '.properties', '.yml', '.yaml', '.ps1', '.bat', '.sh', '.gradle',
  '.gitignore', '.gitattributes']);
const isTextName = (n) => TEXT_EXT.has(extname(n).toLowerCase()) || basename(n) === 'gradlew';

const files = [];
if (TARGET.toLowerCase().endsWith('.zip')) {
  const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('${TARGET.replace(/'/g, "''")}')
$o = @()
foreach ($e in $z.Entries) {
  if ($e.Length -eq 0) { continue }
  $ms = New-Object System.IO.MemoryStream
  $s = $e.Open(); $s.CopyTo($ms); $s.Close()
  $o += [pscustomobject]@{ Name = $e.FullName; B64 = [Convert]::ToBase64String($ms.ToArray()) }
}
$z.Dispose()
$o | ConvertTo-Json -Compress -Depth 3
`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  for (const e of JSON.parse(raw)) {
    const buf = Buffer.from(e.B64, 'base64');
    files.push({ name: e.Name, buf, text: isTextName(e.Name) ? buf.toString('utf8') : null });
  }
} else {
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      const st = statSync(p);
      if (st.isDirectory()) {
        // 目录模式下跳过构建产物：它们不进发布包，扫了只会淹没真正的问题。
        // （zip 模式下不跳 —— 那时候 build/ 出现就是真问题。）
        if (['.git', 'node_modules', '.gradle', 'build'].includes(n)) continue;
        walk(p);
      } else {
        const buf = readFileSync(p);
        files.push({ name: relative(TARGET, p).replace(/\\/g, '/'), buf, text: isTextName(n) ? buf.toString('utf8') : null });
      }
    }
  };
  walk(TARGET);
}

const textFiles = files.filter((f) => f.text !== null);
const binFiles = files.filter((f) => f.text === null);
console.log(`目标  : ${TARGET}`);
console.log(`条目  : ${files.length}（${textFiles.length} 文本 / ${binFiles.length} 二进制）`);
console.log(`身份源: ${identity.size} 个账号标识 + ${pathLeaks.size} 条本机路径`
  + '（运行时从 git / 系统 / local.properties 推导，未硬编码）');
for (const [k, v] of identity) console.log(`          · 标识 ${JSON.stringify(k)}  (${v})`);
for (const [k, v] of pathLeaks) console.log(`          · 路径 ${JSON.stringify(k)}  (${v})`);
console.log('');

/* ==================== 3. 扫描 ==================== */

let fail = 0, warn = 0;
const hit = (label, list, fatal = true) => {
  if (!list.length) { console.log(`  OK   ${label}`); return; }
  console.log(`  ${fatal ? '!!' : '· '}   ${label}  —  ${list.length} 处`);
  for (const h of list.slice(0, 8)) console.log('         ' + h);
  if (fatal) fail += list.length; else warn += list.length;
};

console.log('=== A. 身份标识 ===');
{
  const hits = [];
  for (const [id, why] of identity) {
    for (const f of files) {
      if (f.buf.toString('latin1').includes(id) || f.buf.toString('utf16le').includes(id)) {
        hits.push(`${f.name}  ←  ${JSON.stringify(id)}  (${why})`);
        break;
      }
    }
  }
  hit('身份标识', hits);
}

console.log('\n=== B. 邮箱地址 ===');
{
  const allow = /@users\.noreply\.github\.com$|@example\.(com|org)$|@schemastore\.org$|@types\.|@babel|@esbuild|@rollup|@playwright|@puppeteer|@npmcli|@isaacs|@jridgewell|@ungap|@eslint|@sinonjs/i;
  const seen = new Map();
  for (const f of textFiles) {
    for (const m of f.text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
      if (allow.test(m)) continue;
      if (!seen.has(m)) seen.set(m, f.name);
    }
  }
  hit('邮箱', [...seen].map(([k, v]) => `${k}   (${v})`));
}

console.log('\n=== C. 本机绝对路径 ===');
{
  const seen = new Map();
  for (const f of files) {
    for (const [v, why] of pathLeaks) {
      if (f.buf.toString('latin1').includes(v) || f.buf.toString('utf16le').includes(v)) {
        if (!seen.has(v)) seen.set(v, `${f.name}  (${why})`);
      }
    }
  }
  for (const f of textFiles) {
    for (const m of f.text.match(/(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}(?!(?:Program Files|Windows|ProgramData|Users[\\/]Public)\b)[A-Za-z0-9_ .-]+[\\/][A-Za-z0-9_ .\\/-]*/g) || []) {
      if (!seen.has(m)) seen.set(m, f.name);
    }
    for (const m of f.text.match(/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//g) || []) {
      if (!seen.has(m)) seen.set(m, f.name);
    }
  }
  hit('本机路径', [...seen].map(([k, v]) => `${k}   (${v})`));
}

console.log('\n=== D. 密钥类 ===');
for (const [label, re] of [
  ['API Key (sk-)', /sk-[A-Za-z0-9_-]{20,}/g],
  ['GitHub PAT', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/g],
  ['Slack token', /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/g],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['硬编码 Bearer', /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/g],
]) {
  const hits = [];
  for (const f of files) {
    const t = f.text ?? f.buf.toString('utf8');
    const m = t.match(re);
    if (m) for (const s of [...new Set(m)].slice(0, 2)) hits.push(`${f.name}  →  ${JSON.stringify(s.slice(0, 50))}`);
  }
  hit(label, hits);
}

console.log('\n=== E. 不该外发的文件 ===');
{
  const hits = [];
  const badNames = new Set(['local.properties', '.env', '.env.local', '.npmrc', '.netrc', 'id_rsa', 'keystore', '.keystore', '.jks']);
  for (const f of files) {
    const base = basename(f.name).toLowerCase();
    const p = f.name.replace(/\\/g, '/');
    if (badNames.has(base)) hits.push(`${f.name}  ←  不该发布的文件`);
    else if (/\.(keystore|jks|p12|pfx)$/i.test(base)) hits.push(`${f.name}  ←  签名材料`);
    else if (p.includes('.git/')) hits.push(`${f.name}  ←  git 元数据`);
    else if (p.includes('node_modules/') || p.includes('/build/') || p.includes('.gradle/')) hits.push(`${f.name}  ←  构建产物`);
  }
  hit('黑名单文件', hits);
}

console.log('\n=== F. 8-11 位数字串（提示项，不算失败）===');
{
  const seen = new Map();
  for (const f of textFiles) {
    for (const m of f.text.match(/(?<![0-9A-Fa-fx#])[1-9][0-9]{7,10}(?![0-9A-Fa-f])/g) || []) {
      if (!seen.has(m)) seen.set(m, f.name);
    }
  }
  const list = [...seen].map(([k, v]) => `${k}   (${v})`);
  if (!list.length) console.log('  OK   无');
  else {
    console.log(`  ·   ${list.length} 个 —— 多半是字符画行内容 / 十六进制颜色 / PRNG 常量，人工过一眼`);
    for (const l of list.slice(0, 10)) console.log('         ' + l);
    warn += list.length;
  }
}

console.log('');
if (fail) console.log(`❌ 有 ${fail} 处硬性问题，别发这个包`);
else if (warn) console.log(`✅ 无硬性问题；有 ${warn} 处提示项${STRICT ? '（--strict 下视为失败）' : '（人工扫一眼即可）'}`);
else console.log('✅ 干净：没有密钥 / 身份信息 / 本机路径 / 黑名单文件');
process.exit(fail || (STRICT && warn) ? 1 : 0);
