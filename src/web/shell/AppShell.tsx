import { tsxComponent } from '../tsx-component';
import { shallowRef, defineAsyncComponent as lazy, Suspense } from 'vue';
import { watchRender, writeRef } from '../render-effects';
import { useMessaging } from '../messaging/context';
import { BackendChooser } from '../BackendChooser';
import { DEFAULT_BACKEND } from '../../shared/backends';
import { deviceSession } from '../device-session';
import type { PairedHost } from '../sync-store';
import { Icon } from '../Icon';
import SelectionTranslation from '../SelectionTranslation.vue';
import { translationSettings } from '../selection-translation-settings';
import { modules, workspaceTools } from './modules';
import { backTo, parentRoute, readRoute, routeURL, type AppRoute } from './routes';
import { useAppViewport } from './viewport';
const AgentWorkspace = lazy(workspaceTools[0].load);
const MessagingPages = lazy(() => import('../messaging/MessagingPages'));
import MePages from './MePages';
import { PageBoundary, PageLoading } from './PageBoundary';
import { AccountSecurity } from '../messaging/AccountSecurity';
import { onAccountSessionChange, syncAccountHosts, accountSyncError } from '../account-session';
import { messaging } from '../messaging/context';
import { DesktopAuthorizationPage, readDesktopAuthorization } from './DesktopAuthorizationPage';
import { Avatar } from '../messaging/ui';

export { PageHeader } from './PageHeader';

const isWorkbenchHome = (route: AppRoute) =>
  route.page === 'workbench' && !route.backend && !route.thread && !route.host;

