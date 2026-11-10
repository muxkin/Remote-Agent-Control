import { writeRef } from '../render-effects';
import { tsxComponent } from '../tsx-component';
import { shallowRef, type VNodeChild } from 'vue';

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
export const Avatar = tsxComponent(function Avatar(_props: {
  user?: Pick<ChatUser, 'displayName' | 'kind' | 'avatarUrl'> | null;
  group?: boolean;
  large?: boolean;
}) {
  return ({ user, group = false, large = false }) => {
    return (
      <span
        class={`im-avatar ${large ? 'large' : ''} ${group ? 'group' : (user?.kind ?? '')}`}
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
  };
});
export const ConversationAvatar = tsxComponent(function ConversationAvatar(_props: {
  conversation: ChatConversation;
}) {
  return ({ conversation }) => {
    return <Avatar user={conversation.peer} group={conversation.kind === 'group'} />;
  };
});
export const Notice = tsxComponent(function Notice(_props: { text: string; status?: boolean }) {
  return ({ text, status = false }) => {
    return text ? (
      <p class={`im-notice ${status ? 'success' : ''}`} role={status ? 'status' : 'alert'}>
        {text}
      </p>
    ) : null;
  };
});
export const Empty = tsxComponent(function Empty(_props: {
  icon?: 'chat' | 'contacts' | 'puzzle';
  title: string;
  children?: VNodeChild;
  action?: VNodeChild;
}) {
  return ({ icon = 'chat', title, children, action }) => {
    return (
      <section class="im-empty">
        <span class="empty-symbol">
          <Icon name={icon} size={34} />
        </span>
        <h2>{title}</h2>
        <p>{children}</p>
        {action}
      </section>
    );
  };
});
export const Confirm = tsxComponent(function Confirm(_props: {
  title: string;
  children?: VNodeChild;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  return ({ title, children, onCancel, onConfirm }) => {
    const busy = busyState.value;
    const error = errorState.value;
    return (
      <Dialog
        title={title}
        onClose={() => {
          if (!busy) onCancel();
        }}
      >
        {() => (
          <>
            <p>{children}</p>
            <Notice text={error} />
            <div class="im-dialog-actions">
              <button class="secondary" disabled={busy} onClick={onCancel}>
                取消
              </button>
              <button
                class="primary"
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
          </>
        )}
      </Dialog>
    );
  };
});

/** Identical account sharing controls on profile and contact detail screens. */
export const UserIdentity = tsxComponent(function UserIdentity(_props: {
  user: Pick<ChatUser, 'id' | 'address'>;
}) {
  const noticeState = shallowRef('');
  const setNotice = writeRef(noticeState);
  return ({ user }) => {
    const notice = noticeState.value;
    async function copy(value: string) {
      try {
        await navigator.clipboard.writeText(value);
        setNotice('已复制');
      } catch {
        setNotice('请选中账号标识手动复制');
      }
    }
    return (
      <div class="im-user-identity">
        <div>
          <span>UID</span>
          <code aria-label="UID">{user.id}</code>
          <button
            class="icon-button"
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
            class="icon-button"
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
  };
});
