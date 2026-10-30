import React, { useEffect, useState } from 'react';
import { api, fmtSize } from '../api';

export default function SettingsPage({ settings, save, auth, setAuth, toast }: any) {
  const [s, setS] = useState<any>(settings);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMsg, setLoginMsg] = useState('');
  const [cookieText, setCookieText] = useState('');
  const [cache, setCache] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  useEffect(() => { setS(settings); }, [settings]);
  useEffect(() => { api.cacheStats().then(setCache); }, []);

  const upd = (patch: any) => setS((x: any) => ({ ...x, ...patch }));
  const saveAll = async () => {
    await save(s);
    toast('设置已保存');
    const c = await api.cacheStats();
    setCache(c);
  };

  // 检测前必须先保存：HostResolver 的 DoH 配置只在 settings:save 之后才会重新应用
  const runDiagnose = async () => {
    setDiagBusy(true); setDiag(null);
    try {
      await save(s);
      const r = await api.netDiagnose();
      setDiag(r);
    } catch (e: any) {
      setDiag({ ok: false, error: e.message, results: [] });
    }
    setDiagBusy(false);
  };

  const startLogin = async () => {
    setLoginBusy(true); setLoginMsg('正在启动 Chrome…');
    const r = await api.login({ site: s.site });
    setLoginBusy(false);
    setLoginMsg(r.ok ? '已打开 Chrome 登录窗口。请完成登录（含 Cloudflare 验证），然后点「检测登录状态」。' : ('启动失败：' + r.error));
  };

  const checkLogin = async () => {
    setLoginBusy(true); setLoginMsg('正在检测…');
    // 先关闭我们启动的 Chrome，释放 cookie 数据库
    await api.closeLoginChrome();
    await new Promise((r) => setTimeout(r, 1500));
    const r = await api.pollLogin();
    setLoginBusy(false);
    if (r.ok) {
      setLoginMsg('登录成功：' + (r.username || r.memberId || ''));
      setAuth({ loggedIn: true, username: r.username || '' });
      toast('登录成功');
    } else {
      const map: any = {
        'not-logged-in': '还没有检测到登录态。请确认已在 Chrome 中完成登录，然后重新检测。',
        'cookie-db-missing': '未找到 Chrome 的 cookie 数据库。',
        'no-master-key': '无法读取 Chrome 的加密密钥（可能 Chrome 正在运行，请关闭 Chrome 后重试）。',
        'db-open-failed': '无法打开 cookie 数据库（请关闭 Chrome 后重试）。'
      };
      setLoginMsg('未成功：' + (map[r.error] || r.error) + (r.v20 ? '（检测到 v20 加密 cookie，需在软件打开的 Chrome 中重新登录一次）' : ''));
    }
  };

  const importCookies = async () => {
    const txt = cookieText.trim();
    if (!txt) { toast('请粘贴 cookie'); return; }
    let payload: any = { cookieString: txt };
    if (txt.startsWith('[') || txt.startsWith('{')) {
      try {
        const j = JSON.parse(txt);
        const arr = Array.isArray(j) ? j : (j.cookies || []);
        payload = { cookies: arr.map((c: any) => ({ name: c.name, value: c.value })) };
      } catch (e) { toast('JSON 解析失败'); return; }
    }
    const r = await api.importCookies(payload);
    if (r.ok) { toast('导入成功，共 ' + r.count + ' 项'); setAuth({ loggedIn: true, username: r.who?.username || '' }); }
    else toast('导入失败：' + r.error);
  };

  const doLogout = async () => {
    await api.logout();
    setAuth({ loggedIn: false, username: '' });
    toast('已退出登录');
  };

  if (!s) return null;

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <div className="page-title">设置</div>

      <div className="section">
        <h3>账号</h3>
        <div className="okbox" style={{ marginBottom: 12 }}>
          当前状态：{auth.loggedIn ? ('已登录 ' + (auth.username || '')) : '未登录'}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={startLogin} disabled={loginBusy}>打开 Chrome 登录</button>
          <button className="btn" onClick={checkLogin} disabled={loginBusy}>检测登录状态</button>
          {auth.loggedIn && <button className="btn" onClick={doLogout}>退出登录</button>}
        </div>
        {loginMsg && <div className="hint" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{loginMsg}</div>}
        <div className="hint" style={{ marginTop: 12 }}>
          登录流程：点「打开 Chrome 登录」→ 在弹出的 Chrome 窗口里登录 E-Hentai（Cloudflare 会自动验证）→
          登录后如需 ExHentai，请在同一个窗口打开 https://exhentai.org 完成一次验证 → 回到这里点「检测登录状态」。
        </div>
        <details style={{ marginTop: 12 }}>
          <summary className="hint" style={{ cursor: 'pointer' }}>手动导入 Cookie（备用）</summary>
          <div className="field" style={{ marginTop: 10 }}>
            <label>粘贴 Cookie 字符串（如 ipb_member_id=...; ipb_pass_hash=...）或 Cookie-Editor 导出的 JSON</label>
            <textarea rows={4} value={cookieText} onChange={(e) => setCookieText(e.target.value)} placeholder="ipb_member_id=123456; ipb_pass_hash=abcdef..." />
          </div>
          <button className="btn" onClick={importCookies}>导入</button>
        </details>
      </div>

      <div className="section">
        <h3>网络</h3>
        <div className="field">
          <label>连接方式</label>
          <div className="row" style={{ gap: 18, marginTop: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="netmode" checked={s.netMode !== 'direct'} onChange={() => upd({ netMode: 'proxy' })} /> 代理
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="netmode" checked={s.netMode === 'direct'} onChange={() => upd({ netMode: 'direct' })} /> 直连（HTTP/3，无需代理）
            </label>
          </div>
        </div>

        {s.netMode !== 'direct' ? (
          <>
            <div className="field">
              <label><input type="checkbox" checked={!!s.proxy?.enabled} onChange={(e) => upd({ proxy: { ...s.proxy, enabled: e.target.checked } })} /> 启用代理</label>
            </div>
            <div className="field">
              <label>代理地址（支持 http:// 与 socks5://）</label>
              <input type="text" value={s.proxy?.url || ''} onChange={(e) => upd({ proxy: { ...s.proxy, url: e.target.value } })} placeholder="http://127.0.0.1:10809 或 socks5://127.0.0.1:10808" />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>安全 DNS（DoH）服务器</label>
              <input type="text" value={(s.secureDns?.servers || [])[0] || ''} onChange={(e) => upd({ secureDns: { ...s.secureDns, servers: [e.target.value] } })} placeholder="https://doh.cleanbrowsing.org/doh/security-filter/" />
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              直连原理：GFW 只掐 TCP 443 的 SNI，UDP 443 的 QUIC 没掐。开启后走 DoH 拿真实解析 + HTTPS 记录里的 alpn=h3，Chromium 才会切到 HTTP/3。
              必须用<b>境外</b> DoH —— 国内阿里/腾讯 DoH 的上游同样被污染，填了等于没填。
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={runDiagnose} disabled={diagBusy}>{diagBusy ? '检测中…' : '检测直连'}</button>
            </div>
            {diag && (
              <div className="hint" style={{ marginTop: 10, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                {diag.results && diag.results.length
                  ? diag.results.map((r: any) => r.url + ' → ' + (r.ok ? 'OK ' + r.status : 'FAIL ' + (r.error || '')) + '  ' + r.ms + 'ms' + (r.bytes ? ' / ' + fmtSize(r.bytes) : '')).join('\n')
                  : (diag.hint || diag.error || '无结果')}
              </div>
            )}
          </>
        )}
        <div className="field">
          <label>站点</label>
          <select value={s.site} onChange={(e) => upd({ site: e.target.value })}>
            <option value="exhentai">ExHentai（需要登录）</option>
            <option value="e-hentai">E-Hentai</option>
          </select>
        </div>
        <div className="field">
          <label>User-Agent</label>
          <input type="text" value={s.userAgent} onChange={(e) => upd({ userAgent: e.target.value })} />
        </div>
      </div>

      <div className="section">
        <h3>目录</h3>
        <div className="field">
          <label>下载目录</label>
          <div className="row">
            <input type="text" value={s.downloadDir || ''} onChange={(e) => upd({ downloadDir: e.target.value })} style={{ flex: 1 }} />
            <button className="btn" onClick={async () => { const p = await api.pickDir('downloadDir'); if (p) upd({ downloadDir: p }); }}>选择…</button>
            <button className="btn" onClick={() => api.openPath(s.downloadDir)}>打开</button>
          </div>
        </div>
        <div className="field">
          <label>图片缓存目录</label>
          <div className="row">
            <input type="text" value={s.imageCacheDir || ''} onChange={(e) => upd({ imageCacheDir: e.target.value })} style={{ flex: 1 }} />
            <button className="btn" onClick={async () => { const p = await api.pickDir('imageCacheDir'); if (p) upd({ imageCacheDir: p }); }}>选择…</button>
            <button className="btn" onClick={() => api.openPath(s.imageCacheDir)}>打开</button>
          </div>
        </div>
      </div>

      <div className="section">
        <h3>图片缓存</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <label><input type="checkbox" checked={!!s.cacheEnabled} onChange={(e) => upd({ cacheEnabled: e.target.checked })} /> 启用本地缓存（看过的图下次直接读本地）</label>
        </div>
        <div className="hint">
          当前缓存：{cache ? (cache.count + ' 个文件 / ' + fmtSize(cache.bytes)) : '统计中…'}
          <br />目录：{cache?.dir}
          {cache && cache.localCount !== undefined && (
            <><br />画册分组：本地库 <b>{cache.localCount}</b> 本（不参与淘汰）· 历史 <b>{cache.historyCount}</b> 本 · 未标记 <b>{cache.untagged}</b> 本</>
          )}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={async () => { setCache(await api.cacheClear()); toast('缓存已清空'); }}>清空缓存</button>
          <button className="btn" onClick={async () => setCache(await api.cacheStats())}>刷新统计</button>
        </div>
      </div>

      <div className="section">
        <h3>浏览历史</h3>
        <div className="row">
          <label className="hint">最多保留</label>
          <input type="number" min={10} max={5000} step={10} value={s.historyLimit ?? 200}
            onChange={(e) => upd({ historyLimit: parseInt(e.target.value, 10) || 200 })}
            style={{ width: 100, background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px' }} />
          <span className="hint">条</span>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          这个数字同时也是<b>图片缓存的最大画册数</b>：超出后自动删除最久未访问那本的缓存目录以释放空间。
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={async () => { const l = await api.historyList(0); alert('当前历史 ' + (l || []).length + ' 条'); }}>查看历史条数</button>
        </div>
      </div>

      <div className="section">
        <h3>阅读器</h3>
        <div className="row">
          <label className="hint">默认缩放</label>
          <select value={s.reader?.mode || 'height'} onChange={(e) => upd({ reader: { ...s.reader, mode: e.target.value } })}
            style={{ background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px' }}>
            <option value="height">适应高度</option>
            <option value="width">适应宽度</option>
            <option value="orig">原始大小</option>
          </select>
          <label className="hint">预加载页数</label>
          <input type="number" min={1} max={10} value={s.reader?.preload ?? 3}
            onChange={(e) => upd({ reader: { ...s.reader, preload: parseInt(e.target.value, 10) || 3 } })}
            style={{ width: 70, background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px' }} />
        </div>
      </div>

      <div className="row">
        <button className="btn primary" onClick={saveAll}>保存设置</button>
      </div>

      <div className="hint" style={{ marginTop: 18 }}>
        EhView · 本地浏览工具。所有数据仅保存在本机。
      </div>
    </div>
  );
}
