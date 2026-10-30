export type Settings = any;
export type GalleryItem = {
  gid: string; token: string; title: string; titleJpn?: string; category?: string;
  thumb?: string; pages?: any; rating?: any; tags?: string[]; posted?: any; filesize?: any; torrentcount?: any;
};

const w: any = window;
export const api = w.api;

export function fmtSize(bytes: number): string {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

export function fmtTime(ts: any): string {
  if (!ts) return '';
  const n = parseInt(String(ts), 10);
  if (!n) return String(ts);
  const d = new Date(n * 1000);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

export function fmtSpeed(bps: number): string {
  if (!bps) return '';
  return fmtSize(bps) + '/s';
}
