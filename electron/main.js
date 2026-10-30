'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, protocol, session, shell, dialog, Menu, net } = require('electron');

const cfg = require('./lib/config');
const http = require('./lib/http');
const cookies = require('./lib/cookies');
const eh = require('./lib/eh');
const cache = require('./lib/cache');
const download = require('./lib/download');
const library = require('./lib/library');
const history = require('./lib/history');

app.setName('EhView');
const isDev = process.env.EHV_DEV === '1';
let mainWindow = null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'ehimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 980, minHeight: 640,
    backgroundColor: '#141519',
    title: 'EhView',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });
  Menu.setApplicationMenu(null);
  if (isDev) mainWindow.loadURL('http://127.0.0.1:5173');
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  const s = cfg.get();
  await http.applyProxy();

  // 恢复已保存的 cookie
  try {
    const saved = s.cookies || {};
    for (const [domain, list] of Object.entries(saved)) {
      for (const c of list) await http.setCookie({ ...c, domain });
    }
  } catch (e) { console.warn('restore cookies', e.message); }

  // ehimg 协议：图片走本地缓存
  protocol.handle('ehimg', async (request) => {
    try {
      const u = new URL(request.url);
      // ehimg://get?key=<sha1>&ext=.webp&gid=<gid> —— 已知缓存键时直接读文件，完全不联网
      if (u.host === 'get') {
        const key = u.searchParams.get('key') || '';
        const ext = u.searchParams.get('ext') || '.jpg';
        const gg = u.searchParams.get('gid') || '';
        if (!/^[0-9a-f]{40}$/.test(key)) return new Response('bad key', { status: 400 });
        const fp = cache.pathOfKey(key, ext, gg);
        if (!fs.existsSync(fp)) return new Response('miss', { status: 404 });
        const buf = fs.readFileSync(fp);
        const mm = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return new Response(buf, { status: 200, headers: { 'Content-Type': mm, 'Cache-Control': 'public, max-age=31536000' } });
      }
      const target = u.searchParams.get('url');
      const gid = u.searchParams.get('gid') || '';
      if (!target) return new Response('missing url', { status: 400 });
      if (!cfg.get().cacheEnabled) {
        // 直接代理
        const r = await http.request(target, { referer: 'https://e-hentai.org/' });
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers['content-type'] || 'image/jpeg' } });
      }
      const p = await cache.ensure(target, { referer: 'https://e-hentai.org/', gid });
      if (!p) return new Response('fetch failed', { status: 502 });
      const data = fs.readFileSync(p);
      const ext = path.extname(p).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return new Response(data, { status: 200, headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000' } });
    } catch (e) {
      return new Response('err: ' + e.message, { status: 500 });
    }
  });

  // 下载任务状态变化时推送；归档任务完成/开始时额外通知顶栏刷新货币余额（下载会扣 GP）
  let lastDone = new Set();
  try { const n = cache.sweepTrash(7); if (n) console.log('回收站清理', n, '项'); } catch (e) {}
  download.setEmitter((list) => {
    send('dl:update', list);
    const done = new Set(list.filter((t) => t.status === 'done').map((t) => t.id));
    let changed = false;
    for (const id of done) if (!lastDone.has(id)) { changed = true; break; }
    lastDone = done;
    if (changed) send('stats:refresh');
  });
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/* ============ IPC ============ */

ipcMain.handle('app:init', async () => {
  const s = cfg.get();
  try { if (!fs.existsSync(path.join(app.getPath('userData'), 'settings.json'))) cfg.save({}); } catch (e) {}
  return {
    settings: s,
    version: app.getVersion(),
    platform: process.platform,
    cache: cache.stats(),
    chrome: cookies.findChrome()
  };
});

ipcMain.handle('settings:get', () => cfg.get());
ipcMain.handle('settings:save', async (e, patch) => {
  const s = cfg.save(patch);
  if (patch && patch.proxy) await http.applyProxy();
  if (patch && patch.userAgent) await http.applyProxy();
  return s;
});
ipcMain.handle('settings:pickDir', async (e, which) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  const s = cfg.save({ [which]: r.filePaths[0] });
  return s[which];
});
ipcMain.handle('shell:open', async (e, p) => { shell.openPath(p); return true; });

/* ---- 登录 ---- */
let loginSession = { active: false, profile: null, startedAt: 0 };

