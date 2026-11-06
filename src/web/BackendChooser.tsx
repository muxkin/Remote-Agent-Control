import { useEffect, useState } from 'react';
import { deviceSession } from './device-session';
import type { BackendInfo } from '../shared/backends';
import type { AppRoute } from './shell/routes';
export function BackendChooser({ navigate }: { navigate: (route: AppRoute) => void }) {
  const [backends, setBackends] = useState<BackendInfo[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void deviceSession
        .api<{ backends: BackendInfo[] }>('/backends', undefined, 'codex-local')
        .then((r) => {
          if (active) {
            setBackends(r.backends);
            setError('');
          }
        })
        .catch(() => {
          if (active) setError('主机尚未连接。已配对的 Codex 仍可查看缓存。');
        });
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const entries = backends.length
    ? backends
    : [{ id: 'codex-local', product: 'codex', name: 'Codex', connected: false } as BackendInfo];
  return (
    <main className="module-page backend-page">
      <header className="page-header">
        <h1>工作台</h1>
      </header>
      <p className="muted">选择主机上的 Agent 实例</p>
      <div className="backend-cards">
        {entries.map((backend) => (
          <button
            key={backend.id}
            className="backend-card"
            onClick={() => navigate({ page: 'workbench', backend: backend.id })}
          >
            <strong>{backend.name}</strong>
            <span>{backend.presentation?.description ?? backend.product}</span>
            <small>{backend.connected ? '已连接' : '未连接'}</small>
            {backend.capabilities?.send.reason && backend.capabilities.send.state === 'unavailable' && (
              <small>{backend.capabilities.send.reason}</small>
            )}
          </button>
        ))}
      </div>
      <p className="hint">可在主机端安装接入插件并配置更多实例。</p>
      {error && <p role="status">{error}</p>}
    </main>
  );
}
