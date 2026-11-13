import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';

/**
 * 图集封面悬停预览
 * - 鼠标停在封面上 500ms 后弹出，位置跟随鼠标但不遮挡指针
 * - 尺寸按图片原始比例，最大不超过窗口的 72% × 78%
 * - 滚轮在预览框内翻页（阻止列表滚动）
 * - 先出缩略图（秒开），后台补大图
 */
export default function HoverPreview({ gid, token, anchor, onEnter, onLeave }: any) {
  const [thumbs, setThumbs] = useState<any[]>([]);
  const [pages, setPages] = useState<any[]>([]);
  const [idx, setIdx] = useState(0);
  const [bigUrl, setBigUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const srcRef = useRef('');
  const [box, setBox] = useState({ w: 260, h: 320 });
  const panelRef = useRef<HTMLDivElement>(null);

  // ① 先拉缩略图（快），用于立即出图
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.thumbs(gid, token, 0);
        if (alive && r.ok && r.data && r.data.thumbs) setThumbs(r.data.thumbs);
      } catch (e) {}
    })();
    return () => { alive = false; };
  }, [gid, token]);

  // ② 后台拉页面列表，用于取大图
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.pages(gid, token);
        if (alive && r.ok && r.data && r.data.pages) setPages(r.data.pages);
      } catch (e) {}
    })();
    return () => { alive = false; };
  }, [gid, token]);

  // 下载进度：匹配当前图片的原始 URL（ehimg:// 是包装后的，进度事件里是原始 src）
  useEffect(() => {
    const fn = (api as any).onImgProgress;
    if (typeof fn !== 'function') return;
    const off = fn((d: any) => {
      if (d && d.url && d.url === srcRef.current && d.total) {
        setProgress(Math.min(99, Math.round((d.received / d.total) * 100)));
      }
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // ③ 当前页的大图（双缓冲：先把图下载并解码，onload 后才替换，避免翻页瞬间黑屏）
  const reqRef = useRef(0);
  const loadBig = useCallback(async (n: number) => {
    if (!pages.length) return;
    const p = pages[n];
    if (!p) return;
    const seq = ++reqRef.current;
    setLoading(true);
    setProgress(0);
    try {
      const r = await api.image(p.pageToken, gid, p.index || n + 1);
      if (seq !== reqRef.current) return;
      if (r.ok && r.data) {
        const d = r.data;
        srcRef.current = d.src || '';
        const url = d.local ? api.imgKey(d.key, d.ext, gid) : api.img(d.src, gid);
        const im = new Image();
        const apply = () => {
          if (seq === reqRef.current) { setBigUrl(url); setLoading(false); }
        };
        im.onload = apply;
        im.onerror = apply;
        im.src = url;
      } else {
        if (seq === reqRef.current) setLoading(false);
      }
    } catch (e) {
      if (seq === reqRef.current) setLoading(false);
    }
  }, [pages, gid]);

  useEffect(() => { loadBig(idx); }, [idx, loadBig]);

  // ④ 预载：当前页之后的 10 张（4 个 worker 并行，避免一次性占满连接触发站点限速）
  useEffect(() => {
    if (!pages.length) return;
    let alive = true;
    const targets: number[] = [];
    for (let k = 1; k <= 10; k++) {
      const n = idx + k;
      if (n < pages.length) targets.push(n);
    }
    let cursor = 0;
    const worker = async () => {
      while (alive) {
        const i = cursor++;
        if (i >= targets.length) return;
        const p = pages[targets[i]];
        if (!p) continue;
        try {
          const r = await api.image(p.pageToken, gid, p.index || targets[i] + 1);
          if (!alive || !r.ok || !r.data) continue;
          const d = r.data;
          const url = d.local ? api.imgKey(d.key, d.ext, gid) : api.img(d.src, gid);
          const im = new Image();
          im.src = url;
        } catch (e) {}
      }
    };
    Promise.all([worker(), worker(), worker(), worker()]).catch(() => {});
    return () => { alive = false; };
  }, [idx, pages, gid]);

  // ④ 滚轮翻页（挂 window 捕获阶段）
  // 不能挂 panelRef：面板是 Portal 到 body、位于鼠标右侧，真实滚轮发生在卡片上，
  // 事件目标是卡片而不是面板，挂面板收不到。捕获阶段拦截才能同时翻页并阻止列表滚动。
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;   // Ctrl+滚轮交给界面缩放，不在预览里翻页
      const total = pages.length || thumbs.length;
      if (total <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      setIdx((v) => {
        const next = v + (e.deltaY > 0 ? 1 : -1);
        return Math.max(0, Math.min(total - 1, next));
      });
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true } as any);
  }, [pages.length, thumbs.length]);

  // ⑤ 定位：左右侧在弹出时决定一次，之后翻页不再重新判断
  // （不同页宽高比不同，按当前 box.w 重算会导致面板在左右之间来回横跳）
  const vw = window.innerWidth, vh = window.innerHeight;
  const GAP = 8;
  // 注意：变量不能叫 left/top —— 会和 window.top 这类全局属性撞名，压缩后取到 Window 对象
  const sideRef = useRef<'right' | 'left' | null>(null);
  if (!sideRef.current) {
    // 用最大可能宽度判断，避免初始 box 只有 260 时误判右侧放得下、大图加载后溢出屏幕
    const maxW = Math.min(vw * 0.72, 1200);
    sideRef.current = (anchor.x + GAP + maxW > vw - 12) ? 'left' : 'right';
  }
  let panelLeft = sideRef.current === 'right'
    ? anchor.x + GAP
    : anchor.x - GAP - box.w;
  // 无论哪种情况都夹回视口内，防止宽图把面板推出屏幕
  panelLeft = Math.max(12, Math.min(vw - box.w - 12, panelLeft));
  let panelTop = anchor.y - box.h / 2;
  const maxTop = Math.max(12, vh - box.h - 12);
  panelTop = Math.max(12, Math.min(maxTop, panelTop));
  if (panelTop + box.h > vh - 12) panelTop = Math.max(12, vh - box.h - 12);

  const curThumb = thumbs[idx];
  const pageNo = (pages[idx] && (pages[idx].index || idx + 1)) || (curThumb && curThumb.index) || idx + 1;
  const total = pages.length || thumbs.length;

  // 必须挂到 body：卡片 hover 时有 transform，会让 position:fixed 相对卡片定位
  return createPortal(
    <div
      ref={panelRef}
      className="hover-preview"
      data-anchor={anchor.x + ',' + anchor.y}
      data-box={box.w + 'x' + box.h}
      data-vp={vw + 'x' + vh}
      style={{ width: Math.min(box.w, vw - 24), height: Math.min(box.h, vh - 24), left: panelLeft, top: panelTop }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="hp-stage">
        {loading && (
          <div className="hp-loading">
            <span className="hp-spinner" />
            <span>载入中{progress > 0 ? ' ' + progress + '%' : '…'}</span>
          </div>
        )}
        {bigUrl ? (
          <img src={bigUrl} alt="" onLoad={(e: any) => {
            const w = e.target.naturalWidth, h = e.target.naturalHeight;
            if (!w || !h) return;
            const maxW = Math.min(window.innerWidth * 0.72, w);
            const maxH = Math.min(window.innerHeight * 0.78, h);
            const s = Math.min(maxW / w, maxH / h, 1);
            setBox({ w: Math.round(w * s), h: Math.round(h * s) });
          }} />
        ) : curThumb ? (
          <div
            className="hp-thumb"
            style={{
              width: curThumb.w || 200,
              height: curThumb.h || 283,
              backgroundImage: curThumb.thumb ? 'url(' + api.img(curThumb.thumb, gid) + ')' : 'none',
              backgroundPosition: (curThumb.bgX || 0) + 'px ' + (curThumb.bgY || 0) + 'px',
              transform: 'scale(' + (box.w / (curThumb.w || 200)) + ')',
              transformOrigin: 'center',
            }}
          />
        ) : <div className="hp-empty">载入中…</div>}
      </div>
      <div className="hp-bar">
        <span>{pageNo}{total ? ' / ' + total : ''}</span>
        <span className="hp-hint">滚轮翻页</span>
      </div>
    </div>,
    document.body
  );
}
