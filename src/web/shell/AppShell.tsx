import { useMessaging } from '../messaging/context';
import { BackendChooser } from '../BackendChooser';
import { DEFAULT_BACKEND } from '../../shared/backends';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { deviceSession } from '../device-session';
import type { PairedHost } from '../sync-store';
import { Icon } from '../Icon';
import { modules, workspaceTools } from './modules';
import { parentRoute, readRoute, routeURL, type AppRoute } from './routes';
import { useAppViewport } from './viewport';
const AgentWorkspace = lazy(workspaceTools[0].load);
const MessagingPages = lazy(() => import('../messaging/MessagingPages'));
import MePages from './MePages';
import { PageBoundary, PageLoading } from './PageBoundary';
import { AccountSecurity } from '../messaging/AccountSecurity';
import { onAccountSessionChange, syncAccountHosts, accountSyncError } from '../account-session';
import { messaging } from '../messaging/context';
import { Avatar } from '../messaging/ui';

export { PageHeader } from './PageHeader';

export function AppShell() {
  useAppViewport();
  useEffect(() => {
    window.dispatchEvent(new Event('pocket:app-ready'));
  }, []);
  const { conversations, loading: accountLoading, user } = useMessaging();
  const unread = conversations.reduce((sum, conversation) => sum + conversation.unread, 0);
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
    if (accountLoading) return;
    onAccountSessionChange(() => void refreshHosts());
    void deviceSession
      .init()
      .then(refreshHosts)
      .catch(() => setError('无法读取本机配对，请检查浏览器存储权限'))
      .finally(() => setReady(true));
    return deviceSession.onChange(() => void refreshHosts().catch(() => {}));
  }, [refreshHosts, accountLoading, user?.id]);
  useEffect(() => {
    if (!user?.encrypted) return;
    const sync = () => {
      if (document.visibilityState !== 'hidden')
        void syncAccountHosts(messaging.account)
          .then(refreshHosts)
          .catch(() => {});
    };
    const timer = setInterval(sync, 30000);
    window.addEventListener('focus', sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', sync);
    };
  }, [user?.id, user?.encrypted, refreshHosts]);
  useEffect(() => {
    if (ready && route.page !== 'pair') void deviceSession.init().catch(() => {});
  }, [route.page, ready]);
  const chooser = route.page === 'workbench' && !route.backend && !route.thread && !!deviceSession.host;
  const workspaceRoute = route.page === 'workbench' || route.page === 'pair' ? route : workbenchRoute.current;
  const backendId = workspaceRoute.backend ?? DEFAULT_BACKEND;
  const [selectedBackend, setSelectedBackend] = useState(deviceSession.backendId);
  useEffect(() => {
    deviceSession.selectBackend(backendId);
    setSelectedBackend(backendId);
  }, [backendId]);
  const activeWorkspace = route.page === 'workbench' || route.page === 'pair';
  const root =
    ['messages', 'contacts', 'workbench', 'me'].includes(route.page) && !route.thread && !route.conversation;
  const messagingPage = ['messages', 'contacts', 'profile', 'integrations'].includes(route.page);
  const showNavigation = route.page !== 'pair';
  const activeModule =
    route.page === 'messages' || route.page === 'contacts' || route.page === 'workbench'
      ? route.page
      : route.page === 'integrations'
        ? 'contacts'
        : 'me';
  const back = () => navigate(parentRoute(route));
  return (
    <AccountSecurity>
      <div
        className={`app-shell ${root ? 'shell-root' : 'shell-detail'} ${showNavigation ? 'has-navigation' : ''}`}
      >
        <div className="shell-content">
          {chooser && <BackendChooser key={hostId} navigate={navigate} />}
          {ready && workspaceVisited && !chooser && selectedBackend === backendId && (
            <section className="workspace-module" hidden={!activeWorkspace} aria-label="工作台模块">
              <Suspense fallback={<PageLoading label="正在打开工作台…" />}>
                <PageBoundary
                  page="workbench"
                  backLabel="返回消息"
                  onBack={() => navigate({ page: 'messages' })}
                >
                  <AgentWorkspace
                    key={`${hostId || 'unpaired'}:${backendId}`}
                    active={activeWorkspace}
                    route={workspaceRoute}
                    navigate={navigate}
                    onBusy={setBusy}
                  />
                </PageBoundary>
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
          {messagingPage && (
            <Suspense fallback={<PageLoading />}>
              <PageBoundary
                key={route.page}
                page={route.page}
                backLabel="返回工作台"
                onBack={() => navigate({ page: 'workbench' })}
              >
                <MessagingPages route={route} navigate={navigate} />
              </PageBoundary>
            </Suspense>
          )}
          {!activeWorkspace && !messagingPage && (
            <Suspense fallback={<PageLoading />}>
              <PageBoundary
                key={route.page}
                page={route.page}
                backLabel="返回工作台"
                onBack={() => navigate({ page: 'workbench' })}
              >
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
          {error && (activeWorkspace || route.page === 'devices') && (
            <p className="shell-error" role="alert">
              {error}
            </p>
          )}
          {accountSyncError && (
            <p className="shell-error" role="status">
              {accountSyncError}
            </p>
          )}
        </div>
        {showNavigation && (
          <nav className="bottom-navigation" aria-label="主要功能">
            <button
              className="shell-account"
              aria-label={user ? `我的账号：${user.displayName}` : '登录账号'}
              title={user?.displayName ?? '登录账号'}
              onClick={() => navigate({ page: 'me' })}
            >
              {user ? <Avatar user={user} /> : <Icon name="user" />}
            </button>
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
                {module.id === 'messages' && unread > 0 && (
                  <b className="navigation-unread" aria-hidden="true">
                    {unread > 99 ? '99+' : unread}
                  </b>
                )}
              </button>
            ))}
          </nav>
        )}
      </div>
    </AccountSecurity>
  );
}
