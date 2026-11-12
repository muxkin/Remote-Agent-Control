import { tsxComponent } from './tsx-component';
import { shallowRef, defineAsyncComponent as lazy, Suspense } from 'vue';
import { writeRef, watchRender } from './render-effects';
import { Icon } from './Icon';
import { deviceSession } from './device-session';
import type { BackendInfo } from '../shared/backends';
import type { ThreadSummary } from '../shared/types';
import type { AppRoute } from './shell/routes';
import { backendAppearanceDefaults, backendStyle } from '../shared/backend-appearance';
import { BackendIcon } from './BackendIcon';
import './shell/workbench.css';
const BackendAppearanceEditor = lazy(() => import('./BackendAppearanceEditor'));
type Recent = ThreadSummary & { backendId: string };
const appearance = (backend: BackendInfo) => backend.appearance ?? backendAppearanceDefaults(backend);
const date = (value: number) => {
  const time = new Date(value),
    today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day =
    time.toDateString() === today.toDateString()
      ? '今天'
      : time.toDateString() === yesterday.toDateString()
        ? '昨天'
        : time.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return `${day} ${time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
};
export const BackendChooser = tsxComponent(function BackendChooser(_props: {
  navigate: (route: AppRoute) => void;
}) {
  const backendsState = shallowRef<BackendInfo[]>([]);
  const setBackends = writeRef(backendsState);
  const recentState = shallowRef<Recent[]>([]);
  const setRecent = writeRef(recentState);
  const computerOnline = shallowRef(deviceSession.online);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const historyLoadingState = shallowRef(true);
  const setHistoryLoading = writeRef(historyLoadingState);
  const historyErrorState = shallowRef(false);
  const setHistoryError = writeRef(historyErrorState);
  const queryState = shallowRef('');
  const setQuery = writeRef(queryState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const editingState = shallowRef('');
  const setEditing = writeRef(editingState);
  const noticeState = shallowRef('');
  const setNotice = writeRef(noticeState);
  const generation = { current: 0 };
  const watchBackends = watchRender();
  return ({ navigate }) => {
    const backends = backendsState.value;
    const recent = recentState.value;
    const loading = loadingState.value;
    const historyLoading = historyLoadingState.value;
    const historyError = historyErrorState.value;
    const query = queryState.value;
    const error = errorState.value;
    const editing = editingState.value;
    const notice = noticeState.value;

    watchBackends(() => {
      let active = true,
        inFlight = false,
        refreshAfterConnect = false;
      const refresh = async () => {
        if (inFlight || document.visibilityState === 'hidden') return;
        inFlight = true;
        const version = ++generation.current;
        try {
          const r = await deviceSession.api<{ backends: BackendInfo[] }>(
            '/backends',
            undefined,
            'codex-local',
          );
          if (!active || version !== generation.current) return;
          setBackends(r.backends);
          setError('');
          setLoading(false);
          const histories = await Promise.allSettled(
            r.backends.map(async (b) => {
              if (b.capabilities?.history.state === 'unsupported') return [];
              const result = await deviceSession.api<{ threads: ThreadSummary[] }>(
                '/threads',
                undefined,
                b.id,
              );
              return result.threads.slice(0, 8).map((t) => ({ ...t, backendId: b.id }));
            }),
          );
          if (!active || version !== generation.current) return;
          setHistoryError(histories.some((h) => h.status === 'rejected'));
          setRecent(
            histories
              .flatMap((h) => (h.status === 'fulfilled' ? h.value : []))
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 16),
          );
        } catch {
          if (active && version === generation.current) {
            setError('电脑暂时离线，连接恢复后会自动更新。');
            setHistoryError(true);
          }
        } finally {
          inFlight = false;
          if (active) {
            setLoading(false);
            setHistoryLoading(false);
            if (refreshAfterConnect) {
              refreshAfterConnect = false;
              void refresh();
            }
          }
        }
      };
      void refresh();
      let online = deviceSession.online;
      const unsubscribe = deviceSession.onChange(() => {
        const connected = deviceSession.online;
        computerOnline.value = connected;
        if (connected && !online) {
          if (inFlight) refreshAfterConnect = true;
          else void refresh();
        }
        online = connected;
      });
      const focus = () => void refresh();
      const timer = setInterval(focus, 30000);
      window.addEventListener('focus', focus);
      return () => {
        active = false;
        unsubscribe();
        clearInterval(timer);
        window.removeEventListener('focus', focus);
      };
    }, []);
    const filtered = recent.filter((t) =>
      [t.title, t.projectName, backends.find((b) => b.id === t.backendId)?.name]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    );
    return (
      <main class="workbench-home">
        <header class="workbench-heading">
          <div>
            <h1>工作台</h1>
            <p>你的助手与最近会话，都在这里。</p>
          </div>
          <button class="secondary workbench-manage" onClick={() => navigate({ page: 'devices' })}>
            <Icon name="monitor" size={18} />
            <span>管理电脑</span>
          </button>
        </header>
        <section aria-labelledby="workbench-agents">
          <div class="workbench-section-heading">
            <h2 id="workbench-agents">选择助手</h2>
            <span class="workbench-host">
              <Icon name="monitor" size={16} />
              {deviceSession.host?.name ?? '当前电脑'}
            </span>
          </div>
          {loading ? (
            <p class="workbench-empty" role="status">
              正在读取助手…
            </p>
          ) : backends.length ? (
            <div class="agent-launchers">
              {backends.map((backend) => {
                const value = appearance(backend);
                return (
                  <article
                    class="agent-launcher"
                    data-agent-style={backendStyle(backend.product)}
                    key={backend.id}
                  >
                    <button
                      class="agent-launch"
                      aria-label={`打开 ${value.name}`}
                      onClick={() => navigate({ page: 'workbench', backend: backend.id })}
                    >
                      <div class="agent-launch-top">
                        <BackendIcon icon={value.icon} product={backend.product} />
                        <span
                          class={`backend-status ${computerOnline.value && backend.connected ? 'connected' : ''}`}
                        >
                          <i />
                          {!computerOnline.value ? '电脑未连接' : backend.connected ? '已连接' : '助手未连接'}
                        </span>
                      </div>
                      <h3>{value.name}</h3>
                      <p>{value.description}</p>
                      <span class="agent-launch-action">
                        打开工作区
                        <Icon name="arrow" size={18} />
                      </span>
                    </button>
                    <button
                      class="agent-edit icon-button"
                      aria-label={`编辑 ${value.name}`}
                      title={`编辑 ${value.name}`}
                      onClick={() => {
                        setNotice('');
                        setEditing(backend.id);
                      }}
                    >
                      <Icon name="sliders" size={18} />
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div class="workbench-empty">
              <Icon name="monitor" size={28} />
              <p>{error || '这台电脑还没有可用的助手。'}</p>
              <button class="secondary" onClick={() => navigate({ page: 'devices' })}>
                检查电脑连接
              </button>
              <button
                class="text-button"
                onClick={() => navigate({ page: 'workbench', backend: 'codex-local' })}
              >
                查看 Codex 缓存
              </button>
            </div>
          )}
          {!!backends.length && error && (
            <p class="workbench-notice" role="status">
              {error}
            </p>
          )}
        </section>
        <section class="workbench-recents" aria-labelledby="workbench-recent-title">
          <div class="workbench-section-heading">
            <h2 id="workbench-recent-title">继续最近的工作</h2>
            <label class="workbench-search">
              <Icon name="search" size={18} />
              <input
                type="search"
                aria-label="搜索最近会话"
                placeholder="搜索最近会话"
                maxlength={120}
                value={query}
                onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
          </div>
          <div class="workbench-table-head" aria-hidden="true">
            <span>会话</span>
            <span>助手</span>
            <span>更新时间</span>
            <span />
          </div>
          {filtered.length ? (
            <div class="workbench-recent-list">
              {filtered.map((thread) => {
                const backend = backends.find((b) => b.id === thread.backendId);
                if (!backend) return null;
                return (
                  <button
                    class="workbench-recent"
                    key={JSON.stringify([thread.backendId, thread.id])}
                    onClick={() =>
                      navigate({ page: 'workbench', backend: thread.backendId, thread: thread.id })
                    }
                  >
                    <span class="workbench-recent-title">
                      <BackendIcon icon={appearance(backend).icon} product={backend.product} />
                      <span>
                        <strong>{thread.title || '未命名会话'}</strong>
                        <small>
                          {thread.projectName || thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '未分类'}
                        </small>
                      </span>
                    </span>
                    <span class="workbench-recent-agent">{appearance(backend).name}</span>
                    <time datetime={new Date(thread.updatedAt).toISOString()}>{date(thread.updatedAt)}</time>
                    <Icon name="chevron" size={16} />
                  </button>
                );
              })}
            </div>
          ) : (
            <p class="workbench-empty" role="status">
              {historyLoading
                ? '正在读取最近会话…'
                : query
                  ? '没有匹配的最近会话'
                  : historyError
                    ? '暂时无法读取最近会话，可先打开助手查看。'
                    : '还没有会话，选择一个助手开始工作。'}
            </p>
          )}
          {historyError && !!recent.length && (
            <p class="workbench-notice" role="status">
              部分助手的最近会话暂时无法更新。
            </p>
          )}
        </section>
        {notice && (
          <p class="workbench-notice" role="status">
            {notice}
          </p>
        )}
        {editing && (
          <Suspense timeout={0}>
            {{
              fallback: () => <p role="status">正在打开设置…</p>,
              default: () => (
                <>
                  <BackendAppearanceEditor
                    key={editing}
                    id={editing}
                    product={backends.find((b) => b.id === editing)?.product}
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
                </>
              ),
            }}
          </Suspense>
        )}
      </main>
    );
  };
});
