import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import SearchPage from './pages/SearchPage';
import GalleryPage from './pages/GalleryPage';
import ReaderPage from './pages/ReaderPage';
import LibraryPage from './pages/LibraryPage';
import FavoritesPage from './pages/FavoritesPage';
import DownloadsPage from './pages/DownloadsPage';
import SettingsPage from './pages/SettingsPage';
import { syncDownloads, syncLibrary } from './lib/stores';
import HistoryPage from './pages/HistoryPage';

export type Route =
  | { name: 'search'; query?: string; page?: number; cursor?: string; cats?: string[] }
  | { name: 'gallery'; gid: string; token: string }
  | { name: 'reader'; gid: string; token: string; index: number; title?: string }
  | { name: 'library' }
  | { name: 'history' }
  | { name: 'favorites' }
  | { name: 'downloads' }
  | { name: 'settings' };

function fmtNum(v: any): string {
  if (v === undefined || v === null || v === '') return '-';
  const n = String(v).replace(/,/g, '');
  if (!/^\d+$/.test(n)) return String(v);
  return Number(n).toLocaleString('en-US');
}

export default function App() {
  const [settings, setSettings] = useState<any>(null);
  const [route, setRoute] = useState<Route>({ name: 'search' });
  const [toast, setToast] = useState('');
  const [auth, setAuth] = useState<any>({ loggedIn: false, username: '' });
  const [stats, setStats] = useState<any>(null);
  const [q, setQ] = useState('');
  const [booted, setBooted] = useState(false);
  const toastTimer = useRef<any>(null);
  // 记录进入详情前的列表页，供「返回列表」使用
  const listReturnRef = useRef<any>({ name: 'search', query: '' });
  const setRouteWithHistory = useCallback((next: any) => {
    if (next && next.name === 'gallery' && route && (route.name === 'search' || route.name === 'favorites' || route.name === 'history' || route.name === 'library')) {
      listReturnRef.current = route;
    }
    setRoute(next);
  }, [route]);

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  useEffect(() => {
    (async () => {
      const r = await api.init();
      setSettings(r.settings);
      setAuth({ loggedIn: r.settings.loggedIn, username: r.settings.username });
      setBooted(true);
      // 每次启动都强制拉一次货币余额（不沿用任何旧值）
      if (r.settings.loggedIn) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const s = await api.stats();
            if (s.ok && !s.data.needLogin) { setStats(s.data); break; }
          } catch (e) {}
          await new Promise((res) => setTimeout(res, 800));
        }
      }
    })();
  }, []);

  // 下载 / 收藏状态种子：列表卡片据此决定图标是空心还是实心
  useEffect(() => {
    const pull = async () => {
      try { syncDownloads(await api.dlList()); } catch (e) {}
      try { syncLibrary(await api.libList()); } catch (e) {}
    };
    pull();
    const off = api.onDownload((list: any[]) => syncDownloads(list || []));
    return () => { try { off && off(); } catch (e) {} }
  }, []);

  // 货币信息定时刷新
  useEffect(() => {
    if (!auth.loggedIn) return;
    const tick = async () => { try { const s = await api.stats(); if (s.ok) setStats(s.data); } catch (e) {} };
    tick();
    const h = setInterval(tick, 5 * 60 * 1000);
    return () => clearInterval(h);
  }, [auth.loggedIn]);

  // 下载动作会消耗 GP —— 主进程在归档生成/任务完成时通知刷新
  useEffect(() => {
    if (!auth.loggedIn) return;
    const off = (api as any).onStatsRefresh?.(async () => {
      try { const s = await api.stats(); if (s.ok) setStats(s.data); } catch (e) {}
    });
    return () => { try { off && off(); } catch (e) {} };
  }, [auth.loggedIn]);

  const doSearch = (text: string) => {
    setQ(text);
    setRoute({ name: 'search', query: text });
  };

  const saveSettings = async (patch: any) => {
    const s = await api.saveSettings(patch);
    setSettings(s);
    return s;
  };

  if (!booted) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><div className="spinner" /></div>;
  }

  const navBtn = (name: Route['name'], label: string) => (
    <button className={route.name === name ? 'active' : ''} onClick={() => setRoute({ name } as Route)}>{label}</button>
  );

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand" onClick={() => setRoute({ name: 'search' })} style={{ cursor: 'pointer' }}>EhView<span>for E-Hentai</span></div>
        <div className="searchbox">
          <input
            placeholder="搜索关键词 / 标签（如 language:chinese artist:xxx）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(q); }}
          />
          {q && (
            <button className="clear-x" title="清空搜索框" onClick={() => { setQ(''); const el = document.querySelector('.searchbox input') as HTMLInputElement | null; if (el) { el.value = ''; el.focus(); } }}>✕</button>
          )}
          <button className="btn primary" onClick={() => doSearch(q)}>搜索</button>
        </div>
        <div className="nav">
          {navBtn('library', '本地库')}
          {navBtn('history', '历史')}
          {navBtn('favorites', '站点收藏')}
          {navBtn('downloads', '下载')}
          {navBtn('settings', '设置')}
        </div>
        <div className="status">
          <select
            className="chip site-switch"
            value={settings.site}
            onChange={async (e) => {
              const next = e.target.value;
              if (next === 'exhentai' && !(settings.loggedIn || auth.loggedIn)) { showToast('ExHentai 需要登录后才能切换'); return; }
              const s = await saveSettings({ site: next });
              showToast('已切换到 ' + (next === 'e-hentai' ? 'E-Hentai' : 'ExHentai'));
              setRoute({ name: 'search', query: q });
              void s;
            }}
            title="选择站点"
            style={{ background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 999, padding: '4px 8px', color: 'var(--text-2)' }}
          >
            <option value="e-hentai">E-Hentai</option>
            <option value="exhentai" disabled={!(settings.loggedIn || auth.loggedIn)}>ExHentai{!(settings.loggedIn || auth.loggedIn) ? '（需登录）' : ''}</option>
          </select>
          {stats && !stats.needLogin && (
            <>
              <span className="chip hath">Hath <b>{fmtNum(stats.hath)}</b></span>
              <span className="chip gp">GP <b>{fmtNum(stats.gp)}</b></span>
              <span className="chip credit">Credit <b>{fmtNum(stats.credit)}</b></span>
            </>
          )}
          <span className="chip" title={auth.loggedIn ? '已登录' : '未登录'}>
            {auth.loggedIn ? '👤 ' + (auth.username || '已登录') : '未登录'}
          </span>
        </div>
      </div>

      <div className="content">
        {route.name === 'search' && <SearchPage route={route} nav={setRouteWithHistory} toast={showToast} settings={settings} />}
        {route.name === 'gallery' && <GalleryPage gid={route.gid} token={route.token} listReturn={listReturnRef.current} nav={setRouteWithHistory} toast={showToast} settings={settings} />}
        {route.name === 'reader' && <ReaderPage gid={route.gid} token={route.token} startIndex={route.index} title={route.title} listReturn={listReturnRef.current} nav={setRouteWithHistory} toast={showToast} settings={settings} />}
        {route.name === 'library' && <LibraryPage nav={setRouteWithHistory} toast={showToast} />}
        {route.name === 'history' && <HistoryPage nav={setRouteWithHistory} toast={showToast} />}
        {route.name === 'favorites' && <FavoritesPage nav={setRouteWithHistory} toast={showToast} />}
        {route.name === 'downloads' && <DownloadsPage toast={showToast} />}
        {route.name === 'settings' && <SettingsPage settings={settings} save={saveSettings} auth={auth} setAuth={setAuth} toast={showToast} />}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
