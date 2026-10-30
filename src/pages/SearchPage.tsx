import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, GalleryItem } from '../api';
import GalleryCard from '../components/GalleryCard';

const CATS = [
  ['doujinshi', 'Doujinshi'], ['manga', 'Manga'], ['artistcg', 'Artist CG'], ['gamecg', 'Game CG'],
  ['western', 'Western'], ['nonh', 'Non-H'], ['imageset', 'Image Set'], ['cosplay', 'Cosplay'],
  ['asianporn', 'Asian Porn'], ['misc', 'Misc']
];

// 搜索页状态缓存：进详情再返回时，已加载的卡片和滚动位置原样恢复
const searchMemo = new Map<string, any>();
// 记住最近一次的筛选掩码：从详情返回列表时 route 里没有 fCats，靠它还原
let lastFilter = { query: '', fCats: 0, noFilter: false };
const SEARCH_TTL = 10 * 60 * 1000;

// 官方分类位值（与站点 f_cats 掩码一致）
const CAT_BTNS = [
  { name: 'Doujinshi', mask: 2 }, { name: 'Manga', mask: 4 },
  { name: 'Artist CG', mask: 8 }, { name: 'Game CG', mask: 16 },
  { name: 'Western', mask: 512 }, { name: 'Non-H', mask: 256 },
  { name: 'Image Set', mask: 32 }, { name: 'Cosplay', mask: 64 },
  { name: 'Asian Porn', mask: 128 }, { name: 'Misc', mask: 1 },
];
const ALL_CATS = 1023;

/** 官方三态切换：普通 → 排除 → 仅此 → 普通 */
function toggleCat(mask: number, fCats: number) {
  const excluded = (fCats & mask) !== 0;
  const only = fCats === (ALL_CATS & ~mask);
  if (!excluded && !only) return fCats | mask;      // 普通 → 排除
  if (excluded) return ALL_CATS & ~mask;            // 排除 → 仅此
  return 0;                                        // 仅此 → 普通
}

