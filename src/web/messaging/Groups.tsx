import { tsxComponent } from '../tsx-component';
import { shallowRef } from 'vue';
import { writeRef } from '../render-effects';

import type { ChatConversation } from '../../shared/messaging';
import { messaging, useMessaging } from './context';
import { Avatar, Confirm, Dialog, Notice, errorText, type Navigate } from './ui';
export const CreateGroup = tsxComponent(function CreateGroup(initialProps: {
  navigate: Navigate;
  onClose: () => void;
  initial?: string[];
}) {
  const { initial = [] } = initialProps;

  const nameState = shallowRef('');
  const setName = writeRef(nameState);
  const idsState = shallowRef(initial);
  const setIds = writeRef(idsState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  return ({ navigate, onClose, initial = [] }) => {
    const { contacts } = useMessaging();
    const name = nameState.value;
    const ids = idsState.value;
    const busy = busyState.value;
    const error = errorState.value;
    return (
      <Dialog title="新建群聊" onClose={onClose}>
        {() => (
          <>
            <form
              class="im-form"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                void messaging
                  .group(name, ids)
                  .then(({ conversation }) => {
                    navigate({ page: 'messages', conversation: conversation.id });
                    onClose();
                  })
                  .catch((e) => setError(errorText(e)))
                  .finally(() => setBusy(false));
              }}
            >
              <label>
                群名称
                <input
                  required
                  maxlength={80}
                  value={name}
                  onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
                  placeholder="例如 研究讨论组"
                />
              </label>
              <p class="im-help">
                选择已启用加密的联系人加入。新成员可解密加入后发送的消息；群主可管理成员。
              </p>
              <div class="im-picker" aria-label="选择群成员">
                {contacts
                  .filter((c) => !c.blocked)
                  .map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={ids.includes(c.id)}
                        onChange={(e) =>
                          setIds((old) =>
                            (e.currentTarget as HTMLInputElement).checked
                              ? [...old, c.id]
                              : old.filter((id) => id !== c.id),
                          )
                        }
                      />
                      <Avatar user={c} />
                      <span>
                        {c.remark || c.displayName}
                        <small>
                          @{c.username}
                          {c.kind === 'agent' ? ' · Agent' : ''}
                        </small>
                      </span>
                    </label>
                  ))}
              </div>
              <Notice text={error} />
              <button class="primary" disabled={busy || !name.trim() || !ids.length}>
                {busy ? '正在创建…' : `创建群聊${ids.length ? `（${ids.length + 1} 人）` : ''}`}
              </button>
            </form>
          </>
        )}
      </Dialog>
    );
  };
});
export const GroupDetails = tsxComponent(function GroupDetails(initialProps: {
  conversation: ChatConversation;
  onClose: () => void;
  navigate: Navigate;
}) {
  const { conversation } = initialProps;

  const nameState = shallowRef(conversation.name);
  const setName = writeRef(nameState);
  const selectedState = shallowRef<string[]>([]);
  const setSelected = writeRef(selectedState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const confirmationState = shallowRef<{
    title: string;
    text: string;
    change: object;
    leave?: boolean;
  }>();
  const setConfirmation = writeRef(confirmationState);
  return ({ conversation, onClose, navigate }) => {
    const { user, contacts } = useMessaging();
    const name = nameState.value;
    const selected = selectedState.value;
    const error = errorState.value;
    const busy = busyState.value;
    const confirmation = confirmationState.value;
    const owner = conversation.ownerId === user!.id;
    async function update(change: object) {
      await messaging.request(`/groups/${conversation.id}`, 'PATCH', change);
    }
    async function run(change: object) {
      setBusy(true);
      setError('');
      try {
        await update(change);
        setSelected([]);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    }
    return (
      <Dialog title="群资料与成员" onClose={onClose}>
        {() => (
          <>
            <form
              class="im-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run({ name });
              }}
            >
              <label>
                群名称
                <input
                  value={name}
                  maxlength={80}
                  required
                  disabled={!owner || conversation.closed}
                  onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              {owner && !conversation.closed && (
                <button class="secondary" disabled={busy || !name.trim()}>
                  保存
                </button>
              )}
            </form>
            <p class="im-help">
              {conversation.members.length} 位成员{conversation.closed ? ' · 已解散，只能阅读历史' : ''}
            </p>
            <div class="im-member-list">
              {conversation.members.map((member) => (
                <div class="im-member" key={member.id}>
                  <Avatar user={member} />
                  <span>
                    <strong>{member.displayName}</strong>
                    <small>
                      @{member.username} ·{' '}
                      {member.role === 'owner' ? '群主' : member.kind === 'agent' ? 'Agent' : '成员'}
                    </small>
                  </span>
                  {owner && member.id !== user!.id && !conversation.closed && (
                    <>
                      <button
                        class="secondary"
                        onClick={() =>
                          setConfirmation({
                            title: '转让群主',
                            text: `将群主转让给 ${member.displayName}？`,
                            change: { ownerId: member.id },
                          })
                        }
                      >
                        转让
                      </button>
                      <button
                        class="danger"
                        aria-label={`移除成员 ${member.displayName}`}
                        onClick={() =>
                          setConfirmation({
                            title: '移除成员',
                            text: `移除 ${member.displayName} 后，对方将不能访问此群的消息和附件。`,
                            change: { remove: member.id },
                          })
                        }
                      >
                        移除
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            {owner && !conversation.closed && (
              <section class="im-settings-section">
                <h3>添加成员</h3>
                <div class="im-picker">
                  {contacts
                    .filter((c) => !c.blocked && !conversation.members.some((m) => m.id === c.id))
                    .map((c) => (
                      <label key={c.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(c.id)}
                          onChange={(e) =>
                            setSelected((old) =>
                              (e.currentTarget as HTMLInputElement).checked
                                ? [...old, c.id]
                                : old.filter((id) => id !== c.id),
                            )
                          }
                        />
                        <span>{c.remark || c.displayName}</span>
                      </label>
                    ))}
                </div>
                <button
                  class="secondary"
                  disabled={!selected.length || busy}
                  onClick={() => void run({ add: selected })}
                >
                  添加所选联系人
                </button>
              </section>
            )}
            <Notice text={error} />
            <div class="im-dialog-actions">
              {owner && !conversation.closed ? (
                <button
                  class="danger"
                  onClick={() =>
                    setConfirmation({
                      title: '解散群聊',
                      text: '解散后成员保留历史阅读权限，不能再发送新消息。正在输出的回复将停止。',
                      change: { closed: true },
                    })
                  }
                >
                  解散群聊
                </button>
              ) : (
                <button
                  class="danger"
                  onClick={() =>
                    setConfirmation({
                      title: '退出群聊',
                      text: '退出后你将无法访问此群的历史与附件。',
                      change: { remove: user!.id },
                      leave: true,
                    })
                  }
                >
                  退出群聊
                </button>
              )}
            </div>
            {confirmation && (
              <Confirm
                title={confirmation.title}
                onCancel={() => setConfirmation(undefined)}
                onConfirm={async () => {
                  await update(confirmation.change);
                  if (confirmation.leave) {
                    onClose();
                    navigate({ page: 'messages' });
                  }
                }}
              >
                {() => <>{confirmation.text}</>}
              </Confirm>
            )}
          </>
        )}
      </Dialog>
    );
  };
});
