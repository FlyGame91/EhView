/**
 * 跨页面共享的「下载中 / 已收藏」状态
 * 图集卡片用 useSyncExternalStore 订阅，保证三个更新时机都能反映到按钮上：
 *   1) 列表加载时由 App 统一种子初始化
 *   2) 本卡片点击下载 / 收藏后立即写入
 *   3) 下载列表被清空、本地库取消收藏时由事件回流
 */
type Listener = () => void;

function makeSet() {
  let set = new Set<string>();
  const subs = new Set<Listener>();
  return {
    has: (gid: any) => set.has(String(gid)),
    size: () => set.size,
    set(list: any[], key: string) {
      const next = new Set<string>();
      for (const x of list || []) {
        const g = x && x[key];
        if (g !== undefined && g !== null) next.add(String(g));
      }
      let changed = next.size !== set.size;
      if (!changed) for (const g of next) if (!set.has(g)) { changed = true; break; }
      if (changed) { set = next; subs.forEach((f) => f()); }
    },
    add(gid: any) {
      const g = String(gid);
      if (!set.has(g)) { set = new Set(set); set.add(g); subs.forEach((f) => f()); }
    },
    remove(gid: any) {
      const g = String(gid);
      if (set.has(g)) { set = new Set(set); set.delete(g); subs.forEach((f) => f()); }
    },
    clear() { if (set.size) { set = new Set(); subs.forEach((f) => f()); } },
    subscribe(fn: Listener) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

export const downloadGids = makeSet();
export const libraryGids = makeSet();

/** 下载任务列表 → 同步「下载中」集合（清空列表时自然全部移除） */
export function syncDownloads(list: any[]) {
  downloadGids.set(list, 'gid');
}
/** 本地库列表 → 同步「已收藏」集合 */
export function syncLibrary(list: any[]) {
  libraryGids.set(list, 'gid');
}
