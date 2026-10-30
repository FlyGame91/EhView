'use strict';
const fs = require('fs');
const http = require('./http');
const parser = require('./parser');
const cfg = require('./config');

function unesc(s) {
  if (!s) return s;
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function base() { return cfg.get().site === 'e-hentai' ? 'https://e-hentai.org' : 'https://exhentai.org'; }
function apiBase() { return 'https://api.e-hentai.org/api.php'; }

const CATS = { doujinshi: 2, manga: 4, artistcg: 8, gamecg: 16, western: 512, nonh: 256, imageset: 32, cosplay: 64, asianporn: 128, misc: 1 };
function catsToMask(list) {
  if (!list || !list.length) return 0;
  let m = 0; for (const c of list) { if (CATS[c] != null) m |= CATS[c]; } return m;
}

/** 批量元数据（官方 API，无需登录） */
async function gdata(pairs) {
  if (!pairs.length) return [];
  const out = [];
  for (let i = 0; i < pairs.length; i += 25) {
    const chunk = pairs.slice(i, i + 25);
    try {
      const r = await http.json(apiBase(), { method: 'POST', body: JSON.stringify({ method: 'gdata', gidlist: chunk.map((p) => [parseInt(p.gid, 10), p.token]), namespace: 1 }) });
      if (r && r.gmetadata) out.push(...r.gmetadata);
    } catch (e) { console.warn('gdata fail', e.message); }
  }
  return out;
}

/** 搜索 / 列表 */
async function search({ query = '', page = 1, cursor = '', cats = [], fCats = 0, minRating = 0, favCat = null, disableFilters = false } = {}) {
  const q = new URLSearchParams();
  if (query) q.set('f_search', query);
  // f_cats 是「要排除的分类」掩码；cats 数组是旧接口，仍然兼容
  const mask = fCats || (cats && cats.length ? catsToMask(cats) : 0);
  if (mask) q.set('f_cats', String(mask));
  // 临时关闭站点的软过滤（标签 / 上传者 / 语言）—— 这是官方 Disable Filters 用的那组参数
  if (disableFilters) { q.set('f_sft', 'on'); q.set('f_sfu', 'on'); q.set('f_sfl', 'on'); }
  if (cursor) {
    // E-Hentai 的 next/prev 是整条 URL（?f_search=...&next=123456），直接展开成查询参数
    if (/^https?:/i.test(cursor)) {
      try {
        const u = new URL(cursor);
        for (const [k, v] of u.searchParams) q.set(k, v);
      } catch (err) { q.set('next', cursor); }
    } else {
      q.set('next', cursor);
    }
  } else if (page > 1) q.set('page', String(page - 1));
  if (minRating) q.set('f_sr', 'on'), q.set('f_srdd', String(minRating));
  const url = base() + '/?' + q.toString();
  const r = await http.text(url);
  if (r.status === 403) throw new Error('Cloudflare 拦截（请检查代理或登录状态）');
  const list = parser.parseList(r.text);
  // 用 gdata 补充元数据
  if (list.items.length) {
    const meta = await gdata(list.items.map((x) => ({ gid: x.gid, token: x.token })));
    const byGid = new Map(meta.map((m) => [String(m.gid), m]));
    for (const it of list.items) {
      const m = byGid.get(it.gid);
      if (m) {
        it.title = unesc(m.title) || it.title;
        it.titleJpn = m.title_jpn;
        it.category = m.category;
        it.thumb = m.thumb || it.thumb;
        it.pages = m.filecount;
        it.rating = m.rating;
        it.tags = m.tags || [];
        it.posted = m.posted;
        it.filesize = m.filesize;
        it.torrentcount = m.torrentcount;
      }
    }
  }
  return list;
}

/** 详情 */
async function gallery(gid, token) {
  const url = base() + '/g/' + gid + '/' + token + '/';
  const r = await http.text(url);
  if (r.status === 404) throw new Error('图集不存在');
  const d = parser.parseDetail(r.text);
  // 补 gdata
  try {
    const [m] = await gdata([{ gid, token }]);
    if (m) { d.title = unesc(m.title) || d.title; d.titleJpn = unesc(m.title_jpn) || d.titleJpn; d.tags = (m.tags || []).map((t) => { const i = t.indexOf(':'); return { ns: t.slice(0, i), name: t, strength: 'normal' }; }); d.rating = m.rating; d.pagesTotal = parseInt(m.filecount, 10) || d.pagesTotal; d.filesize = m.filesize; d.posted = m.posted; d.torrentcount = m.torrentcount; d.uploader = m.uploader || d.uploader; d.category = m.category || d.category; }
  } catch (e) {}
  return d;
}

/** 拉取详情页某一分页的缩略图（详情页每页 20 张，?p=0,1,2...） */
async function galleryThumbs(gid, token, page = 0) {
  const url = base() + '/g/' + gid + '/' + token + '/?p=' + page;
  const r = await http.text(url);
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const d = parser.parseDetail(r.text);
  return { thumbs: d.thumbs || [], pagesTotal: d.pagesTotal || 0 };
}

/** 获取页面列表（用于阅读器） */
const PAGES_TTL = 24 * 3600 * 1000;
function pagesCachePath(gid) {
  const { app } = require('electron');
  return require('path').join(app.getPath('userData'), 'pages-' + String(gid) + '.json');
}

/** 页面列表磁盘缓存：图片列表 24 小时内基本不变，避免每次打开都翻 20+ 次分页 */
async function pageListCached(gid, token) {
  const f = pagesCachePath(gid);
  try {
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs < PAGES_TTL) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && j.token === String(token) && Array.isArray(j.pages) && j.pages.length) {
        return { mode: j.mode, pages: j.pages, pagecount: j.pagecount, cached: true };
      }
    }
  } catch (err) {}
  const r = await pageList(gid, token);
  try {
    fs.writeFileSync(f, JSON.stringify({ token: String(token), mode: r.mode, pages: r.pages, pagecount: r.pagecount, savedAt: Date.now() }));
  } catch (err) {}
  return r;
}

