import { useState, type ReactNode } from 'react';
import { Dialog } from '../shell/Dialog';
export { Dialog } from '../shell/Dialog';
import { CachedImage } from './CachedImage';
import { Icon } from '../Icon';
import type { ChatUser, ChatConversation } from '../../shared/messaging';
import type { AppRoute } from '../shell/routes';
export type Navigate = (route: AppRoute, replace?: boolean) => void;
export const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作未完成，请重试');
export const time = (value: number) =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
export function Avatar({
  user,
  group = false,
  large = false,
}: {
  user?: Pick<ChatUser, 'displayName' | 'kind' | 'avatarUrl'> | null;
  group?: boolean;
  large?: boolean;
}) {
  return (
    <span
      className={`im-avatar ${large ? 'large' : ''} ${group ? 'group' : (user?.kind ?? '')}`}
      aria-hidden="true"
    >
      {group ? (
        <Icon name="contacts" />
      ) : user?.avatarUrl ? (
        <CachedImage src={user.avatarUrl} alt="" />
      ) : user?.kind === 'agent' ? (
        <Icon name="puzzle" />
      ) : (
        Array.from(user?.displayName ?? '我')[0]
      )}
    </span>
  );
}
export function ConversationAvatar({ conversation }: { conversation: ChatConversation }) {
  return <Avatar user={conversation.peer} group={conversation.kind === 'group'} />;
}
export function Notice({ text, status = false }: { text: string; status?: boolean }) {
  return text ? (
    <p className={`im-notice ${status ? 'success' : ''}`} role={status ? 'status' : 'alert'}>
      {text}
    </p>
  ) : null;
}
export function Empty({
  icon = 'chat',
  title,
  children,
  action,
}: {
  icon?: 'chat' | 'contacts' | 'puzzle';
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="im-empty">
      <span className="empty-symbol">
        <Icon name={icon} size={34} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </section>
  );
}
export function Confirm({
  title,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog
      title={title}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <p>{children}</p>
      <Notice text={error} />
      <div className="im-dialog-actions">
        <button className="secondary" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm()
              .then(onCancel)
              .catch((e) => setError(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? '处理中…' : '确认'}
        </button>
      </div>
    </Dialog>
  );
}

/** Identical account sharing controls on profile and contact detail screens. */
export function UserIdentity({ user }: { user: Pick<ChatUser, 'id' | 'address'> }) {
  const [notice, setNotice] = useState('');
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('已复制');
    } catch {
      setNotice('请选中账号标识手动复制');
    }
  }
  return (
    <div className="im-user-identity">
      <div>
        <span>UID</span>
        <code aria-label="UID">{user.id}</code>
        <button
          className="icon-button"
          aria-label="复制 UID"
          title="复制 UID"
          onClick={() => void copy(user.id)}
        >
          <Icon name="copy" size={16} />
        </button>
      </div>
      <div>
        <span>完整账号</span>
        <code aria-label="完整账号">{user.address}</code>
        <button
          className="icon-button"
          aria-label="复制完整账号"
          title="复制完整账号"
          onClick={() => void copy(user.address)}
        >
          <Icon name="copy" size={16} />
        </button>
      </div>
      {notice && <small role="status">{notice}</small>}
    </div>
  );
}
