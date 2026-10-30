import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import GalleryCard from '../components/GalleryCard';

export default function FavoritesPage({ nav, toast }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState('');
  const [needLogin, setNeedLogin] = useState(false);
  const busyRef = useRef(false);
  const nextRef = useRef('');

  const fetchPage = useCallback(async (cursor: string, append: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (append) setLoadingMore(true); else setLoading(true);
    setErr('');
    try {
      const r = await api.favorites(0, cursor);
      if (!r.ok) { setErr(r.error); return; }
      if (r.data.needLogin) { setNeedLogin(true); return; }
      const list = r.data.items || [];
      setItems((prev) => (append ? [...prev, ...list] : list));
      nextRef.current = r.data.next || '';
    } catch (e: any) {
      setErr(e.message);
    } finally {
      busyRef.current = false;
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPage('', false); }, [fetchPage]);

  useEffect(() => {
    const c = document.querySelector('.content') as HTMLElement | null;
    if (!c) return;
    const onScroll = () => {
      if (!nextRef.current || busyRef.current) return;
      if (c.scrollHeight - c.scrollTop - c.clientHeight < 900) {
        fetchPage(nextRef.current, true);
      }
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => c.removeEventListener('scroll', onScroll);
  }, [fetchPage]);

  if (needLogin) return <div className="page"><div className="warnbox">需要登录后才能查看站点收藏。请在「设置 → 账号」中登录。</div></div>;

  return (
    <div className="page">
      <div className="page-title">
        站点收藏
        <span className="hint">已加载 {items.length} 项{loadingMore ? ' · 加载中…' : ''}</span>
      </div>
      {loading && <div className="spinner" />}
      {err && <div className="warnbox">{err}</div>}
      {!loading && items.length === 0 && <div className="empty">收藏夹是空的</div>}
      <div className="grid">
        {items.map((it) => <GalleryCard key={it.gid} item={it} onClick={() => nav({ name: 'gallery', gid: it.gid, token: it.token })} nav={nav} toast={toast} />)}
      </div>
      <div className="pager">
        {loadingMore && <span className="hint">正在加载更多…</span>}
        {!loadingMore && !nextRef.current && items.length > 0 && <span className="hint">已到最后一页</span>}
        {!loadingMore && nextRef.current && <button className="btn" onClick={() => fetchPage(nextRef.current, true)}>加载更多</button>}
      </div>
    </div>
  );
}
