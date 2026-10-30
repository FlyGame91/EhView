'use strict';
const cheerio = require('cheerio');

function textOf($, el) { return $(el).text().replace(/\s+/g, ' ').trim(); }

/** 列表页：返回 { items:[{gid, token, thumb, title, category, pages, posted}], next, prev, total } */
function parseList(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // ① 缩略图视图（搜索结果 / 收藏夹）：div.gl1t
  $('div.gl1t').each((i, el) => {
    const box = $(el);
    const a = box.find('a[href*="/g/"]').first();
    const href = a.attr('href') || '';
    const m = href.match(/\/g\/(\d+)\/([0-9a-f]{10})/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    const img = box.find('div.gl3t img').first().length ? box.find('div.gl3t img').first() : box.find('img').first();
    const pagesNode = box.find('div.gl5t div').filter((j, d) => /pages?/i.test($(d).text())).first();
    const pagesM = (pagesNode.length ? pagesNode.text() : box.find('div.gl5t').text()).match(/(\d+)\s*pages?/i);
    items.push({
      gid: m[1], token: m[2],
      thumb: img.attr('src') || '',
      title: (box.find('span.glink').text() || img.attr('title') || img.attr('alt') || '').trim(),
      category: box.find('div.gl5t .cs').first().text().trim(),
      pages: pagesM ? pagesM[1] : '',
      posted: ''
    });
  });

  // ② Compact 视图（table.itg）：div.glthumb —— 没有 <a>，gid 在 id="it<gid>"，token 在 onclick 的 t= 里
  if (!items.length) {
    $('div.glthumb').each((i, el) => {
      const box = $(el);
      const id = box.attr('id') || '';
      const gid = id.replace(/^it/, '');
      if (!gid || !/^\d+$/.test(gid) || seen.has(gid)) return;
      const inner = box.html() || '';
      const tm = inner.match(/[?&](?:amp;)?t=([0-9a-f]{10})/);
      if (!tm) return;
      const token = tm[1];
      seen.add(gid);
      const img = box.find('img').first();
      const pickThumb = () => {
        const cands = [img.attr('data-src'), img.attr('src'), img.attr('data-original'), (img.attr('srcset') || '').split(' ')[0]];
        for (const c of cands) { if (c && !/^data:/i.test(c)) return c; }
        // 退路：外层 div 的 background
        const bgStyle = box.find('div[style*="url("]').first().attr('style') || '';
        const m = bgStyle.match(/url\(([^)]+)\)/);
        return m ? m[1] : '';
      };
      const pagesNode = box.find('div').filter((j, e) => /^\d+\s*pages?$/i.test($(e).text().trim())).first();
      const pagesM = pagesNode.length ? pagesNode.text().match(/(\d+)/) : null;
      items.push({
        gid, token,
        thumb: pickThumb(),
        title: (img.attr('title') || img.attr('alt') || '').trim(),
        category: box.find('.cn').first().text().trim(),
        pages: pagesM ? pagesM[1] : '',
        posted: ''
      });
    });
  }

  // ③ 紧凑/表格视图（旧式）：a[href*="/g/"] + tr/td
  if (!items.length) {
    $('a[href*="/g/"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/g\/(\d+)\/([0-9a-f]{10})/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const tr = $(el).closest('tr');
      const img = $(el).find('img').first().length ? $(el).find('img').first() : tr.find('img').first();
      const txt = tr.text().replace(/\s+/g, ' ').trim();
      const pagesM = txt.match(/(?:^|[^\d])(\d+)\s*pages?/i);
      items.push({
        gid: m[1], token: m[2],
        thumb: img.attr('data-src') || img.attr('src') || '',
        title: (img.attr('title') || $(el).attr('title') || $(el).text() || '').trim(),
        category: tr.find('.cn').first().text().trim(),
        pages: pagesM ? pagesM[1] : '',
        posted: ''
      });
    });
  }

  // 分页
  let next = null, prev = null;
  const nx = html.match(/var nexturl="([^"]*)"/);
  const pv = html.match(/var prevurl="([^"]*)"/);
  if (nx && nx[1]) next = nx[1];
  if (pv && pv[1]) prev = pv[1];
  if (!next) { const n2 = html.match(/<a id="unext" href="([^"]+)"/); if (n2) next = n2[1]; }
  if (!prev) { const p2 = html.match(/<a id="uprev" href="([^"]+)"/); if (p2) prev = p2[1]; }

  const total = (html.match(/Found about ([\d,]+) results/) || [])[1] || '';
  const pageLinks = [];
  $('table.ptt a, div.searchnav a').each((i, el) => { const h = $(el).attr('href'); if (h) pageLinks.push(h); });

  return { items, next, prev, total, pageLinks };
}

