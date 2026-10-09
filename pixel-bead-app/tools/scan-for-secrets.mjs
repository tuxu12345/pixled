/**
 * 发布前自检：扫压缩包 / 目录里有没有密钥、账号、本机路径等不该外发的东西。
 * 用法：node scan-for-secrets.mjs <zip路径 或 目录>
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const TARGET = process.argv[2];
if (!TARGET || !existsSync(TARGET)) { console.error('用法: node scan-for-secrets.mjs <zip或目录>'); process.exit(2); }
console.log('扫描目标:', TARGET, '\n');

/* ---------- 收集 {name, text} 列表 ---------- */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.xml',
  '.kts', '.java', '.pro', '.properties', '.yml', '.yaml', '.ps1', '.bat', '.sh', '.gradle']);
const BIN_SKIP = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.apk', '.jar', '.zip', '.so', '.dex']);

const files = [];

function isTextName(name) {
  const base = name.split(/[\\/]/).pop();
  if (base === '.gitignore' || base === '.gitattributes' || base === 'gradlew') return true;
  return TEXT_EXT.has(extname(name).toLowerCase());
}

if (TARGET.toLowerCase().endsWith('.zip')) {
  // 用 PowerShell 的 ZipFile 在内存里读，避免解压污染磁盘
  const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('${TARGET.replace(/'/g, "''")}')
