import { useState } from 'react';
import type { ChatConversation } from '../../shared/messaging';
import { messaging, useMessaging } from './context';
import { Avatar, Confirm, Dialog, Notice, errorText, type Navigate } from './ui';
export function CreateGroup({
  navigate,
  onClose,
  initial = [],
}: {
  navigate: Navigate;
  onClose: () => void;
  initial?: string[];
}) {
  const { contacts } = useMessaging(),
    [name, setName] = useState(''),
    [ids, setIds] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog title="新建群聊" onClose={onClose}>
      <form
        className="im-form"
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
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如 研究讨论组"
          />
        </label>
        <p className="im-help">选择联系人加入。新成员可以查看群历史；群主可管理成员。</p>
        <div className="im-picker" aria-label="选择群成员">
          {contacts
            .filter((c) => !c.blocked)
            .map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(c.id)}
                  onChange={(e) =>
                    setIds((old) => (e.target.checked ? [...old, c.id] : old.filter((id) => id !== c.id)))
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
        <button className="primary" disabled={busy || !name.trim() || !ids.length}>
          {busy ? '正在创建…' : `创建群聊${ids.length ? `（${ids.length + 1} 人）` : ''}`}
        </button>
      </form>
    </Dialog>
  );
}
export function GroupDetails({
  conversation,
  onClose,
  navigate,
}: {
  conversation: ChatConversation;
  onClose: () => void;
  navigate: Navigate;
}) {
  const { user, contacts } = useMessaging(),
    [name, setName] = useState(conversation.name),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    text: string;
    change: object;
    leave?: boolean;
  }>();
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
      <form
        className="im-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run({ name });
        }}
      >
        <label>
          群名称
          <input
            value={name}
            maxLength={80}
            required
            disabled={!owner || conversation.closed}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {owner && !conversation.closed && (
          <button className="secondary" disabled={busy || !name.trim()}>
            保存
          </button>
        )}
      </form>
      <p className="im-help">
        {conversation.members.length} 位成员{conversation.closed ? ' · 已解散，只能阅读历史' : ''}
      </p>
      <div className="im-member-list">
        {conversation.members.map((member) => (
          <div className="im-member" key={member.id}>
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
                  className="secondary"
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
                  className="danger"
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
        <section className="im-settings-section">
          <h3>添加成员</h3>
          <div className="im-picker">
            {contacts
              .filter((c) => !c.blocked && !conversation.members.some((m) => m.id === c.id))
              .map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked ? [...old, c.id] : old.filter((id) => id !== c.id),
                      )
                    }
                  />
                  <span>{c.remark || c.displayName}</span>
                </label>
              ))}
          </div>
          <button
            className="secondary"
            disabled={!selected.length || busy}
            onClick={() => void run({ add: selected })}
          >
            添加所选联系人
          </button>
        </section>
      )}
      <Notice text={error} />
      <div className="im-dialog-actions">
        {owner && !conversation.closed ? (
          <button
            className="danger"
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
            className="danger"
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
          {confirmation.text}
        </Confirm>
      )}
    </Dialog>
  );
}
