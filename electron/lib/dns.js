'use strict';
const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');
const cfg = require('./config');

/**
 * 把「直连 + 安全 DNS」配置落到 Chromium 的 HostResolver 上。
 *
 * 为什么必须同时满足两个条件（实测依据，2026-10-31）：
 *   1) 系统 DNS、阿里 DoH、腾讯 DoH 全部返回被污染的假 IP（Facebook/Dropbox/Twitter 段），
 *      所以必须用「境外且未被打进黑洞」的 DoH 端点拿真实 A/AAAA。
 *   2) 光有 IP 不够 —— GFW 对 TCP 443 做 SNI 关键词阻断（同一可用 IP 上
 *      SNI=www.cloudflare.com 握手成功、SNI=e-hentai.org 立刻 RST）。
 *      只有 QUIC(UDP 443) 没被拦。而浏览器要主动尝试 QUIC，必须先通过 DoH 拿到
 *      HTTPS(type 65) 记录里的 alpn=h3 —— 这就是 enableAdditionalDnsQueryTypes 的作用。
 *      缺这条，浏览器只会走 TCP，必死（实测 --disable-quic 时 100% ERR_CONNECTION_RESET）。
 *
 * 注意：本方法必须在 app ready 之后调用（Electron 文档明确要求）。
 */

const DEFAULT_SERVERS = ['https://doh.cleanbrowsing.org/doh/security-filter/'];

function config() {
  const s = cfg.get();
  const d = s.secureDns || {};
  return {
    netMode: s.netMode === 'direct' ? 'direct' : 'proxy',
    enabled: d.enabled !== false,
    mode: d.mode || 'secure',
    servers: (Array.isArray(d.servers) ? d.servers : DEFAULT_SERVERS).map((x) => String(x || '').trim()).filter(Boolean)
  };
}

/** 应用配置；返回实际生效的状态，便于 UI 回显与排错 */
function apply() {
  if (typeof app.configureHostResolver !== 'function') {
    return { ok: false, error: '当前 Electron 版本不支持 configureHostResolver' };
  }
  const c = config();
  try {
    if (c.netMode !== 'direct' || !c.enabled) {
      app.configureHostResolver({ secureDnsMode: 'off', secureDnsServers: [] });
      return { ok: true, active: false, ...c };
    }
    app.configureHostResolver({
      secureDnsMode: c.mode,
      secureDnsServers: c.servers.length ? c.servers : DEFAULT_SERVERS,
      enableBuiltInResolver: true,
      enableAdditionalDnsQueryTypes: true, // 关键：允许查询 HTTPS(type 65)，浏览器才会知道服务器支持 h3
      enableHappyEyeballs: true
    });
    return { ok: true, active: true, ...c };
  } catch (e) {
    return { ok: false, error: e.message, ...c };
  }
}

/** 单次探测：返回状态码/字节数/耗时。能拿到 2xx/3xx 就说明 QUIC 通道打通了 */
function probe(url, timeout = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve({ ...r, url }); };
    let req;
    try {
      // manual：不会因为业务重定向（exhentai 未登录会 /↔/?poni=no 循环）误判成网络故障
      req = net.request({ method: 'GET', url, redirect: 'manual' });
    } catch (e) { return finish({ ok: false, error: e.message, ms: 0 }); }
    req.on('response', (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => finish({
        // 收到任何 HTTP 响应都说明链路是通的；具体 2xx/3xx 只是业务状态
        ok: res.statusCode > 0 && res.statusCode < 500,
        status: res.statusCode,
        location: res.headers['location'] || '',
        bytes,
        ms: Date.now() - t0,
        altSvc: res.headers['alt-svc'] || ''
      }));
      res.on('error', (e) => finish({ ok: false, error: e.message, ms: Date.now() - t0 }));
    });
    // manual 模式下 Electron 对 3xx 触发 redirect 事件而非 response：能收到重定向本身就证明链路通
    req.on('redirect', (statusCode, method, redirectUrl) => {
      finish({ ok: true, status: statusCode, location: redirectUrl, redirect: true, bytes: 0, ms: Date.now() - t0 });
    });
    req.on('error', (e) => finish({ ok: false, error: e.message, ms: Date.now() - t0 }));
    setTimeout(() => { try { req.abort(); } catch (e) {} finish({ ok: false, error: 'timeout', ms: Date.now() - t0 }); }, timeout);
    req.end();
  });
}

