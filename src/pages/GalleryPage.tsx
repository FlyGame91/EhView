import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtSize, fmtTime } from '../api';
import { galleryMemo, GALLERY_TTL } from '../lib/galleryMemo';
import { libraryGids } from '../lib/stores';


const catClass = (c: any) => 'badge c-' + String(c || '').replace(/[^a-zA-Z]/g, '');

export default function GalleryPage({ gid, token, nav, toast, settings, listReturn }: any) {
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [local, setLocal] = useState<any>(null);
  const [archiveRes, setArchiveRes] = useState('org');
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveCost, setArchiveCost] = useState<any>(null);
  const [torrents, setTorrents] = useState<any>(null);
  const [showTorrents, setShowTorrents] = useState(false);
  const [thumbs, setThumbs] = useState<any[]>([]);
  const [thumbPage, setThumbPage] = useState(0);
  const [pagesTotal, setPagesTotal] = useState(0);
  const [loadingThumbs, setLoadingThumbs] = useState(false);
  const thumbBusyRef = useRef(false);

  const load = async () => {
    setErr('');
    const memKey = gid + '/' + token;
    const hit = galleryMemo.get(memKey);
    if (hit && Date.now() - hit.ts < GALLERY_TTL) {
      // 命中缓存：秒开，不发任何请求
      setD(hit.data);
      setThumbs(hit.thumbs);
      setPagesTotal(hit.pagesTotal);
      setThumbPage(hit.thumbPage);
      setArchiveCost(hit.archiveCost || null);
      setLoading(false);
      api.libGet(gid).then(setLocal).catch(() => {});
      requestAnimationFrame(() => {
        const c = document.querySelector('.content');
        if (c && hit.scrollTop) c.scrollTop = hit.scrollTop;
      });
      return;
    }
    setLoading(true);
    const r = await api.gallery(gid, token);
    setLoading(false);
    if (!r.ok) { setErr(r.error); return; }
    setD(r.data);
    setThumbs(r.data.thumbs || []);
    // 异步查归档花费（不阻塞页面）
    api.archiveCost(gid, token).then((cr: any) => {
      if (!cr.ok) return;
      setArchiveCost(cr.data);
      const mm = galleryMemo.get(gid + '/' + token);
      if (mm) mm.archiveCost = cr.data;
    }).catch(() => {});
    setPagesTotal(r.data.pagesTotal || 0);
    setThumbPage(0);
    galleryMemo.set(gid + '/' + token, {
      data: r.data, thumbs: r.data.thumbs || [], pagesTotal: r.data.pagesTotal || 0,
      thumbPage: 0, archiveCost: null, ts: Date.now(), scrollTop: 0
    });
    const l = await api.libGet(gid);
    setLocal(l);
    // 记入浏览历史（超过上限会淘汰最老条目并清掉其缓存）
    try {
      const dd = r.data || {};
      await api.historyRecord({
        gid, token,
        title: dd.title || '',
        cover: dd.thumb || (dd.thumbs && dd.thumbs[0] && dd.thumbs[0].thumb) || '',
        category: dd.category || '',
        pages: dd.pagesTotal || 0
      });
    } catch (e) { console.warn('history record failed', e); }
  };

  useEffect(() => { load(); }, [gid, token]);

  // 记住滚动位置 + 缩略图增量，返回时原样还原（否则就算不转圈也会跳回顶部）
  useEffect(() => {
    const memKey = gid + '/' + token;
    const c = document.querySelector('.content') as HTMLElement | null;
    if (!c) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const m = galleryMemo.get(memKey);
        if (m) { m.scrollTop = c.scrollTop; m.thumbs = thumbs; m.thumbPage = thumbPage; }
      });
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => { c.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [gid, token, thumbs, thumbPage]);

  // 缩略图无限滚动：滚到底自动拉下一批（每批 20 张）
  useEffect(() => {
    const c = document.querySelector('.content') as HTMLElement | null;
    if (!c) return;
    const onScroll = async () => {
      if (thumbBusyRef.current) return;
      if (c.scrollHeight - c.scrollTop - c.clientHeight > 900) return;
      if (!pagesTotal || thumbs.length === 0 || thumbs.length >= pagesTotal) return;
      thumbBusyRef.current = true;
      setLoadingThumbs(true);
      try {
        const nextPage = thumbPage + 1;
        const r = await api.thumbs(gid, token, nextPage);
        if (r.ok && r.data && r.data.thumbs && r.data.thumbs.length) {
          setThumbs((prev) => {
            const seen = new Set(prev.map((t: any) => t.index));
            return [...prev, ...r.data.thumbs.filter((t: any) => !seen.has(t.index))];
          });
          setThumbPage(nextPage);
        } else {
          setPagesTotal(thumbs.length); // 拉不到就认定为到底
        }
      } catch (e) {}
      thumbBusyRef.current = false;
      setLoadingThumbs(false);
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => c.removeEventListener('scroll', onScroll);
  }, [gid, token, thumbPage, thumbs.length, pagesTotal]);

  const addLocal = async () => {
    if (!d) return;
    await api.libAdd({
      gid, token, title: d.title, titleJpn: d.titleJpn, category: d.category,
      pages: d.pagesTotal, rating: d.rating, cover: d.thumb || (d.thumbs && d.thumbs[0] && d.thumbs[0].thumb), tags: (d.tags || []).map((t: any) => t.name),
      addedAt: Date.now(), uploader: d.uploader, filesize: d.filesize
    });
    libraryGids.add(gid);
    const mm2 = galleryMemo.get(gid + '/' + token);
    if (mm2) mm2.inLib = true;
    setLocal(await api.libGet(gid));
    toast('已加入本地库');
  };

  const removeLocal = async () => {
    await api.libRemove(gid);
    libraryGids.remove(gid);
    // 顺手从详情缓存里抹掉 local 标记，避免返回列表时还显示已收藏
    const mm = galleryMemo.get(gid + '/' + token);
    if (mm) mm.inLib = false;
    setLocal(null);
    toast('已从本地库移除');
  };

  const downloadArchive = async () => {
    setArchiveBusy(true);
    const safeName = String(d.title || gid).replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || (gid + '-' + token);
    const r = await api.dlArchive({ gid, token, resolution: archiveRes, title: d.title, filename: safeName, cover: d.thumb || '' });
    setArchiveBusy(false);
    if (!r.ok) { toast(r.error || '下载失败'); return; }
    toast('已开始下载到 ' + (settings.downloadDir || '默认目录'));
    nav({ name: 'downloads' });
  };

  const loadTorrents = async () => {
    setShowTorrents(true);
    setTorrents({ loading: true });
    const r = await api.torrents(gid, token);
    setTorrents(r.ok ? r.data : { error: r.error });
  };

  if (loading) return <div className="page"><div className="spinner" /></div>;
  if (err) return <div className="page"><div className="warnbox">{err}</div></div>;
  if (!d) return null;

  const meta = d.meta || {};

  const backToList = () => nav(listReturn || { name: 'search', query: '' });

  return (
    <div className="page">
      <div className="crumb">
        <button className="btn sm" onClick={backToList}>← 返回列表</button>
        <span className="hint">{listReturn && listReturn.name === 'favorites' ? '站点收藏' : listReturn && listReturn.name === 'history' ? '浏览历史' : listReturn && listReturn.name === 'library' ? '本地库' : '搜索结果'}</span>
      </div>
      <div className="detail">
        <div className="cover">
          {d.thumb ? <img src={api.img(d.thumb, gid)} /> : null}
        </div>
        <div className="info">
          <h1>{d.title}</h1>
          {d.titleJpn && <div className="jpn">{d.titleJpn}</div>}
          <div className="kv">
            <div className="k">分类</div><div className="v"><span className={catClass(d.category)}>{d.category}</span></div>
            <div className="k">上传者</div><div className="v">{d.uploader}</div>
            <div className="k">页数</div><div className="v">{d.pagesTotal}</div>
            <div className="k">大小</div><div className="v">{meta['File Size'] || fmtSize(d.filesize)}</div>
            <div className="k">评分</div><div className="v">{d.rating} （收藏 {d.favorited || meta['Favorited'] || '-'}）</div>
            <div className="k">发布时间</div><div className="v">{meta['Posted'] || fmtTime(d.posted)}</div>
            <div className="k">种子</div><div className="v">{d.torrentCount} 个</div>
          </div>

          <div className="actions">
            <button className="btn primary" onClick={() => nav({ name: 'reader', gid, token, index: 0, title: d.title })}>开始阅读</button>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <button className="btn" onClick={downloadArchive} disabled={archiveBusy}>
                {archiveBusy ? '准备下载…' : '⬇ 一键下载原始归档'}
              </button>
              <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: archiveCost && /Free/i.test(archiveCost.cost || '') ? 'var(--ok)' : 'var(--text-2)' }}
                    title={archiveCost && archiveCost.size ? ('预估大小 ' + archiveCost.size) : ''}>
                {archiveCost === null ? '…'
                  : archiveCost.needLogin ? '需登录'
                  : archiveCost.cost ? (archiveCost.cost + (archiveCost.size ? ' · ' + archiveCost.size : ''))
                  : '未知'}
              </span>
            </div>
            <select value={archiveRes} onChange={(e) => setArchiveRes(e.target.value)}
              style={{ background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 8, padding: '0 8px' }}>
              <option value="org">原始文件</option>
              <option value="res">重新采样（较小）</option>
            </select>
            <button className="btn" onClick={loadTorrents}>种子 / 做种情况</button>
            {local ? <button className="btn" onClick={removeLocal}>★ 已在本地库</button> : <button className="btn" onClick={addLocal}>☆ 加入本地库</button>}
          </div>

          <div className="tags">
            {(d.tags || []).map((t: any) => (
              <span key={t.name} className={'tag ns'} title={t.strength}
                onClick={() => nav({ name: 'search', query: t.name })}>{t.name}</span>
            ))}
          </div>
        </div>
      </div>

      {showTorrents && (
        <div className="section" style={{ marginTop: 18 }}>
          <h3>种子列表 <button className="btn sm" style={{ float: 'right' }} onClick={() => setShowTorrents(false)}>关闭</button></h3>
          {torrents?.loading && <div className="spinner" />}
          {torrents?.error && <div className="warnbox">{torrents.error}</div>}
          {torrents && !torrents.loading && !torrents.error && (
            <>
              {(!torrents.items || torrents.items.length === 0) && <div className="hint">没有可用的种子。{torrents.text ? <div className="mono" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{torrents.text.slice(0, 500)}</div> : null}</div>}
              {torrents.items && torrents.items.length > 0 && (
                <table className="tbl">
                  <thead><tr><th>文件</th><th>Seeds</th><th>Peers</th><th>大小</th><th>发布</th><th></th></tr></thead>
                  <tbody>
                    {torrents.items.map((t: any, i: number) => {
                      const dead = t.seeds === 0;
                      return (
                        <tr key={i}>
                          <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.filename}>{t.filename}</td>
                          <td style={{ color: dead ? 'var(--err)' : (t.seeds > 0 ? 'var(--ok)' : 'var(--text-2)'), fontWeight: 600 }}>{t.seeds ?? '?'}</td>
                          <td>{t.peers ?? '?'}</td>
                          <td className="hint">{t.size}</td>
                          <td className="hint">{t.posted}</td>
                          <td><button className="btn sm" onClick={() => api.dlUrl({ url: t.url, filename: t.filename.replace(/[\\/:*?"<>|]/g, '_') || ('torrent_' + gid + '_' + i + '.torrent'), kind: 'torrent' })}>下载种子</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {torrents.items && torrents.items.some((t: any) => t.seeds === 0) && (
                <div className="warnbox">⚠ 有种子无人做种（seeds = 0），这些种子实际上无法下载。</div>
              )}
            </>
          )}
        </div>
      )}

      <div className="page-title" style={{ marginTop: 22 }}>
        页面预览（{thumbs.length}{pagesTotal ? ' / ' + pagesTotal : ''}）
        {loadingThumbs && <span className="hint" style={{ marginLeft: 8 }}>加载中…</span>}
      </div>
      <div className="thumbs">
        {thumbs.map((t: any) => (
          <div
            className="t"
            key={t.index}
            onClick={() => nav({ name: 'reader', gid, token, index: t.index - 1, title: d.title })}
            style={{ aspectRatio: (t.w || 200) + ' / ' + (t.h || 284) }}
          >
            <div
              className="t-img"
              style={{
                width: (t.w || 200), height: (t.h || 284),
                backgroundImage: t.thumb ? 'url(' + api.img(t.thumb, gid) + ')' : 'none',
                backgroundPosition: (t.bgX || 0) + 'px ' + (t.bgY || 0) + 'px',
                transform: 'scale(' + (132 / (t.w || 200)) + ')'
              }}
            />
            <div className="n">{t.index}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
