import { lazy, Suspense, useState } from 'react';
import { Icon } from '../Icon';
import { DirectoryRow, DirectoryControls } from '../shell/Directory';
import { messaging, useMessaging } from './context';
import { ConversationAvatar, Avatar, Dialog, Empty, Notice, errorText, time, type Navigate } from './ui';
import { CreateGroup } from './Groups';
const ChatView = lazy(() => import('./ChatView'));
export default function MessagesPage({ id, navigate }: { id?: string; navigate: Navigate }) {
  const { conversations, contacts } = useMessaging(),
    [q, setQ] = useState(''),
    [filter, setFilter] = useState('all'),
    [newChat, setNewChat] = useState(false),
    [group, setGroup] = useState(false),
    [error, setError] = useState('');
  const visible = conversations.filter(
    (c) =>
      (filter !== 'unread' || c.unread > 0) &&
      (filter !== 'group' || c.kind === 'group') &&
      `${c.name} ${c.peer?.username ?? ''} ${c.peer?.id ?? ''} ${c.lastMessage?.text ?? ''} ${c.lastMessage?.interaction?.title ?? ''}`
        .toLowerCase()
        .includes(q.toLowerCase()),
  );
  return (
    <div className={`im-messages-layout ${id ? 'has-chat' : ''}`}>
      <aside className="im-conversation-sidebar directory-sidebar">
        <DirectoryControls
          title="消息"
          action={
            <button
              className="icon-button directory-add"
              aria-label="新建聊天"
              onClick={() => setNewChat(true)}
            >
              <Icon name="plus" />
            </button>
          }
          searchLabel="搜索会话"
          query={q}
          onQuery={setQ}
          filterLabel="会话筛选"
          filter={filter}
          onFilter={setFilter}
          options={[
            ['all', '全部'],
            ['unread', '未读'],
            ['group', '群聊'],
          ]}
        />
        <div className="directory-scroll">
          <div className="directory-panel im-conversation-list">
            {visible.map((c) => (
              <DirectoryRow
                key={c.id}
                className="im-conversation-row"
                selected={c.id === id}
                onClick={() => navigate({ page: 'messages', conversation: c.id })}
                avatar={<ConversationAvatar conversation={c} />}
                title={c.name}
                meta={<time>{c.lastMessage ? time(c.lastMessage.updatedAt) : ''}</time>}
                preview={
                  <span className={c.lastMessage?.state === 'streaming' ? 'im-stream-preview' : ''}>
                    {c.closed
                      ? '群聊已解散'
                      : c.lastMessage?.state === 'streaming'
                        ? '正在回复…'
                        : c.lastMessage?.interaction
                          ? `[${c.lastMessage.interaction.kind === 'approval' ? '授权确认' : '问题'}] ${c.lastMessage.interaction.title}`
                          : c.lastMessage?.sticker
                            ? '[表情包]'
                            : c.lastMessage?.text.replace(/[#*`\n]/g, ' ').slice(0, 90) ||
                              (c.lastMessage?.attachments.some((f) => f.mime.startsWith('audio/'))
                                ? '[语音]'
                                : c.lastMessage?.attachments.length
                                  ? '[附件]'
                                  : '发送第一条消息')}
                  </span>
                }
                badge={
                  c.unread > 0 ? (
                    <b className="im-badge" aria-label={`${c.unread} 条未读`}>
                      {c.unread > 99 ? '99+' : c.unread}
                    </b>
                  ) : undefined
                }
              />
            ))}
            {!visible.length && (
              <div className="im-list-hint">
                <p>{conversations.length ? '没有匹配的会话' : '还没有聊天记录'}</p>
                <button className="secondary" onClick={() => setNewChat(true)}>
                  开始聊天
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
      <div className="im-chat-container">
        {id ? (
          <Suspense fallback={<div className="page-loading">正在打开聊天…</div>}>
            <ChatView key={id} id={id} navigate={navigate} />
          </Suspense>
        ) : (
          <Empty
            title="开始一段新对话"
            action={
              <div className="im-empty-actions">
                <button className="primary" onClick={() => setNewChat(true)}>
                  发起聊天
                </button>
                <button className="secondary" onClick={() => navigate({ page: 'integrations' })}>
                  接入 Agent
                </button>
              </div>
            }
          >
            与你的朋友和 Agent 分享想法、文件与进展。
            <br />
            选择左侧会话，或开始一段新对话。
          </Empty>
        )}
      </div>
      {newChat && (
        <Dialog title="发起聊天" onClose={() => setNewChat(false)}>
          <button
            className="im-setting-row"
            onClick={() => {
              setNewChat(false);
              setGroup(true);
            }}
          >
            <Icon name="contacts" />
            <span>新建群聊</span>
            <Icon name="chevron" size={18} />
          </button>
          <button
            className="im-setting-row"
            onClick={() => {
              setNewChat(false);
              navigate({ page: 'contacts' });
            }}
          >
            <Icon name="plusCircle" />
            <span>添加联系人</span>
            <Icon name="chevron" size={18} />
          </button>
          <div className="im-picker-list">
            {contacts
              .filter((c) => !c.blocked)
              .map((c) => (
                <button
                  key={c.id}
                  className="im-person-row"
                  onClick={() => {
                    void messaging
                      .direct(c.id)
                      .then(({ conversation }) => {
                        navigate({ page: 'messages', conversation: conversation.id });
                        setNewChat(false);
                      })
                      .catch((e) => setError(errorText(e)));
                  }}
                >
                  <Avatar user={c} />
                  <span>
                    <strong>{c.remark || c.displayName}</strong>
                    <small>@{c.username}</small>
                  </span>
                </button>
              ))}
          </div>
          <Notice text={error} />
        </Dialog>
      )}
      {group && <CreateGroup navigate={navigate} onClose={() => setGroup(false)} />}
    </div>
  );
}