async function pageList(gid, token) {
  // 1) 先尝试 MPV
  try {
    const r = await http.text(base() + '/mpv/' + gid + '/' + token + '/');
    if (r.status === 200 && r.text.length > 50 && !/eeenope/.test(r.text.slice(0, 200))) {
      const mpv = parser.parseMpv(r.text);
      if (mpv.list.length) return { mode: 'mpv', pages: mpv.list, pagecount: mpv.pagecount };
      // MPV 页面可能是 JS 加载，尝试从 HTML 里提取 pToken 列表
      const toks = [...r.text.matchAll(/\/([0-9a-f]{10})\/(\d+)-(\d+)/g)].map((m) => ({ pageToken: m[1], gid: m[2], index: parseInt(m[3], 10) }));
      if (toks.length) return { mode: 'mpv-html', pages: toks, pagecount: toks.length };
    }
  } catch (e) {}
  // 2) 回退：详情页缩略图（每页 20 张，需要翻页）
  const all = [];
  let p = 0;
  let total = 0;
  while (true) {
    const url = base() + '/g/' + gid + '/' + token + '/?p=' + p;
    const r = await http.text(url);
    const d = parser.parseDetail(r.text);
    if (!total) total = d.pagesTotal;
    if (!d.thumbs.length) break;
    all.push(...d.thumbs);
    if (d.thumbs.length < 20 || all.length >= total) break;
    p++;
    if (p > 60) break;
  }
  return { mode: 'thumbs', pages: all, pagecount: total || all.length };
}

/** 单页图片（返回真实图片 URL） */
async function imagePage(pageToken, gid, index) {
  const url = base() + '/s/' + pageToken + '/' + gid + '-' + index;
  const r = await http.text(url);
  const p = parser.parseImagePage(r.text);
  if (!p.src) throw new Error('无法解析图片地址（可能未登录或需要重新验证）');
  return { ...p, pageUrl: url };
}

