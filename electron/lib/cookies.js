'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const cfg = require('./config');

/** 项目根目录（开发版与打包版布局不同，逐个候选探测） */
function projectRoot() {
  const cands = [];
  try {
    const { app } = require('electron');
    const exeDir = path.dirname(app.getPath('exe'));
    cands.push(path.resolve(exeDir, '..', '..'));        // 打包版: <root>/release/App/App.exe
    cands.push(path.resolve(exeDir, '..', '..', '..'));  // 打包版放在更深一层时
  } catch (e) {}
  cands.push(path.resolve(__dirname, '..', '..'));       // 开发版: <root>/electron/lib
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'package.json'))) return c; } catch (e) {}
  }
  return cands[cands.length - 1];
}

/** 随项目分发的独立 Chrome（存在时优先，避免碰用户日常浏览器的配置） */
function projectChrome() {
  try {
    const root = projectRoot();
    const cands = [
      path.join(root, 'tools', 'chrome', 'chrome.exe'),
      path.join(root, '..', 'tools', 'chrome', 'chrome.exe'),
    ];
    for (const c of cands) { if (fs.existsSync(c)) return c; }
  } catch (e) {}
  return null;
}

function findChrome() {
  const s = cfg.get();
  if (s.chromePath && fs.existsSync(s.chromePath)) return s.chromePath;
  const proj = projectChrome();
  if (proj) return proj;
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

/** 软件专用 Chrome 配置目录（独立于用户日常浏览器，绝不指向其 profile） */
function profileDir() {
  const cands = [];
  try {
    const root = projectRoot();
    cands.push(path.join(root, 'tools', 'chrome-profile'));
    cands.push(path.join(root, '..', 'tools', 'chrome-profile'));
  } catch (e) {}
  for (const c of cands) {
    if (fs.existsSync(path.dirname(c))) { try { fs.mkdirSync(c, { recursive: true }); } catch (e) {} return c; }
  }
  const { app } = require('electron');
  const d = path.join(app.getPath('userData'), 'chrome-profile');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function dbPath(profile) {
  const p1 = path.join(profile, 'Default', 'Network', 'Cookies');
  const p2 = path.join(profile, 'Default', 'Cookies');
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  return p1;
}

function localStatePath(profile) { return path.join(profile, 'Local State'); }

/** 用 Windows DPAPI 解密（PowerShell 调用，返回 Buffer 或 null） */
function dpapiDecrypt(blob) {
  const tmpIn = path.join(os.tmpdir(), 'ehv_dpapi_' + process.pid + '_' + Date.now() + '.bin');
  const tmpOut = tmpIn + '.out';
  try {
    fs.writeFileSync(tmpIn, blob);
    const ps = [
      'Add-Type -AssemblyName System.Security',
      "$b=[IO.File]::ReadAllBytes('" + tmpIn.replace(/'/g, "''") + "')",
      "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[IO.File]::WriteAllBytes('" + tmpOut.replace(/'/g, "''") + "',$p)"
    ].join('; ');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 20000, windowsHide: true, stdio: 'pipe' });
    const out = fs.readFileSync(tmpOut);
    return out;
  } catch (e) {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    try { fs.unlinkSync(tmpOut); } catch (e) {}
  }
}

let masterKeyCache = null;
function masterKey(profile) {
  if (masterKeyCache) return masterKeyCache;
  try {
    const ls = JSON.parse(fs.readFileSync(localStatePath(profile), 'utf8'));
    const raw = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
    if (raw.slice(0, 5).toString('latin1') !== 'DPAPI') return null;
    const key = dpapiDecrypt(raw.slice(5));
    if (!key || key.length !== 32) return null;
    masterKeyCache = key;
    return key;
  } catch (e) { return null; }
}

/** 解密单条 cookie 值；失败返回 null */
function decryptValue(encBuf, key) {
  if (!encBuf || encBuf.length < 20) return null;
  const prefix = encBuf.slice(0, 3).toString('latin1');
  if (prefix !== 'v10') return null; // v20 无法解密
  const nonce = encBuf.slice(3, 15);
  const ct = encBuf.slice(15, encBuf.length - 16);
  const tag = encBuf.slice(encBuf.length - 16);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(ct), d.final()]);
    // 前 32 字节是 domain hash
    return out.slice(32).toString('utf8');
  } catch (e) { return null; }
}

