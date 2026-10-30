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

module.exports = { apply, config, diagnose, probe, preparePartition, DEFAULT_SERVERS };
