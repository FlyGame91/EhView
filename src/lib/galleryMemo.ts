/**
 * 详情页结果缓存（模块级，跨页面组件存活）
 * 阅读器的左侧缩略图栏直接复用这里已加载的 thumbs，避免重复请求。
 */
export const galleryMemo = new Map<string, any>();
export const GALLERY_TTL = 5 * 60 * 1000;

export function memoKey(gid: any, token: any) { return String(gid) + '/' + String(token); }

export function getMemo(gid: any, token: any) {
  const m = galleryMemo.get(memoKey(gid, token));
  if (!m) return null;
  if (Date.now() - m.ts > GALLERY_TTL) return null;
  return m;
}

/** 拿到已缓存的缩略图（可能为空数组） */
export function getCachedThumbs(gid: any, token: any): any[] {
  const m = getMemo(gid, token);
  return (m && Array.isArray(m.thumbs)) ? m.thumbs : [];
}
