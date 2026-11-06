import { useEffect, useState } from 'react';

const build = typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__ : '';
export function WebUpdateNotice({ hasDraft, busy }: { hasDraft: boolean; busy: boolean }) {
  const [latest, setLatest] = useState<string>();
  useEffect(() => {
    let stopped = false;
    let checking = false;
    const check = async () => {
      if (document.visibilityState !== 'visible' || checking) return;
      checking = true;
      try {
        const response = await fetch('/version.json', {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const data = await response.json();
          if (!stopped && /^[a-f0-9]{16}$/.test(data.buildId)) setLatest(data.buildId);
        }
      } catch {
        /* Version checks must not interrupt the chat on an unstable network. */
      } finally {
        checking = false;
      }
    };
    // Only the origin serving this page knows which web release is actually published.
    void check();
    const timer = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  if (!build || !latest || latest === build) return null;
  return (
    <aside className="web-update-notice" role="status" aria-label="网页更新提示">
      <div>
        <strong>页面已更新</strong>
        <p>
          {hasDraft
            ? '有未提交内容，请先提交或清空后刷新。'
            : busy
              ? '当前操作完成后即可刷新。'
              : '刷新后使用最新功能，配对状态会保留。'}
        </p>
      </div>
      <button className="primary" disabled={hasDraft || busy} onClick={() => location.reload()}>
        刷新页面
      </button>
    </aside>
  );
}
