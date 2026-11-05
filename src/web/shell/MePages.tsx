import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { deviceSession } from '../device-session';
import type { PairedHost } from '../sync-store';
import { Icon } from '../Icon';
import { PageHeader } from './AppShell';
import type { AppRoute } from './routes';

function readName() {
  try {
    return localStorage.getItem('pocket-profile-name') || '我的 Agent 空间';
  } catch {
    return '我的 Agent 空间';
  }
}
function Row({
  icon,
  title,
  detail,
  onClick,
  disabled,
}: {
  icon: ComponentProps<typeof Icon>['name'];
  title: string;
  detail?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="settings-row" onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
      <span>{title}</span>
      <small>{detail}</small>
      <Icon name="chevron" size={17} />
    </button>
  );
}
export default function MePages({
  route,
  navigate,
  back,
  hosts,
  hostId,
  busy,
  refreshHosts,
}: {
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
  back: () => void;
  hosts: PairedHost[];
  hostId: string;
  busy: boolean;
  refreshHosts: () => Promise<void>;
}) {
  const [name, setName] = useState(readName);
  const [draftName, setDraftName] = useState(name);
  const [usage, setUsage] = useState<string>();
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    setNotice('');
    setConfirmRemove(false);
  }, [route.page]);
  useEffect(() => {
    if (route.page !== 'settings') return;
    let alive = true;
    void deviceSession.cache
      .usage()
      .then((u) => {
        if (alive) setUsage(formatBytes(u.bytes));
      })
      .catch(() => {
        if (alive) setUsage('暂不可用');
      });
    return () => {
      alive = false;
    };
  }, [route.page]);
  async function run(action: () => Promise<void>) {
    setWorking(true);
    setNotice('');
    try {
      await action();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '操作未完成，请重试');
    } finally {
      setWorking(false);
    }
  }
  const titles: Partial<Record<AppRoute['page'], string>> = {
    me: '我的',
    settings: '设置',
    devices: '我的设备',
    integrations: 'Agent 接入',
    profile: '个人资料',
    about: '关于',
  };
  return (
    <main className="module-page me-page">
      <PageHeader title={titles[route.page] ?? '我的'} back={route.page === 'me' ? undefined : back} />
      {route.page === 'me' && (
        <>
          <button className="profile-card" onClick={() => navigate({ page: 'profile' })}>
            <span className="profile-avatar">{name.slice(0, 1)}</span>
            <span>
              <strong>{name}</strong>
              <small>个人资料</small>
            </span>
            <Icon name="chevron" size={19} />
          </button>
          <section className="settings-group">
            <Row icon="puzzle" title="Agent 接入" onClick={() => navigate({ page: 'integrations' })} />
            <Row icon="monitor" title="我的设备" onClick={() => navigate({ page: 'devices' })} />
          </section>
          <section className="settings-group">
            <Row icon="sliders" title="设置" onClick={() => navigate({ page: 'settings' })} />
          </section>
        </>
      )}
      {route.page === 'settings' && (
        <>
          <section className="settings-group">
            <Row
              icon="trash"
              title={working ? '正在清理…' : '清理缓存'}
              detail={usage}
              disabled={working}
              onClick={() =>
                void run(async () => {
                  await deviceSession.cache.clear();
                  setUsage(formatBytes((await deviceSession.cache.usage()).bytes));
                  setNotice('缓存已清理');
                })
              }
            />
            <Row icon="info" title="关于" onClick={() => navigate({ page: 'about' })} />
          </section>
        </>
      )}
      {route.page === 'profile' && (
        <form
          className="profile-form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = draftName.trim();
            if (!value) return;
            try {
              localStorage.setItem('pocket-profile-name', value);
              setName(value);
              setNotice('已保存');
            } catch {
              setNotice('无法保存，请检查浏览器存储权限');
            }
          }}
        >
          <span className="profile-avatar">{draftName.trim().slice(0, 1) || '我'}</span>
          <label>
            昵称
            <input
              maxLength={40}
              required
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              autoComplete="nickname"
            />
          </label>
          <button className="primary" disabled={!draftName.trim()}>
            保存
          </button>
        </form>
      )}
      {route.page === 'devices' && (
        <>
          <section className="settings-group">
            {hosts.map((host) => (
              <button
                key={host.hostId}
                className="device-row"
                disabled={working || busy || host.hostId === hostId}
                onClick={() =>
                  void run(async () => {
                    await deviceSession.select(host);
                    await refreshHosts();
                    setNotice(`已切换到 ${host.name}`);
                  })
                }
              >
                <span className="tool-avatar">
                  <Icon name="monitor" />
                </span>
                <span>
                  <strong>{host.name}</strong>
                  <small>{host.hostId === hostId ? '当前设备' : '点击切换'}</small>
                </span>
                {host.hostId === hostId && <Icon name="check" />}
              </button>
            ))}
            <Row
              icon="plusCircle"
              title="添加电脑"
              disabled={working || busy}
              onClick={() => navigate({ page: 'pair' })}
            />
          </section>
          {!!hostId && (
            <section className="settings-group">
              {confirmRemove ? (
                <div className="inline-confirm">
                  <p>解除当前电脑的配对，并移除它在此手机上的记录？</p>
                  <div>
                    <button className="secondary" onClick={() => setConfirmRemove(false)}>
                      取消
                    </button>
                    <button
                      className="danger"
                      disabled={working || busy}
                      onClick={() =>
                        void run(async () => {
                          await deviceSession.forget();
                          await deviceSession.init();
                          await refreshHosts();
                          setConfirmRemove(false);
                          setNotice('已解除配对');
                        })
                      }
                    >
                      解除配对
                    </button>
                  </div>
                </div>
              ) : (
                <Row
                  icon="close"
                  title="解除当前配对"
                  disabled={busy || working}
                  onClick={() => setConfirmRemove(true)}
                />
              )}
            </section>
          )}
        </>
      )}
      {route.page === 'integrations' && (
        <section className="module-empty">
          <span className="empty-symbol">
            <Icon name="puzzle" size={38} />
          </span>
          <h2>还没有接入聊天 Agent</h2>
          <p>
            Dot 等即时聊天接入将在后续开放。
            <br />
            当前可在工作台使用 Codex。
          </p>
          <button className="secondary" onClick={() => navigate({ page: 'workbench' })}>
            打开工作台
          </button>
        </section>
      )}
      {route.page === 'about' && (
        <section className="about-content">
          <span className="empty-symbol">
            <Icon name="grid" size={38} />
          </span>
          <h2>Agent 空间</h2>
          <p>即时聊天与 Agent 工作台</p>
          <p>连接电脑后，可继续已有会话、发送任务、处理审批。消息模块的 Agent 接入将陆续开放。</p>
          <small>
            网页版本{' '}
            {typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__.slice(0, 8) : '开发版'}
          </small>
        </section>
      )}
      {notice && (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}
    </main>
  );
}
function formatBytes(value: number) {
  return value < 1024 ** 2
    ? `${Math.ceil(value / 1024)} KB`
    : value < 1024 ** 3
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${(value / 1024 ** 3).toFixed(2)} GB`;
}