/** 直连自检：两个站各打一发 */
async function diagnose() {
  const state = apply();
  if (!state.ok) return { ok: false, state, results: [] };
  if (!state.active) return { ok: false, state, results: [], hint: '当前是代理模式或安全 DNS 已关闭' };
  const results = [];
  for (const u of ['https://e-hentai.org/', 'https://exhentai.org/']) {
    results.push(await probe(u));
  }
  return { ok: results[0].ok, state, results };
}

/* ================= DoH 优选 =================
 *
 * 实测（2026-10-31，石家庄联通）：
 *   doh.cleanbrowsing.org/security-filter  693ms  ✅ 干净（返回 172.66.x Cloudflare）
 *   doh.cleanbrowsing.org/family-filter    168ms  ❌ 直接拦截成人站（空结果）
 *   doh.pub                                201ms  ❌ 返回 124.11.210.175（浙江电信，假 IP）
 *   dot.pub                                262ms  ❌ 同上
 *   cloudflare-dns.com / dns.google / quad9 / adguard / mullvad / tiar … 全部被墙
 *
 * 结论：**快的不干净，干净的不快**。所以「优选」必须是二维判断：
 * 既要比延迟，也要验证解析结果没被污染 —— 只比延迟会选到 doh.pub 这种快而毒的端点。
 */

/** e-hentai.org 真身在 Cloudflare；返回非这些段的 IP 一律视为被污染 */
const CLOUDFLARE_PREFIX = [/^172\.6[4-9]\./, /^172\.7[0-3]\./, /^188\.114\./, /^104\.(1[6-9]|2[0-9]|3[0-1])\./, /^162\.15[89]\./];
function looksCloudflare(ips) {
  if (!ips || !ips.length) return false;
  return ips.every((ip) => CLOUDFLARE_PREFIX.some((re) => re.test(ip)));
}

/** 默认候选：可以在这里加自建 DoH，测速会自动纳入 */
const CANDIDATES = [
  'https://doh.cleanbrowsing.org/doh/security-filter/',
  'https://doh.cleanbrowsing.org/doh/family-filter/',
  'https://doh.pub/dns-query',
  'https://dot.pub/dns-query',
  'https://dns.alidns.com/resolve',
];

/** 原生 DNS 报文（POST，兼容所有 RFC8484 端点） */
function buildQuery(name, type) {
  const enc = [];
  for (const part of name.split('.')) { const b = Buffer.from(part); enc.push(Buffer.from([b.length]), b); }
  enc.push(Buffer.from([0]));
  const h = Buffer.alloc(12);
  h.writeUInt16BE(Math.floor(Math.random() * 60000), 0);
  h.writeUInt16BE(0x0100, 2);
  h.writeUInt16BE(1, 4);
  return Buffer.concat([h, ...enc, Buffer.from([0, type]), Buffer.from([0, 1])]);
}
function skipName(buf, o) { let g = 0; while (g++ < 128) { const l = buf[o]; if (l === 0) return o + 1; if ((l & 0xc0) === 0xc0) return o + 2; o += 1 + l; } return o; }
function parseA(buf) {
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6);
  let o = 12;
  for (let i = 0; i < qd; i++) o = skipName(buf, o) + 4;
  const out = [];
  for (let i = 0; i < an; i++) {
    o = skipName(buf, o);
    const type = buf.readUInt16BE(o);
    const rdlen = buf.readUInt16BE(o + 8);
    const rd = buf.slice(o + 10, o + 10 + rdlen);
    o += 10 + rdlen;
    if (type === 1 && rdlen === 4) out.push([...rd].join('.'));
  }
  return out;
}

