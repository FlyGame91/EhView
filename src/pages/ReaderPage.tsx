import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtSize } from '../api';
import { getCachedThumbs } from '../lib/galleryMemo';

export default function ReaderPage({ gid, token, startIndex, title, nav, toast, settings, listReturn }: any) {
  const [pages, setPages] = useState<any[]>([]);
  // 旧版本存过 'fit' 这类已废弃的值，必须校验，否则 CSS 类名对不上导致缩放完全失效
  const VALID_MODES = ['fit', 'height', 'width', 'orig'] as const;
  const pickMode = (v: any) => (VALID_MODES as readonly string[]).includes(v) ? v : 'fit';
  const [mode, setMode] = useState<'fit' | 'height' | 'width' | 'orig'>(pickMode(settings?.reader?.mode) as any);
  const [continuous, setContinuous] = useState(false);
  const [idx, setIdx] = useState(startIndex || 0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [cur, setCur] = useState<any>(null);
  const [imgErr, setImgErr] = useState('');
  const [showBar, setShowBar] = useState(true);
  const cacheRef = useRef<Map<number, any>>(new Map());
  // 当前页的实时引用：并发请求回来时必须拿它判断，闭包里的 idx 是旧值
  const idxRef = useRef(idx);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  const stageRef = useRef<HTMLDivElement>(null);
  // 左侧缩略图栏：优先复用详情页已缓存的 thumbs，不够再按批拉
  const [sbThumbs, setSbThumbs] = useState<any[]>([]);
  const [sbPage, setSbPage] = useState(0);
  const [sbBusy, setSbBusy] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const sbRef = useRef<HTMLDivElement>(null);
  const sbBusyRef = useRef(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const r = await api.pages(gid, token);
      setLoading(false);
      if (!r.ok) { setErr(r.error); return; }
      const list = (r.data.pages || []).slice().sort((a: any, b: any) => (a.index || 0) - (b.index || 0));
      setPages(list);
      if (!list.length) setErr('无法获取页面列表（可能需要登录）');
    })();
  }, [gid, token]);

  // 侧栏缩略图：先用详情页缓存，再按需补拉后续批次
  const loadSb = useCallback(async (p: number, replace = false) => {
    if (sbBusyRef.current) return;
    sbBusyRef.current = true;
    setSbBusy(true);
    try {
      const r = await api.thumbs(gid, token, p);
      if (r.ok && r.data && r.data.thumbs) {
        const list = r.data.thumbs;
        setSbThumbs((prev) => {
          if (replace) return list;
          const have = new Set(prev.map((x: any) => x.index));
          return [...prev, ...list.filter((x: any) => !have.has(x.index))].sort((a: any, b: any) => a.index - b.index);
        });
        setSbPage(p);
      }
    } catch (e) {}
    sbBusyRef.current = false;
    setSbBusy(false);
  }, [gid, token]);

  useEffect(() => {
    const cached = getCachedThumbs(gid, token);
    if (cached.length) { setSbThumbs(cached); setSbPage(0); }
    else loadSb(0, true);
  }, [gid, token, loadSb]);

  const fetchPage = useCallback(async (i: number) => {
    if (i < 0 || i >= pages.length) return;
    // 缓存命中也要确认「这就是当前页」——快速翻页时旧页的缓存不能覆盖新页
    if (cacheRef.current.has(i)) {
      if (i === idxRef.current) setCur(cacheRef.current.get(i));
      return;
    }
    const p = pages[i];
    try {
      const r = await api.image(p.pageToken, gid, p.index || i + 1);
      if (r.ok) {
        cacheRef.current.set(i, { ...r.data, idx: i });
        // 只有请求回来时仍停留在这一页，才允许上屏（防止后发先至的旧请求覆盖）
        if (i === idxRef.current) setCur(r.data);
      } else if (i === idxRef.current) {
        setImgErr(r.error);
      }
    } catch (e: any) { if (i === idxRef.current) setImgErr(e.message); }
  }, [pages, gid]);

  useEffect(() => { if (pages.length) fetchPage(idx); }, [idx, pages]);

  // 预载：解析后续页的图片地址，并让主进程把图片真正落盘到缓存
  // 旧实现只解析 URL、不下图片，翻页时仍然要现下，等于没预载
  useEffect(() => {
    if (!pages.length) return;
    const AHEAD = 5;      // 后面 5 张（重点）
    const BEHIND = 2;     // 前面 2 张（回看用）
    const CONCURRENCY = 3; // 并发上限，避免触发站点限流
    const targets: number[] = [];
    for (let k = 1; k <= AHEAD; k++) if (idx + k < pages.length) targets.push(idx + k);
    for (let k = 1; k <= BEHIND; k++) if (idx - k >= 0) targets.push(idx - k);
    const queue = targets.filter((n) => !cacheRef.current.has(n));
    if (!queue.length) return;

    let stopped = false;
    let cursor = 0;
    const worker = async () => {
      while (!stopped && cursor < queue.length) {
        const n = queue[cursor++];
        const p = pages[n];
        try {
          const rr = await api.image(p.pageToken, gid, p.index || n + 1, { prefetch: true });
          if (rr.ok) cacheRef.current.set(n, { ...rr.data, idx: n });   // 数据有效就保留，不因翻页丢弃
        } catch (e) {}
      }
    };
    Promise.all(Array.from({ length: CONCURRENCY }, worker)).catch(() => {});
    return () => { stopped = true; };
  }, [idx, pages, gid]);

  // 侧栏滚到底继续加载；当前页变化时把高亮项滚进视野
  useEffect(() => {
    const el = sbRef.current;
    if (!el || !showSidebar) return;
    const onScroll = () => {
      if (sbBusyRef.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 200) return;
      if (sbThumbs.length >= pages.length) return;
      loadSb(sbPage + 1);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [sbThumbs.length, sbPage, pages.length, showSidebar, loadSb]);

  useEffect(() => {
    if (!showSidebar) return;
    const el = sbRef.current?.querySelector('.sb-thumb.active') as HTMLElement | null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [idx, showSidebar]);

  // 相对步进：用 idxRef 取实时页，避免同一渲染帧内连点多次只前进一页
  const step = useCallback((delta: number) => {
    const n = Math.max(0, Math.min(pages.length - 1, idxRef.current + delta));
    idxRef.current = n;
    setIdx(n);
    setCur((c: any) => (c && c.idx === n ? c : null));
    setImgErr('');
    if (pages.length) api.libSetRead(gid, n + 1, pages.length);
    if (stageRef.current) stageRef.current.scrollTop = 0;
    return n;
  }, [pages.length, gid]);

  const go = useCallback((n: number) => {
    if (n < 0 || n >= pages.length) return;
    idxRef.current = n;      // 立刻生效，避免并发请求用旧页判断
    setIdx(n);
    setCur((c: any) => (c && c.idx === n ? c : null));   // 清掉不属于新页的画面
    setImgErr('');
    if (pages.length) api.libSetRead(gid, n + 1, pages.length);
    if (stageRef.current) stageRef.current.scrollTop = 0;
  }, [pages.length, gid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'd') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'a') { e.preventDefault(); step(-1); }
      else if (e.key === 'Home') { e.preventDefault(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); go(pages.length - 1); }
      else if (e.key === 'Escape') { nav({ name: 'gallery', gid, token }); }
      else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
      else if (e.key === 'w' || e.key === 'W') { chooseMode(((() => { const order = ['fit', 'height', 'width', 'orig']; return order[(order.indexOf(mode) + 1) % order.length]; })())); }
      else if (e.key === ' ') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, pages.length, go]);

  // 切换缩放模式并持久化到设置
  const chooseMode = (m: any) => {
    setMode(m);
    try { api.saveSettings({ reader: { ...(settings?.reader || {}), mode: m } }); } catch (e) {}
  };

  // 另存当前页：优先用已落盘的缓存文件，缓存没有就先下载再弹另存为
  const [saving, setSaving] = useState(false);
  const saveCurrent = async () => {
    if (!curOk || !cur) { toast('当前页还没加载完成'); return; }
    setSaving(true);
    try {
      const r = await api.saveImage({
        gid, title,
        index: idx + 1,
        key: cur.local ? cur.key : '',
        ext: cur.local ? cur.ext : '',
        src: cur.local ? '' : (cur.src || '')
      });
      if (r.ok) toast('已保存到 ' + r.path);
      else if (!r.canceled) toast('保存失败：' + (r.error || '未知错误'));
    } catch (e: any) { toast('保存失败：' + e.message); }
    setSaving(false);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  };

  // 连续模式：加载所有已访问页
  const [loadedContinuous, setLoadedContinuous] = useState<number[]>([]);
  useEffect(() => {
    if (continuous) setLoadedContinuous(Array.from({ length: pages.length }, (_, i) => i));
  }, [continuous, pages.length]);

  if (loading) return <div className="reader"><div className="bar"><button className="btn sm" onClick={() => nav({ name: 'gallery', gid, token })}>返回</button></div><div className="stage"><div className="spinner" /></div></div>;
  if (err) return <div className="reader"><div className="bar"><button className="btn sm" onClick={() => nav({ name: 'gallery', gid, token })}>返回</button><span>{title}</span></div><div className="stage"><div className="warnbox">{err}</div></div></div>;

  // local: 主进程已按缓存键命中，直接读本地文件（零网络）
  // 只有「当前页自己的数据」才允许上屏，彻底杜绝预览与主图不一致
  const curOk = cur && (cur.idx === undefined || cur.idx === idx);
  const imgSrc = curOk ? (cur.local ? api.imgKey(cur.key, cur.ext, gid) : (cur.src ? api.img(cur.src, gid) : '')) : '';

  return (
    <div className={'reader mode-' + mode + (continuous ? ' continuous' : '') + (showSidebar ? ' has-sidebar' : '')}>
      {showSidebar && (
        <aside className="sb" ref={sbRef}>
          {sbThumbs.map((t: any) => {
            const w = t.w || 200, h = t.h || 283;
            const scale = 104 / w;
            return (
              <div
                key={t.index}
                className={'sb-thumb' + (t.index - 1 === idx ? ' active' : '')}
                style={{ height: Math.round(104 * (h / w)) }}
                onClick={(e) => { e.stopPropagation(); go(t.index - 1); }}
                title={'第 ' + t.index + ' 页'}
                data-i={t.index}
              >
                <div
                  className="sb-inner"
                  style={{
                    width: w, height: h,
                    backgroundImage: t.thumb ? 'url(' + api.img(t.thumb, gid) + ')' : 'none',
                    backgroundPosition: (t.bgX || 0) + 'px ' + (t.bgY || 0) + 'px',
                    transform: 'scale(' + scale + ')',
                  }}
                />
              </div>
            );
          })}
          {sbBusy && <div className="sb-more">加载中…</div>}
        </aside>
      )}
      <div className="main">
      <div className="bar">
        <button className="btn sm" onClick={() => nav({ name: 'gallery', gid, token })}>← 返回图集</button>
        <button className="btn sm" onClick={() => nav(listReturn || { name: 'search', query: '' })}>← 列表</button>
        <span className="mono" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn sm" onClick={() => step(-1)} disabled={idx <= 0}>◀</button>
          <input type="number" value={idx + 1} min={1} max={pages.length}
            onChange={(e) => go(Math.max(0, Math.min(pages.length - 1, parseInt(e.target.value, 10) - 1)))}
            style={{ width: 58, background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 6px', textAlign: 'center' }} />
          <span className="hint">/ {pages.length}</span>
          <button className="btn sm" onClick={() => step(1)} disabled={idx >= pages.length - 1}>▶</button>
        </div>
        <select value={mode} onChange={(e) => chooseMode(e.target.value)}
          style={{ background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 6px' }}>
          <option value="fit">自适应（铺满不裁切）</option>
          <option value="height">适应高度</option>
          <option value="width">适应宽度</option>
          <option value="orig">原始大小</option>
        </select>
        <button className="btn sm" onClick={() => setContinuous((c) => !c)}>{continuous ? '单页模式' : '连续模式'}</button>
        <button className="btn sm" onClick={() => setShowSidebar((s) => !s)}>{showSidebar ? '隐藏缩略图' : '显示缩略图'}</button>
        <button className="btn sm" onClick={saveCurrent} disabled={saving || !curOk} title="把当前页另存为">{saving ? '保存中…' : '保存'}</button>
        <button className="btn sm" onClick={toggleFullscreen}>全屏</button>
        <button className="btn sm" onClick={() => setShowBar((s) => !s)}>{showBar ? '隐藏工具栏' : '显示工具栏'}</button>
      </div>

      <div className="stage" ref={stageRef} onClick={(e) => {
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (x < rect.width * 0.3) step(-1); else if (x > rect.width * 0.7) step(1);
      }}>
        {!continuous && (
          <>
            {imgSrc
              ? <img key={idx} data-idx={idx} src={imgSrc} onError={() => setImgErr('图片加载失败')} draggable={false} />
              : <div className="spinner" />}
            {imgErr && <div className="warnbox" style={{ position: 'absolute' }}>{imgErr}</div>}
          </>
        )}
        {continuous && loadedContinuous.map((i) => {
          const pg = pages[i];
          return (
            <div key={i} style={{ marginBottom: 8, textAlign: 'center' }}>
              <img src={api.img('')} style={{ display: 'none' }} />
              <ContinuousImage p={pg} gid={gid} index={i} api={api} />
            </div>
          );
        })}
        <div className="hint">← → 翻页 · F 全屏 · W 切换缩放 · Esc 返回</div>
      </div>
      </div>
    </div>
  );
}

function ContinuousImage({ p, gid, index, api }: any) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api.image(p.pageToken, gid, p.index || index + 1);
      if (!alive || !r.ok) return;
      const d = r.data;
      setUrl(d.local ? api.imgKey(d.key, d.ext, gid) : api.img(d.src, gid));
    })();
    return () => { alive = false; };
  }, [p.pageToken]);
  return url ? <img src={url} loading="lazy" style={{ maxWidth: '100%', margin: '0 auto' }} /> : <div style={{ height: 200 }} />;
}
