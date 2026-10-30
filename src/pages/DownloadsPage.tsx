import React, { useEffect, useState } from 'react';
import { api, fmtSize, fmtSpeed } from '../api';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', running: '下载中', done: '完成', error: '失败', cancelled: '已取消',
};

export default function DownloadsPage({ toast }: any) {
  const [list, setList] = useState<any[]>([]);

  useEffect(() => {
    api.dlList().then(setList);
    const off = api.onDownload((l: any[]) => setList(l));
    return () => { try { off(); } catch (e) {} }
  }, []);

  const totalBytes = list.reduce((a, t) => a + (t.status === 'done' ? (t.total || t.received || 0) : (t.total || 0)), 0);
  const doneBytes = list.reduce((a, t) => a + (t.received || 0), 0);
  const speed = list.reduce((a, t) => a + (t.status === 'running' ? (t.speed || 0) : 0), 0);
  const running = list.filter((t) => t.status === 'running' || t.status === 'queued').length;

  return (
    <div className="page">
      <div className="page-title">
        下载
        <span className="hint">{list.length} 个任务{running ? ` · ${running} 个进行中` : ''}</span>
        <button className="btn sm" style={{ marginLeft: 'auto' }}
          onClick={async () => { await api.dlClear(); setList(await api.dlList()); }}>清除已完成</button>
      </div>

      {!!list.length && (
        <div className="dl-summary">
          <span>总大小 <b>{fmtSize(totalBytes)}</b></span>
          <span>已下载 <b>{fmtSize(doneBytes)}</b></span>
          <span>速度 <b>{fmtSpeed(speed)}</b></span>
        </div>
      )}

      {!list.length && <div className="empty">暂无下载任务</div>}

      <div className="dl-grid">
        {list.map((t) => {
          const pct = Math.max(0, Math.min(100, Math.round(t.progress || 0)));
          const failed = t.status === 'error';
          return (
            <div className={'dl-card ' + (t.status || '')} key={t.id}>
              <div className="dl-thumb">
                {t.cover
                  ? <img src={api.img(t.cover, t.gid)} alt="" loading="lazy" />
                  : <div className="ph">无封面</div>}
                <span className={'dl-badge ' + (t.status || '')}>{STATUS_LABEL[t.status] || t.status}</span>
              </div>

              {/* 进度条：缩略图与标题之间 */}
              <div className="bar-bg dl-bar"><div className="bar-fg" style={{ width: pct + '%' }} /></div>

              <div className="dl-title" title={failed ? (t.title + ' — ' + t.error) : (t.title || t.url)}>
                {t.title || t.url}
                {failed ? <span style={{ color: 'var(--err)' }}> ⚠</span> : null}
              </div>

              {/* 每个图集一行：总大小 · 已下载 · 速度 · 百分比 */}
              <div className="dl-meta">
                <span title="已下载 / 总大小">{fmtSize(t.received)} / {fmtSize(t.total)}</span>
                <span>{fmtSpeed(t.speed)}</span>
                <span className={failed ? 'err' : t.status === 'done' ? 'ok' : ''}>{pct}%</span>
              </div>

              <div className="dl-actions">
                {t.dest && <button className="btn sm" title={t.dest} onClick={() => api.dlOpenFolder(t.dest)}>📂 文件夹</button>}
                {t.status === 'done' && t.dest && <button className="btn sm" onClick={() => api.dlOpenFile(t.dest)}>打开文件</button>}
                {t.status !== 'done' && <button className="btn sm" onClick={() => api.dlRemove(t.id)}>取消</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
