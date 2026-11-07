import { Icon } from './Icon';
import { PageHeader } from './shell/PageHeader';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { deviceSession } from './device-session';
import type { BackendInfo } from '../shared/backends';
import type { AppRoute } from './shell/routes';
import { backendAppearanceDefaults } from '../shared/backend-appearance';
import { BackendIcon } from './BackendIcon';
const BackendAppearanceEditor = lazy(() => import('./BackendAppearanceEditor'));
export function BackendChooser({ navigate }: { navigate: (route: AppRoute) => void }) {
  const [backends, setBackends] = useState<BackendInfo[]>([]),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(''),
    [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      const version = ++generation.current;
      void deviceSession
        .api<{ backends: BackendInfo[] }>('/backends', undefined, 'codex-local')
        .then((r) => {
          if (active && version === generation.current) {
            setBackends(r.backends);
            setError('');
          }
        })
        .catch(() => {
          if (active && version === generation.current)
            setError('主机尚未连接。已配对的 Codex 仍可查看缓存。');
        });
    };
    refresh();
    let online = deviceSession.online;
    const unsubscribe = deviceSession.onChange(() => {
      const connected = deviceSession.online;
      if (connected && !online) refresh();
      online = connected;
    });
    const timer = setInterval(refresh, 10000);
    return () => {
      active = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const entries = backends.length
    ? backends
    : [{ id: 'codex-local', product: 'codex', name: 'Codex', connected: false } as BackendInfo];
  return (
    <main className="module-page backend-page">
      <PageHeader title="工作台" />
      <p className="muted">选择主机上的 Agent 实例</p>
      <div className="backend-cards">
        {entries.map((backend) => (
          <article key={backend.id} className="backend-card">
            <button
              className="backend-open"
              onClick={() => navigate({ page: 'workbench', backend: backend.id })}
            >
              <BackendIcon icon={(backend.appearance ?? backendAppearanceDefaults(backend)).icon} />
              <span className="backend-copy">
                <strong>{backend.name}</strong>
                <small>{(backend.appearance ?? backendAppearanceDefaults(backend)).description}</small>
              </span>
              <span className={`backend-status ${backend.connected ? 'connected' : ''}`}>
                <i />
                {backend.connected ? '已连接' : '未连接'}
              </span>
              {backend.capabilities?.send.reason && backend.capabilities.send.state === 'unavailable' && (
                <small className="backend-reason">{backend.capabilities.send.reason}</small>
              )}
            </button>
            <button
              className="backend-edit icon-button"
              aria-label="编辑实例"
              title={`编辑 ${backend.name}`}
              disabled={!backends.length}
              onClick={() => {
                setNotice('');
                setEditing(backend.id);
              }}
            >
              <Icon name="sliders" size={18} />
            </button>
          </article>
        ))}
      </div>
      <p className="hint">可在主机端安装接入插件并配置更多实例。</p>
      {error && <p role="status">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {editing && (
        <Suspense fallback={<p role="status">正在打开设置…</p>}>
          <BackendAppearanceEditor
            key={editing}
            id={editing}
            onClose={() => setEditing('')}
            onSaved={(value) => {
              generation.current++;
              setBackends((current) =>
                current.map((b) =>
                  b.id === value.id ? { ...b, name: value.values.name, appearance: value.values } : b,
                ),
              );
              setNotice('已保存，已配对设备会自动同步');
            }}
          />
        </Suspense>
      )}
    </main>
  );
}
