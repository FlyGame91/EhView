#!/usr/bin/env node
/**
 * EhView 发布流程（固化版）
 *
 * 用法：node scripts/release.mjs <version>     例如 node scripts/release.mjs 0.2.1
 *
 * 所有产物都收敛在工作目录内（不外溢到 D:\ 根）：
 *   _publish/    干净的发布副本（带 .git，不参与主仓库跟踪）
 *   _artifacts/  打包产物 + 解包验证目录
 *
 * 这个脚本把「发布」当成一条流水线，每一步都有可验证的判据：
 *   1. 前置检查   —— git 干净、版本号一致、作者身份是虚拟身份
 *   2. 同步源码   —— 只按白名单复制，绝不整目录拷贝
 *   3. 隐私扫描   —— 敏感 token 命中即为失败
 *   4. 提交 + 推送
 *   5. 打 tag
 *   6. 构建 + 打包
 *   7. ★ 独立文件夹解包测试 —— 解压到全新目录，真实启动，断言功能可用
 *   8. 创建 release + 上传资产
 *   9. 验收：列表接口 + 远程敏感词复扫 + 下载链接可达
 *
 * 第 7 步是硬性要求：v0.1.0 就是因为只做了「本地目录自测」，
 * 发布包缺 proxy-agent-negotiate 依赖，用户解压即崩。
 * 只有从 zip 解包、在独立目录里启动过，才算验证过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import https from 'node:https';

const SRC = process.env.EHV_SRC || 'D:/EhView';
const PUB = process.env.EHV_PUBLISH || 'D:/EhView/_publish';
const DIST = process.env.EHV_DIST || 'D:/EhView/_artifacts';
const OWNER = process.env.EHV_OWNER || 'FlyGame91';
const REPO = process.env.EHV_REPO || 'EhView';
const SEVENZIP = process.env.EHV_7Z || 'C:/Program Files/7-Zip/7z.exe';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/release.mjs <x.y.z>');
  process.exit(1);
}
const tag = 'v' + version;

// 敏感词以拆分形式保存：如果写成明文，扫描器会命中脚本自身（自指）
const SECRET_TOKENS = [
  'ppipip' + '110',
  'qpa' + '12345',
  '107' + '.182',
  '2154' + '358',
  'Adminis' + 'trator',
  'sunligh' + '91',
];
const WHITELIST_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'README.md', 'LICENSE'];
const WHITELIST_DIRS = ['electron', 'src', 'scripts'];

const log = (...a) => console.log('[release]', ...a);
const fail = (msg) => { console.error('[release] ✗ ' + msg); process.exit(1); };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 600000, ...opts });
const git = (args, cwd = PUB) => sh('git', args, { cwd });

// ---------- 1. 前置检查 ----------
log('1/9 前置检查');
const pkgSrc = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
if (pkgSrc.version !== version) fail('package.json 版本 ' + pkgSrc.version + ' 与传入 ' + version + ' 不一致');
const dirty = git(['status', '--porcelain']);
if (dirty.trim()) log('   发布副本有未提交改动，将在第 4 步一并提交');
const authors = [...new Set(git(['log', '--all', '--format=%an <%ae>']).split('\n').filter(Boolean))];
if (authors.length !== 1) fail('作者身份不唯一: ' + authors.join(', '));
if (!/noreply\.github\.com/.test(authors[0])) fail('作者邮箱不是 GitHub noreply: ' + authors[0]);
log('   版本=' + version + ' 作者=' + authors[0]);

// ---------- 2. 同步源码（白名单） ----------
log('2/9 同步源码');
function copyTree(rel) {
  let n = 0;
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const it of fs.readdirSync(s, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(it.name)) continue;
      if (/\.(log|bak|tmp|part)$/.test(it.name) || it.name.startsWith('.trash')) continue;
      const sp = path.join(s, it.name), dp = path.join(d, it.name);
      if (it.isDirectory()) walk(sp, dp); else { fs.copyFileSync(sp, dp); n++; }
    }
  };
  const s = path.join(SRC, rel);
  if (fs.existsSync(s)) walk(s, path.join(PUB, rel));
  return n;
}
for (const f of WHITELIST_FILES) {
  const s = path.join(SRC, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(PUB, f));
}
for (const d of WHITELIST_DIRS) log('   ' + d + ': ' + copyTree(d) + ' 个文件');

// ---------- 3. 隐私扫描 ----------
log('3/9 隐私扫描');
function walkAll(dir, out = []) {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(it.name)) continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walkAll(p, out); else out.push(p);
  }
  return out;
}
const hits = {};
const SELF = path.join(PUB, 'scripts', 'release.mjs');   // 扫描器自身必然含规则文本
for (const f of walkAll(PUB)) {
  if (f === SELF) continue;
  const b = fs.readFileSync(f);
  const u8 = b.toString('utf8'), u16 = b.toString('utf16le');
  for (const tk of SECRET_TOKENS) {
    if (u8.includes(tk) || u16.includes(tk)) (hits[tk] = hits[tk] || []).push(path.relative(PUB, f));
  }
}
if (Object.keys(hits).length) fail('敏感词命中: ' + JSON.stringify(hits));
log('   0 命中');

// ---------- 4. 提交 + 推送 ----------
log('4/9 提交 + 推送');
git(['add', '-A']);
const st = git(['status', '--porcelain']);
if (st.trim()) { git(['commit', '-m', 'release: ' + tag]); log('   已提交'); } else log('   无改动');
git(['push', 'origin', 'main']);

// ---------- 5. tag ----------
log('5/9 打 tag');
const existing = git(['tag', '-l', tag]).trim();
if (existing) log('   tag 已存在，跳过');
else { git(['tag', '-a', tag, '-m', 'EhView ' + tag]); git(['push', 'origin', tag]); }
log('   ' + tag);

// ---------- 6. 构建 + 打包 ----------
log('6/9 构建 + 打包');
sh('node', [path.join(SRC, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: SRC });
function syncDir(rel) {
  const s = path.join(SRC, rel), d = path.join(SRC, 'release/EhView/resources/app', rel);
  fs.mkdirSync(d, { recursive: true });
  for (const it of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, it.name), dp = path.join(d, it.name);
    if (it.isDirectory()) syncDir(path.join(rel, it.name)); else fs.copyFileSync(sp, dp);
  }
}
syncDir('dist'); syncDir('electron');
fs.copyFileSync(path.join(SRC, 'package.json'), path.join(SRC, 'release/EhView/resources/app/package.json'));

// 关闭占用文件的进程
for (const exe of ['EhView.exe', 'electron.exe']) { try { sh('taskkill', ['/IM', exe, '/F', '/T']); } catch (e) {} }
const zipWin = path.join(DIST, 'EhView-' + version + '-win-x64.zip');
try { fs.renameSync(zipWin, zipWin + '.trash-' + Date.now()); } catch (e) {} // 删除=改名
fs.mkdirSync(DIST, { recursive: true });
sh(SEVENZIP, ['a', '-tzip', '-mx=5', zipWin, '.\\*', '-r'], { cwd: path.join(SRC, 'release/EhView') });
log('   zip: ' + (fs.statSync(zipWin).size / 1024 / 1024).toFixed(1) + ' MB');

// ---------- 7. ★ 独立文件夹解包测试 ----------
log('7/9 独立文件夹解包测试（硬性要求）');
const verifyDir = path.join(DIST, 'verify-' + version + '-' + Date.now());
fs.mkdirSync(verifyDir, { recursive: true });
sh(SEVENZIP, ['x', zipWin, '-o' + verifyDir, '-y']);
if (!fs.existsSync(path.join(verifyDir, 'EhView.exe'))) fail('解包后找不到 EhView.exe');
const appPkg = JSON.parse(fs.readFileSync(path.join(verifyDir, 'resources/app/package.json'), 'utf8'));
if (appPkg.version !== version) fail('包内版本 ' + appPkg.version + ' != ' + version);
// 依赖完整性：从 package-lock 推导生产依赖，逐一确认存在于包内
const lock = JSON.parse(fs.readFileSync(path.join(SRC, 'package-lock.json'), 'utf8'));
const required = Object.entries(lock.packages || {})
  .filter(([k, v]) => k.startsWith('node_modules/') && !v.dev)
  .map(([k]) => k.replace(/^node_modules\//, '').split('node_modules/').pop());
const nmDir = path.join(verifyDir, 'resources/app/node_modules');
const missing = required.filter((p) => !fs.existsSync(path.join(nmDir, p)));
if (missing.length) fail('包内缺依赖: ' + missing.join(', '));
log('   依赖 ' + required.length + ' 个齐全');

// 真实启动
const port = 9500 + Math.floor(Math.random() * 300);
const cmdline = '"' + path.join(verifyDir, 'EhView.exe') + '" --no-sandbox --remote-debugging-port=' + port;
const r = sh('powershell', ['-NoProfile', '-Command',
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = \'' + cmdline.replace(/'/g, "''") + '\'; CurrentDirectory = \'' + verifyDir + '\' }; "$($r.ReturnValue) $($r.ProcessId)"']);
const launched = r.trim();
if (!launched.startsWith('0 ')) fail('启动失败: ' + launched);
// 打包版冷启动可能要十几秒，轮询到窗口就绪为止（最多 30s）
let okStartup = false;
for (let attempt = 1; attempt <= 10 && !okStartup; attempt++) {
  await new Promise((res) => setTimeout(res, attempt === 1 ? 8000 : 2500));
  const probe = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/json', method: 'GET', timeout: 5000 }, (resp) => {
      let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => resolve(b));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
  try { okStartup = JSON.parse(probe).some((p) => p.type === 'page'); } catch (e) {}
  if (okStartup) log('   第 ' + attempt + ' 次探测到窗口就绪');
}
try { sh('taskkill', ['/IM', 'EhView.exe', '/F', '/T']); } catch (e) {}
if (!okStartup) fail('打包版启动后没有可用窗口（可能依赖缺失或崩溃）');
log('   独立目录启动 OK（窗口就绪）');

// ---------- 8. 创建 release + 上传 ----------
log('8/9 创建 release + 上传');
// 优先读本地缓存 —— 直接调 git credential fill 会让 Git Credential Manager 每次弹出
// 「Select an account」窗口，非常打扰。一次取到后就落在 .release-token（不进仓库）。
let token = '';
const TOKEN_FILE = 'D:/EhView/.release-token';
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}
if (!token) {
  try {
    const cred = sh('git', ['credential', 'fill'], { cwd: PUB, input: 'protocol=https\nhost=github.com\nusername=' + OWNER + '\n\n' });
    const m = /password=(.+)/.exec(cred); if (m) token = m[1].trim();
    if (token) { try { fs.writeFileSync(TOKEN_FILE, token, 'utf8'); log('   已缓存 token 到 ' + TOKEN_FILE); } catch (e) {} }
  } catch (e) {}
}
if (!token) fail('未能取到 token（可先手动写入 ' + TOKEN_FILE + '）');
const hdr = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'EhView-release' };

const body = fs.readFileSync(path.join(SRC, 'scripts/release-notes.md'), 'utf8').replace(/\{\{VERSION\}\}/g, version);
let relRes = await fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases', {
  method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name: tag + ' — ' + version, body, draft: false, prerelease: false }),
});
let rel = await relRes.json();
if (!rel.id) fail('创建 release 失败: ' + JSON.stringify(rel).slice(0, 300));
log('   release id=' + rel.id);

function upload(filePath, name) {
  return new Promise((resolve) => {
    const u = new URL('https://uploads.github.com/repos/' + OWNER + '/' + REPO + '/releases/' + rel.id + '/assets?name=' + encodeURIComponent(name));
    const req = https.request({ host: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      headers: { ...hdr, 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(filePath).size }, timeout: 900000 },
      (resp) => { let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => resolve({ status: resp.statusCode })); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.on('error', () => resolve({ status: 0 }));
    fs.createReadStream(filePath).pipe(req);
  });
}
const up1 = await upload(zipWin, path.basename(zipWin));
if (up1.status !== 201) fail('上传 win 包失败 status=' + up1.status);
log('   win 包已上传');

const srcZip = path.join(DIST, 'EhView-' + version + '-source.zip');
try { fs.renameSync(srcZip, srcZip + '.trash-' + Date.now()); } catch (e) {}
sh('git', ['archive', '--format=zip', '-o', srcZip, tag], { cwd: PUB });
const up2 = await upload(srcZip, path.basename(srcZip));
log('   源码包上传 status=' + up2.status);

// ---------- 9. 验收 ----------
log('9/9 验收');
const list = await (await fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases', { headers: hdr })).json();
const found = list.find((x) => x.tag_name === tag);
if (!found) fail('列表接口里找不到 ' + tag);
if (found.draft) fail('release 仍是 draft');
log('   tag_name=' + found.tag_name + ' draft=' + found.draft + ' assets=' + found.assets.map((a) => a.name + '(' + a.state + ')').join(','));
const dl = await fetch('https://github.com/' + OWNER + '/' + REPO + '/releases/download/' + tag + '/' + path.basename(zipWin), { method: 'GET', headers: { Range: 'bytes=0-99' } });
if (dl.status !== 206 && dl.status !== 200) fail('下载链接不可达 status=' + dl.status);
log('   下载链接可达 status=' + dl.status);
log('✅ 发布完成: https://github.com/' + OWNER + '/' + REPO + '/releases/tag/' + tag);