/** 查询归档下载花费（Free! 或 N GP），供详情页在按钮旁显示 */
async function archiveCost(gid, token) {
  const url = base() + '/archiver.php?gid=' + gid + '&token=' + token;
  const r = await http.text(url);
  if (/requires you to log on/i.test(r.text)) return { needLogin: true, cost: '' };
  const p = parser.parseArchiver(r.text);
  return { cost: p.cost || '', size: p.sizeText || '', original: !!p.cost };
}

/** 归档：生成下载链接 */
async function archive(gid, token, resolution = 'org') {
  const url = base() + '/archiver.php?gid=' + gid + '&token=' + token;
  const r1 = await http.text(url);
  if (r1.status === 403) throw new Error('Cloudflare 拦截');
  if (/requires you to log on/i.test(r1.text)) throw new Error('需要登录后才能使用归档下载');
  const first = parser.parseArchiver(r1.text);
  const hathAvailable = /do_hathdl/.test(r1.text);
  const hasOriginal = /Download Original Archive/.test(r1.text);
  const hasResample = /Download Resample Archive/.test(r1.text);

  // 优先普通归档（dltype）—— 直接在响应里给下载链接
  const dltype = resolution === 'res' ? 'res' : 'org';
  if (dltype === 'res' ? hasResample : hasOriginal) {
    const body = 'dltype=' + dltype + '&dlcheck=' + encodeURIComponent(dltype === 'res' ? 'Download Resample Archive' : 'Download Original Archive');
    const r2 = await http.text(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url } });
    if (/requires you to log on/i.test(r2.text)) throw new Error('需要登录后才能使用归档下载');
    const p2 = parser.parseArchiver(r2.text);
    if (p2.downloadUrl) {
      // H@H 的 /archive/<gid>/<hash>/<token>/<n> 加上 ?start=1 即触发文件流；
      // 不加则返回 "ready for download" 的 HTML 页。先直接拼，失败再轮询。
      const withStart = p2.downloadUrl + (p2.downloadUrl.includes('?') ? '&' : '?') + 'start=1';
      // 已知：H@H 的 /archive/<gid>/<hash>/<token>/<n>?start=1 即文件流（Electron net 会挂起，故交给 Node 下载层）
      return { url: withStart, size: p2.sizeText, via: 'archive-final' };
      /* 兜底：轮询 ready 页（正常情况下上面已 return） */
      const origin = new URL(p2.downloadUrl).origin;
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r3 = await http.text(p2.downloadUrl, { referer: url });
          const ct = String(r3.headers['content-type'] || '');
          if (ct && !/html/i.test(ct)) {
            return { url: p2.downloadUrl, size: p2.sizeText, via: 'archive' };
          }
          const m3 = r3.text.match(/href="(\/archive\/[^"']+)"/);
          if (m3 && m3[1]) {
            return { url: origin + m3[1], size: p2.sizeText, via: 'archive-final' };
          }
          if (/in queue|being prepared|preparing/i.test(r3.text)) {
            await new Promise(r => setTimeout(r, 4000));
            continue;
          }
          break;
        } catch (e) { lastErr = e.message; await new Promise(r => setTimeout(r, 3000)); }
      }
      return { url: p2.downloadUrl, size: p2.sizeText, via: 'archive', warning: lastErr || '未取到最终链接，回退到中间链接' };
    }
    return { url: '', pending: true, text: p2.text, via: 'archive', options: first.options };
  }

  // 回退 H@H Downloader（排队后轮询）
  if (hathAvailable) {
    const hres = ['org', '800', '1280', '1920', '2560'].includes(String(resolution)) ? String(resolution) : 'org';
    const r3 = await http.text(url, { method: 'POST', body: 'hathdl_xres=' + encodeURIComponent(hres), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url } });
    const p3 = parser.parseArchiver(r3.text);
    if (p3.downloadUrl) return { url: p3.downloadUrl, size: p3.sizeText, via: 'hath' };
    return { url: '', pending: true, text: p3.text, via: 'hath', options: first.options };
  }

  return { url: '', pending: true, text: first.text, options: first.options };
}

