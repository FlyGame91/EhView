'use strict';
const { net, session } = require('electron');
const cfg = require('./config');

const PART = 'persist:ehmain';
let ses = null;

function getSession() {
  if (!ses) ses = session.fromPartition(PART);
  return ses;
}

async function applyProxy() {
  const s = cfg.get();
  const ses = getSession();
  if (s.proxy && s.proxy.enabled && s.proxy.url) {
    await ses.setProxy({ proxyRules: s.proxy.url, proxyBypassRules: '<local>' });
  } else {
    await ses.setProxy({ mode: 'direct' });
  }
  ses.setUserAgent(s.userAgent, 'en-US,en;q=0.9');
}

/** 底层请求：返回 { status, headers, body(Buffer), url } */
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = cfg.get();
    const ses = getSession();
    let settled = false;
    const req = net.request({
      method: opts.method || 'GET',
      url,
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

module.exports = { request, text, json, setCookie, getCookies, clearCookies, getSession, applyProxy };
