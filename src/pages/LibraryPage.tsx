import React, { useEffect, useMemo, useState } from 'react';
import { libraryGids } from '../lib/stores';
import { api } from '../api';

export default function LibraryPage({ nav, toast }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [sort, setSort] = useState('added');
  const [showTags, setShowTags] = useState(true);
  // 右键菜单：{ x, y, item } | null
  const [menu, setMenu] = useState<{ x: number; y: number; item: any } | null>(null);

  const reload = async () => {
    const [r, t] = await Promise.all([api.libSearch({ q, tags: sel, sort }), api.libTags()]);
    setItems(r || []);
    setTags(t || []);
  };
  useEffect(() => { reload(); }, [q, sel, sort]);

  const toggleTag = (t: string) => setSel((s) => s.includes(t) ? s.filter((x) => x !== t) : [...s, t]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);   // 在别处再右键也先关掉旧菜单
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onEsc);
    };
  }, [menu]);

  // 打开该画集的缓存目录
  const openCacheDir = async (it: any) => {
    setMenu(null);
    const r = await api.libOpenCacheDir(it.gid);
    if (!r.ok) toast(r.error || '打开失败');
    else if (!r.hasFiles) toast('该画集还没有缓存文件，已打开空目录');
  };

  return (
    <div className="page">
      <div className="page-title">本地库 <span className="hint">{items.length} 项</span></div>

      <div className="row" style={{ marginBottom: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题 / 标签 / 备注…"
          style={{ flex: 1, background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px' }} />
        <select value={sort} onChange={(e) => setSort(e.target.value)}
          style={{ background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}>
          <option value="added">按加入时间</option>
          <option value="rating">按评分</option>
          <option value="pages">按页数</option>
          <option value="title">按标题</option>
        </select>
        <button className="btn" onClick={() => setShowTags((s) => !s)}>{showTags ? '隐藏标签' : '显示标签'}</button>
      </div>

      {showTags && (
        <div className="tagcloud">
          {sel.length > 0 && <div className="tag on" onClick={() => setSel([])}>清除筛选 ({sel.length})</div>}
          {tags.slice(0, 120).map((t) => (
            <div key={t.tag} className={'tag' + (sel.includes(t.tag) ? ' on' : '')} onClick={() => toggleTag(t.tag)}>
              {t.tag} <span className="hint">{t.count}</span>
            </div>
          ))}
          {!tags.length && <span className="hint">还没有标签，先把图集加入本地库吧</span>}
        </div>
      )}

      {items.length === 0 && <div className="empty">本地库为空</div>}
      <div className="grid">
        {items.map((it) => (
          <div className="card" key={it.gid}
            onClick={() => nav({ name: 'gallery', gid: it.gid, token: it.token })}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, item: it }); }}>
            {it.cover ? <img className="cover" src={api.img(it.cover)} loading="lazy" /> : <div className="cover" />}
            <div className="meta">
              <div className="title">{it.title}</div>
              <div className="sub">
                {it.category && <span className="badge">{it.category}</span>}
                {it.pages && <span>{it.pages} 页</span>}
                {it.lastRead ? <span>读到 {it.lastRead}</span> : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <div className="ctx-item" onClick={() => openCacheDir(menu.item)}>打开缓存所在目录</div>
        </div>
      )}
    </div>
  );
}
