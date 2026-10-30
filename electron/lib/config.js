'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  proxy: { enabled: true, url: 'http://127.0.0.1:10809' },
  downloadDir: '',
  imageCacheDir: '',
  cacheEnabled: true,
  cacheLimitMB: 16384,
  historyLimit: 200,
  concurrency: 4,
  site: 'e-hentai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  cookies: {},
  loggedIn: false,
  username: '',
  memberId: '',
  lastSync: 0,
  reader: { mode: 'fit', gap: 8, preload: 3 },
  chromePath: ''
};

let cache = null;
function file() { return path.join(app.getPath('userData'), 'settings.json'); }

function defaultRoot() {
  // 便携式：优先放在程序所在磁盘的 EhView 数据目录
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const drive = path.parse(exeDir).root;
    if (drive && fs.existsSync(drive)) return path.join(drive, 'EhView', 'data');
  } catch (e) {}
  return app.getPath('userData');
}

const VALID_READER_MODES = ['fit', 'height', 'width', 'orig'];
/** 读配置时归一化历史遗留值：旧版本存过 'fit'（已废弃），不改会导致阅读器缩放 CSS 类名对不上 */
function normalizeReader(s) {
  if (!s) return s;
  if (!s.reader || typeof s.reader !== 'object') s.reader = {};
  if (!VALID_READER_MODES.includes(s.reader.mode)) s.reader.mode = 'height';
  return s;
}

function ensureDirs(s) {
  const root = defaultRoot();
  if (!s.downloadDir) s.downloadDir = path.join(root, 'downloads');
  if (!s.imageCacheDir) s.imageCacheDir = path.join(root, 'imagecache');
  for (const d of [s.downloadDir, s.imageCacheDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  }
  return s;
}

function load() {
  if (cache) return cache;
  let s = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    s = { ...s, ...raw, proxy: { ...DEFAULTS.proxy, ...(raw.proxy || {}) }, reader: { ...DEFAULTS.reader, ...(raw.reader || {}) } };
  } catch (e) {}
  const beforeMode = s.reader && s.reader.mode;
  cache = normalizeReader(ensureDirs(s));
  // 旧值被修正过就回写一次，避免每次启动都重复迁移
  if (beforeMode !== cache.reader.mode) {
    try { fs.writeFileSync(file(), JSON.stringify(cache, null, 2)); console.log('settings 迁移: reader.mode', beforeMode, '->', cache.reader.mode); } catch (e) {}
  }
  return cache;
}

function save(patch) {
  const s = load();
  Object.assign(s, patch || {});
  ensureDirs(s);
  try { fs.writeFileSync(file(), JSON.stringify(s, null, 2)); } catch (e) { console.error('save settings', e); }
  return s;
}

function get() { return load(); }

module.exports = { load, save, get, DEFAULTS };
