import React, { useState, useSyncExternalStore } from 'react';
import { api, GalleryItem } from '../api';
import { downloadGids, libraryGids } from '../lib/stores';

const catClass = (c: any) => 'badge c-' + String(c || '').replace(/[^a-zA-Z]/g, '');

export default function GalleryCard({ item, onClick, nav, toast }: any) {
  const cover = item.thumb ? api.img(item.thumb) : '';
  const downloading = useSyncExternalStore(downloadGids.subscribe, () => downloadGids.has(item.gid));
  const inLib = useSyncExternalStore(libraryGids.subscribe, () => libraryGids.has(item.gid));

  const [asking, setAsking] = useState(false);
  const [cost, setCost] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  // ① 下载：已在下载列表 → 直接跳下载页；否则弹确认框显示 GP 消耗
  const onDownload = async (e: any) => {
    e.stopPropagation();
    if (downloading) { nav && nav({ name: 'downloads' }); return; }
    setAsking(true); setCost(null);
    try {
      const r = await api.archiveCost(item.gid, item.token);
      setCost(r.ok ? r.data : { error: r.error });
    } catch (err: any) { setCost({ error: err.message }); }
  };

  const confirmDownload = async (e: any) => {
    e.stopPropagation();
    setBusy(true);
    try {
      const filename = String(item.title || (item.gid + '-' + item.token)).replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
      const r = await api.dlArchive({
        gid: item.gid, token: item.token, resolution: 'org',
        title: item.title, filename, cover: item.thumb || '',
      });
      if (r.ok) {
        downloadGids.add(item.gid);
        setAsking(false);
        toast && toast('已加入下载：' + (item.title || item.gid));
      } else {
        toast && toast(r.error || '下载失败');
      }
    } catch (err: any) { toast && toast(err.message); }
    setBusy(false);
  };

  // ② 收藏：实心点击取消，空心点击收藏
  const onFav = async (e: any) => {
    e.stopPropagation();
    try {
      // 以本地库真实状态为准（Set 可能因外部删除而过期）
      const real = await api.libGet(item.gid).catch(() => null);
      const actuallyIn = !!real;
      if (actuallyIn) {
        await api.libRemove(item.gid);
        libraryGids.remove(item.gid);
        toast && toast('已从本地库移除');
      } else {
        await api.libAdd({
          gid: item.gid, token: item.token, title: item.title,
          titleJpn: item.titleJpn, category: item.category, thumb: item.thumb,
          pages: item.pages, rating: item.rating, tags: item.tags, posted: item.posted,
        });
        libraryGids.add(item.gid);
        toast && toast('已收藏到本地库');
      }
    } catch (err: any) { toast && toast(err.message); }
  };

  return (
    <div className="card" onClick={onClick}>
      {cover ? <img className="cover" src={cover} loading="lazy" /> : <div className="cover" />}

      <button
        className={'card-btn card-dl' + (downloading ? ' solid' : '')}
        onClick={onDownload}
        title={downloading ? '已在下载列表，点击查看' : '下载该图集'}
      >{downloading ? '⬇' : '⤓'}</button>

      <button
        className={'card-btn card-star' + (inLib ? ' solid' : '')}
        onClick={onFav}
        title={inLib ? '已在本地库，点击取消收藏' : '收藏到本地库'}
      >{inLib ? '★' : '☆'}</button>

      {asking && (
        <div className="dl-confirm" onClick={(e) => e.stopPropagation()}>
          <div className="dlc-title">{item.title}</div>
          <div className="dlc-cost">
            {cost === null ? '查询花费中…'
              : cost.error ? ('查询失败：' + cost.error)
              : cost.needLogin ? '需要登录'
              : (cost.cost || '未知') + (cost.size ? ' · ' + cost.size : '')}
          </div>
          <div className="dlc-actions">
            <button className="btn sm" onClick={() => setAsking(false)} disabled={busy}>取消</button>
            <button className="btn sm primary" onClick={confirmDownload} disabled={busy || !!(cost && cost.error)}>
              {busy ? '加入中…' : '确定下载'}
            </button>
          </div>
        </div>
      )}

      <div className="meta">
        <div className="title" title={item.title}>{item.title}</div>
        <div className="sub">
          {item.category && <span className={catClass(item.category)}>{item.category}</span>}
          {item.pages && <span>{item.pages} 页</span>}
          {item.rating && <span>★ {item.rating}</span>}
        </div>
      </div>
    </div>
  );
}
