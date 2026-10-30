'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron');
const cfg = require('./config');
const http = require('./http');

function dir() {
  const d = cfg.get().imageCacheDir;
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 缓存键 = sha1(host + 稳定路径)
 *
 * 关键：E-Hentai 的 H@H 图片地址把 keystamp 放在【路径】里而不是 query：
 *   https://<node>/h/<hash>-<w>-<h>-wbp/keystamp=<时间戳>-<签名>;fileindex=<n>;xres=<w>/<file>.webp
 * keystamp 每次打开图集都会重新下发，若算进 key，缓存将永远命中不了（表现为「缓存了还是慢」）。
 * 这里把 keystamp=<...>; 整段剔除，只保留 host + 目录特征 + 文件名。
 */
function keyOf(url) {
  let u;
  try { u = new URL(url); } catch (e) { u = { host: '', pathname: url, search: '' }; }
  let p = u.pathname || '';
  p = p.replace(/keystamp=[^/;]*;?/gi, '');   // 剔除时效签名段
  p = p.replace(/\/{2,}/g, '/');              // 收拾残留的连续斜杠
  const stable = u.host + p;
  return crypto.createHash('sha1').update(stable).digest('hex');
}

function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const e = path.extname(p).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'].includes(e)) return e;
  } catch (e) {}
  return '.jpg';
}

/** 已知 key 时直接定位文件（用于跳过 /s/ 页面请求） */
function pathOfKey(key, ext, gid) {
  return path.join(dir(), 'g' + String(gid), String(key).slice(0, 2), key + (ext || '.jpg'));
}

function pathOf(url, gid) {
  const k = keyOf(url);
  const ext = extOf(url);
  // 有 gid 时按画册分目录，便于整本淘汰
  if (gid) return path.join(dir(), 'g' + String(gid), k.slice(0, 2), k + ext);
  return path.join(dir(), k.slice(0, 2), k + ext);
}

function statOf(url, gid) {
  const p = pathOf(url, gid);
  try { const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; } catch (e) { return null; }
}

/** 下载到缓存（若已存在则跳过） */
async function ensure(url, opts = {}) {
  const s = cfg.get();
  if (!s.cacheEnabled) return null;
  const p = pathOf(url, opts.gid);
  const st = statOf(url, opts.gid);
  if (st && st.size > 0) { touch(st.path); return st.path; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.part' + process.pid + '.tmp';
  const ok = await streamTo(url, tmp, opts);
  if (!ok) { try { fs.unlinkSync(tmp); } catch (e) {} return null; }
  try { fs.renameSync(tmp, p); } catch (e) { try { fs.copyFileSync(tmp, p); fs.unlinkSync(tmp); } catch (e2) {} }
  return p;
}

function touch(p) { try { const now = new Date(); fs.utimesSync(p, now, now); } catch (e) {} }

function streamTo(url, dest, opts = {}) {
  return new Promise((resolve) => {
    const s = cfg.get();
    let done = false;
    try {
      const req = net.request({ method: 'GET', url, session: http.getSession(), useSessionCookies: true, redirect: 'follow' });
      req.setHeader('User-Agent', s.userAgent);
      req.setHeader('Referer', opts.referer || 'https://e-hentai.org/');
      req.setHeader('Accept', 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8');
      req.on('response', (res) => {
        if (res.statusCode >= 400) { done = true; resolve(false); return; }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => { done = true; out.close(() => resolve(true)); });
        out.on('error', () => { done = true; resolve(false); });
        res.on('error', () => { done = true; resolve(false); });
      });
      req.on('error', () => { if (!done) { done = true; resolve(false); } });
      req.end();
    } catch (e) { resolve(false); }
  });
}

/** 缓存统计 */
function stats() {
  const d = dir();
  let total = 0, count = 0;
  const walk = (p) => {
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else { try { total += fs.statSync(f).size; count++; } catch (err) {} }
    }
  };
  walk(d);
  return { dir: d, bytes: total, count };
}