/** 详情页 */
function parseDetail(html) {
  const $ = cheerio.load(html);
  const gid = (html.match(/var gid=(\d+)/) || [])[1] || '';
  const title = textOf($, $('#gn')) || textOf($, 'h1#gn');
  const titleJpn = textOf($, '#gj');
  const category = textOf($, '#gdc .cs');
  const uploader = textOf($, '#gdn a');
  const thumb = (($('#gd1 div').attr('style') || '').match(/url\(([^)]+)\)/) || [])[1] || '';

  const meta = {};
  $('#gdd tr').each((i, tr) => {
    const k = textOf($, $(tr).find('td').eq(0)).replace(/:$/, '');
    const v = textOf($, $(tr).find('td').eq(1));
    if (k) meta[k] = v;
  });

  const rating = textOf($, '#grt2');
  const favorited = textOf($, '#favcount');

  const tags = [];
  $('#taglist tr').each((i, tr) => {
    const ns = textOf($, $(tr).find('td.tc')).replace(/:$/, '');
    $(tr).find('div.gt, div.gtl, div.gtw').each((j, d) => {
      const name = textOf($, $(d).find('a'));
      const cls = $(d).attr('class') || '';
      tags.push({ ns, name: ns + ':' + name, strength: cls.includes('gtw') ? 'weak' : (cls.includes('gtl') ? 'low' : 'normal') });
    });
  });

  // 操作区
  const archiveUrl = ($('#gd5 a[onclick*="archiver.php"]').attr('onclick') || '').match(/'(https:[^']+)'/)?.[1] || '';
  const torrentUrl = ($('#gd5 a[onclick*="gallerytorrents.php"]').attr('onclick') || '').match(/'(https:[^']+)'/)?.[1] || '';
  const torrentCount = (textOf($, $('#gd5 a[onclick*="gallerytorrents.php"]')).match(/\((\d+)\)/) || [])[1] || '0';

  // 预览缩略图（每页）—— 注意：详情页预览是一张横向雪碧图，靠 background-position 切格子
  const thumbs = [];
  $('#gdt a').each((i, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/s\/([0-9a-f]{10})\/(\d+)-(\d+)/);
    if (!m) return;
    const div = $(a).find('div').first();
    const style = div.attr('style') || '';
    const bg = (style.match(/url\(([^)]+)\)/) || [])[1] || '';
    const posM = style.match(/url\([^)]+\)\s*(-?\d+)px\s+(-?\d+)(?:px)?/);
    const wM = style.match(/width:(\d+)px/);
    const hM = style.match(/height:(\d+)px/);
    thumbs.push({
      pageToken: m[1], gid: m[2], index: parseInt(m[3], 10),
      thumb: bg,
      bgX: posM ? parseInt(posM[1], 10) : 0,
      bgY: posM ? parseInt(posM[2], 10) : 0,
      w: wM ? parseInt(wM[1], 10) : 200,
      h: hM ? parseInt(hM[1], 10) : 284,
      title: div.attr('title') || ''
    });
  });

  // 总页数
  const pagesTotal = parseInt((meta['Length'] || '').replace(/[^0-9]/g, ''), 10) || thumbs.length;

  return { gid, title, titleJpn, category, uploader, thumb, meta, rating, favorited, tags, archiveUrl, torrentUrl, torrentCount, thumbs, pagesTotal };
}

/** 单页图片 */
function parseImagePage(html) {
  const $ = cheerio.load(html);
  const img = $('#img');
  const src = img.attr('src') || '';
  const style = img.attr('style') || '';
  const w = (style.match(/width:(\d+)px/) || [])[1];
  const h = (style.match(/height:(\d+)px/) || [])[1];
  const info = textOf($, $('#i4 div').first());
  const nextHref = ($('#next').attr('href') || '');
  const prevHref = ($('#prev').attr('href') || '');
  const cur = (textOf($, $('#i2 .sn div span').first())) || (textOf($, $('.sn div span').first()));
  const total = ($('.sn div span').last().text() || '');
  const vars = {
    gid: (html.match(/var gid=(\d+)/) || [])[1],
    startpage: (html.match(/var startpage=(\d+)/) || [])[1],
    startkey: (html.match(/var startkey="([^"]+)"/) || [])[1],
    showkey: (html.match(/var showkey="([^"]+)"/) || [])[1]
  };
  return { src, width: w ? parseInt(w, 10) : 0, height: h ? parseInt(h, 10) : 0, info, nextHref, prevHref, cur: parseInt(cur, 10) || 0, total: parseInt(total, 10) || 0, vars };
}

