import React, { useEffect, useState } from 'react';
import { api } from '../api';

export default function HistoryPage({ nav, toast }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [cache, setCache] = useState<any>(null);

  const reload = async () => {
    setLoading(true);
    const list = await api.historyList(0);
    setItems(list || []);
    setLoading(false);
    api.cacheStats().then(setCache);
  };
  useEffect(() => { reload(); }, []);

  const del = async (gid: string, e: any) => {
    e.stopPropagation();
    await api.historyRemove(gid);
    await api.historyPurgeCache(gid);
    toast('已删除记录与该画册缓存');
    reload();
  };
  const clearAll = async () => {
    if (!confirm('清空全部浏览历史？（不会删除缓存）')) return;
    await api.historyClear();
    toast('历史已清空');
    reload();
  };

  const fmt = (t: number) => {
    if (!t) return '';
    const d = new Date(t);
    const now = Date.now();
    const diff = (now - t) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
    return d.toLocaleDateString();
  };

  return (
    <div className="page">
      <div className="page-title">
        浏览历史
        <span className="hint">{items.length} 条{cache ? ' · 缓存 ' + cache.count + ' 文件 / ' + (cache.bytes / 1048576).toFixed(0) + ' MB' : ''}</span>
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={clearAll}>清空历史</button>
      </div>
      {loading && <div className="spinner" />}
      {!loading && items.length === 0 && <div className="empty">还没有浏览记录</div>}
      <div className="grid">
        {items.map((it) => (
          <div className="card" key={it.gid} onClick={() => nav({ name: 'gallery', gid: it.gid, token: it.token })}>
            {it.cover ? <img className="cover" src={api.img(it.cover)} loading="lazy" /> : <div className="cover" />}
            <div className="meta">
              <div className="title" title={it.title}>{it.title}</div>
              <div className="sub">
                {it.category && <span className="badge">{it.category}</span>}
                {it.pages ? <span>{it.pages} 页</span> : null}
                <span>{fmt(it.lastVisit)}</span>
                {it.visits > 1 ? <span>看过 {it.visits} 次</span> : null}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn sm" onClick={(e) => del(it.gid, e)} title="删除记录并清除该画册缓存">删除</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