ipcMain.handle('auth:login', async (e, opts) => {
  try {
    const url = (opts && opts.site) === 'e-hentai' ? 'https://e-hentai.org/bounce_login.php' : 'https://e-hentai.org/bounce_login.php';
    const r = cookies.launchLoginChrome(url);
    loginSession = { active: true, profile: r.profile, startedAt: Date.now(), pid: r.pid };
    return { ok: true, profile: r.profile, note: '已打开 Chrome，请登录；登录成功后点「检测登录状态」' };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('auth:poll', async () => {
  const profile = loginSession.profile || cookies.profileDir();
  const r = cookies.readCookies(profile);
  if (!r.ok) return { ok: false, error: r.error, cookies: 0 };
  const getId = (n) => r.cookies.find((c) => c.name === n);
  const member = getId('ipb_member_id');
  const pass = getId('ipb_pass_hash');
  const igneous = getId('igneous');
  if (!member || !pass) return { ok: false, error: 'not-logged-in', total: r.total, v20: r.v20, found: r.cookies.map((c) => c.name) };
  // 保存全部相关 cookie；并把 E-Hentai 的登录凭证同步一份到 .exhentai.org
  // （ExHentai 认同一套 ipb_member_id/ipb_pass_hash，缺这份就会一直拿不到 igneous）
  const CROSS = ['ipb_member_id', 'ipb_pass_hash', 'sk'];
  const ehCookies = r.cookies.filter(c => /\.e-hentai\.org$/.test(c.domain) && CROSS.includes(c.name));
  for (const c of ehCookies) {
    r.cookies.push({ ...c, domain: '.exhentai.org' });
  }
  const byDomain = {};
  for (const c of r.cookies) {
    if (!byDomain[c.domain]) byDomain[c.domain] = [];
    if (!byDomain[c.domain].some(x => x.name === c.name)) byDomain[c.domain].push(c);
    await http.setCookie(c);
  }
  const hasIgneous = !!(igneous && igneous.value);
  cfg.save({ cookies: byDomain, loggedIn: true, memberId: member.value, username: cfg.get().username || '', lastSync: Date.now(), ...(hasIgneous ? { site: 'exhentai' } : {}) });
  let who = { loggedIn: true, username: '' };
  try { who = await eh.whoami(); } catch (e) {}
  if (who.username) cfg.save({ username: who.username });
  loginSession.active = false;
  return { ok: true, memberId: member.value, username: who.username || '', igneous: !!igneous, cookies: r.cookies.length };
});

ipcMain.handle('auth:import', async (e, payload) => {
  // payload: 支持 { cookieString } 或 { domain, cookies:[{name,value}] }
  try {
    const list = [];
    if (payload && payload.cookieString) {
      for (const part of payload.cookieString.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!name) continue;
        list.push({ name, value });
      }
    } else if (payload && payload.cookies) list.push(...payload.cookies);
    if (!list.length) return { ok: false, error: '没有解析到 cookie' };
    const byDomain = cfg.get().cookies || {};
    const domains = ['e-hentai.org', 'exhentai.org'];
    for (const d of domains) {
      byDomain[d] = byDomain[d] || [];
      for (const c of list) {
        const full = { domain: d, name: c.name, value: c.value, path: '/', secure: true, httpOnly: true };
        await http.setCookie(full);
        const i = byDomain[d].findIndex((x) => x.name === c.name);
        if (i >= 0) byDomain[d][i] = full; else byDomain[d].push(full);
      }
    }
    cfg.save({ cookies: byDomain, loggedIn: true });
    let who = {};
    try { who = await eh.whoami(); } catch (err) {}
    return { ok: true, count: list.length, who };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('auth:logout', async () => {
  await http.clearCookies();
  cfg.save({ cookies: {}, loggedIn: false, username: '', memberId: '' });
  return { ok: true };
});

ipcMain.handle('auth:check', async () => {
  try {
    const r = await eh.whoami();
    if (r.loggedIn) cfg.save({ loggedIn: true, username: r.username || cfg.get().username });
    return r;
  } catch (e) { return { loggedIn: false, error: e.message }; }
});

ipcMain.handle('auth:closeChrome', () => { cookies.closeLoginChrome(); return { ok: true }; });

/* ---- E-Hentai ---- */
ipcMain.handle('eh:search', async (e, q) => { try { return { ok: true, ...(await eh.search(q)) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('eh:gallery', async (e, gid, token) => { try { return { ok: true, data: await eh.gallery(gid, token) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('eh:pages', async (e, gid, token) => { try { return { ok: true, data: await eh.pageListCached(gid, token) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('eh:thumbs', async (e, gid, token, page) => { try { return { ok: true, data: await eh.galleryThumbs(gid, token, page || 0) }; } catch (err) { return { ok: false, error: err.message }; } });
let keyMap = {};
let keyMapDirty = false;
let keyMapTimer = null;
function keyMapPath() { return path.join(app.getPath('userData'), 'pagekeys.json'); }
function loadKeyMap() {
  try { keyMap = JSON.parse(fs.readFileSync(keyMapPath(), 'utf8')) || {}; } catch (err) { keyMap = {}; }
  // 条目上限：超出后按 gid 分组的条目数从多到少整组丢弃（这些图集的缓存多半也早被淘汰了）
  const MAX_KEYS = 30000;
  const keys = Object.keys(keyMap);
  if (keys.length > MAX_KEYS) {
    const byGid = {};
    for (const k of keys) { const g = keyMap[k] && keyMap[k].gid; if (g) (byGid[g] = byGid[g] || []).push(k); }
    const groups = Object.entries(byGid).sort((a, b) => a[1].length - b[1].length);
    let drop = keys.length - MAX_KEYS + 5000;
    for (const [g, ks] of groups) {
      if (drop <= 0) break;
      for (const k of ks) delete keyMap[k];
      drop -= ks.length;
    }
    keyMapDirty = true;
    scheduleKeyMapSave();
  }
}

/** 清理过期的图集页面列表缓存（保留 7 天） */
function sweepPagesCache(maxAgeDays = 7) {
  try {
    const d = app.getPath('userData');
    const cutoff = Date.now() - maxAgeDays * 86400000;
    let n = 0;
    for (const f of fs.readdirSync(d)) {
      if (!/^pages-\d+\.json$/.test(f)) continue;
      const p = path.join(d, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) { fs.renameSync(p, p + '.trash-' + Date.now()); n++; } } catch (err) {}
    }
    return n;
  } catch (err) { return 0; }
}
function flushKeyMap() { if (!keyMapDirty) return; try { fs.writeFileSync(keyMapPath(), JSON.stringify(keyMap)); keyMapDirty = false; } catch (err) {} }
function scheduleKeyMapSave() { if (keyMapTimer) return; keyMapTimer = setTimeout(() => { keyMapTimer = null; flushKeyMap(); }, 3000); }
app.whenReady().then(() => {
  loadKeyMap();
  const swept = sweepPagesCache(7);
  if (swept) console.log('清理过期 pages 缓存', swept, '个');
}).catch(() => {});

ipcMain.handle('eh:image', async (e, pageToken, gid, index, opts) => {
  try {
    // 已解析过且缓存文件还在 → 直接给本地键，省掉一次 /s/ 页面请求（约 450ms/页）
    const hit = keyMap[pageToken];
    if (hit && String(hit.gid) === String(gid)) {
      const fp = cache.pathOfKey(hit.key, hit.ext, gid);
      if (fs.existsSync(fp)) return { ok: true, data: { src: null, local: true, key: hit.key, ext: hit.ext } };
    }
    const data = await eh.imagePage(pageToken, gid, index);
    // prefetch：解析出图片地址后，后台把它真正落盘到 ehimg 缓存（不阻塞返回）
    // 记录 pageToken → 缓存键，下次直接命中
    if (data && data.src) {
      try {
        keyMap[pageToken] = { gid: String(gid), key: cache.keyOf(data.src), ext: cache.extOf(data.src) };
        keyMapDirty = true;
        scheduleKeyMapSave();
      } catch (err) { console.error('keyMap record failed:', err.message); }
    }
    if (opts && opts.prefetch && data && data.src) {
      cache.ensure(data.src, { referer: 'https://e-hentai.org/', gid }).catch((err) => {
        try { console.error('prefetch fail', data.src.slice(0, 80), err.message); } catch (e2) {}
      });
    }
    return { ok: true, data };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('eh:archiveCost', async (e, gid, token) => { try { return { ok: true, data: await eh.archiveCost(gid, token) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('eh:archive', async (e, gid, token, resolution) => {
  try {
    const r = await eh.archive(gid, token, resolution || 'org');
    if (!r.url && r.pending) { const p = await eh.archivePoll(gid, token, resolution || 'org'); if (p.url) r.url = p.url; }
    return { ok: true, data: r };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('eh:torrents', async (e, gid, token) => { try { return { ok: true, data: await eh.torrents(gid, token) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('eh:stats', async () => { try { return { ok: true, data: await eh.stats() }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('eh:favorites', async (e, page, cursor) => { try { return { ok: true, data: await eh.favorites(page || 0, cursor || '') }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('eh:addfav', async (e, gid, token, cat, note) => { try { return { ok: true, data: await eh.addFavorite(gid, token, cat, note) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('eh:removefav', async (e, gid, token) => { try { return { ok: true, data: await eh.removeFavorite(gid, token) }; } catch (err) { return { ok: false, error: err.message }; } });

/* ---- 浏览历史 ---- */
ipcMain.handle('history:record', async (e, entry) => {
  try {
    const s = cfg.get();
    const evicted = history.record(entry, s.historyLimit || 200);
    // 给这本画册的缓存打上 history 标签
    try { cache.setTag(entry.gid, 'history', true); } catch (err) {}
    // 超出上限：只删除「带 history 且不带 local」的缓存；本地库收藏的永不删
    const removed = [];
    const kept = [];
    for (const gid of evicted) {
      try {
        if (cache.isHistoryOnly(gid)) { cache.removeGallery(gid); removed.push(gid); }
        else kept.push(gid);
      } catch (err) {}
    }
    return { ok: true, evicted, removed, kept };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('history:list', (e, limit) => history.list(limit || 0));
ipcMain.handle('history:remove', (e, gid) => history.remove(gid));
ipcMain.handle('history:clear', () => history.clear());
ipcMain.handle('history:purgeCache', async (e, gid) => ({ ok: cache.removeGallery(gid) }));

/* ---- 本地库 ---- */
ipcMain.handle('lib:list', () => library.all());
ipcMain.handle('lib:search', (e, q) => library.search(q || {}));
ipcMain.handle('lib:add', (e, entry) => {
  const r = library.upsert(entry);
  try { cache.setTag(entry.gid, 'local', true); } catch (err) {}
  return r;
});
ipcMain.handle('lib:remove', (e, gid) => {
  const r = library.remove(gid);
  try { cache.setTag(gid, 'local', false); } catch (err) {}
  return r;
});
ipcMain.handle('lib:get', (e, gid) => library.get(gid));
ipcMain.handle('lib:tags', () => library.tagIndex());
ipcMain.handle('lib:setread', (e, gid, index, total) => library.setRead(gid, index, total));

/* ---- 下载 ---- */
ipcMain.handle('dl:list', () => download.list());
ipcMain.handle('dl:archive', async (e, payload) => {
  try {
    const s = cfg.get();
    const r = await eh.archive(payload.gid, payload.token, payload.resolution || 'org');
    let url = r.url;
    if (!url && r.pending) { const p = await eh.archivePoll(payload.gid, payload.token, payload.resolution || 'org'); url = p.url; }
    if (!url) return { ok: false, error: '未能获取下载链接（可能仍在生成，请稍后重试）', detail: r.text || '' };
    const rawName = String(payload.filename || payload.title || (payload.gid + '-' + payload.token));
    const safe = rawName.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || (payload.gid + '-' + payload.token);
    const name = safe + '.zip';
    const dest = path.join(payload.dir || s.downloadDir, name);
    const task = download.add({ url, dest, title: payload.title || name, kind: 'archive', gid: payload.gid, cover: payload.cover || '' });
    send('stats:refresh');   // 归档已生成，GP 此刻已扣，立即刷新顶栏
    return { ok: true, task };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('dl:url', async (e, payload) => {
  try {
    const s = cfg.get();
    const dest = path.join(payload.dir || s.downloadDir, payload.filename || ('download_' + Date.now() + '.bin'));
    const task = download.add({ url: payload.url, dest, title: payload.title || payload.filename, kind: payload.kind || 'file' });
    return { ok: true, task };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('dl:remove', (e, id) => download.remove(id));
ipcMain.handle('dl:openFolder', async (e, dest) => {
  try { const p = path.dirname(String(dest)); await shell.openPath(p); return { ok: true, path: p }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('dl:openFile', async (e, dest) => {
  try { await shell.openPath(String(dest)); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('dl:clear', () => download.clearFinished());

/* ---- 缓存 ---- */
ipcMain.handle('cache:stats', () => {
  const st = cache.stats();
  try {
    const dirs = fs.readdirSync(st.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^g\d+$/.test(d.name));
    let localCount = 0, historyCount = 0, untagged = 0;
    for (const d of dirs) {
      const gid = d.name.slice(1);
      const tags = cache.getTags(gid);
      if (tags.includes('local')) localCount++;
      else if (tags.includes('history')) historyCount++;
      else untagged++;
    }
    Object.assign(st, { localCount, historyCount, untagged });
  } catch (err) {}
  return st;
});
ipcMain.handle('cache:clear', () => { cache.clear(); return cache.stats(); });
ipcMain.handle('cache:prefetch', async (e, urls) => {
  let n = 0;
  for (const u of urls || []) { try { await cache.ensure(u); n++; } catch (err) {} }
  return { ok: true, count: n };
});