/** 清空缓存 = 全部移入回收站（可恢复），不做销毁 */
function clear() {
  const d = dir();
  const t = trashDir();
  fs.mkdirSync(t, { recursive: true });
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return true; }
  const ts = Date.now();
  let n = 0;
  for (const e of ents) {
    if (e.name === '.trash') continue;
    const f = path.join(d, e.name);
    try {
      fs.renameSync(f, path.join(t, e.name + '.cleared-' + ts));
      n++;
    } catch (err) {}
  }
  console.log('cache.clear: 已移入回收站', n, '项');
  return true;
}

/* ---------- 画册级缓存标签 ----------
 * 每个画册的缓存目录 g<gid>/ 下放一个 .meta.json：
 *   { gid, tags: ['history' | 'local'], lastVisit }
 * 历史记录淘汰时只删带 history 且不带 local 的；本地库收藏的缓存永不被历史淘汰。
 */
function galleryDir(gid) { return path.join(dir(), 'g' + String(gid)); }
function metaPath(gid) { return path.join(galleryDir(gid), '.meta.json'); }

function readMeta(gid) {
  try { return JSON.parse(fs.readFileSync(metaPath(gid), 'utf8')); }
  catch (e) { return { gid: String(gid), tags: [], lastVisit: 0 }; }
}
function writeMeta(gid, meta) {
  try {
    fs.mkdirSync(galleryDir(gid), { recursive: true });
    fs.writeFileSync(metaPath(gid), JSON.stringify(meta));
    return true;
  } catch (e) { return false; }
}
function getTags(gid) { return readMeta(gid).tags || []; }
/** 打/去标签；tag 为 'history' 或 'local' */
function setTag(gid, tag, on) {
  const m = readMeta(gid);
  const set = new Set(m.tags || []);
  if (on) set.add(tag); else set.delete(tag);
  m.gid = String(gid);
  m.tags = [...set];
  m.lastVisit = Date.now();
  return writeMeta(gid, m);
}
/** 记录访问时间（不改变标签） */
function touchGallery(gid) {
  const m = readMeta(gid);
  m.gid = String(gid);
  m.lastVisit = Date.now();
  writeMeta(gid, m);
}
/** 是否需要被历史淘汰：带 history 且不带 local */
function isHistoryOnly(gid) {
  const t = getTags(gid);
  return t.includes('history') && !t.includes('local');
}

/* ---------- 安全删除：改名到 .trash，不直接毁数据 ---------- */
function trashDir() { return path.join(dir(), '.trash'); }

/** 「删除」某本画册缓存 = 改名进回收站，可人工恢复；7 天后由 sweepTrash 真正清掉 */
function removeGallery(gid) {
  const d = path.join(dir(), 'g' + String(gid));
  try {
    if (!fs.existsSync(d)) return false;
    fs.mkdirSync(trashDir(), { recursive: true });
    const dst = path.join(trashDir(), 'g' + String(gid) + '.' + Date.now());
    fs.renameSync(d, dst);
    return true;
  } catch (e) { return false; }
}

/** 启动时清扫回收站里超过 7 天的条目 */
function sweepTrash(maxAgeDays = 7) {
  const t = trashDir();
  let n = 0;
  try {
    if (!fs.existsSync(t)) return 0;
    const cutoff = Date.now() - maxAgeDays * 86400000;
    for (const name of fs.readdirSync(t)) {
      const p = path.join(t, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { recursive: true, force: true }); n++; }
      } catch (e) {}
    }
  } catch (e) {}
  return n;
}

function trashStats() {
  const t = trashDir();
  try {
    if (!fs.existsSync(t)) return { count: 0, bytes: 0 };
    let bytes = 0, count = 0;
    const walk = (q) => { for (const x of fs.readdirSync(q, { withFileTypes: true })) { const r = path.join(q, x.name); if (x.isDirectory()) walk(r); else { count++; bytes += fs.statSync(r).size; } } };
    for (const name of fs.readdirSync(t)) { try { walk(path.join(t, name)); } catch (e) {} }
    return { count, bytes };
  } catch (e) { return { count: 0, bytes: 0 }; }
}

module.exports = { dir, keyOf, extOf, pathOf, pathOfKey, statOf, ensure, stats, clear, streamTo, removeGallery, sweepTrash, trashStats,
  galleryDir, readMeta, writeMeta, getTags, setTag, touchGallery, isHistoryOnly };
