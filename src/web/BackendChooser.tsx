import { defineAsyncComponent, shallowRef, Suspense } from 'vue';
import { tsxComponent } from './tsx-component';
import { watchRender } from './render-effects';
import { Icon } from './Icon';
import { BackendIcon } from './BackendIcon';
import { deviceSession, type DeviceOverview } from './device-session';
import { messaging, useMessaging } from './messaging/context';
import { syncAccountHosts } from './account-session';
import type { PairedHost } from './sync-store';
import type { AppRoute } from './shell/routes';
import { DEFAULT_BACKEND } from '../shared/backends';
import type { AccountDesktop } from '../shared/desktop-authorization';
import { backendAppearanceDefaults } from '../shared/backend-appearance';
import './shell/workbench.css';

const BackendAppearanceEditor = defineAsyncComponent(() => import('./BackendAppearanceEditor'));
type Action = 'rename' | 'details' | 'remove';
const empty: DeviceOverview = { online: null, toolsChecked: false, backends: [], recent: [] };

export const BackendChooser = tsxComponent(function BackendChooser(_props: {
  hosts: PairedHost[];
  busy: boolean;
  navigate: (route: AppRoute) => void;
  refreshHosts: () => Promise<void>;
  manage: boolean;
  back: () => void;
}) {
  const accountDesktops = shallowRef<AccountDesktop[]>([]);
  const authorizationsKnown = shallowRef(false);
  const overview = shallowRef(new Map<string, DeviceOverview>());
  const menu = shallowRef<string>();
  const action = shallowRef<{ hostId: string; kind: Action }>();
  const editing = shallowRef<{ hostId: string; backendId: string; product: string }>();
  const alias = shallowRef('');
  const working = shallowRef(false);
  const notice = shallowRef('');
  const query = shallowRef('');
  const refresh = shallowRef(0);
  const watchDesktops = watchRender();
  const watchHosts = watchRender();
  return ({ hosts, busy, navigate, refreshHosts, manage, back }) => {
    const { user } = useMessaging();
    const signature = JSON.stringify(
      hosts.map(({ hostId, deviceId, phoneId, ticket }) => [hostId, deviceId, phoneId, ticket]).sort(),
    );
    watchDesktops(() => {
      if (user?.kind !== 'human') return;
      const controller = new AbortController();
      void messaging
        .request<{ devices: AccountDesktop[] }>('/desktop-devices', 'GET', undefined, controller.signal)
        .then(({ devices }) => {
          if (!controller.signal.aborted) {
            accountDesktops.value = devices;
            authorizationsKnown.value = true;
          }
        })
        .catch(() => {});
      return () => controller.abort();
    }, [user?.id, refresh.value]);
    watchHosts(() => {
      const controller = new AbortController();
      const ids = new Set(hosts.map(({ hostId }) => hostId));
      overview.value = new Map([...overview.value].filter(([id]) => ids.has(id)));
      let refreshing = false;
      const update = async () => {
        if (refreshing || document.visibilityState === 'hidden') return;
        refreshing = true;
        try {
          for (let start = 0; start < hosts.length && !controller.signal.aborted; start += 3) {
            await Promise.allSettled(
              hosts.slice(start, start + 3).map((host) =>
                deviceSession.overview(host, controller.signal, (value) => {
                  if (value.online !== null || !overview.value.has(host.hostId))
                    overview.value = new Map(overview.value).set(host.hostId, value);
                }),
              ),
            );
          }
        } finally {
          refreshing = false;
        }
      };
      void update();
      const interval = setInterval(update, 30000);
      window.addEventListener('focus', update);
      return () => {
        controller.abort();
        clearInterval(interval);
        window.removeEventListener('focus', update);
      };
    }, [signature, refresh.value]);
    const devices = new Map(accountDesktops.value.map((device) => [device.hostId, device]));
    const paired = new Map(hosts.map((host) => [host.hostId, host]));
    const computers = [...new Set([...paired.keys(), ...devices.keys()])];
    const filter = manage ? '' : query.value.trim().toLocaleLowerCase();
    const matches = (text: string) => text.toLocaleLowerCase().includes(filter);
    const visible = computers.filter((id) => {
      const snapshot = overview.value.get(id) ?? empty;
      return (
        matches(paired.get(id)?.name ?? devices.get(id)?.name ?? '') ||
        snapshot.backends.some((backend) => matches(backend.name)) ||
        snapshot.recent.some((thread) => matches(`${thread.title} ${thread.projectName ?? ''}`))
      );
    });

    async function run(task: () => Promise<void>) {
      working.value = true;
      notice.value = '';
      try {
        await task();
      } catch (error) {
        notice.value = error instanceof Error ? error.message : '操作未完成，请重试';
      } finally {
        working.value = false;
      }
    }

    function open(hostId: string, backend: string, thread?: string) {
      navigate({ page: 'workbench', host: hostId, backend, thread });
    }

    return (
      <main class="workbench-home">
        <header class="workbench-heading">
          <div class="workbench-title">
            {manage && (
              <button class="icon-button" aria-label="返回" onClick={back}>
                <Icon name="back" />
              </button>
            )}
            <h1>{manage ? '管理电脑' : '工作台'}</h1>
          </div>
          <button
            class="workbench-add"
            disabled={busy || working.value}
            onClick={() => navigate({ page: 'pair' })}
          >
            <Icon name="plusCircle" size={18} />
            添加电脑
          </button>
        </header>
        {!manage && !!computers.length && (
          <label class="workbench-search">
            <Icon name="search" size={18} />
            <input
              type="search"
              aria-label="搜索电脑、工具或最近会话"
              placeholder="搜索电脑、工具或最近会话"
              maxlength={120}
              value={query.value}
              onInput={(event) => {
                query.value = (event.currentTarget as HTMLInputElement).value;
              }}
            />
          </label>
        )}
        {!computers.length && (
          <section class="workbench-empty">
            <Icon name="monitor" size={28} />
            <p>还没有电脑。安装并登录适配器后，即可在这里打开电脑上的工具。</p>
            <button class="text-button" onClick={() => navigate({ page: 'downloads' })}>
              下载电脑适配器
            </button>
          </section>
        )}
        {!!computers.length && !visible.length && <p class="workbench-empty">没有匹配的电脑、工具或会话</p>}
        <div class="computer-grid">
          {visible.map((hostId) => {
            const host = paired.get(hostId);
            const authorized = devices.get(hostId);
            const name = host?.name ?? authorized?.name ?? '电脑';
            const snapshot = overview.value.get(hostId) ?? empty;
            const matchingRecents = filter
              ? snapshot.recent.filter((thread) => matches(`${thread.title} ${thread.projectName ?? ''}`))
              : [];
            const recents = matchingRecents.length ? matchingRecents : snapshot.recent.slice(0, 3);
            const online = snapshot.online;
            const status = !host ? '等待配对同步' : online === null ? '正在检查' : online ? '在线' : '离线';
            const selectedAction = action.value?.hostId === hostId ? action.value.kind : undefined;
            function choose(kind: Action) {
              menu.value = undefined;
              action.value = { hostId, kind };
              alias.value = name;
            }
            return (
              <article key={hostId} class="computer-card" aria-label={name}>
                <header class="computer-header">
                  <span class="computer-icon">
                    <Icon name="monitor" size={24} />
                  </span>
                  <h2>{name}</h2>
                  <span class="computer-status" data-online={online === true}>
                    <i />
                    {status}
                  </span>
                  <div class="computer-menu">
                    <button
                      class="icon-button"
                      aria-label={`管理 ${name}`}
                      aria-expanded={menu.value === hostId}
                      disabled={busy || working.value}
                      onClick={() => {
                        menu.value = menu.value === hostId ? undefined : hostId;
                      }}
                    >
                      <Icon name="more" size={21} />
                    </button>
                    {menu.value === hostId && (
                      <div
                        class="computer-menu-items"
                        onKeydown={(event) => {
                          if (event.key === 'Escape') {
                            menu.value = undefined;
                            (
                              (event.currentTarget as HTMLElement).previousElementSibling as HTMLElement
                            )?.focus();
                          }
                        }}
                      >
                        {host && <button onClick={() => choose('rename')}>重命名</button>}
                        <button onClick={() => choose('details')}>连接详情</button>
                        <button
                          class="danger"
                          disabled={user?.kind === 'human' && !authorizationsKnown.value}
                          onClick={() => choose('remove')}
                        >
                          {authorized ? '撤销授权' : '解除配对'}
                        </button>
                      </div>
                    )}
                  </div>
                </header>
                {selectedAction === 'details' && (
                  <div class="computer-action">
                    <p>
                      {status} · {authorized ? '账号已授权' : '通过配对码连接'}
                    </p>
                    <p>{host ? '此浏览器可访问这台电脑。' : '配对记录同步后即可打开工具。'}</p>
                    <button
                      class="text-button"
                      onClick={() => {
                        action.value = undefined;
                      }}
                    >
                      关闭
                    </button>
                  </div>
                )}
                {selectedAction === 'rename' && host && (
                  <form
                    class="computer-action"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = alias.value.trim();
                      if (!value) return;
                      void run(async () => {
                        await deviceSession.renameHost(host, value);
                        await refreshHosts();
                        action.value = undefined;
                      });
                    }}
                  >
                    <label>
                      电脑名称
                      <input
                        required
                        maxlength={80}
                        value={alias.value}
                        onInput={(event) => {
                          alias.value = (event.currentTarget as HTMLInputElement).value;
                        }}
                      />
                    </label>
                    <div>
                      <button
                        type="button"
                        class="secondary"
                        onClick={() => {
                          action.value = undefined;
                        }}
                      >
                        取消
                      </button>
                      <button type="submit" disabled={busy || working.value || !alias.value.trim()}>
                        保存
                      </button>
                    </div>
                  </form>
                )}
                {selectedAction === 'remove' && (
                  <div class="computer-action">
                    <p>
                      {authorized
                        ? `撤销后，${name} 将失去此账号的授权。`
                        : `解除与 ${name} 的配对并移除此浏览器的缓存？`}
                    </p>
                    <div>
                      <button
                        class="secondary"
                        onClick={() => {
                          action.value = undefined;
                        }}
                      >
                        取消
                      </button>
                      <button
                        class="danger"
                        disabled={busy || working.value}
                        onClick={() =>
                          void run(async () => {
                            if (authorized && user) {
                              await messaging.request(`/desktop-devices/${hostId}`, 'DELETE', {
                                accountId: user.id,
                              });
                              if (messaging.account.user?.id !== user.id) return;
                              if (deviceSession.host?.hostId === hostId) deviceSession.resetAccount(user.id);
                              await deviceSession.cache.forget(hostId);
                              accountDesktops.value = accountDesktops.value.filter(
                                (entry) => entry.hostId !== hostId,
                              );
                              await syncAccountHosts(messaging.account);
                            } else if (host) {
                              await deviceSession.forgetHost(host);
                            }
                            await deviceSession.init();
                            await refreshHosts();
                            action.value = undefined;
                            refresh.value++;
                          })
                        }
                      >
                        确认{authorized ? '撤销' : '解除'}
                      </button>
                    </div>
                  </div>
                )}
                {snapshot.backends.map((backend) => {
                  const appearance = backend.appearance ?? backendAppearanceDefaults(backend);
                  const cached = snapshot.recent.some((thread) => thread.backendId === backend.id);
                  const connected = snapshot.toolsChecked && backend.connected;
                  return (
                    <div class="computer-tool" key={backend.id}>
                      <BackendIcon icon={appearance.icon} product={backend.product} />
                      <div class="computer-tool-name">
                        <strong>{appearance.name}</strong>
                        {online === true && !connected && (
                          <small>{snapshot.toolsChecked ? '工具未连接' : '工具状态待确认'}</small>
                        )}
                      </div>
                      {(online || cached) && (
                        <button
                          class="computer-open"
                          aria-label={`打开 ${appearance.name}`}
                          disabled={busy || working.value}
                          onClick={() => open(hostId, backend.id)}
                        >
                          {online && connected ? '打开会话' : cached ? '查看历史' : '打开工作区'}
                          <Icon name="chevron" size={16} />
                        </button>
                      )}
                      {online && host && (
                        <button
                          class="icon-button computer-tool-settings"
                          aria-label={`编辑 ${appearance.name}`}
                          disabled={busy || working.value}
                          onClick={() =>
                            void run(async () => {
                              if (deviceSession.host?.hostId !== hostId)
                                await deviceSession.select(host, false);
                              if (deviceSession.host?.hostId === hostId)
                                editing.value = { hostId, backendId: backend.id, product: backend.product };
                            })
                          }
                        >
                          <Icon name="sliders" size={16} />
                        </button>
                      )}
                    </div>
                  );
                })}
                {!snapshot.backends.length && (
                  <p class="computer-empty">
                    {!host
                      ? '配对记录尚未同步。'
                      : online === null
                        ? '正在读取工具…'
                        : online
                          ? '暂时无法读取工具。'
                          : '电脑离线，暂无工具缓存。'}
                    {host && online === false && (
                      <button
                        class="text-button"
                        disabled={busy || working.value}
                        onClick={() => open(hostId, DEFAULT_BACKEND)}
                      >
                        打开工作区
                      </button>
                    )}
                  </p>
                )}
                {!manage && !!recents.length && (
                  <section class="computer-recents" aria-label={`${name}的最近会话`}>
                    <h3>最近会话</h3>
                    {recents.map((thread) => (
                      <button
                        key={JSON.stringify([thread.backendId, thread.id])}
                        disabled={busy || working.value}
                        onClick={() => open(hostId, thread.backendId, thread.id)}
                      >
                        <span>{thread.title || '未命名会话'}</span>
                        <Icon name="chevron" size={16} />
                      </button>
                    ))}
                  </section>
                )}
              </article>
            );
          })}
        </div>
        {notice.value && (
          <p class="workbench-notice" role="status">
            {notice.value}
          </p>
        )}
        {editing.value && editing.value.hostId === deviceSession.host?.hostId && (
          <Suspense timeout={0}>
            {{
              fallback: () => <p role="status">正在打开设置…</p>,
              default: () =>
                editing.value ? (
                  <BackendAppearanceEditor
                    key={JSON.stringify(editing.value)}
                    id={editing.value.backendId}
                    product={editing.value.product}
                    onClose={() => {
                      editing.value = undefined;
                    }}
                    onSaved={() => {
                      refresh.value++;
                    }}
                  />
                ) : null,
            }}
          </Suspense>
        )}
      </main>
    );
  };
});