/** MPV 页面（旧式 /mpv/<gid>/<token>/） */
function parseMpv(html) {
  const gid = (html.match(/var gid=(\d+)/) || [])[1] || '';
  const token = (html.match(/var token="([0-9a-f]+)"/) || [])[1] || '';
  const pagecount = parseInt((html.match(/var pagecount=(\d+)/) || [])[1] || '0', 10);
  // imagelist: [["<pageToken>", <index>], ...]
  let list = [];
  const m = html.match(/var imagelist=\[([\s\S]*?)\];/);
  if (m) {
    try {
      const arr = JSON.parse('[' + m[1] + ']');
      list = arr.map((x) => ({ pageToken: x[1], index: x[0] }));
    } catch (e) {}
  }
  return { gid, token, pagecount, list };
}

/** 归档页：解析可选格式与生成后的下载链接 */
function parseArchiver(html) {
  const $ = cheerio.load(html);
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  const options = [];
  $('input[name="or"]').each((i, el) => {
    options.push({ value: $(el).attr('value'), label: $(el).parent().text().replace(/\s+/g, ' ').trim() });
  });
  // 下载链接：H@H 节点 /archive/<gid>/<hash>/<token>/<n>，无扩展名
  let downloadUrl = '';
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (/hath\.network\/archive\//i.test(href)) { downloadUrl = href; return false; }
    if (/\.(zip|rar|7z)($|\?)/i.test(href) && /^https?:/i.test(href)) { downloadUrl = href; return false; }
    if (/e-hentai\.org\/archive\//.test(href)) { downloadUrl = href; return false; }
  });
  // 形态 2：需要轮询的 msg
  const pending = /This will take a while|正在生成|Please wait|preparing/i.test(body);
  const sizeText = (body.match(/(\d+(?:\.\d+)?\s?(?:KiB|MiB|GiB|KB|MB|GB))/i) || [])[1] || '';
  // 下载花费：'Download Cost: Free!' 或 'Download Cost: 123 GP'
  const costM = body.match(/Download Cost:\s*(?:&nbsp;)?\s*(Free!|[\d,]+\s*GP)/i);
  const cost = costM ? costM[1].trim() : '';
  return { options, downloadUrl, pending, text: body.slice(0, 600), sizeText, cost };
}

/** 种子列表页：解析每个种子的 Seeds / Peers / 大小 / 下载链接 */
function parseTorrents(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('#torrentinfo div[style*="border"]').each((i, el) => {
    const box = $(el);
    const txt = box.text().replace(/\s+/g, ' ');
    const num = (label) => {
      const re = new RegExp(label + '\\s*:?\\s*([\\d,]+)', 'i');
      const m = txt.match(re);
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    };
    const link = box.find('a[href*=".torrent"]').first();
    if (!link.length) return;
    const href = link.attr('href') || '';
    const filename = link.text().trim();
    const gtid = box.find('input[name="gtid"]').attr('value') || '';
    items.push({
      gtid,
      url: href,
      filename,
      seeds: num('Seeds'),
      peers: num('Peers'),
      downloads: num('Downloads'),
      size: (txt.match(/Size:\s*([\d.]+\s*[KMG]i?B)/i) || [])[1] || '',
      posted: (txt.match(/Posted:\s*([\d-]+ [\d:]+)/) || [])[1] || '',
      uploader: (txt.match(/Uploader:\s*(\S+)/) || [])[1] || '',
      text: txt.slice(0, 300)
    });
  });
  return { items, text: $('body').text().replace(/\s+/g, ' ').slice(0, 600) };
}

/** 货币页：余额在订单栏的 "Available:" 后面，不是上方的汇率表 */
function parseExchange(html) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const out = { hath: '', gp: '', credit: '', raw: text.slice(0, 600) };
  const cm = text.match(/Available:\s*([\d,]+)\s*Credits/i);
  if (cm) out.credit = cm[1];
  const hm = text.match(/Available:\s*([\d,]+)\s*Hath/i);
  if (hm) out.hath = hm[1];
  const gm = text.match(/Available:\s*([\d,]+)\s*kGP/i);
  if (gm) out.gp = String(parseInt(gm[1].replace(/,/g, ''), 10) * 1000);
  // 汇率（备用展示）
  const rateH = text.match(/Avg\s*:\s*([\d,]+)\s*Credits/i);
  if (rateH) out.hathRate = rateH[1];
  return out;
}

/** 收藏夹页 */
function parseFavorites(html) {
  const list = parseList(html);
  const $ = cheerio.load(html);
  const cats = [];
  $('div#favselect a, div.favselect a').each((i, el) => {
    const t = textOf($, el);
    const href = $(el).attr('href') || '';
    if (t) cats.push({ name: t, href });
  });
  return { ...list, cats };
}

module.exports = { parseList, parseDetail, parseImagePage, parseMpv, parseArchiver, parseTorrents, parseExchange, parseFavorites };