export const AppShell = tsxComponent(function AppShell() {
  useAppViewport();
  const routeState = shallowRef(readRoute(new URL(location.href)));
  const setRoute = writeRef(routeState);
  let desktopRequest =
    routeState.value.page === 'desktop-authorization' ? readDesktopAuthorization(location.hash) : undefined;
  if (routeState.value.page === 'desktop-authorization' && location.hash)
    history.replaceState(history.state, '', location.pathname + location.search);
  const workbenchRoute: { current: AppRoute } = {
    current: routeState.value.page === 'workbench' ? routeState.value : { page: 'workbench' },
  };
  const lastChat: { current: { account: string; id: string } | undefined } = { current: undefined };
  const readyState = shallowRef(false);
  const setReady = writeRef(readyState);
  const hostsState = shallowRef<PairedHost[]>([]);
  const setHosts = writeRef(hostsState);
  const hostIdState = shallowRef('');
  const setHostId = writeRef(hostIdState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const workspaceVisitedState = shallowRef(
    routeState.value.page === 'workbench' || routeState.value.page === 'pair',
  );
  const setWorkspaceVisited = writeRef(workspaceVisitedState);
  const navigate = (next: AppRoute, replace = false) => {
    if (next.page === 'workbench' && (next.backend || next.thread) && !next.host)
      next = { ...next, host: deviceSession.host?.hostId };
    if (next.page === 'workbench' && !isWorkbenchHome(next)) workbenchRoute.current = next;
    if (routeURL(next) !== location.pathname + location.search) {
      const current = readRoute(new URL(location.href));
      let previousRoute = replace ? history.state?.previousRoute : routeURL(current);
      if (
        !replace &&
        next.page !== current.page &&
        (next.conversation || next.thread) &&
        matchMedia('(max-width: 700px)').matches
      ) {
        const parent = routeURL(parentRoute(next));
        history.pushState({ pocket: true, previousRoute }, '', parent);
        previousRoute = parent;
      }
      history[replace ? 'replaceState' : 'pushState']({ pocket: true, previousRoute }, '', routeURL(next));
    }
    setRoute(next);
    if (next.page === 'workbench' || next.page === 'pair') setWorkspaceVisited(true);
  };
  let hostRefresh = 0;
  const refreshHosts = async () => {
    const refresh = ++hostRefresh;
    const scope = deviceSession.cache.scope;
    const hosts = await deviceSession.cache.hosts(scope);
    if (refresh !== hostRefresh || scope !== deviceSession.cache.scope) return;
    setHosts(hosts);
    setHostId(deviceSession.host?.hostId ?? '');
  };
  const selectedBackendState = shallowRef(deviceSession.backendId);
  const setSelectedBackend = writeRef(selectedBackendState);
  const afterRender = watchRender();
  const watchItem = watchRender();
  const watchRoute = watchRender();
  const watchError = watchRender();
  const watchInterval = watchRender();
  const watchRoute2 = watchRender();
  const watchSelectedBackend = watchRender();
  const watchWorkspaceHost = watchRender();
  return () => {
    afterRender(() => {
      window.dispatchEvent(new Event('pocket:app-ready'));
    }, []);
    const { conversations, loading: accountLoading, user } = useMessaging();
    const unread = conversations.reduce((sum, conversation) => sum + conversation.unread, 0);
    const route = routeState.value;

    const accountId = user?.id;
    const ready = readyState.value;
    const hosts = hostsState.value;
    const hostId = hostIdState.value;
    const busy = busyState.value;
    const error = errorState.value;
    const workspaceVisited = workspaceVisitedState.value;

    watchItem(() => {
      if (
        accountId &&
        route.page === 'messages' &&
        route.conversation &&
        conversations.some(({ id }) => id === route.conversation)
      ) {
        lastChat.current = { account: accountId, id: route.conversation };
        try {
          sessionStorage.setItem(`pocket-last-chat:${accountId}`, route.conversation);
        } catch {}
      }
    }, [accountId, route.page, route.conversation, conversations]);
    function resumeMessages(): AppRoute {
      let id = lastChat.current?.account === accountId ? lastChat.current?.id : undefined;
      if (accountId && !id) {
        try {
          id = sessionStorage.getItem(`pocket-last-chat:${accountId}`) ?? undefined;
        } catch {}
      }
      return id && conversations.some((chat) => chat.id === id)
        ? { page: 'messages', conversation: id }
        : { page: 'messages' };
    }
    watchRoute(() => {
      const pop = () => {
        const next = readRoute(new URL(location.href));
        if (next.page === 'workbench' && !isWorkbenchHome(next)) workbenchRoute.current = next;
        setRoute(next);
        if (next.page === 'workbench' || next.page === 'pair') setWorkspaceVisited(true);
      };
      window.addEventListener('popstate', pop);
      return () => window.removeEventListener('popstate', pop);
    }, []);

    watchError(() => {
      if (accountLoading) return;
      onAccountSessionChange(() => void refreshHosts());
      void deviceSession
        .init()
        .then(refreshHosts)
        .catch(() => setError('无法读取本机配对，请检查浏览器存储权限'))
        .finally(() => setReady(true));
      return deviceSession.onChange(() => void refreshHosts().catch(() => {}));
    }, [refreshHosts, accountLoading, user?.id]);
    watchInterval(() => {
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
    watchRoute2(() => {
      if (ready && route.page !== 'pair') void deviceSession.init().catch(() => {});
    }, [route.page, ready]);
    const chooser = isWorkbenchHome(route);
    const devices = route.page === 'devices';
    const workspaceRoute =
      (route.page === 'workbench' && !chooser) || route.page === 'pair' ? route : workbenchRoute.current;
    const backendId = workspaceRoute.backend ?? DEFAULT_BACKEND;
    const selectedBackend = selectedBackendState.value;
    watchSelectedBackend(() => {
      deviceSession.selectBackend(backendId);
      setSelectedBackend(backendId);
    }, [backendId]);
    const activeWorkspace = route.page === 'workbench' || route.page === 'pair';
    const showWorkspace = activeWorkspace && !chooser;
    const requestedHost = workspaceRoute.page === 'workbench' ? workspaceRoute.host : undefined;
    const matchingHost = !requestedHost || requestedHost === hostId;
    const knownHost = hosts.some((host) => host.hostId === requestedHost);
    watchWorkspaceHost(() => {
      if (
        !ready ||
        !showWorkspace ||
        route.page !== 'workbench' ||
        !requestedHost ||
        matchingHost ||
        !knownHost
      )
        return;
      const scope = deviceSession.cache.scope;
      let alive = true;
      void deviceSession.cache
        .hosts(scope)
        .then((pairedHosts) => {
          const host = pairedHosts.find((entry) => entry.hostId === requestedHost);
          if (alive && host && scope === deviceSession.cache.scope) return deviceSession.select(host, false);
        })
        .catch(() => setError('无法打开这台电脑，请重试'));
      return () => {
        alive = false;
      };
    }, [ready, showWorkspace, route.page, requestedHost, matchingHost, knownHost, accountId]);
    const root =
      ['messages', 'contacts', 'workbench', 'me'].includes(route.page) &&
      !route.thread &&
      !route.conversation;
    const messagingPage = ['messages', 'contacts', 'profile', 'integrations'].includes(route.page);
    const showNavigation = route.page !== 'pair';
    const activeModule =
      route.page === 'messages' || route.page === 'contacts' || route.page === 'workbench'
        ? route.page
        : route.page === 'integrations'
          ? 'contacts'
          : 'me';
    const back = () => backTo(parentRoute(route), navigate);
    if (route.page === 'desktop-authorization') {
      return (
        <AccountSecurity>
          {() => (
            <DesktopAuthorizationPage
              request={desktopRequest}
              finish={() => {
                desktopRequest = undefined;
                navigate({ page: 'workbench' }, true);
              }}
            />
          )}
        </AccountSecurity>
      );
    }
    return (
      <AccountSecurity>
        {() => (
          <>
            <div
              class={`app-shell ${root ? 'shell-root' : 'shell-detail'} ${showNavigation ? 'has-navigation' : ''}`}
            >
              <div class="shell-content">
                {ready && (chooser || devices) && (
                  <BackendChooser
                    key={accountId ?? 'local'}
                    hosts={hosts}
                    busy={busy}
                    navigate={navigate}
                    refreshHosts={refreshHosts}
                    manage={devices}
                    back={back}
                  />
                )}
                {ready && showWorkspace && !matchingHost && (
                  <section class="module-empty" role="status">
                    <p>{knownHost ? '正在打开电脑…' : '这台电脑已移除或尚未配对。'}</p>
                    <button class="secondary" onClick={() => navigate({ page: 'workbench' })}>
                      返回工作台
                    </button>
                  </section>
                )}
                {ready &&
                  workspaceVisited &&
                  !isWorkbenchHome(workspaceRoute) &&
                  matchingHost &&
                  selectedBackend === backendId && (
                    <section class="workspace-module" hidden={!showWorkspace} aria-label="工作台模块">
                      <Suspense timeout={0}>
                        {{
                          fallback: () => <PageLoading label="正在打开工作台…" />,
                          default: () => (
                            <>
                              <PageBoundary
                                page="workbench"
                                backLabel="返回消息"
                                onBack={() => navigate(resumeMessages())}
                              >
                                {() => (
                                  <>
                                    <AgentWorkspace
                                      key={`${hostId || 'unpaired'}:${backendId}`}
                                      active={showWorkspace}
                                      route={workspaceRoute}
                                      navigate={navigate}
                                      onBusy={setBusy}
                                    />
                                  </>
                                )}
                              </PageBoundary>
                            </>
                          ),
                        }}
                      </Suspense>
                    </section>
                  )}
                {activeWorkspace && !ready && (
                  <div class="page-loading" role="status">
                    正在打开…
                  </div>
                )}
                {route.page === 'pair' && (
                  <button class="pair-back icon-button" aria-label="返回" onClick={back}>
                    <Icon name="back" />
                  </button>
                )}
                {messagingPage && (
                  <Suspense timeout={0}>
                    {{
                      fallback: () => <PageLoading />,
                      default: () => (
                        <>
                          <PageBoundary
                            key={route.page}
                            page={route.page}
                            backLabel="返回工作台"
                            onBack={() => navigate({ page: 'workbench' })}
                          >
                            {() => (
                              <>
                                <MessagingPages route={route} navigate={navigate} />
                              </>
                            )}
                          </PageBoundary>
                        </>
                      ),
                    }}
                  </Suspense>
                )}
                {!activeWorkspace && !messagingPage && !devices && (
                  <Suspense timeout={0}>
                    {{
                      fallback: () => <PageLoading />,
                      default: () => (
                        <>
                          <PageBoundary
                            key={route.page}
                            page={route.page}
                            backLabel="返回工作台"
                            onBack={() => navigate({ page: 'workbench' })}
                          >
                            {() => (
                              <>
                                <MePages route={route} navigate={navigate} back={back} />
                              </>
                            )}
                          </PageBoundary>
                        </>
                      ),
                    }}
                  </Suspense>
                )}
                {error && (activeWorkspace || route.page === 'devices') && (
                  <p class="shell-error" role="alert">
                    {error}
                  </p>
                )}
                {accountSyncError && (
                  <p class="shell-error" role="status">
                    {accountSyncError}
                  </p>
                )}
              </div>
              {ready &&
                translationSettings.value.enabled &&
                (showWorkspace || (route.page === 'messages' && route.conversation)) && (
                  <SelectionTranslation
                    key={JSON.stringify([accountId, hostId, routeURL(route)])}
                    onSettings={() => navigate({ page: 'translation' })}
                  />
                )}
              {showNavigation && (
                <nav class="bottom-navigation" aria-label="主要功能">
                  <button
                    class="shell-account"
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
                        navigate(
                          module.id === 'workbench'
                            ? { page: 'workbench' }
                            : module.id === 'messages'
                              ? route.page === 'messages'
                                ? route
                                : resumeMessages()
                              : { page: module.id },
                        )
                      }
                    >
                      <Icon name={module.icon} size={24} />
                      <span>{module.title}</span>
                      {module.id === 'messages' && unread > 0 && (
                        <b class="navigation-unread" aria-hidden="true">
                          {unread > 99 ? '99+' : unread}
                        </b>
                      )}
                    </button>
                  ))}
                </nav>
              )}
            </div>
          </>
        )}
      </AccountSecurity>
    );
  };
});
