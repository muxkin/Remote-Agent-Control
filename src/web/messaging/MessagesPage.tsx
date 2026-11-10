import { tsxComponent } from '../tsx-component';
import { shallowRef, defineAsyncComponent as lazy, Suspense } from 'vue';
import { writeRef } from '../render-effects';

import { Icon } from '../Icon';
import { DirectoryRow, DirectoryControls } from '../shell/Directory';
import { messaging, useMessaging } from './context';
import { ConversationAvatar, Avatar, Dialog, Empty, Notice, errorText, time, type Navigate } from './ui';
import { CreateGroup } from './Groups';
const ChatView = lazy(() => import('./ChatView'));
export default tsxComponent(function MessagesPage(_props: { id?: string; navigate: Navigate }) {
  const qState = shallowRef('');
  const setQ = writeRef(qState);
  const filterState = shallowRef('all');
  const setFilter = writeRef(filterState);
  const newChatState = shallowRef(false);
  const setNewChat = writeRef(newChatState);
  const groupState = shallowRef(false);
  const setGroup = writeRef(groupState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  return ({ id, navigate }) => {
    const { humanContacts, conversations, contacts } = useMessaging();
    const q = qState.value;
    const filter = filterState.value;
    const newChat = newChatState.value;
    const group = groupState.value;
    const error = errorState.value;
    const visible = conversations.filter(
      (c) =>
        (filter !== 'unread' || c.unread > 0) &&
        (filter !== 'group' || c.kind === 'group') &&
        `${c.name} ${c.peer?.username ?? ''} ${c.peer?.id ?? ''} ${c.lastMessage?.text ?? ''} ${c.lastMessage?.interaction?.title ?? ''}`
          .toLowerCase()
          .includes(q.toLowerCase()),
    );
    return (
      <div class={`im-messages-layout ${id ? 'has-chat' : ''}`}>
        <aside class="im-conversation-sidebar directory-sidebar">
          <DirectoryControls
            title="消息"
            action={
              <button
                class="icon-button directory-add"
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
          <div class="directory-scroll">
            <div class="directory-panel im-conversation-list">
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
                    <span class={c.lastMessage?.state === 'streaming' ? 'im-stream-preview' : ''}>
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
                      <b class="im-badge" aria-label={`${c.unread} 条未读`}>
                        {c.unread > 99 ? '99+' : c.unread}
                      </b>
                    ) : undefined
                  }
                />
              ))}
              {!visible.length && (
                <div class="im-list-hint">
                  <p>{conversations.length ? '没有匹配的会话' : '还没有聊天记录'}</p>
                  <button class="secondary" onClick={() => setNewChat(true)}>
                    开始聊天
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>
        <div class="im-chat-container">
          {id ? (
            <Suspense timeout={0}>
              {{
                fallback: () => <div class="page-loading">正在打开聊天…</div>,
                default: () => (
                  <>
                    <ChatView key={id} id={id} navigate={navigate} />
                  </>
                ),
              }}
            </Suspense>
          ) : (
            <Empty
              title="开始一段新对话"
              action={
                <div class="im-empty-actions">
                  <button class="primary" onClick={() => setNewChat(true)}>
                    发起聊天
                  </button>
                  <button class="secondary" onClick={() => navigate({ page: 'integrations' })}>
                    接入 Agent
                  </button>
                </div>
              }
            >
              {() => (
                <>
                  与 Agent 分享想法、文件与进展。
                  <br />
                  选择左侧会话，或开始一段新对话。
                </>
              )}
            </Empty>
          )}
        </div>
        {newChat && (
          <Dialog title="发起聊天" onClose={() => setNewChat(false)}>
            {() => (
              <>
                <button
                  class="im-setting-row"
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
                  class="im-setting-row"
                  onClick={() => {
                    setNewChat(false);
                    navigate({ page: humanContacts ? 'contacts' : 'integrations' });
                  }}
                >
                  <Icon name="plusCircle" />
                  <span>{humanContacts ? '添加联系人' : '接入 Agent'}</span>
                  <Icon name="chevron" size={18} />
                </button>
                <div class="im-picker-list">
                  {contacts
                    .filter((c) => !c.blocked)
                    .map((c) => (
                      <button
                        key={c.id}
                        class="im-person-row"
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
              </>
            )}
          </Dialog>
        )}
        {group && <CreateGroup navigate={navigate} onClose={() => setGroup(false)} />}
      </div>
    );
  };
});
