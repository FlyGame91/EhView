'use strict';
const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const nodeHttps = require('https');
const nodeHttp = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const cfg = require('./config');
const http = require('./http');

const tasks = new Map();
let seq = 0;
let emitter = null;

/** 删除 = 移入同目录 .trash（用户级铁律：所有删除先入回收站） */
function safeRemove(target) {
  try {
    if (!fs.existsSync(target)) return null;
    const trash = path.join(path.dirname(target), '.trash');
    fs.mkdirSync(trash, { recursive: true });
    const dst = path.join(trash, path.basename(target) + '.' + Date.now());
    fs.renameSync(target, dst);
    return dst;
  } catch (e) { return null; }
}
function setEmitter(fn) { emitter = fn; }
function emit() { if (emitter) try { emitter(list()); } catch (e) {} }

function list() { return [...tasks.values()].map((t) => ({ ...t })); }

function add(task) {
  const id = 't' + (++seq);
  const t = { id, status: 'queued', progress: 0, received: 0, total: 0, speed: 0, createdAt: Date.now(), ...task };
  tasks.set(id, t);
  emit();
  run(t).catch((e) => { t.status = 'error'; t.error = e.message; emit(); });
  return t;
}

/** 用 Node 原生 https + 代理下载（Electron 的 net 对 H@H 的 ?start=1 会挂起） */
function nodeDownload(t, dest, tmp) {
  return new Promise(async (resolve, reject) => {
    const s = cfg.get();
    let cookieStr = '';
    try {
      const list = await http.getCookies();
      cookieStr = list.filter(c => /e-hentai|exhentai|hath/i.test(c.domain)).map(c => c.name + '=' + c.value).join('; ');
    } catch (e) {}
    const isHttps = /^https:/i.test(t.url);
    const lib = isHttps ? nodeHttps : nodeHttp;
    let agent;
    // 直连模式下不能给 Node 请求挂代理（否则绕过了 HTTP/3 通道）
    if (s.netMode !== 'direct' && s.proxy && s.proxy.enabled && s.proxy.url) {
      agent = isHttps ? new HttpsProxyAgent(s.proxy.url) : new HttpProxyAgent(s.proxy.url);
    }
    const req = lib.get(t.url, {
      agent,
      headers: Object.assign({
        'User-Agent': s.userAgent,
        'Referer': t.referer || 'https://e-hentai.org/',
        'Accept': '*/*'
      }, cookieStr ? { Cookie: cookieStr } : {})
    }, (res) => {
      if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const ctype = String(res.headers['content-type'] || '');
      if (/text\/html/i.test(ctype)) { reject(new Error('服务器返回 HTML 而不是文件')); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      t.total = total;
      const out = fs.createWriteStream(tmp);
      let lastT = Date.now(), lastBytes = 0;
      res.on('data', (chunk) => {
        t.received += chunk.length;
        t.progress = total ? Math.min(100, (t.received / total) * 100) : 0;
        const now = Date.now();
        if (now - lastT > 500) { t.speed = (t.received - lastBytes) / ((now - lastT) / 1000); lastT = now; lastBytes = t.received; emit(); }
      });
      res.pipe(out);
      out.on('finish', () => { out.close(() => resolve()); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('timeout')); });
  });
}

async function run(t) {
  if (t.status !== 'queued') return;
  t.status = 'running'; emit();
  const s = cfg.get();
  const dest = t.dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  // 直连模式下，主站域名必须走 Electron net（Node 是纯 TCP，会命中 SNI 阻断被 RST）；
  // H@H 节点（非主站域名）仍优先 Node 原生下载 —— Electron net 对 ?start=1 会挂起。
  const isMainSite = /^https?:\/\/([a-z0-9-]+\.)*(e-hentai|exhentai)\.org\//i.test(t.url);
  const skipNode = s.netMode === 'direct' && isMainSite;
  try {
    if (skipNode) throw new Error('direct-mode: 主站域名改走 Electron net(HTTP/3)');
    await nodeDownload(t, dest, tmp);
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); fs.renameSync(tmp, dest); } catch (e) { try { fs.copyFileSync(tmp, dest); fs.unlinkSync(tmp); } catch (e2) {} }
    t.status = 'done'; t.progress = 100; t.finishedAt = Date.now(); emit();
    return;
  } catch (e) {
    t.nodeError = e.message;
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
  }
  await new Promise((resolve, reject) => {
    let lastT = Date.now(), lastBytes = 0;
    const req = net.request({ method: 'GET', url: t.url, session: http.getSession(), useSessionCookies: true, redirect: 'follow' });
    req.setHeader('User-Agent', s.userAgent);
    req.setHeader('Referer', t.referer || 'https://e-hentai.org/');
    req.on('response', (res) => {
      if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const ctype = String(res.headers['content-type'] || '');
      if (/text\/html/i.test(ctype)) { reject(new Error('服务器返回了 HTML 而不是文件（链接可能已失效或尚未准备好）')); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      t.total = total;
      const out = fs.createWriteStream(tmp);
      res.on('data', (chunk) => {
        t.received += chunk.length;
        t.progress = total ? Math.min(100, (t.received / total) * 100) : 0;
        const now = Date.now();
        if (now - lastT > 500) {
          t.speed = (t.received - lastBytes) / ((now - lastT) / 1000);
          lastT = now; lastBytes = t.received;
          emit();
        }
      });
      res.pipe(out);
      out.on('finish', () => { out.close(() => resolve()); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  try {
    if (fs.existsSync(dest)) safeRemove(dest);   // 覆盖前先把原文件移入回收站
    fs.renameSync(tmp, dest);
  } catch (e) { try { fs.copyFileSync(tmp, dest); fs.unlinkSync(tmp); } catch (e2) {} }
  t.status = 'done'; t.progress = 100; t.finishedAt = Date.now();
  emit();
}

function cancel(id) {
  const t = tasks.get(id);
  if (!t) return false;
  t.status = 'canceled';
  emit();
  return true;
}

function remove(id) { tasks.delete(id); emit(); return true; }

function clearFinished() {
  for (const [id, t] of tasks) if (t.status === 'done' || t.status === 'error' || t.status === 'canceled') tasks.delete(id);
  emit();
}

module.exports = { add, list, cancel, remove, clearFinished, setEmitter };