/** 归档：轮询下载页（有些情况链接延迟生成） */
async function archivePoll(gid, token, resolution, tries = 8) {
  const url = base() + '/archiver.php?gid=' + gid + '&token=' + token;
  for (let i = 0; i < tries; i++) {
    const r = await http.text(url, { method: 'POST', body: 'or=' + encodeURIComponent(resolution) + '&submit=Download', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url } });
    const p = parser.parseArchiver(r.text);
    if (p.downloadUrl) return { url: p.downloadUrl, size: p.sizeText };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { url: '' };
}

/** 种子列表 */
async function torrents(gid, token) {
  const url = base() + '/gallerytorrents.php?gid=' + gid + '&t=' + token;
  const r = await http.text(url);
  const p = parser.parseTorrents(r.text);
  return p;
}

/** 货币信息：Hath 余额在 ?t=hath，GP 余额在 ?t=gp，Credit 两边都有 */
async function stats() {
  const [rh, rg] = await Promise.all([
    http.text('https://e-hentai.org/exchange.php?t=hath'),
    http.text('https://e-hentai.org/exchange.php?t=gp')
  ]);
  if (/requires you to log on/i.test(rh.text)) return { needLogin: true };
  const a = parser.parseExchange(rh.text);
  const b = parser.parseExchange(rg.text);
  return {
    hath: a.hath || '',
    gp: b.gp || '',
    credit: a.credit || b.credit || '',
    hathRate: a.hathRate || '',
    raw: a.raw
  };
}

/** 站点收藏 */
async function favorites(page = 0, cursor = '') {
  let url = 'https://e-hentai.org/favorites.php';
  if (cursor) url = /^https?:/i.test(cursor) ? cursor : url + '?next=' + cursor;
  else if (page) url += '?page=' + page;
  const r = await http.text(url);
  if (/requires you to log on/i.test(r.text)) return { needLogin: true, items: [] };
  return parser.parseFavorites(r.text);
}

/** 加入收藏 */
async function addFavorite(gid, token, cat = 0, note = '') {
  const url = base() + '/gallerypopups.php?gid=' + gid + '&t=' + token + '&act=addfav';
  const body = 'favcat=' + cat + '&favnote=' + encodeURIComponent(note) + '&apply=Apply+Changes&update=1';
  const r = await http.text(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': url } });
  if (/requires you to log on/i.test(r.text)) throw new Error('需要登录');
  return { ok: true, text: r.text.slice(0, 300) };
}

/** 移出收藏 */
async function removeFavorite(gid, token) {
  const url = base() + '/gallerypopups.php?gid=' + gid + '&t=' + token + '&act=removefav';
  const r = await http.text(url);
  return { ok: true, text: r.text.slice(0, 200) };
}

/** 登录态检查 */
async function whoami() {
  const r = await http.text('https://e-hentai.org/home.php');
  if (/requires you to log on/i.test(r.text)) return { loggedIn: false };
  const m = r.text.match(/<p>Currently logged in as:[\s\S]{0,200}?<a[^>]*>([^<]+)<\/a>/);
  const m2 = r.text.match(/Logged in as:?\s*<[^>]*>([^<]+)</i);
  return { loggedIn: true, username: (m && m[1]) || (m2 && m2[1]) || cfg.get().username || 'unknown' };
}

module.exports = { base, gdata, pageListCached, search, gallery, galleryThumbs, pageList, imagePage, archive, archiveCost, archivePoll, torrents, stats, favorites, addFavorite, removeFavorite, whoami, CATS, catsToMask };
