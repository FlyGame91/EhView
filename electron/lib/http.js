'use strict';
const { net, session } = require('electron');
const cfg = require('./config');

const PART = 'persist:ehmain';

/**
 * 图片域名重写。
 *
 * 实测（2026-10-31）：E-Hentai 的图片服务器 s.exhentai.org / s.e-hentai.org 落在 178.175.x
 * （AlexHost 自建机，不在 Cloudflare），只能走 TCP —— 而它们的 SNI 正被墙，ClientHello 一发就 RST，
 * 表现为「主站能打开、预览图全裂」。同一台机器上换成官方 CDN 域名 ehgt.org 的 SNI 握手正常，
 * 且 ehgt.org 与 s.exhentai.org 是同一套存储、同一套路径，实测 4/4 图片 200 + 正确 content-type，
 * 对 Referer 无要求。
 */
const IMG_HOST_MAP = { 's.exhentai.org': 'ehgt.org', 's.e-hentai.org': 'ehgt.org' };

function rewriteImageHost(url) {
  try {
    const u = new URL(url);
    const mapped = IMG_HOST_MAP[u.hostname];
    if (!mapped) return url;
    u.hostname = mapped;
    return u.toString();
  } catch (e) { return url; }
}
let ses = null;

function getSession() {
  if (!ses) ses = session.fromPartition(PART);
  return ses;
}

async function applyProxy() {
  const s = cfg.get();
  const ses = getSession();
  // 直连模式：不挂代理，交给 DoH + HTTP/3（见 lib/dns.js）
  const direct = s.netMode === 'direct';
  if (!direct && s.proxy && s.proxy.enabled && s.proxy.url) {
    await ses.setProxy({ proxyRules: s.proxy.url, proxyBypassRules: '<local>' });
  } else {
    await ses.setProxy({ mode: 'direct' });
  }
  ses.setUserAgent(s.userAgent, 'en-US,en;q=0.9');
  // 直连模式切换时清掉旧分区里缓存的解析/连接状态，
  // 否则 persist 分区会沿用之前代理模式留下的网络上下文，导致新请求仍走 TCP 被 RST
  if (direct) {
    try { await ses.clearHostResolverCache(); } catch (e) {}
    try { await ses.clearCache(); } catch (e) {}
  }
  return { direct };
}

/** 底层请求：返回 { status, headers, body(Buffer), url } */
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = cfg.get();
    const ses = getSession();
    let settled = false;
    const req = net.request({
      method: opts.method || 'GET',
      url: rewriteImageHost(url),
      session: ses,
      useSessionCookies: true,
      redirect: opts.redirect || 'follow'
    });
    const headers = Object.assign({
      'User-Agent': s.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': opts.referer || 'https://e-hentai.org/'
    }, opts.headers || {});
    for (const [k, v] of Object.entries(headers)) {
      try { req.setHeader(k, v); } catch (e) {}
    }
    const chunks = [];
    const timeout = setTimeout(() => { if (!settled) { settled = true; try { req.abort(); } catch (e) {} reject(new Error('timeout')); } }, opts.timeout || 45000);
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url });
      });
      res.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timeout); reject(e); } });
    });
    req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timeout); reject(e); } });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function text(url, opts = {}) {
  const r = await request(url, opts);
  return { ...r, text: r.body.toString('utf8') };
}

async function json(url, opts = {}) {
  const r = await request(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = r.body.toString('utf8');
  try { return JSON.parse(t); } catch (e) { throw new Error('bad json: ' + t.slice(0, 200)); }
}

/** 写入 cookie 到 session */
async function setCookie(c) {
  const ses = getSession();
  const details = {
    url: (c.secure === false ? 'http://' : 'https://') + (c.domain || '').replace(/^\./, ''),
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: c.secure !== false,
    httpOnly: c.httpOnly !== false
  };
  if (c.expirationDate) details.expirationDate = c.expirationDate;
  try { await ses.cookies.set(details); } catch (e) { console.warn('setCookie fail', c.name, e.message); }
}

async function getCookies(domain) {
  const ses = getSession();
  const list = await ses.cookies.get({ domain });
  return list;
}

async function clearCookies() {
  const ses = getSession();
  const list = await ses.cookies.get({});
  for (const c of list) {
    try {
      await ses.cookies.remove((c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path, c.name);
    } catch (e) {}
  }
}

module.exports = { request, text, json, setCookie, getCookies, clearCookies, getSession, applyProxy, rewriteImageHost, IMG_HOST_MAP };
