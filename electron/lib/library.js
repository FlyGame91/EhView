'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file() { return path.join(app.getPath('userData'), 'library.json'); }
let data = null;

/**
 * 历史数据归一化：早期「列表卡片星标」写入的是 thumb，「详情页加入」写入的是 cover，
 * 两种字段名并存导致本地库有 3 条封面永远空白。统一收敛到 cover，thumb 不再保留。
 * 只在 load 时跑一次，修过就回写，避免每次启动重复迁移。
 */
function normalize(d) {
  let changed = false;
  for (const it of Object.values(d.items || {})) {
    if (!it.cover && it.thumb) { it.cover = it.thumb; changed = true; }
    if (it.thumb !== undefined) { delete it.thumb; changed = true; }
  }
  return changed;
}

function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (e) { data = { items: {}, tags: {} }; }
  if (!data.items) data.items = {};
  if (normalize(data)) {
    try { fs.writeFileSync(file(), JSON.stringify(data)); console.log('library 迁移: thumb -> cover'); } catch (e) {}
  }
  return data;
}
function persist() {
  try { fs.writeFileSync(file(), JSON.stringify(data)); } catch (e) { console.error('persist library', e); }
}

function key(gid) { return String(gid); }

function upsert(entry) {
  const d = load();
  const k = key(entry.gid);
  const prev = d.items[k] || {};
  const next = { ...prev, ...entry, updatedAt: Date.now() };
  // 写入时就归一：调用方传 cover 或 thumb 都行，读侧永远只认 cover
  next.cover = entry.cover || entry.thumb || prev.cover || '';
  delete next.thumb;
  d.items[k] = next;
  persist();
  return next;
}

function remove(gid) {
  const d = load();
  delete d.items[key(gid)];
  persist();
  return true;
}

function get(gid) { return load().items[key(gid)] || null; }

function all() { return Object.values(load().items); }

/** 关键词 + 标签搜索 */
function search({ q = '', tags = [], category = '', minRating = 0, sort = 'added', dir = 'desc', limit = 500 } = {}) {
  const d = load();
  let arr = Object.values(d.items);
  const ql = q.trim().toLowerCase();
  if (ql) {
    const terms = ql.split(/\s+/).filter(Boolean);
    arr = arr.filter((it) => {
      const hay = [it.title, it.titleJpn, it.note, (it.tags || []).join(' '), it.uploader].filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (tags && tags.length) {
    arr = arr.filter((it) => tags.every((t) => (it.tags || []).some((x) => x.toLowerCase() === t.toLowerCase())));
  }
  if (category) arr = arr.filter((it) => it.category === category);
  if (minRating) arr = arr.filter((it) => parseFloat(it.rating || 0) >= minRating);
  const cmp = (a, b) => {
    let va = a[sort], vb = b[sort];
    if (sort === 'added') { va = a.addedAt || 0; vb = b.addedAt || 0; }
    if (sort === 'rating') { va = parseFloat(a.rating || 0); vb = parseFloat(b.rating || 0); }
    if (sort === 'pages') { va = parseInt(a.pages || 0); vb = parseInt(b.pages || 0); }
    if (typeof va === 'string') return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return dir === 'asc' ? (va || 0) - (vb || 0) : (vb || 0) - (va || 0);
  };
  arr.sort(cmp);
  return arr.slice(0, limit);
}

/** 全部标签 + 使用次数 */
function tagIndex() {
  const d = load();
  const map = new Map();
  for (const it of Object.values(d.items)) {
    for (const t of it.tags || []) {
      map.set(t, (map.get(t) || 0) + 1);
    }
  }
  return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

function setRead(gid, index, total) {
  const d = load();
  const it = d.items[key(gid)];
  if (!it) return null;
  it.lastRead = index;
  it.total = total;
  it.lastReadAt = Date.now();
  persist();
  return it;
}

module.exports = { load, upsert, remove, get, all, search, tagIndex, setRead };
