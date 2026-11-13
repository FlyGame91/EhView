'use strict';
/**
 * 标签收藏夹 + 搜索条件收藏夹
 * 存在 userData 下，与图集收藏（library.json）分开，互不影响。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file(n) { return path.join(app.getPath('userData'), n); }
let tags = null;
let searches = null;

function loadTags() {
  if (!tags) { try { const j = JSON.parse(fs.readFileSync(file('saved-tags.json'), 'utf8')); tags = Array.isArray(j) ? j : []; } catch (e) { tags = []; } }
  return tags;
}
function loadSearches() {
  if (!searches) { try { const j = JSON.parse(fs.readFileSync(file('saved-searches.json'), 'utf8')); searches = Array.isArray(j) ? j : []; } catch (e) { searches = []; } }
  return searches;
}
function saveTags() { try { fs.writeFileSync(file('saved-tags.json'), JSON.stringify(tags, null, 2)); } catch (e) {} }
function saveSearches() { try { fs.writeFileSync(file('saved-searches.json'), JSON.stringify(searches, null, 2)); } catch (e) {} }

/* ---------- 标签收藏 ---------- */
function listTags() { return loadTags(); }
function addTag(tag) {
  const t = String(tag || '').trim();
  if (!t) return loadTags();
  const a = loadTags();
  if (a.some((x) => String(x.tag).toLowerCase() === t.toLowerCase())) return a;
  a.unshift({ tag: t, addedAt: Date.now() });
  saveTags();
  return a;
}
function removeTag(tag) {
  tags = loadTags().filter((x) => String(x.tag).toLowerCase() !== String(tag).toLowerCase());
  saveTags();
  return tags;
}
function hasTag(tag) { return loadTags().some((x) => String(x.tag).toLowerCase() === String(tag).toLowerCase()); }

/* ---------- 搜索条件收藏 ---------- */
function searchKey(s) { return JSON.stringify({ q: String(s.query || ''), f: Number(s.fCats || 0), n: !!s.noFilter }); }
function listSearches() { return loadSearches(); }
function addSearch(s) {
  const a = loadSearches();
  const key = searchKey(s || {});
  if (a.some((x) => searchKey(x) === key)) return a;
  a.unshift({
    id: 's' + Date.now() + Math.random().toString(36).slice(2, 6),
    query: String((s && s.query) || ''),
    fCats: Number((s && s.fCats) || 0),
    noFilter: !!(s && s.noFilter),
    label: String((s && s.label) || (s && s.query) || '(空搜索)'),
    addedAt: Date.now(),
  });
  saveSearches();
  return a;
}
function removeSearch(id) {
  searches = loadSearches().filter((x) => x.id !== id);
  saveSearches();
  return searches;
}

module.exports = { listTags, addTag, removeTag, hasTag, listSearches, addSearch, removeSearch };
