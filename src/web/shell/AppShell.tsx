import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { deviceSession } from '../device-session';
import type { PairedHost } from '../sync-store';
import { Icon } from '../Icon';
import { modules, workspaceTools } from './modules';
import { parentRoute, readRoute, routeURL, type AppRoute } from './routes';
import { useAppViewport } from './viewport';
const CodexWorkspace = lazy(workspaceTools[0].load);
const MePages = lazy(() => import('./MePages'));

export function PageHeader({
  title,
  back,
  children,
}: {
  title: string;
  back?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      {back && (
        <button className="icon-button" aria-label="返回" onClick={back}>
          <Icon name="back" />
        </button>
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}
export function AppShell() {
  useAppViewport();
  const [route, setRoute] = useState(() => readRoute(new URL(location.href)));
  const workbenchRoute = useRef<AppRoute>(route.page === 'workbench' ? route : { page: 'workbench' });
  const [ready, setReady] = useState(false);
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  const [hostId, setHostId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [workspaceVisited, setWorkspaceVisited] = useState(
    route.page === 'workbench' || route.page === 'pair',
  );
  const navigate = useCallback((next: AppRoute, replace = false) => {
    if (next.page === 'workbench' && next.thread && !next.host)
      next = { ...next, host: deviceSession.host?.hostId };
    if (next.page === 'workbench') workbenchRoute.current = next;
    if (routeURL(next) !== location.pathname + location.search) {
      history[replace ? 'replaceState' : 'pushState']({ pocket: true }, '', routeURL(next));
    }
    setRoute(next);
    if (next.page === 'workbench' || next.page === 'pair') setWorkspaceVisited(true);
  }, []);
  useEffect(() => {
    const pop = () => {
      const next = readRoute(new URL(location.href));
      if (next.page === 'workbench') workbenchRoute.current = next;
      setRoute(next);
      if (next.page === 'workbench' || next.page === 'pair') setWorkspaceVisited(true);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const refreshHosts = useCallback(async () => {
    setHosts(await deviceSession.cache.hosts());
    setHostId(deviceSession.host?.hostId ?? '');
  }, []);
  useEffect(() => {
    void deviceSession
      .init()
      .then(refreshHosts)
      .catch(() => setError('无法读取本机配对，请检查浏览器存储权限'))
      .finally(() => setReady(true));
    return deviceSession.onChange(() => void refreshHosts().catch(() => {}));
  }, [refreshHosts]);
  useEffect(() => {
    if (ready && route.page !== 'pair') void deviceSession.init().catch(() => {});
  }, [route.page, ready]);
  const activeWorkspace = route.page === 'workbench' || route.page === 'pair';
  const root = ['messages', 'workbench', 'me'].includes(route.page) && !route.thread;
  const showNavigation = route.page !== 'pair';
  const activeModule = route.page === 'messages' || route.page === 'workbench' ? route.page : 'me';
  const back = () => navigate(parentRoute(route));
  return (
    <div
      className={`app-shell ${root ? 'shell-root' : 'shell-detail'} ${showNavigation ? 'has-navigation' : ''}`}
    >
      <div className="shell-content">
        {ready && workspaceVisited && (
          <section className="workspace-module" hidden={!activeWorkspace} aria-label="工作台模块">
            <Suspense
              fallback={
                <div className="page-loading" role="status">
                  正在打开工作台…
                </div>
              }
            >
              <CodexWorkspace key={hostId || 'unpaired'} route={route} navigate={navigate} onBusy={setBusy} />
            </Suspense>
          </section>
        )}
        {activeWorkspace && !ready && (
          <div className="page-loading" role="status">
            正在打开…
          </div>
        )}
        {route.page === 'pair' && (
          <button className="pair-back icon-button" aria-label="返回" onClick={back}>
            <Icon name="back" />
          </button>
        )}
        {route.page === 'messages' && (
          <main className="module-page messages-page">
            <PageHeader title="消息">
              <button
                className="icon-button"
                aria-label="Agent 联系人"
                onClick={() => navigate({ page: 'integrations' })}
              >
                <Icon name="user" />
              </button>
            </PageHeader>
            <section className="module-empty">
              <span className="empty-symbol">
                <Icon name="chat" size={38} />
              </span>
              <h2>和 Agent 保持联系</h2>
              <p>接入即时聊天后，消息会出现在这里。</p>
              <button className="secondary" onClick={() => navigate({ page: 'integrations' })}>
                查看 Agent 接入
              </button>
            </section>
          </main>
        )}
        {!activeWorkspace && route.page !== 'messages' && (
          <Suspense fallback={<div className="page-loading">正在打开…</div>}>
            <PageBoundary key={route.page} onBack={() => navigate({ page: 'workbench' })}>
              <MePages
                route={route}
                navigate={navigate}
                back={back}
                hosts={hosts}
                hostId={hostId}
                busy={busy}
                refreshHosts={refreshHosts}
              />
            </PageBoundary>
          </Suspense>
        )}
        {error && (
          <p className="shell-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {showNavigation && (
        <nav className="bottom-navigation" aria-label="主要功能">
          {modules.map((module) => (
            <button
              key={module.id}
              aria-current={activeModule === module.id ? 'page' : undefined}
              onClick={() =>
                navigate(module.id === 'workbench' ? workbenchRoute.current : { page: module.id })
              }
            >
              <Icon name={module.icon} size={24} />
              <span>{module.title}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

class PageBoundary extends Component<{ children: ReactNode; onBack: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <section className="module-empty">
        <h2>暂时无法打开此页面</h2>
        <p>请检查网络后重试。</p>
        <button className="secondary" onClick={this.props.onBack}>
          返回工作台
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}