export default function SearchPage({ route, nav, toast, settings }: any) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [next, setNext] = useState('');
  const [total, setTotal] = useState('');
  const [cats, setCats] = useState<string[]>([]);
  // 本地过滤：隐藏带 ai generated 标签的画集（站点 Hidden 设置在我们这边不生效时的兜底）
  // 关闭站点软过滤（官方 Disable Filters：f_sft/f_sfu/f_sfl）+ 本地 AI 兜底
  const [noFilter, setNoFilter] = useState<boolean>(() => (lastFilter.query === (route.query || '') ? !!lastFilter.noFilter : false));
  const hideAI = !noFilter;
  const [fCats, setFCats] = useState<number>(() => (lastFilter.query === (route.query || '') ? lastFilter.fCats : 0));   // 要排除的分类掩码（官方 f_cats）
  const busyRef = useRef(false);
  const nextRef = useRef('');
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(async (opts: any, append: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      const r = await api.search({ query: route.query || '', cats: [], fCats, disableFilters: noFilter, ...opts });
      if (!r.ok) { setError(r.error || '加载失败'); return; }
      const list = r.items || [];
      setItems((prev) => {
        const key2 = route.query + '|f' + fCats + (noFilter ? '|nf' : '');
        const nextItems = append ? [...prev, ...list] : list;
        const mm = searchMemo.get(key2);
        if (mm) { mm.items = nextItems; mm.next = r.next || ''; mm.ts = Date.now(); }
        else searchMemo.set(key2, { items: nextItems, next: r.next || '', total: r.total || '', ts: Date.now(), scrollTop: 0, fCats });
        return nextItems;
      });
      setNext(r.next || '');
      nextRef.current = r.next || '';
      setTotal(r.total || '');
    } catch (e: any) {
      setError(e.message);
    } finally {
      busyRef.current = false;
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [route.query, fCats, noFilter]);

  // 条件变化 → 重置并加载第一页
  useEffect(() => {
    const key = route.query + '|f' + fCats + (noFilter ? '|nf' : '');
    const hit = searchMemo.get(key);
    if (hit && Date.now() - hit.ts < SEARCH_TTL) {
      // 从详情返回：直接恢复列表和滚动位置，不重新搜索
      setItems(hit.items);
      nextRef.current = hit.next || '';
      setTotal(hit.total || '');
      if (typeof hit.fCats === 'number') setFCats(hit.fCats);
      setLoading(false);
      requestAnimationFrame(() => {
        const c = document.querySelector('.content') as HTMLElement | null;
        if (c && hit.scrollTop) c.scrollTop = hit.scrollTop;
      });
      return;
    }
    setItems([]);
    setNext('');
    nextRef.current = '';
    fetchPage({ page: 1 }, false);
  }, [route, fCats, noFilter]);

  // 滚到底部自动加载下一页（用 scroll 事件，比 IntersectionObserver 更可靠：
  // 应用里的滚动容器是 .content，IO 的 root 在某些渲染时机下拿不到）
  useEffect(() => {
    const c = document.querySelector('.content') as HTMLElement | null;
    if (!c) return;
    const THRESHOLD = 900; // 距离底部 900px 就开始预取
    const onScroll = () => {
      // 记住滚动位置，返回时还原
      const mm = searchMemo.get(route.query + '|f' + fCats + (noFilter ? '|nf' : ''));
      if (mm) mm.scrollTop = c.scrollTop;
      if (!nextRef.current || busyRef.current) return;
      if (c.scrollHeight - c.scrollTop - c.clientHeight < THRESHOLD) {
        fetchPage({ cursor: nextRef.current }, true);
      }
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => c.removeEventListener('scroll', onScroll);
  }, [fetchPage]);

  useEffect(() => { lastFilter = { query: route.query || '', fCats, noFilter }; }, [route.query, fCats, noFilter]);

  const loadMore = () => {
    if (nextRef.current && !busyRef.current) fetchPage({ cursor: nextRef.current }, true);
  };

  return (
    <div className="page">
      <div className="page-title">
        {route.query ? '搜索：' + route.query : '浏览'}
        {total && <span className="hint">约 {total} 个结果 · 已加载 {items.length}</span>}
      </div>

      <div className="cat-bar">
        {CAT_BTNS.map((c) => {
          const excluded = (fCats & c.mask) !== 0;
          const only = fCats === (ALL_CATS & ~c.mask);
          return (
            <button
              key={c.mask}
              className={'cat-btn ct-' + c.name.toLowerCase().replace(/[^a-z]/g, '') + (excluded ? ' excluded' : '') + (only ? ' only' : '')}
              onClick={() => setFCats((f) => toggleCat(c.mask, f))}
              title={excluded ? '已排除，点击改为「只看这个」' : only ? '只看这个，点击恢复正常' : '点击排除这个分类'}
            >{c.name}</button>
          );
        })}
        {fCats !== 0 && <button className="cat-btn reset" onClick={() => setFCats(0)}>重置筛选</button>}
        <button
          className={'cat-btn ai-toggle' + (!noFilter ? ' on' : '')}
          onClick={() => setNoFilter((v) => !v)}
          title="关闭站点的标签/上传者/语言软过滤（f_sft/f_sfu/f_sfl），同时显示本地隐藏的 AI 图"
        >{noFilter ? '⚠ 过滤已关闭' : '✓ 过滤生效中'}</button>
      </div>

      {loading && <div style={{ padding: 40 }}><div className="spinner" /></div>}
      {error && <div className="warnbox">{error}</div>}
      {!loading && !error && items.length === 0 && <div className="empty">没有结果</div>}

      <div className="grid">
        {items.filter((it: any) => !hideAI || !(it.tags || []).some((t: string) => /^other:ai generated$/i.test(t))).map((it) => (
          <GalleryCard key={it.gid} item={it} onClick={() => nav({ name: 'gallery', gid: it.gid, token: it.token })} nav={nav} toast={toast} settings={settings} />
        ))}
      </div>

      {/* 无限滚动哨兵 */}
      <div ref={sentinelRef} style={{ height: 1 }} />

      <div className="pager">
        {loadingMore && <span className="hint" style={{ alignSelf: 'center' }}>正在加载下一页…</span>}
        {!loadingMore && next && <button className="btn" onClick={loadMore}>加载更多</button>}
        {!next && items.length > 0 && <span className="hint" style={{ alignSelf: 'center' }}>已到最后一页</span>}
      </div>
    </div>
  );
}
