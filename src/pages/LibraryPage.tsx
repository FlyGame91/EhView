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

  const reload = async () => {
    const [r, t] = await Promise.all([api.libSearch({ q, tags: sel, sort }), api.libTags()]);
    setItems(r || []);
    setTags(t || []);
  };
  useEffect(() => { reload(); }, [q, sel, sort]);

  const toggleTag = (t: string) => setSel((s) => s.includes(t) ? s.filter((x) => x !== t) : [...s, t]);

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
          <div className="card" key={it.gid} onClick={() => nav({ name: 'gallery', gid: it.gid, token: it.token })}>
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
    </div>
  );
}
