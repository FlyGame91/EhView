'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file() { return path.join(app.getPath('userData'), 'history.json'); }
let data = null;

function load() {
  if (data) return data;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    data = Array.isArray(j) ? j : (j.items || []);
  } catch (e) { data = []; }
  return data;
}
function persist() {
  try { fs.writeFileSync(file(), JSON.stringify(data)); } catch (e) { console.error('persist history', e); }
}

/** 记录一次浏览；超过上限时淘汰最老的条目并返回被淘汰的 gid 列表 */
let lastStamp = 0;
function nextStamp() {
  const t = Date.now();
  lastStamp = t > lastStamp ? t : lastStamp + 1;
  return lastStamp;
}

function record(entry, limit) {
  const d = load();
  const gid = String(entry.gid);
  const i = d.findIndex((x) => String(x.gid) === gid);
  const now = nextStamp();
  if (i >= 0) {
    d[i] = { ...d[i], ...entry, gid, lastVisit: now, visits: (d[i].visits || 1) + 1 };
  } else {
    d.push({ ...entry, gid, lastVisit: now, visits: 1 });
  }
  // 按最近访问排序（新的在前）
  d.sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0));
  const max = Math.max(1, parseInt(limit, 10) || 200);
  const evicted = [];
  while (d.length > max) {
    const old = d.pop();
    if (old) evicted.push(String(old.gid));
  }
  persist();
  return evicted;
}

function list(limit) {
  const d = load().slice().sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0));
  return limit ? d.slice(0, limit) : d;
}

function remove(gid) {
  const d = load();
  const i = d.findIndex((x) => String(x.gid) === String(gid));
  if (i >= 0) { d.splice(i, 1); persist(); return true; }
  return false;
}

function clear() { data = []; persist(); return true; }

module.exports = { record, list, remove, clear };
