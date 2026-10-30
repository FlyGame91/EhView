'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (p) => ipcRenderer.invoke('settings:save', p),
  pickDir: (which) => ipcRenderer.invoke('settings:pickDir', which),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  netDiagnose: () => ipcRenderer.invoke('net:diagnose'),
  netState: () => ipcRenderer.invoke('net:state'),

  login: (opts) => ipcRenderer.invoke('auth:login', opts),
  pollLogin: () => ipcRenderer.invoke('auth:poll'),
  importCookies: (payload) => ipcRenderer.invoke('auth:import', payload),
  logout: () => ipcRenderer.invoke('auth:logout'),
  checkAuth: () => ipcRenderer.invoke('auth:check'),
  closeLoginChrome: () => ipcRenderer.invoke('auth:closeChrome'),

  search: (q) => ipcRenderer.invoke('eh:search', q),
  gallery: (gid, token) => ipcRenderer.invoke('eh:gallery', gid, token),
  pages: (gid, token) => ipcRenderer.invoke('eh:pages', gid, token),
  thumbs: (gid, token, page) => ipcRenderer.invoke('eh:thumbs', gid, token, page),
  image: (pageToken, gid, index, opts) => ipcRenderer.invoke('eh:image', pageToken, gid, index, opts),
  archive: (gid, token, res) => ipcRenderer.invoke('eh:archive', gid, token, res),
  archiveCost: (gid, token) => ipcRenderer.invoke('eh:archiveCost', gid, token),
  torrents: (gid, token) => ipcRenderer.invoke('eh:torrents', gid, token),
  stats: () => ipcRenderer.invoke('eh:stats'),
  favorites: (page, cursor) => ipcRenderer.invoke('eh:favorites', page, cursor),
  addFav: (gid, token, cat, note) => ipcRenderer.invoke('eh:addfav', gid, token, cat, note),
  removeFav: (gid, token) => ipcRenderer.invoke('eh:removefav', gid, token),

  libList: () => ipcRenderer.invoke('lib:list'),
  libSearch: (q) => ipcRenderer.invoke('lib:search', q),
  libAdd: (entry) => ipcRenderer.invoke('lib:add', entry),
  libRemove: (gid) => ipcRenderer.invoke('lib:remove', gid),
  libGet: (gid) => ipcRenderer.invoke('lib:get', gid),
  libTags: () => ipcRenderer.invoke('lib:tags'),
  libSetRead: (gid, index, total) => ipcRenderer.invoke('lib:setread', gid, index, total),

  dlList: () => ipcRenderer.invoke('dl:list'),
  dlArchive: (payload) => ipcRenderer.invoke('dl:archive', payload),
  dlUrl: (payload) => ipcRenderer.invoke('dl:url', payload),
  dlRemove: (id) => ipcRenderer.invoke('dl:remove', id),
  dlOpenFolder: (dest) => ipcRenderer.invoke('dl:openFolder', dest),
  dlOpenFile: (dest) => ipcRenderer.invoke('dl:openFile', dest),
  dlClear: () => ipcRenderer.invoke('dl:clear'),
  onDownload: (cb) => { const h = (e, list) => cb(list); ipcRenderer.on('dl:update', h); return () => ipcRenderer.removeListener('dl:update', h); },
  onStatsRefresh: (cb) => { const h = () => cb(); ipcRenderer.on('stats:refresh', h); return () => ipcRenderer.removeListener('stats:refresh', h); },

  historyRecord: (entry) => ipcRenderer.invoke('history:record', entry),
  historyList: (limit) => ipcRenderer.invoke('history:list', limit),
  historyRemove: (gid) => ipcRenderer.invoke('history:remove', gid),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyPurgeCache: (gid) => ipcRenderer.invoke('history:purgeCache', gid),

  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  cacheClear: () => ipcRenderer.invoke('cache:clear'),
  prefetch: (urls) => ipcRenderer.invoke('cache:prefetch', urls),

  img: (url, gid) => 'ehimg://fetch?url=' + encodeURIComponent(url) + (gid ? '&gid=' + encodeURIComponent(gid) : ''),
  imgKey: (key, ext, gid) => 'ehimg://get?key=' + encodeURIComponent(key) + '&ext=' + encodeURIComponent(ext || '.jpg') + '&gid=' + encodeURIComponent(gid || '')
});
