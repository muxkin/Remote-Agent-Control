import { tsxComponent } from '../tsx-component';
import { shallowRef, defineAsyncComponent as lazy, Suspense, type VNodeChild } from 'vue';
import { watchRender, writeRef } from '../render-effects';
import type { IconName } from '../icon-paths';

import { useMessaging } from '../messaging/context';
import { Avatar } from '../messaging/ui';
import { deviceSession } from '../device-session';
import { Icon } from '../Icon';
import { PageHeader } from './PageHeader';
import type { AppRoute } from './routes';
const DownloadsPage = lazy(() => import('./DownloadsPage.vue'));
const DonationPage = lazy(() => import('./DonationPage.vue'));
const AppearanceSettings = lazy(() => import('../theme/AppearanceSettings.vue'));

const Row = tsxComponent(function Row(_props: {
  icon: IconName;
  title: string;
  detail?: VNodeChild;
  onClick: () => void;
  disabled?: boolean;
}) {
  return ({ icon, title, detail, onClick, disabled }) => {
    return (
      <button class="settings-row" onClick={onClick} disabled={disabled}>
        <span class="surface-icon">
          <Icon name={icon} size={21} />
        </span>
        <span>{title}</span>
        <small>{detail}</small>
        <Icon name="chevron" size={17} />
      </button>
    );
  };
});
export default tsxComponent(function MePages(_props: {
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
  back: () => void;
}) {
  const usageState = shallowRef<string>();
  const setUsage = writeRef(usageState);
  const workingState = shallowRef(false);
  const noticeState = shallowRef('');
  const watchUsage = watchRender();
  return ({ route, navigate, back }) => {
    const { user } = useMessaging();
    const name = user?.displayName ?? '登录或创建账户';
    const usage = usageState.value;
    const working = workingState.value;
    async function run(action: () => Promise<void>) {
      workingState.value = true;
      noticeState.value = '';
      try {
        await action();
      } catch (error) {
        noticeState.value = error instanceof Error ? error.message : '操作未完成，请重试';
      } finally {
        workingState.value = false;
      }
    }
    watchUsage(() => {
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
    const titles: Partial<Record<AppRoute['page'], string>> = {
      me: '我的',
      settings: '设置',
      appearance: '外观',
      devices: '我的设备',
      integrations: 'Agent 接入',
      profile: '个人资料',
      about: '关于',
      donation: '支持项目',
      downloads: '电脑适配器',
    };
    return (
      <main class="module-page me-page">
        <PageHeader title={titles[route.page] ?? '我的'} back={route.page === 'me' ? undefined : back} />
        {route.page === 'me' && (
          <>
            <button class="profile-card" onClick={() => navigate({ page: 'profile' })}>
              <Avatar user={user ?? { displayName: '我', kind: 'human' }} large />
              <span>
                <strong>{name}</strong>
                <small>{user ? `UID ${user.id}` : '与你的 Agent 聊天'}</small>
              </span>
              <span class="profile-link">
                {user ? '个人资料' : '登录'}
                <Icon name="chevron" size={16} />
              </span>
            </button>
            <section class="settings-group">
              <Row icon="puzzle" title="Agent 接入" onClick={() => navigate({ page: 'integrations' })} />
              <Row
                icon="download"
                title="电脑适配器"
                detail="Windows、macOS、Linux"
                onClick={() => navigate({ page: 'downloads' })}
              />
              <Row icon="monitor" title="我的设备" onClick={() => navigate({ page: 'devices' })} />
            </section>
            <section class="settings-group">
              <Row icon="sliders" title="设置" onClick={() => navigate({ page: 'settings' })} />
            </section>
            <section class="settings-group">
              <Row
                icon="heart"
                title="支持项目"
                detail="微信赞赏 · 爱发电"
                onClick={() => navigate({ page: 'donation' })}
              />
            </section>
          </>
        )}
        {route.page === 'settings' && (
          <>
            <section class="settings-group">
              <Row
                icon="palette"
                title="外观"
                detail="主题与亮暗模式"
                onClick={() => navigate({ page: 'appearance' })}
              />
              <Row
                icon="trash"
                title={working ? '正在清理…' : '清理缓存'}
                detail={usage}
                disabled={working}
                onClick={() =>
                  void run(async () => {
                    await deviceSession.cache.clear();
                    setUsage(formatBytes((await deviceSession.cache.usage()).bytes));
                    noticeState.value = '缓存已清理';
                  })
                }
              />
              <Row icon="info" title="关于" onClick={() => navigate({ page: 'about' })} />
            </section>
          </>
        )}
        {route.page === 'downloads' && (
          <Suspense timeout={0}>
            {{
              fallback: () => <div class="page-loading">正在读取安装包…</div>,
              default: () => (
                <>
                  <DownloadsPage />
                </>
              ),
            }}
          </Suspense>
        )}
        {route.page === 'donation' && (
          <Suspense timeout={0}>
            {{
              fallback: () => <div class="page-loading">正在打开支持项目页面…</div>,
              default: () => (
                <>
                  <DonationPage />
                </>
              ),
            }}
          </Suspense>
        )}
        {route.page === 'appearance' && (
          <Suspense timeout={0}>
            {{
              fallback: () => <div class="page-loading">正在打开外观设置…</div>,
              default: () => (
                <>
                  <AppearanceSettings />
                </>
              ),
            }}
          </Suspense>
        )}
        {route.page === 'about' && (
          <section class="about-content">
            <img class="about-app-icon" src="/app-icon-192.png" alt="Agent 空间图标" width="96" height="96" />
            <h2>Agent 空间</h2>
            <p>即时聊天与 Agent 工作台</p>
            <p>注册账户后，可以与你的 Agent 聊天。连接电脑后，可继续已有会话、发送任务、处理审批。</p>
            <small>
              网页版本{' '}
              {typeof __POCKET_WEB_BUILD_ID__ === 'string' ? __POCKET_WEB_BUILD_ID__.slice(0, 8) : '开发版'}
            </small>
          </section>
        )}
        {route.page === 'settings' && noticeState.value && (
          <p class="settings-notice" role="status">
            {noticeState.value}
          </p>
        )}
      </main>
    );
  };
});
function formatBytes(value: number) {
  return value < 1024 ** 2
    ? `${Math.ceil(value / 1024)} KB`
    : value < 1024 ** 3
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${(value / 1024 ** 3).toFixed(2)} GB`;
}