$o = @()
foreach ($e in $z.Entries) {
  if ($e.Length -eq 0) { continue }
  $ms = New-Object System.IO.MemoryStream
  $s = $e.Open(); $s.CopyTo($ms); $s.Close()
  $o += [pscustomobject]@{ Name = $e.FullName; Size = $e.Length; B64 = [Convert]::ToBase64String($ms.ToArray()) }
}
$z.Dispose()
$o | ConvertTo-Json -Compress -Depth 3
`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  for (const e of JSON.parse(raw)) {
    const ext = extname(e.Name).toLowerCase();
    const buf = Buffer.from(e.B64, 'base64');
    if (BIN_SKIP.has(ext)) { files.push({ name: e.Name, size: e.Size, buf, text: null }); continue; }
    if (!isTextName(e.Name)) { files.push({ name: e.Name, size: e.Size, buf, text: null }); continue; }
    files.push({ name: e.Name, size: e.Size, buf, text: buf.toString('utf8') });
  }
} else {
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (['.git', 'node_modules', 'build', '.gradle'].includes(n)) continue;
        walk(p);
      } else {
        const buf = readFileSync(p);
        files.push({ name: relative(TARGET, p), size: st.size, buf, text: isTextName(n) ? buf.toString('utf8') : null });
      }
    }
  };
  walk(TARGET);
}

console.log(`共 ${files.length} 个文件（${files.filter((f) => f.text !== null).length} 个按文本扫）\n`);

/* ---------- 规则 ---------- */
const STR = [
  ['API 密钥 sk-', /sk-[A-Za-z0-9_-]{16,}/g],
  ['GitHub PAT', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/g],
  ['Slack token', /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/g],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['硬编码 Bearer', /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g],
];
const PERSONAL = [
  ['邮箱地址', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['QQ 号形态的 5-11 位数字串', /\b[1-9][0-9]{4,10}\b/g],
  ['tutan123 / tuxu12345 账号名', /tutan123|tuxu12345/gi],
  ['Windows 用户目录', /(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}Users[\\/][A-Za-z0-9_.-]+/gi],
  ['/Users/ 家目录', /\/Users\/[A-Za-z0-9_.-]+/g],
  ['/home/ 家目录', /\/home\/[A-Za-z0-9_.-]+/g],
];
// 盘符绝对路径：只关心"看起来像本机工作目录"的，忽略 C:\Program Files 这种通用路径
const LOCALPATH = /(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}(?!(?:Program Files|Windows|ProgramData|Users\\Public)\b)[A-Za-z0-9_ .-]+[\\/][A-Za-z0-9_ .\\/-]*/g;

const ALLOW_EMAIL = /@users\.noreply\.github\.com$|@example\.(com|org)$|@schemastore\.org$|@types\.|@babel|@esbuild|@rollup|@playwright|@puppeteer|@npmcli|@isaacs|@jridgewell|@ungap|@eslint/i;

let issues = 0;
const report = (label, hits) => {
  if (!hits.length) return;
  console.log(`  [${label}] ${hits.length} 处`);
  for (const h of hits.slice(0, 8)) console.log('      ' + h);
  issues += hits.length;
};

console.log('=== 1. 密钥类 ===');
let any = false;
for (const [label, re] of STR) {
  const hits = [];
  for (const f of files) {
    if (!f.text) continue;
    re.lastIndex = 0;
    const m = f.text.match(re);
    if (m) for (const s of [...new Set(m)].slice(0, 3)) hits.push(`${f.name}  →  ${JSON.stringify(s.slice(0, 60))}`);
  }
  if (hits.length) { any = true; report(label, hits); }
}
if (!any) console.log('  无 ✓');

console.log('\n=== 2. 身份信息 ===');
any = false;
for (const [label, re] of PERSONAL) {
  const hits = [];
  for (const f of files) {
    if (!f.text) continue;
    re.lastIndex = 0;
    const m = f.text.match(re);
    if (m) for (const s of [...new Set(m)].slice(0, 6)) {
      if (label === '邮箱地址' && ALLOW_EMAIL.test(s)) continue;
      if (label === 'QQ 号形态的 5-11 位数字串' && /^\d+$/.test(s) && (s.length >= 8 || +s < 1000000)) {
        // 排除明显的版本号/时间戳/端口：只报 5-11 位且看起来像 QQ 的
      }
      hits.push(`${f.name}  →  ${JSON.stringify(s.slice(0, 60))}`);
    }
  }
  if (hits.length) { any = true; report(label, hits); }
}
if (!any) console.log('  无 ✓');

console.log('\n=== 3. 本机绝对路径（忽略 C:\\Program Files 这类通用路径）===');
{
  const hits = [];
  for (const f of files) {
    if (!f.text) continue;
    const m = f.text.match(LOCALPATH);
    if (m) for (const s of [...new Set(m)].slice(0, 8)) hits.push(`${f.name}  →  ${JSON.stringify(s.slice(0, 80))}`);
  }
  if (hits.length) report('盘符路径', hits); else console.log('  无 ✓');
}

console.log('\n=== 4. 不该出现在发布包里的文件 ===');
for (const r of ['local.properties', '.env', '.npmrc', '.netrc', 'keystore', '.jks', 'id_rsa', 'credentials']) {
  const hit = files.filter((f) => f.name.split(/[\\/]/).pop().toLowerCase().includes(r));
  if (hit.length) { console.log(`  !! ${r}: ${hit.map((h) => h.name).join(', ')}`); issues++; }
}
for (const r of ['.git/', 'node_modules/', '/build/', '.gradle/']) {
  const hit = files.filter((f) => f.name.replace(/\\/g, '/').includes(r));
  if (hit.length) { console.log(`  !! ${r}: ${hit.length} 个文件`); issues++; }
}
console.log('  （没列出 = 都没有）');

console.log('\n=== 5. 二进制文件也抽串扫一遍 ===');
{
  const hits = [];
  for (const f of files) {
    if (f.text !== null) continue;
    if (f.size > 8 * 1024 * 1024) continue;
    const a = f.buf.toString('latin1');
    const u = f.buf.toString('utf16le');
    for (const re of [/sk-[A-Za-z0-9_-]{20,}/g, /(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}Users[\\/]/gi, /tutan123|tuxu12345/gi, /\b[1-9][0-9]{7,10}\b/g]) {
      for (const src of [a, u]) {
        const m = src.match(re);
        if (m) for (const s of [...new Set(m)].slice(0, 2)) hits.push(`${f.name}  →  ${JSON.stringify(String(s).slice(0, 50))}`);
      }
    }
  }
  if (hits.length) report('二进制命中', hits); else console.log(`  ${files.filter((f) => f.text === null).length} 个二进制文件无命中 ✓`);
}

console.log(`\n${issues === 0 ? '✅ 干净：没有密钥 / 账号 / 本机路径' : `⚠️  共 ${issues} 处需要人工确认`}`);
process.exit(0);
