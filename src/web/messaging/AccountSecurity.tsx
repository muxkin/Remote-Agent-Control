import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import { messaging, useMessaging } from './context';
import { rememberAccount } from '../account-session';
import './messaging.css';
import { Icon } from '../Icon';
import { RecoveryCode } from './RecoveryCode';
import './account-security.css';

export function AccountSecurity({ children }: { children: ReactNode }) {
  const { user, setUser, loading } = useMessaging();
  const [, redraw] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => messaging.account.onChange(() => redraw((v) => v + 1)), []);
  const account = messaging.account;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      redraw((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '账号操作失败');
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await run(async () => {
      if (!user) return;
      if (account.recoveryLogin) {
        if (data.get('newPassword') !== data.get('confirm')) throw Error('两次密码不一致');
        await account.changePassword(account.recoveryLogin, String(data.get('newPassword')), true);
        account.recoveryLogin = '';
        await rememberAccount(account);
        setUser(user);
      } else {
        const result = await account.login(user.id, String(data.get('password')));
        setUser(result.user);
      }
    });
  }
  if (loading)
    return (
      <main className="module-page">
        <p className="page-loading" role="status">
          正在解锁和同步账号…
        </p>
      </main>
    );
  if (!user) return children;
  const recovery = !!account.recoveryCode && !account.recoveryLogin;
  if (account.secrets && !recovery && !account.recoveryLogin) return children;
  return (
    <main className="module-page account-security-page">
      <section className="im-account account-security-panel">
        <span className="account-security-symbol">
          <Icon name="shield" size={36} />
        </span>
        <h2>{recovery ? '保存恢复码' : account.recoveryLogin ? '设置新的账号密码' : '解锁账号'}</h2>
        <p>
          {recovery
            ? '忘记密码时，用它找回账号和加密数据。请保存在密码管理器或安全位置，服务器无法代为找回。'
            : '解锁后即可恢复你的电脑和聊天记录。'}
        </p>
        {recovery ? (
          <RecoveryCode
            key={account.recoveryCode}
            code={account.recoveryCode}
            busy={busy}
            onContinue={() => {
              account.recoveryCode = '';
              account.changed();
            }}
          />
        ) : (
          <form className="im-form" onSubmit={submit}>
            {!account.recoveryLogin && (
              <label>
                账号密码
                <input
                  name="password"
                  type="password"
                  required
                  minLength={10}
                  maxLength={128}
                  autoComplete="current-password"
                />
              </label>
            )}
            {account.recoveryLogin && (
              <>
                <label>
                  新密码
                  <input
                    name="newPassword"
                    type="password"
                    required
                    minLength={10}
                    maxLength={128}
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  确认新密码
                  <input
                    name="confirm"
                    type="password"
                    required
                    minLength={10}
                    maxLength={128}
                    autoComplete="new-password"
                  />
                </label>
              </>
            )}
            <button className="primary" disabled={busy}>
              {busy ? '正在处理…' : !account.recoveryLogin ? '解锁' : '设置密码'}
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          className="account-security-logout"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await messaging.raw('/logout', 'POST', {});
              setUser(null);
            })
          }
        >
          退出登录
        </button>
      </section>
    </main>
  );
}