/** 从 Chrome profile 读取 E-Hentai 相关 cookie */
function readCookies(profile) {
  const db = dbPath(profile);
  if (!fs.existsSync(db)) return { ok: false, error: 'cookie-db-missing', cookies: [] };
  const key = masterKey(profile);
  if (!key) return { ok: false, error: 'no-master-key', cookies: [] };
  let DatabaseSync;
  try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (e) { return { ok: false, error: 'no-sqlite', cookies: [] }; }
  const tmp = path.join(os.tmpdir(), 'ehv_cookies_' + process.pid + '_' + Date.now() + '.db');
  try {
    fs.copyFileSync(db, tmp);
  } catch (e) {
    // 文件被占用，尝试 immutable 直读
  }
  let d;
  try { d = new DatabaseSync(fs.existsSync(tmp) ? tmp : db, { readOnly: true }); }
  catch (e) { return { ok: false, error: 'db-open-failed:' + e.message, cookies: [] }; }
  let rows = [];
  try {
    rows = d.prepare("SELECT host_key, name, path, is_secure, is_httponly, CAST(expires_utc AS TEXT) AS expires_utc, encrypted_value FROM cookies WHERE host_key LIKE '%e-hentai%' OR host_key LIKE '%exhentai%' OR host_key LIKE '%ehgt%'").all();
  } catch (e) { d.close(); return { ok: false, error: 'query:' + e.message, cookies: [] }; }
  d.close();
  try { fs.unlinkSync(tmp); } catch (e) {}

  const out = [];
  let v20count = 0;
  for (const r of rows) {
    const buf = Buffer.from(r.encrypted_value);
    const v = decryptValue(buf, key);
    if (v == null) { if (buf.slice(0,3).toString('latin1') === 'v20') v20count++; continue; }
    out.push({
      domain: r.host_key,
      name: r.name,
      value: v,
      path: r.path || '/',
      secure: !!r.is_secure,
      httpOnly: !!r.is_httponly,
      expirationDate: r.expires_utc ? (Number(r.expires_utc) / 1000000 - 11644473600) : undefined
    });
  }
  return { ok: true, cookies: out, v20: v20count, total: rows.length };
}

/** 启动 Chrome 让用户登录（独立 profile，关闭 App-Bound 加密以便读取） */
function launchLoginChrome(url) {
  const chrome = findChrome();
  if (!chrome) throw new Error('未找到 Chrome，请安装 Chrome 或在设置中指定路径');
  const profile = profileDir();
  const s = cfg.get();
  const args = [
    '--user-data-dir=' + profile,
    '--disable-features=AppBoundEncryption',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1300,900'
  ];
  if (s.proxy && s.proxy.enabled && s.proxy.url) args.push('--proxy-server=' + s.proxy.url);
  if (s.userAgent) args.push('--user-agent=' + s.userAgent);
  args.push(url || 'https://e-hentai.org/bounce_login.php');
  args.push('https://exhentai.org/');
  const cp = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  cp.unref();
  return { pid: cp.pid, profile };
}

/** 关闭由我们启动的 Chrome（按 profile 路径匹配）：先优雅关闭，再强制 */
function closeLoginChrome() {
  const profile = profileDir();
  try {
    const p = profile.replace(/\\/g, '\\\\');
    const ps = [
      "$procs = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*" + p + "*' })",
      "foreach ($pr in $procs) { $g = Get-Process -Id $pr.ProcessId -ErrorAction SilentlyContinue; if ($g -and $g.MainWindowHandle -ne 0) { $g.CloseMainWindow() | Out-Null } }",
      "Start-Sleep -Seconds 3",
      "$procs2 = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*" + p + "*' })",
      "foreach ($pr in $procs2) { Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue }",
      "Start-Sleep -Seconds 1"
    ].join('; ');
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 30000, windowsHide: true });
  } catch (e) {}
}

module.exports = { findChrome, profileDir, readCookies, launchLoginChrome, closeLoginChrome, masterKey };
