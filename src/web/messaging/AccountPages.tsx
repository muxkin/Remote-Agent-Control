import { useEffect, useState, type FormEvent } from 'react';
import type { ChatUser } from '../../shared/messaging';
import { PageHeader } from '../shell/AppShell';
import { Icon } from '../Icon';
import { messaging, useMessaging } from './context';
import { Avatar, UserIdentity, Notice as ErrorNotice, Confirm, errorText, time, type Navigate } from './ui';
export function AccountForm() {
  const { setUser } = useMessaging();
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [requiresCode, setRequiresCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void messaging
      .request<{ registrationRequiresCode: boolean }>('/status')
      .then((v) => setRequiresCode(v.registrationRequiresCode))
      .catch(() => {});
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await messaging.request<{ user: ChatUser }>(
        `/${mode}`,
        'POST',
        Object.fromEntries(data.entries()),
      );
      setUser(result.user);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="im-account">
      <span className="empty-symbol">
        <Icon name="chat" size={38} />
      </span>
      <h2>和 Agent 保持联系</h2>
      <p>创建自己的账户，把 Agent 和朋友添加为联系人。无需邮箱或手机号。</p>
      <div className="im-tabs" role="group" aria-label="账户操作">
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
      </div>
      <form className="im-form" onSubmit={submit}>
        {mode === 'register' && (
          <label>
            昵称
            <input name="displayName" required maxLength={60} autoComplete="nickname" />
          </label>
        )}
        <label>
          {mode === 'register' ? '用户名' : 'UID 或用户名'}
          <input
            key={mode}
            name={mode === 'register' ? 'username' : 'identifier'}
            required
            minLength={mode === 'register' ? 3 : undefined}
            maxLength={mode === 'register' ? 32 : undefined}
            pattern={mode === 'register' ? '(?=.*[a-zA-Z])[a-zA-Z0-9][a-zA-Z0-9_\\-]{2,31}' : undefined}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={mode === 'register' ? '例如 chatuser' : '输入 UID 或 @用户名'}
          />
        </label>
        {mode === 'register' && (
          <small>3–32 位字母、数字、横线或下划线，至少一个字母。注册后自动获得永久 UID。</small>
        )}
        <label>
          密码
          <input
            name="password"
            type="password"
            required
            minLength={10}
            maxLength={128}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            placeholder="至少 10 位"
          />
        </label>
        {mode === 'register' && requiresCode && (
          <label>
            注册码
            <input name="registrationCode" required autoComplete="off" />
          </label>
        )}
        <ErrorNotice text={error} />
        <button className="primary" disabled={busy}>
          {busy ? '请稍候…' : mode === 'register' ? '创建账户' : '登录账户'}
        </button>
      </form>
    </section>
  );
}
export function Agents({ navigate }: { navigate: Navigate }) {
  const [agents, setAgents] = useState<ChatUser[]>([]),
    [invitation, setInvitation] = useState<{ invitation: string; expiresAt: number }>();
  const [credential, setCredential] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{ id: string; rotate: boolean }>();
  const { revision } = useMessaging();
  useEffect(() => {
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
    ? `请使用以下一次性邀请注册为我的聊天 Agent（15 分钟有效）。\nPOST ${location.origin}/api/im/agents/register\nContent-Type: application/json\n\n${JSON.stringify({ invitation: invitation.invitation, username: 'my-agent', displayName: '我的助手' }, null, 2)}\n\n用户名请改为唯一值。返回的 user.id 是永久数字 UID（字符串），请勿转成数值；user.address 是完整账号标识。保存返回的 token；后续请求使用 Authorization: Bearer <token>。\n通过 POST /api/im/conversations {"userId":"<返回的 owner.id>"} 创建会话，POST /api/im/conversations/<id>/messages {"clientId":"<唯一请求标识>","text":"你好"} 发送消息，GET /api/im/sync?cursor=0&wait=25000 接收更新，更新事件内包含 message 快照。\n\n流式回复：POST messages 时加 "state":"streaming"，然后 PATCH /api/im/conversations/<id>/messages/<messageId>，提交 {"revision":1,"text":"当前完整内容","state":"streaming"}；版本逐次加一，结束用 "state":"complete"。收到 cancelled 或 409 时停止。\n支持 Markdown、引用回复 replyTo、附件 attachmentIds 与群内 mentions。群聊 GET /api/im/conversations，建群 POST /api/im/groups {"name":"讨论组","userIds":["<联系人 ID>"]}。\n问题与授权：发送消息时附加 interaction，例如 {"kind":"approval","recipientId":"<owner.id>","title":"确认操作","description":"具体动作与影响"}；问题改为 kind:"question" 并附 questions:[{id:"q1",header:"选择",question:"如何继续？",options:[{label:"继续",description:"按当前方案"}]}]。收到 message.updated 后读取 message.interaction；仅 status:"approved" 且 respondedBy 为指定用户时才执行该次操作，rejected/cancelled/expired 均应停止。普通文字回复不算授权。\n接收更新后保存并使用返回的 cursor 继续同步，按消息 ID 与 revision 去重，不要回复自己的消息。音频通过附件收发，Emoji 直接放入 text，表情包可用 stickerId 发送。\n使用仓库 CLI 时运行 npm run im -- help 查看 request、表情、群聊、流式更新、附件与搜索命令。`
    : '';
  return (
    <>
      <PageHeader title="Agent 接入" back={() => navigate({ page: 'contacts' })} />
      <section className="im-agent-content">
        <div className="im-profile-heading">
          <span className="im-agent-symbol">
            <Icon name="chat" size={30} />
          </span>
          <div>
            <h2>让你的 Agent 加入聊天</h2>
            <p>一个邀请，连接你正在使用的助手。</p>
          </div>
        </div>
        <ol className="im-onboarding-steps">
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
          className="primary"
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
          <div className="im-secret">
            <strong>有效至 {time(invitation.expiresAt)}</strong>
            <p>重新生成会使旧邀请失效；邀请使用一次即失效。</p>
            <textarea aria-label="Agent 注册说明" value={instructions} readOnly rows={9} />
            <button
              className="secondary"
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
          <div className="im-secret">
            <strong>新凭据仅在这里显示</strong>
            <p>交给对应 Agent 保存后，关闭此区域。</p>
            <textarea aria-label="Agent 新凭据" value={credential} readOnly rows={2} />
            <button className="secondary" onClick={() => setCredential('')}>
              已保存，关闭
            </button>
          </div>
        )}
        <h3>我的 Agent</h3>
        {!agents.length && <p>注册成功的 Agent 会出现在这里。</p>}
        {agents.map((agent) => (
          <div className="im-agent-row" key={agent.id}>
            <Avatar user={agent} />
            <span>
              <strong>{agent.displayName}</strong>
              <small>
                UID {agent.id} · @{agent.username}
              </small>
            </span>
            <button className="secondary" onClick={() => setConfirm({ id: agent.id, rotate: true })}>
              重置凭据
            </button>
            <button className="danger" onClick={() => setConfirm({ id: agent.id, rotate: false })}>
              撤销
            </button>
          </div>
        ))}
        {confirm && (
          <div className="inline-confirm">
            <p>
              {confirm.rotate
                ? '重置后，原凭据立即失效。请将新凭据交给此 Agent。'
                : '撤销后，此 Agent 无法继续收发消息；聊天记录会保留。可以重置凭据恢复使用。'}
            </p>
            <div>
              <button className="secondary" disabled={busy} onClick={() => setConfirm(undefined)}>
                取消
              </button>
              <button
                className="danger"
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
}
export function Profile({ navigate }: { navigate: Navigate }) {
  const { user, setUser } = useMessaging(),
    [name, setName] = useState(user!.displayName),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [passwordOpen, setPasswordOpen] = useState(false),
    [confirm, setConfirm] = useState(false);
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
      <div className="im-settings-content">
        <div className="im-profile-heading">
          <Avatar user={user} large />
          <div>
            <h2>{user!.displayName}</h2>
            <p>@{user!.username}</p>
          </div>
        </div>
        <UserIdentity user={user!} />
        <section className="im-settings-section">
          <h3>个人资料</h3>
          <div className="im-avatar-controls">
            <label className="secondary im-import-sticker">
              更换头像
              <input
                type="file"
                aria-label="更换头像"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
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
                    setUser(body.user);
                    setNotice('头像已更新');
                  });
                }}
              />
            </label>
            {user?.avatarUrl && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await messaging.request<{ user: ChatUser }>('/me/avatar', 'DELETE');
                    setUser(result.user);
                  })
                }
              >
                移除头像
              </button>
            )}
            <small>自动裁切为方形 · 最大 2 MB</small>
          </div>
          <form
            className="im-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await messaging.request<{ user: ChatUser }>('/me', 'PATCH', {
                  displayName: name,
                });
                setUser(result.user);
                setNotice('已保存');
              });
            }}
          >
            <label>
              昵称
              <input maxLength={60} required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button className="primary" disabled={busy || !name.trim()}>
              保存
            </button>
          </form>
          <p className="im-help">分享 UID 或 @用户名，朋友就可以添加你。</p>
        </section>
        <section className="im-settings-section">
          <h3>账户安全</h3>
          <button className="im-setting-row" onClick={() => setPasswordOpen(!passwordOpen)}>
            <Icon name="shield" />
            <span>修改密码</span>
            <Icon name={passwordOpen ? 'down' : 'chevron'} size={18} />
          </button>
          {passwordOpen && (
            <form
              className="im-form im-password-form"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  data = new FormData(form);
                if (data.get('newPassword') !== data.get('confirm')) {
                  setError('两次新密码不一致');
                  return;
                }
                void run(async () => {
                  await messaging.request('/password', 'POST', {
                    currentPassword: data.get('currentPassword'),
                    newPassword: data.get('newPassword'),
                  });
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
                  autoComplete="current-password"
                  minLength={10}
                  maxLength={128}
                  required
                />
              </label>
              <label>
                新密码
                <input
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={128}
                  required
                />
              </label>
              <label>
                确认新密码
                <input
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={128}
                  required
                />
              </label>
              <button className="primary" disabled={busy}>
                更新密码
              </button>
            </form>
          )}
          <button className="im-setting-row" onClick={() => setConfirm(true)}>
            <Icon name="monitor" />
            <span>退出其他设备</span>
            <Icon name="chevron" size={18} />
          </button>
          <p className="im-help">仅管理消息账户，不影响电脑的设备配对。</p>
        </section>
        <ErrorNotice text={error} />
        {notice && (
          <p className="im-notice success" role="status">
            {notice}
          </p>
        )}
        <button
          className="danger im-logout"
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
          其他浏览器需要重新登录，当前设备继续使用。
        </Confirm>
      )}
    </>
  );
}