/** 单端点测速：返回 { url, ms, ok, clean, ips, error } */
function benchOne(url, probeName = 'e-hentai.org') {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ url, ok: false, error: 'URL 无效' }); }
    const buf = buildQuery(probeName, 1);
    const req = require('https').request({
      host: u.hostname, port: 443, path: u.pathname, method: 'POST', servername: u.hostname,
      headers: { 'content-type': 'application/dns-message', 'content-length': buf.length, accept: 'application/dns-message' },
      timeout: 6000,
    }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        let ips = [];
        try { ips = parseA(Buffer.concat(ch)); } catch (e) {}
        resolve({ url, ms: Date.now() - t0, status: res.statusCode, ok: res.statusCode === 200, ips, clean: looksCloudflare(ips) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ url, ok: false, error: '超时', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ url, ok: false, error: e.code || e.message, ms: Date.now() - t0 }));
    req.write(buf); req.end();
  });
}

/** 并发测所有候选，只保留「干净」的，按延迟升序 */
async function benchmark(extra = []) {
  const list = [...new Set([...(extra || []), ...CANDIDATES])];
  const results = await Promise.all(list.map((u) => benchOne(u)));
  const clean = results.filter((r) => r.ok && r.clean).sort((a, b) => a.ms - b.ms);
  const dirty = results.filter((r) => r.ok && !r.clean);
  const dead = results.filter((r) => !r.ok);
  return { best: clean[0] || null, clean, dirty, dead, all: results };
}

/** 启动预热：把关键域名的 DoH 解析与连接提前建好，省掉用户第一次点击的握手开销（实测省 ~700ms） */
function warmup() {
  const c = config();
  if (c.netMode !== 'direct' || !c.enabled) return [];
  const targets = ['https://e-hentai.org/', 'https://exhentai.org/', 'https://ehgt.org/'];
  return targets.map((u) => probe(u, 10000).catch(() => null));
}

/** persist:ehmain -> <userData>/Partitions/ehmain */
function partitionDir(name) {
  const bare = String(name || '').replace(/^persist:/, '');
  return path.join(app.getPath('userData'), 'Partitions', bare);
}

/**
 * 清掉分区里缓存的 HTTP/3 连接状态。
 *
 * 为什么必须做（实测 2026-10-31）：从代理模式切到直连后，`Network Persistent State` 里残留着
 * 代理时期协商出的 QUIC server info，新的 QUIC 握手会一直失败并回退到 TCP，而 TCP 会命中
 * SNI 阻断被 RST —— 表现就是「diagnose 能通、业务请求全 ERR_CONNECTION_RESET」。
 * Chromium 没有 API 能清这个文件，只能赶在 session 创建之前做文件级回收。
 * 代价只是丢了 Alt-Svc 缓存（DoH 的 HTTPS 记录本身带 alpn=h3，不影响再次协商）。
 */
function preparePartition(name = 'persist:ehmain') {
  const c = config();
  if (c.netMode !== 'direct' || !c.enabled) return { cleaned: false, reason: 'not-direct' };
  try {
    const dir = path.join(partitionDir(name), 'Network');
    const f = path.join(dir, 'Network Persistent State');
    if (!fs.existsSync(f)) return { cleaned: false, reason: 'absent' };
    const trash = path.join(dir, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    const dst = path.join(trash, path.basename(f) + '.' + Date.now());
    fs.renameSync(f, dst);
    return { cleaned: true, moved: path.basename(dst) };
  } catch (e) { return { cleaned: false, error: e.message }; }
}

module.exports = { apply, config, diagnose, probe, preparePartition, benchmark, benchOne, warmup, looksCloudflare, CANDIDATES, DEFAULT_SERVERS };
