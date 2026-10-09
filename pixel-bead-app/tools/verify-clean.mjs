/**
 * 针对这个项目做一次"精确点名"式扫描：直接找你自己的身份标识，
 * 而不是靠宽泛正则（上一版把 CSS 十六进制颜色当成 QQ 号了）。
 */
import { execFileSync } from 'node:child_process';

const ZIP = process.argv[2];
if (!ZIP) { console.error('用法: node verify-clean.mjs <zip>'); process.exit(2); }

const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('${ZIP.replace(/'/g, "''")}')
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
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const files = JSON.parse(raw).map((e) => ({ name: e.Name, buf: Buffer.from(e.B64, 'base64') }));
console.log(`${ZIP}\n${files.length} 个条目\n`);

const check = (label, fn) => {
  const hits = [];
  for (const f of files) {
    const r = fn(f);
    if (r) hits.push(`${f.name}${r === true ? '' : '  →  ' + JSON.stringify(String(r).slice(0, 70))}`);
  }
  console.log(`  ${hits.length ? '!!' : 'OK'}  ${label}`);
  for (const h of hits.slice(0, 6)) console.log('        ' + h);
  return hits.length;
};

console.log('=== A. 直呼其名：你的身份标识 ===');
let bad = 0;
for (const id of ['823747469', '82374', 'qq.com', 'tutan123', 'tuxu12345', 'Agent Cli', '.android-toolchain']) {
  bad += check(id, (f) => f.buf.toString('latin1').includes(id) || f.buf.toString('utf16le').includes(id));
}

console.log('\n=== B. 邮箱地址 ===');
{
  const mails = new Map();
  for (const f of files) {
    for (const m of f.buf.toString('utf8').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
      if (!mails.has(m)) mails.set(m, f.name);
    }
  }
  if (mails.size) { for (const [k, v] of mails) console.log(`  · ${k}   (${v})`); bad += mails.size; }
  else console.log('  OK  无');
}

console.log('\n=== C. 8-11 位纯数字串（QQ 号形态；已排除 #hex 颜色）===');
{
  const nums = new Map();
  for (const f of files) {
    const t = f.buf.toString('utf8');
    for (const m of t.match(/(?<![0-9A-Fa-fx#])[1-9][0-9]{7,10}(?![0-9A-Fa-f])/g) || []) {
      if (!nums.has(m)) nums.set(m, f.name);
    }
  }
  if (nums.size) { for (const [k, v] of nums) console.log(`  · ${k}   (${v})`); bad += nums.size; }
  else console.log('  OK  无');
}

console.log('\n=== D. 盘符绝对路径（忽略 C:\\Program Files 通用路径）===');
{
  const paths = new Map();
  for (const f of files) {
    if (!/\.(js|mjs|cjs|json|html|css|md|txt|xml|kts|java|pro|properties|yml|yaml|ps1|bat|sh)$/i.test(f.name)
      && !/\.gitignore$|\.gitattributes$|gradlew$/.test(f.name)) continue;
    const t = f.buf.toString('utf8');
    for (const m of t.match(/(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}(?!(?:Program Files|Windows|ProgramData)\b)[A-Za-z0-9_ .-]+[\\/][A-Za-z0-9_ .\\/-]*/g) || []) {
      if (!paths.has(m)) paths.set(m, f.name);
    }
  }
  if (paths.size) { for (const [k, v] of paths) console.log(`  · ${k}   (${v})`); bad += paths.size; }
  else console.log('  OK  无');
}

console.log('\n=== E. 密钥类 ===');
for (const [label, re] of [
  ['sk- API key', /sk-[A-Za-z0-9_-]{16,}/g],
  ['GitHub PAT', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['AWS AKIA', /AKIA[0-9A-Z]{16}/g],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
]) {
  bad += check(label, (f) => { const m = f.buf.toString('utf8').match(re); return m ? m[0] : null; });
}

console.log('\n=== F. 不该发布的文件 ===');
for (const r of ['local.properties', '.env', '.npmrc', '.netrc', 'keystore', '.jks', 'id_rsa']) {
  bad += check(r, (f) => f.name.split(/[\\/]/).pop().toLowerCase() === r);
}
for (const r of ['.git/', 'node_modules/', '/build/', '.gradle/']) {
  bad += check(r, (f) => f.name.replace(/\\/g, '/').includes(r));
}

console.log(`\n${bad === 0 ? '✅ 干净' : `⚠️  ${bad} 处`}`);
process.exit(0);
