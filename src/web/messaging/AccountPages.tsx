import { tsxComponent } from '../tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from '../render-effects';

import type { ChatUser } from '../../shared/messaging';
import { PageHeader } from '../shell/AppShell';
import { Icon } from '../Icon';
import { messaging, useMessaging } from './context';
import { Avatar, UserIdentity, Notice as ErrorNotice, Confirm, errorText, time, type Navigate } from './ui';
import ResourceSettings from './ResourceSettings';
export const AccountForm = tsxComponent(function AccountForm(props: { initialMode?: 'login' }) {
  const modeState = shallowRef<'register' | 'login' | 'recovery'>(props.initialMode ?? 'register');
  const setMode = writeRef(modeState);
  const requiresCodeState = shallowRef(false);
  const setRequiresCode = writeRef(requiresCodeState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const watchRequiresCode = watchRender();
  return () => {
    const { setUser } = useMessaging();
    const mode = modeState.value;
    const requiresCode = requiresCodeState.value;
    const error = errorState.value;
    const busy = busyState.value;
    watchRequiresCode(() => {
      void messaging
        .request<{ registrationRequiresCode: boolean }>('/status')
        .then((v) => setRequiresCode(v.registrationRequiresCode))
        .catch(() => {});
    }, []);
    async function submit(event: SubmitEvent) {
      event.preventDefault();
      setError('');
      setBusy(true);
      const data = new FormData(event.currentTarget as HTMLFormElement);
      try {
        const result =
          mode === 'register'
            ? await messaging.account.register(
                String(data.get('username')),
                String(data.get('displayName')),
                String(data.get('password')),
                data.get('registrationCode') ? String(data.get('registrationCode')) : undefined,
              )
            : await messaging.account.login(
                String(data.get('identifier')),
                String(data.get('password')),
                mode === 'recovery',
              );
        setUser(result.user);
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy(false);
      }
    }
    return (
      <section class="im-account">
        <span class="empty-symbol">
          <Icon name="chat" size={38} />
        </span>
        <h2>一个账号，连接你的设备</h2>
        <p>登录后同步已添加的 Codex 和加密聊天。无需邮箱或手机号。</p>
        <div class="im-tabs" role="group" aria-label="账户操作">
          <button
            aria-pressed={mode === 'register'}
            onClick={() => {
              setMode('register');
              setError('');
            }}
          >
            注册
          </button>
          <button
            aria-pressed={mode === 'login'}
            onClick={() => {
              setMode('login');
              setError('');
            }}
          >
            登录
          </button>
          <button
            aria-pressed={mode === 'recovery'}
            onClick={() => {
              setMode('recovery');
              setError('');
            }}
          >
            恢复账号
          </button>
        </div>
        <form class="im-form" onSubmit={submit}>
          {mode === 'register' && (
            <label>
              昵称
              <input name="displayName" required maxlength={60} autocomplete="nickname" />
            </label>
          )}
          <label>
            {mode === 'register' ? '用户名' : 'UID 或用户名'}
            <input
              key={mode}
              name={mode === 'register' ? 'username' : 'identifier'}
              required
              minlength={mode === 'register' ? 3 : undefined}
              maxlength={mode === 'register' ? 32 : undefined}
              pattern={mode === 'register' ? '(?=.*[a-zA-Z])[a-zA-Z0-9][a-zA-Z0-9_\\-]{2,31}' : undefined}
              autocomplete="username"
              autocapitalize="none"
              spellcheck={false}
              placeholder={mode === 'register' ? '例如 chatuser' : '输入 UID 或 @用户名'}
            />
          </label>
          {mode === 'register' && (
            <small>3–32 位字母、数字、横线或下划线，至少一个字母。注册后自动获得永久 UID。</small>
          )}
          <label>
            {mode === 'recovery' ? '恢复码' : '密码'}
            <input
              name="password"
              type="password"
              required
              minlength={10}
              maxlength={128}
              autocomplete={
                mode === 'register' ? 'new-password' : mode === 'recovery' ? 'off' : 'current-password'
              }
              placeholder={
                mode === 'recovery' ? '输入注册时保存的恢复码' : '至少 10 位，建议使用密码管理器生成'
              }
            />
          </label>
          {mode === 'register' && requiresCode && (
            <label>
              注册码
              <input name="registrationCode" required autocomplete="off" />
            </label>
          )}
          <ErrorNotice text={error} />
          <button class="primary" disabled={busy}>
            {busy ? '请稍候…' : mode === 'register' ? '创建账户' : '登录账户'}
          </button>
        </form>
      </section>
    );
  };
});
export const Agents = tsxComponent(function Agents(_props: { navigate: Navigate }) {
  const agentsState = shallowRef<ChatUser[]>([]);
  const setAgents = writeRef(agentsState);
  const invitationState = shallowRef<{ invitation: string; expiresAt: number }>();
  const setInvitation = writeRef(invitationState);
  const credentialState = shallowRef('');
  const setCredential = writeRef(credentialState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const noticeState = shallowRef('');
  const setNotice = writeRef(noticeState);
  const confirmState = shallowRef<{ id: string; rotate: boolean }>();
  const setConfirm = writeRef(confirmState);
  const watchAgents = watchRender();
  return ({ navigate }) => {
    const agents = agentsState.value;
    const invitation = invitationState.value;
    const credential = credentialState.value;
    const error = errorState.value;
    const busy = busyState.value;
    const notice = noticeState.value;
    const confirm = confirmState.value;
    const { revision } = useMessaging();
    watchAgents(() => {
      const abort = new AbortController();
      void messaging
        .request<{ users: ChatUser[] }>('/agents', 'GET', undefined, abort.signal)
        .then((v) => setAgents(v.users))
        .catch((e) => {
          if (!abort.signal.aborted) setError(errorText(e));
        });
      return () => abort.abort();
    }, [revision]);
    async function run(action: () => Promise<void>) {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy(false);
      }
    }
    const instructions = invitation
      ? `请使用最新版 Remote-Agent-Control 的加密客户端注册为我的聊天 Agent（邀请 15 分钟有效）。
服务地址：${location.origin}
一次性邀请：${invitation.invitation}

推荐使用项目 CLI：把邀请设置为 POCKET_IM_INVITATION，然后执行：
npm run im -- register --origin ${location.origin} --username my-agent --name 我的助手 --state /private/my-agent.json

用户名请改为唯一值。CLI 会在本地生成加密身份，将令牌和解密私钥保存在权限为 0600 的状态文件。请安全备份此文件，不要上传或打印其中的秘密。

后续使用相同 --state 执行 contacts、chat、send、sync、history、upload、request 等命令。用户 UID 始终是字符串，不要转换为数值。发送时提供稳定的 --request-id；保存 sync cursor，按消息 ID 与 revision 去重，不要回复自己的消息。

也可使用 src/client/encrypted-messaging.ts 的 EncryptedMessagingClient，在本地恢复自己的 AccountSecrets。不要直接向 /api/im POST 明文 text 或文件字节；所有正文、附件描述与授权回复均由加密客户端处理。

授权必须来自指定用户的有效签名回复，且绑定具体交互 ID。普通文本不算授权。收到 cancelled、rejected、expired 或无法验证的消息时，不要执行对应操作。

实时通话为 WebRTC 双向音视频，由 Agent 的媒体处理器处理。接入文档：docs/AGENT_CALLS.md；SDK：src/client/calls.ts。已有凭据可运行 npm run im:call -- --state /private/my-agent.json --handler /private/media-handler.mjs。仅在处理器就绪时声明接听能力，不要把普通文字回复器标记为支持通话。

妥善保存 Agent 状态文件；重置登录令牌不恢复丢失的解密密钥。`
      : '';
    return (
      <>
        <PageHeader title="Agent 接入" back={() => navigate({ page: 'contacts' })} />
        <section class="im-agent-content">
          <div class="im-profile-heading">
            <span class="im-agent-symbol">
              <Icon name="chat" size={30} />
            </span>
            <div>
              <h2>让你的 Agent 加入聊天</h2>
              <p>一个邀请，连接你正在使用的助手。</p>
            </div>
          </div>
          <ol class="im-onboarding-steps">
            <li>
              <strong>生成邀请</strong>
              <span>一次使用，15 分钟有效。</span>
            </li>
            <li>
              <strong>交给 Agent</strong>
              <span>复制说明，让它完成注册并保存凭据。</span>
            </li>
            <li>
              <strong>开始协作</strong>
              <span>私聊、群聊和流式回复，使用同一个账户。</span>
            </li>
          </ol>
          <button
            class="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setInvitation(await messaging.request('/agent-invitations', 'POST', {}));
                setCredential('');
              })
            }
          >
            生成一次性邀请
          </button>
          {invitation && (
            <div class="im-secret">
              <strong>有效至 {time(invitation.expiresAt)}</strong>
              <p>重新生成会使旧邀请失效；邀请使用一次即失效。</p>
              <textarea aria-label="Agent 注册说明" value={instructions} readonly rows={9} />
              <button
                class="secondary"
                onClick={() =>
                  void run(async () => {
                    if (!navigator.clipboard) throw Error('请选中上方说明并手动复制');
                    await navigator.clipboard.writeText(instructions);
                    setNotice('注册说明已复制');
                  })
                }
              >
                复制注册说明
              </button>
            </div>
          )}
          <ErrorNotice text={error} />
          {notice && <p role="status">{notice}</p>}
          {credential && (
            <div class="im-secret">
              <strong>新凭据仅在这里显示</strong>
              <p>交给对应 Agent 保存后，关闭此区域。</p>
              <textarea aria-label="Agent 新凭据" value={credential} readonly rows={2} />
              <button class="secondary" onClick={() => setCredential('')}>
                已保存，关闭
              </button>
            </div>
          )}
          <h3>我的 Agent</h3>
          {!agents.length && <p>注册成功的 Agent 会出现在这里。</p>}
          {agents.map((agent) => (
            <div class="im-agent-row" key={agent.id}>
              <Avatar user={agent} />
              <span>
                <strong>{agent.displayName}</strong>
                <small>
                  UID {agent.id} · @{agent.username}
                </small>
              </span>
              <button class="secondary" onClick={() => setConfirm({ id: agent.id, rotate: true })}>
                重置凭据
              </button>
              <button class="danger" onClick={() => setConfirm({ id: agent.id, rotate: false })}>
                撤销
              </button>
            </div>
          ))}
          {confirm && (
            <div class="inline-confirm">
              <p>
                {confirm.rotate
                  ? '重置后，原凭据立即失效。请将新凭据交给此 Agent。'
                  : '撤销后，此 Agent 无法继续收发消息；聊天记录会保留。可以重置凭据恢复使用。'}
              </p>
              <div>
                <button class="secondary" disabled={busy} onClick={() => setConfirm(undefined)}>
                  取消
                </button>
                <button
                  class="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await messaging.request<{ token?: string }>(
                        `/agents/${confirm.id}/credentials`,
                        confirm.rotate ? 'POST' : 'DELETE',
                      );
                      setCredential(result.token ?? '');
                      setNotice(confirm.rotate ? '旧凭据已失效' : '凭据已撤销');
                      setConfirm(undefined);
                    })
                  }
                >
                  确认{confirm.rotate ? '重置' : '撤销'}
                </button>
              </div>
            </div>
          )}
        </section>
      </>
    );
  };
});
export const Profile = tsxComponent(function Profile(_props: { navigate: Navigate }) {
  const { user } = useMessaging();

  const nameState = shallowRef(user!.displayName);
  const setName = writeRef(nameState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const noticeState = shallowRef('');
  const setNotice = writeRef(noticeState);
  const passwordOpenState = shallowRef(false);
  const setPasswordOpen = writeRef(passwordOpenState);
  const confirmState = shallowRef(false);
  const setConfirm = writeRef(confirmState);
  return ({ navigate }) => {
    const { user, setUser, updateProfile } = useMessaging();
    const name = nameState.value;
    const busy = busyState.value;
    const error = errorState.value;
    const notice = noticeState.value;
    const passwordOpen = passwordOpenState.value;
    const confirm = confirmState.value;
    async function run(action: () => Promise<void>) {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    }
    return (
      <>
        <PageHeader title="账户设置" back={() => navigate({ page: 'me' })} />
        <div class="im-settings-content">
          <div class="im-profile-heading">
            <Avatar user={user} large />
            <div>
              <h2>{user!.displayName}</h2>
              <p>@{user!.username}</p>
            </div>
          </div>
          <UserIdentity user={user!} />
          <ResourceSettings key={user!.id} />
          <section class="im-settings-section">
            <h3>个人资料</h3>
            <div class="im-avatar-controls">
              <label class="secondary im-import-sticker">
                更换头像
                <input
                  type="file"
                  aria-label="更换头像"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  disabled={busy}
                  onChange={(e) => {
                    const file = (e.currentTarget as HTMLInputElement).files?.[0];
                    (e.currentTarget as HTMLInputElement).value = '';
                    if (!file) return;
                    void run(async () => {
                      if (file.size > 2 * 1024 * 1024) throw Error('头像不能超过 2 MB');
                      const response = await fetch('/api/im/me/avatar', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: file,
                      });
                      const body = await response.json();
                      if (!response.ok) throw Error(body.error);
                      updateProfile(body.user);
                      setNotice('头像已更新');
                    });
                  }}
                />
              </label>
              {user?.avatarUrl && (
                <button
                  class="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await messaging.request<{ user: ChatUser }>('/me/avatar', 'DELETE');
                      updateProfile(result.user);
                    })
                  }
                >
                  移除头像
                </button>
              )}
              <small>自动裁切为方形 · 最大 2 MB</small>
            </div>
            <form
              class="im-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const result = await messaging.request<{ user: ChatUser }>('/me', 'PATCH', {
                    displayName: name,
                  });
                  updateProfile(result.user);
                  setNotice('已保存');
                });
              }}
            >
              <label>
                昵称
                <input
                  maxlength={60}
                  required
                  value={name}
                  onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <button class="primary" disabled={busy || !name.trim()}>
                保存
              </button>
            </form>
            <p class="im-help">UID 和用户名用于识别你的账号，接入 Agent 时会自动建立联系。</p>
          </section>
          <section class="im-settings-section">
            <h3>账户安全</h3>
            <button class="im-setting-row" onClick={() => setPasswordOpen(!passwordOpen)}>
              <Icon name="shield" />
              <span>修改密码</span>
              <Icon name={passwordOpen ? 'down' : 'chevron'} size={18} />
            </button>
            {passwordOpen && (
              <form
                class="im-form im-password-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget as HTMLFormElement,
                    data = new FormData(form);
                  if (data.get('newPassword') !== data.get('confirm')) {
                    setError('两次新密码不一致');
                    return;
                  }
                  void run(async () => {
                    await messaging.account.changePassword(
                      String(data.get('currentPassword')),
                      String(data.get('newPassword')),
                    );
                    const { rememberAccount } = await import('../account-session');
                    await rememberAccount(messaging.account);
                    form.reset();
                    setPasswordOpen(false);
                    setNotice('密码已修改，其他设备已退出登录');
                  });
                }}
              >
                <label>
                  当前密码
                  <input
                    name="currentPassword"
                    type="password"
                    autocomplete="current-password"
                    minlength={10}
                    maxlength={128}
                    required
                  />
                </label>
                <label>
                  新密码
                  <input
                    name="newPassword"
                    type="password"
                    autocomplete="new-password"
                    minlength={10}
                    maxlength={128}
                    required
                  />
                </label>
                <label>
                  确认新密码
                  <input
                    name="confirm"
                    type="password"
                    autocomplete="new-password"
                    minlength={10}
                    maxlength={128}
                    required
                  />
                </label>
                <button class="primary" disabled={busy}>
                  更新密码
                </button>
              </form>
            )}
            <button class="im-setting-row" onClick={() => setConfirm(true)}>
              <Icon name="monitor" />
              <span>退出其他设备</span>
              <Icon name="chevron" size={18} />
            </button>
            <p class="im-help">
              密码用于解锁云端密文。修改密码会生成新的恢复码。退出其他设备会撤销账号登录；已授权电脑的配对可在设备管理中解除。
            </p>
          </section>
          <ErrorNotice text={error} />
          {notice && (
            <p class="im-notice success" role="status">
              {notice}
            </p>
          )}
          <button
            class="danger im-logout"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await messaging.request('/logout', 'POST', {});
                setUser(null);
                navigate({ page: 'messages' });
              })
            }
          >
            退出登录
          </button>
        </div>
        {confirm && (
          <Confirm
            title="退出其他设备"
            onCancel={() => setConfirm(false)}
            onConfirm={async () => {
              await messaging.request('/logout-others', 'POST');
              setNotice('其他设备已退出登录');
            }}
          >
            {() => <>其他浏览器需要重新登录，当前设备继续使用。</>}
          </Confirm>
        )}
      </>
    );
  };
});
