import { useState } from 'react';
import type { ChatContact } from '../../shared/messaging';
import { Icon } from '../Icon';
import { DirectoryRow, DirectoryControls } from '../shell/Directory';
import { messaging, useMessaging } from './context';
import { Avatar, UserIdentity, Confirm, Dialog, Empty, Notice, errorText, type Navigate } from './ui';
import { CreateGroup } from './Groups';
export default function ContactsPage({ navigate }: { navigate: Navigate }) {
  const { contacts } = useMessaging(),
    [q, setQ] = useState(''),
    [filter, setFilter] = useState('all'),
    [selected, setSelected] = useState(''),
    [adding, setAdding] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [group, setGroup] = useState(false);
  const selectedContact = contacts.find((c) => c.id === selected),
    visible = contacts.filter(
      (c) =>
        (filter === 'all' || c.kind === filter) &&
        `${c.remark} ${c.displayName} ${c.username} ${c.id} ${c.address}`
          .toLowerCase()
          .includes(q.toLowerCase()),
    );
  async function chat(id: string) {
    setBusy(true);
    setError('');
    try {
      const { conversation } = await messaging.direct(id);
      navigate({ page: 'messages', conversation: conversation.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`im-contacts-layout ${selectedContact ? 'has-selection' : ''}`}>
      <section className="im-contact-directory directory-sidebar">
        <DirectoryControls
          title="联系人"
          action={
            <button
              className="icon-button directory-add"
              aria-label="添加联系人"
              onClick={() => setAdding(true)}
            >
              <Icon name="plus" />
            </button>
          }
          searchLabel="搜索联系人"
          query={q}
          onQuery={setQ}
          filterLabel="联系人类型"
          filter={filter}
          onFilter={setFilter}
          options={[
            ['all', '全部'],
            ['agent', 'Agent'],
            ['human', '朋友'],
          ]}
        />
        <div className="directory-scroll">
          <div className="directory-panel im-contact-list">
            {visible.map((c) => (
              <DirectoryRow
                key={c.id}
                className="im-person-row"
                selected={selected === c.id}
                onClick={() => setSelected(c.id)}
                avatar={<Avatar user={c} />}
                title={c.remark || c.displayName}
                preview={c.blocked ? '已屏蔽私聊' : c.kind === 'agent' ? 'Agent' : `@${c.username}`}
                trailing={<Icon name="chevron" size={16} />}
              />
            ))}
            {!visible.length && (
              <p className="im-list-hint">
                {contacts.length ? '没有匹配的联系人' : '添加朋友，或邀请 Agent 加入'}
              </p>
            )}
          </div>
          <button
            aria-label="接入 Agent"
            className="directory-action"
            onClick={() => navigate({ page: 'integrations' })}
          >
            <span className="surface-icon">
              <Icon name="puzzle" size={22} />
            </span>
            <span className="directory-action-copy">
              <strong>接入 Agent</strong>
              <small>连接你的智能助手</small>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        </div>
      </section>
      <section className="im-contact-detail">
        {selectedContact ? (
          <>
            <button
              className="icon-button im-mobile-back"
              aria-label="返回联系人列表"
              onClick={() => setSelected('')}
            >
              <Icon name="back" />
            </button>
            <ContactDetail
              key={selectedContact.id}
              contact={selectedContact}
              busy={busy}
              chat={() => void chat(selectedContact.id)}
              group={() => setGroup(true)}
              removed={() => setSelected('')}
            />
          </>
        ) : (
          <Empty icon="contacts" title="与你的联系人保持联系">
            选择朋友或 Agent，查看资料并开始聊天。
          </Empty>
        )}
        <Notice text={error} />
      </section>
      {adding && (
        <Dialog title="添加联系人" onClose={() => setAdding(false)}>
          <form
            className="im-form"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const identifier = String(new FormData(e.currentTarget).get('identifier'));
              void messaging
                .addContact(identifier)
                .then(({ user }) => {
                  setSelected(user.id);
                  setAdding(false);
                })
                .catch((e) => setError(errorText(e)))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              UID 或用户名
              <input
                name="identifier"
                aria-label="UID 或用户名"
                required
                autoFocus
                autoCapitalize="none"
                placeholder="输入 UID 或 @用户名"
              />
            </label>
            <p className="im-help">无需邮箱或手机号。UID 和用户名可以在“我的 → 个人资料”中查看。</p>
            <Notice text={error} />
            <button className="primary" disabled={busy}>
              添加
            </button>
          </form>
        </Dialog>
      )}
      {group && selectedContact && (
        <CreateGroup navigate={navigate} initial={[selectedContact.id]} onClose={() => setGroup(false)} />
      )}
    </div>
  );
}
function ContactDetail({
  contact,
  busy,
  chat,
  group,
  removed,
}: {
  contact: ChatContact;
  busy: boolean;
  chat: () => void;
  group: () => void;
  removed: () => void;
}) {
  const [remark, setRemark] = useState(contact.remark),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    [confirmation, setConfirmation] = useState<'remove' | 'block'>();
  return (
    <div className="im-contact-profile">
      <Avatar user={contact} large />
      <h2>{contact.displayName}</h2>
      <p>
        @{contact.username}
        {contact.kind === 'agent' ? ' · Agent' : ''}
      </p>
      <UserIdentity user={contact} />
      <form
        className="im-form"
        onSubmit={(e) => {
          e.preventDefault();
          setSaving(true);
          void messaging
            .request(`/contacts/${contact.id}`, 'PATCH', { remark })
            .catch((e) => setError(errorText(e)))
            .finally(() => setSaving(false));
        }}
      >
        <label>
          备注
          <div className="im-remark-field">
            <input
              value={remark}
              maxLength={60}
              placeholder="仅对你可见"
              onChange={(e) => setRemark(e.target.value)}
            />
            <button
              type="submit"
              className="icon-button"
              aria-label="保存备注"
              disabled={saving || remark === contact.remark}
            >
              <Icon name="check" size={18} />
            </button>
          </div>
        </label>
      </form>
      <Notice text={error} />
      <button className="primary" onClick={chat} disabled={busy || contact.blocked}>
        <Icon name="chat" size={18} />
        发消息
      </button>
      <button className="secondary" onClick={group} disabled={contact.blocked}>
        <Icon name="contacts" size={18} />
        一起建群
      </button>
      <div className="im-contact-danger">
        <button className="danger" onClick={() => setConfirmation('remove')}>
          <Icon name="trash" size={18} />
          移除联系人
        </button>
        <button className={contact.blocked ? 'secondary' : 'danger'} onClick={() => setConfirmation('block')}>
          <Icon name="shield" size={18} />
          {contact.blocked ? '解除屏蔽' : '屏蔽私聊'}
        </button>
      </div>
      {confirmation && (
        <Confirm
          title={confirmation === 'remove' ? '移除联系人' : contact.blocked ? '解除屏蔽' : '屏蔽私聊'}
          onCancel={() => setConfirmation(undefined)}
          onConfirm={async () => {
            await messaging.request(
              `/contacts/${contact.id}`,
              confirmation === 'remove' ? 'DELETE' : 'PATCH',
              confirmation === 'remove' ? undefined : { blocked: !contact.blocked },
            );
            if (confirmation === 'remove') removed();
          }}
        >
          {confirmation === 'remove'
            ? '从通讯录移除，历史聊天仍会保留。'
            : contact.blocked
              ? '解除后双方可以继续发送私聊消息。'
              : '双方的私聊发送将被阻止；共同群聊不受影响。'}
        </Confirm>
      )}
    </div>
  );
}
