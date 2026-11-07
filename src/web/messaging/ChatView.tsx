import { ConversationHeader } from '../shell/ConversationHeader';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatAttachment,
  ChatConversation,
  ChatMessage,
  SendMessageOptions,
} from '../../shared/messaging';
import { ChatComposer } from '../ChatComposer';
import { FileAttachment } from '../FileAttachment';
import { Media } from '../MediaAttachment';
import { AttachmentAccessContext, type AttachmentAccess } from '../AttachmentAccess';
import { Icon } from '../Icon';
import { browserId } from '../browser-id';
import { messaging, useMessaging } from './context';
import { readDraft, writeDraft, type MessagingDraft } from './drafts';
import { Avatar, Dialog, Notice, errorText, time, type Navigate } from './ui';
import { loadMessagingMedia } from './media-cache';
import { GroupDetails } from './Groups';
import { InteractionCard, CreateInteraction } from './InteractionCard';
const Expressions = lazy(() => import('./Expressions').then((m) => ({ default: m.Expressions })));
const VoiceRecorder = lazy(() => import('./VoiceRecorder').then((m) => ({ default: m.VoiceRecorder })));
const RichMessage = lazy(() => import('../RichMessage'));
function merge(old: ChatMessage[], next: ChatMessage[]) {
  const map = new Map(old.map((m) => [m.id, m]));
  for (const m of next) {
    if (!map.has(m.id) || map.get(m.id)!.revision <= m.revision) map.set(m.id, m);
  }
  return [...map.values()].sort((a, b) => a.sequence - b.sequence);
}
function Files({
  files,
  id,
  compact = false,
  onRemove,
}: {
  files: ChatAttachment[];
  id: string;
  compact?: boolean;
  onRemove?: (file: ChatAttachment) => void;
}) {
  return (
    <div className={`user-attachments im-files ${compact ? 'compact' : ''}`}>
      {files.map((file) =>
        /^(image|audio|video)\//.test(file.mime) ? (
          <Media
            key={file.id}
            src={file.url}
            mediaType={file.mime.split('/')[0] as 'image' | 'audio' | 'video'}
            label={file.name}
            threadId={id}
            compact={compact}
            onRemove={onRemove ? () => onRemove(file) : undefined}
          />
        ) : (
          <FileAttachment
            key={file.id}
            href={file.url}
            name={file.name}
            threadId={id}
            card
            compact={compact}
            onRemove={onRemove ? () => onRemove(file) : undefined}
          />
        ),
      )}
    </div>
  );
}
export default function ChatView({ id, navigate }: { id: string; navigate: Navigate }) {
  const { user, conversations, recovery, updates } = useMessaging(),
    conversation = conversations.find((c) => c.id === id);
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [before, setBefore] = useState<number>(),
    [draft, setDraft] = useState<MessagingDraft>(() => readDraft(id));
  const [tool, setTool] = useState<'expressions' | 'voice' | 'interaction'>();
  const [insertText, setInsertText] = useState<{ key: string; text: string }>();
  const [savedSticker, setSavedSticker] = useState('');
  const specialRequest = useRef<{ key: string; id: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [uploadProgress, setUploadProgress] = useState(''),
    [olderBusy, setOlderBusy] = useState(false);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [unavailable, setUnavailable] = useState(false),
    [visible, setVisible] = useState(document.visibilityState === 'visible');
  const [details, setDetails] = useState(false),
    [search, setSearch] = useState(false),
    [quoted, setQuoted] = useState<ChatMessage>(),
    [copied, setCopied] = useState(''),
    [following, setFollowing] = useState(true);
  const latest = useRef(0),
    scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    initialized = useRef(false),
    draftRef = useRef(draft),
    uploadAbort = useRef<AbortController | null>(null);
  const access = useMemo<AttachmentAccess>(
    () => ({
      async load(threadId, path, signal, fullSize) {
        const url = new URL(path, location.origin);
        if (
          url.origin !== location.origin ||
          threadId !== id ||
          !url.pathname.startsWith(`/api/im/conversations/${id}/files/`)
        )
          throw Error('请使用此会话中的附件');
        return loadMessagingMedia(user!.id, path, signal, fullSize);
      },
    }),
    [id, user!.id],
  );
  function change(update: Partial<MessagingDraft>) {
    const next = { ...draftRef.current, ...update };
    draftRef.current = next;
    setDraft(next);
    writeDraft(id, next);
  }
  useEffect(
    () => () => {
      uploadAbort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const listener = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const page = await messaging.history(id, undefined, abort.signal);
        let rows = page.messages,
          cursor = page.before;
        while (latest.current && cursor && rows[0]?.sequence > latest.current) {
          const p = await messaging.history(id, cursor, abort.signal);
          rows = [...p.messages, ...rows];
          cursor = p.before;
        }
        if (abort.signal.aborted) return;
        if (!initialized.current) {
          setBefore(cursor);
          initialized.current = true;
        }
        setMessages((old) => merge(old, rows));
        latest.current = Math.max(latest.current, rows.at(-1)?.sequence ?? 0);
        setLoading(false);
        setUnavailable(false);
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(errorText(e));
          setLoading(false);
          if ((e as { status?: number }).status === 404) {
            setMessages([]);
            setUnavailable(true);
          }
        }
      }
    })();
    return () => abort.abort();
  }, [id, recovery]);
  useEffect(() => {
    if (!conversation && initialized.current) {
      setMessages([]);
      setUnavailable(true);
      return;
    }
    if (conversation) {
      const incoming = updates.filter((m) => m.conversationId === id);
      if (incoming.length) {
        setMessages((old) => merge(old, incoming));
        latest.current = Math.max(latest.current, ...incoming.map((m) => m.sequence));
      }
    }
  }, [updates, conversation, id]);
  const last = messages.at(-1),
    active = messages.filter((m) => m.state === 'streaming'),
    hasDraft = !!draft.text.trim() || !!draft.files.length;
  useEffect(() => {
    if (visible && last && conversation && last.sequence > conversation.readSequence)
      void messaging.read(id, last.sequence).catch(() => {});
  }, [visible, last?.sequence, conversation?.readSequence, id]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);
  async function older() {
    if (!before) return;
    setOlderBusy(true);
    const height = scroll.current?.scrollHeight ?? 0;
    try {
      const page = await messaging.history(id, before);
      setBefore(page.before);
      setMessages((old) => merge(page.messages, old));
      requestAnimationFrame(() => {
        if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - height;
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOlderBusy(false);
    }
  }
  async function upload(files: FileList | File[] | null) {
    if (!files) return false;
    const list = Array.from(files);
    if (list.length + draftRef.current.files.length > 6) {
      setError('每条消息最多 6 个附件');
      return false;
    }
    if (list.some((f) => f.size > 10 * 1024 * 1024 || !f.size)) {
      setError('请选择不超过 10 MB 的非空文件');
      return false;
    }
    const abort = new AbortController();
    uploadAbort.current = abort;
    setUploading(true);
    setError('');
    try {
      for (let i = 0; i < list.length; i++) {
        setUploadProgress(`正在上传 ${i + 1}/${list.length}：${list[i].name}`);
        const { file } = await messaging.upload(id, list[i].name, list[i], abort.signal);
        if (abort.signal.aborted) return false;
        change({ files: [...draftRef.current.files, file] });
      }
    } catch (e) {
      if (!abort.signal.aborted) setError(errorText(e));
      return false;
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
    return true;
  }
  async function remove(file: ChatAttachment) {
    change({ files: draftRef.current.files.filter((f) => f.id !== file.id) });
    void messaging.request(`/conversations/${id}/files/${file.id}`, 'DELETE').catch(() => {});
  }
  async function send() {
    if (!hasDraft || busy || uploading) return;
    setBusy(true);
    setError('');
    const current = draftRef.current,
      text = current.text.trim(),
      mentions =
        conversation?.members
          .filter((m) =>
            Array.from(text.matchAll(/(?:^|\s)@([a-z0-9_-]+)/gi)).some(
              (match) => match[1].toLowerCase() === m.username,
            ),
          )
          .map((m) => m.id) ?? [];
    const options = { attachmentIds: current.files.map((f) => f.id), mentions, replyTo: current.reply?.id },
      key = JSON.stringify({ text, ...options });
    const request = current.pending?.key === key ? current.pending : { key, id: browserId() };
    change({ pending: request });
    try {
      const { message } = await messaging.send(id, text, request.id, options);
      follow.current = true;
      setFollowing(true);
      setMessages((old) => merge(old, [message]));
      change({ text: '', files: [], reply: undefined, pending: undefined });
    } catch (e) {
      setError(`${errorText(e)}；草稿已保留，可以重试。`);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(message: ChatMessage) {
    try {
      const result = await messaging.cancel(id, message.id);
      setMessages((old) => merge(old, [result.message]));
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function sendSpecial(options: SendMessageOptions) {
    const text = options.interaction?.title ?? '',
      key = JSON.stringify({ text, options });
    const request = specialRequest.current?.key === key ? specialRequest.current : { key, id: browserId() };
    specialRequest.current = request;
    const result = await messaging.send(id, text, request.id, options);
    follow.current = true;
    setFollowing(true);
    setMessages((old) => merge(old, [result.message]));
    specialRequest.current = undefined;
  }
  async function favorite(file: ChatAttachment) {
    try {
      await messaging.saveSticker(id, file.id);
      setSavedSticker(file.id);
    } catch (e) {
      setError(errorText(e));
    }
  }
  function jump() {
    follow.current = true;
    setFollowing(true);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }
  return (
    <AttachmentAccessContext.Provider value={access}>
      <section className="im-chat" aria-label="聊天内容">
        <ConversationHeader
          className="im-chat-header"
          title={conversation?.name ?? '聊天'}
          backLabel="返回消息列表"
          onBack={() => navigate({ page: 'messages' })}
          subtitle={
            conversation?.kind === 'group'
              ? `${conversation.members.length} 位成员${conversation.closed ? ' · 已解散' : ''}`
              : conversation?.peer
                ? `@${conversation.peer.username} · ${conversation.peer.kind === 'agent' ? 'Agent' : '联系人'}`
                : ''
          }
        >
          <button className="icon-button" aria-label="搜索聊天记录" onClick={() => setSearch(true)}>
            <Icon name="search" />
          </button>
          {conversation?.kind === 'group' && (
            <button className="secondary im-members-button" onClick={() => setDetails(true)}>
              <Icon name="contacts" size={18} />
              <span>成员</span>
            </button>
          )}
        </ConversationHeader>
        <div
          ref={scroll}
          className="im-transcript"
          role="log"
          aria-label="聊天记录"
          onScroll={() => {
            if (scroll.current) {
              follow.current =
                scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100;
              setFollowing(follow.current);
            }
          }}
        >
          {before && (
            <button className="secondary im-history" disabled={olderBusy} onClick={() => void older()}>
              {olderBusy ? '正在加载…' : '加载更早消息'}
            </button>
          )}
          {loading && <p className="page-loading">正在加载消息…</p>}
          {!loading && !messages.length && !unavailable && (
            <p className="im-start">发送第一条消息，开始聊天。</p>
          )}
          {messages.map((message, index) => {
            const mine = message.senderId === user!.id,
              sender = conversation?.members.find((m) => m.id === message.senderId) ?? message.sender;
            const previous = messages[index - 1];
            const newDay =
              !previous ||
              new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
            return (
              <div key={message.id}>
                {newDay && (
                  <div className="im-date">
                    <span>
                      {new Date(message.createdAt).toLocaleDateString('zh-CN', {
                        month: 'long',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                )}
                <article className={`im-message ${mine ? 'mine' : ''}`} data-message-id={message.id}>
                  <Avatar user={sender} />
                  <div className="im-message-main">
                    <div className="im-message-author">
                      <strong>{sender?.displayName ?? '成员'}</strong>
                      {sender?.kind === 'agent' && <span className="im-kind">Agent</span>}
                      <time>{time(message.createdAt)}</time>
                    </div>
                    <div
                      className={`im-bubble ${message.state === 'streaming' ? 'is-streaming' : ''} ${message.sticker ? 'is-sticker' : ''} ${!message.text && message.attachments.length && !message.replyTo ? 'is-media-only' : ''}`}
                    >
                      {message.replyTo && (
                        <button
                          className="im-quote"
                          onClick={() =>
                            void messaging
                              .request<{ message: ChatMessage }>(
                                `/conversations/${id}/messages/${message.replyTo}`,
                              )
                              .then((r) => setQuoted(r.message))
                              .catch((e) => setError(errorText(e)))
                          }
                        >
                          <Icon name="chat" size={14} />
                          <span>
                            {messages.find((m) => m.id === message.replyTo)?.text.slice(0, 100) ||
                              '查看引用消息'}
                          </span>
                        </button>
                      )}
                      {message.text && !message.interaction && (
                        <Suspense fallback={<div className="im-plain">{message.text}</div>}>
                          <RichMessage
                            text={message.text}
                            threadId={id}
                            streaming={message.state === 'streaming'}
                          />
                        </Suspense>
                      )}
                      {message.interaction && (
                        <InteractionCard
                          message={message}
                          userId={user!.id}
                          disabled={unavailable || !!conversation?.closed}
                          onUpdate={(message) => setMessages((old) => merge(old, [message]))}
                        />
                      )}
                      {!!message.attachments.length && <Files files={message.attachments} id={id} />}
                      {message.state === 'streaming' && (
                        <div className="im-stream-status" role="status">
                          <span className="im-stream-dots" />
                          正在回复…
                          <button className="secondary" onClick={() => void cancel(message)}>
                            <Icon name="stop" size={13} />
                            停止
                          </button>
                        </div>
                      )}
                      {message.state === 'cancelled' && <p className="im-message-state">回复已停止</p>}
                      {message.state === 'failed' && (
                        <p className="im-message-state">回复中断，已保留收到的内容</p>
                      )}
                    </div>
                    <div className="im-message-actions">
                      <button
                        aria-label="引用回复"
                        title="引用回复"
                        onClick={() => change({ reply: message })}
                      >
                        <Icon name="chat" size={14} />
                      </button>
                      <button
                        aria-label="复制消息"
                        title="复制消息"
                        onClick={() => {
                          if (!navigator.clipboard) {
                            setError('请选中消息手动复制');
                            return;
                          }
                          void navigator.clipboard
                            .writeText(message.text)
                            .then(() => setCopied(message.id))
                            .catch(() => setError('请选中消息手动复制'));
                        }}
                      >
                        <Icon name={copied === message.id ? 'check' : 'copy'} size={14} />
                      </button>
                      {message.attachments
                        .filter((file) => file.mime.startsWith('image/') && file.size <= 2 * 1024 * 1024)
                        .map((file) => (
                          <button
                            key={file.id}
                            aria-label={`收藏表情 ${file.name}`}
                            title="收藏表情"
                            onClick={() => void favorite(file)}
                          >
                            <Icon name={savedSticker === file.id ? 'check' : 'sticker'} size={14} />
                            <span>{savedSticker === file.id ? '已收藏' : '收藏表情'}</span>
                          </button>
                        ))}
                      {mine && (
                        <small>
                          {conversation?.kind === 'direct'
                            ? message.sequence <= (conversation.peerReadSequence ?? 0)
                              ? '已读'
                              : '已发送'
                            : `${conversation?.members.filter((m) => m.id !== user!.id && m.readSequence >= message.sequence).length ?? 0} 人已读`}
                        </small>
                      )}
                    </div>
                  </div>
                </article>
              </div>
            );
          })}
        </div>
        {!following && (
          <button className="im-jump secondary" onClick={jump}>
            <Icon name="down" size={16} />
            最新消息
          </button>
        )}
        <Notice text={error} />
        <footer className="im-compose-wrap">
          <Suspense fallback={null}>
            {tool === 'expressions' && (
              <Expressions
                userId={user!.id}
                conversationId={id}
                onClose={() => setTool(undefined)}
                onEmoji={(text) => setInsertText({ key: browserId(), text })}
                onSticker={(stickerId) => sendSpecial({ stickerId })}
              />
            )}
          </Suspense>
          {draft.reply && (
            <div className="im-reply-draft">
              <span>
                回复 {draft.reply.sender?.displayName ?? '成员'}：{draft.reply.text.slice(0, 100)}
              </span>
              <button
                aria-label="取消引用"
                className="icon-button"
                onClick={() => change({ reply: undefined })}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          <ChatComposer
            activity={busy ? '正在发送…' : undefined}
            insertText={insertText}
            value={{
              text: draft.text,
              uploads: draft.files.map((f) => ({ id: f.id, name: f.name, path: f.url })),
              skills: [],
              plugins: [],
            }}
            onChange={(update) => {
              const current = { text: draftRef.current.text, uploads: [], skills: [], plugins: [] };
              const next = typeof update === 'function' ? update(current) : update;
              change({ text: next.text ?? current.text });
            }}
            disabled={busy || unavailable || !!conversation?.closed}
            sendDisabled={
              busy ||
              uploading ||
              loading ||
              unavailable ||
              !!conversation?.closed ||
              (!hasDraft && !active.length)
            }
            placeholder={
              conversation?.closed
                ? '群聊已解散'
                : conversation?.kind === 'group'
                  ? '发送消息，@ 提及成员'
                  : '发送消息…'
            }
            messageLabel="聊天消息"
            maxLength={16000}
            onSubmit={() => void send()}
            onUpload={(files) => void upload(files)}
            uploading={uploading}
            uploadProgress={uploadProgress}
            uploadDisabled={busy || unavailable || !!conversation?.closed}
            running={!!active.length}
            onInterrupt={() => {
              for (const message of active) void cancel(message);
            }}
            sendLabels={{ send: '发送消息', running: '发送消息', stop: '停止回复' }}
            attachmentPreview={
              draft.files.length ? (
                <Files files={draft.files} id={id} compact onRemove={(file) => void remove(file)} />
              ) : null
            }
            actions={
              <>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="表情与 Emoji"
                  title="表情与 Emoji"
                  disabled={busy || uploading || loading || unavailable || !!conversation?.closed}
                  data-expression-trigger
                  aria-expanded={tool === 'expressions'}
                  onClick={() => setTool(tool === 'expressions' ? undefined : 'expressions')}
                >
                  <Icon name="smile" size={22} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="语音消息"
                  title="语音消息"
                  disabled={busy || uploading || loading || unavailable || !!conversation?.closed}
                  onClick={() => setTool('voice')}
                >
                  <Icon name="mic" size={22} />
                </button>
                {conversation?.members.some((m) => m.id !== user!.id && m.kind === 'human') && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="发起交互请求"
                    title="问题与授权确认"
                    disabled={busy || loading || unavailable || !!conversation?.closed}
                    onClick={() => setTool('interaction')}
                  >
                    <Icon name="plan" size={22} />
                  </button>
                )}
                {conversation?.kind === 'group' ? (
                  <label className="im-mention">
                    <span aria-hidden="true">@</span>
                    <select
                      aria-label="提及成员"
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          change({
                            text: `${draftRef.current.text}${draftRef.current.text && !draftRef.current.text.endsWith(' ') ? ' ' : ''}@${e.target.value} `,
                          });
                      }}
                    >
                      <option value="">提及成员</option>
                      {conversation.members
                        .filter((m) => m.id !== user!.id)
                        .map((m) => (
                          <option key={m.id} value={m.username}>
                            {m.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                ) : null}
              </>
            }
          />
          <p className="im-compose-help">
            {conversation?.closed ? '历史消息仍可阅读' : 'Enter 发送 · Shift + Enter 换行'}
          </p>
        </footer>
        <Suspense
          fallback={
            <p role="status" className="im-tool-loading">
              正在打开…
            </p>
          }
        >
          {tool === 'voice' && (
            <VoiceRecorder onClose={() => setTool(undefined)} onAttach={(file) => upload([file])} />
          )}
        </Suspense>
        {tool === 'interaction' && conversation && (
          <CreateInteraction
            conversation={conversation}
            userId={user!.id}
            onClose={() => setTool(undefined)}
            onSend={(interaction) => sendSpecial({ interaction })}
          />
        )}
        {details && conversation && (
          <GroupDetails conversation={conversation} onClose={() => setDetails(false)} navigate={navigate} />
        )}
        {search && <SearchMessages id={id} onClose={() => setSearch(false)} onSelect={setQuoted} />}
        {quoted && (
          <Dialog title="消息详情" onClose={() => setQuoted(undefined)}>
            <p className="im-help">
              {quoted.sender?.displayName} · {new Date(quoted.createdAt).toLocaleString('zh-CN')}
            </p>
            <Suspense fallback={quoted.text}>
              <RichMessage text={quoted.text} threadId={id} streaming={quoted.state === 'streaming'} />
            </Suspense>
            {quoted.interaction && (
              <InteractionCard
                message={quoted}
                userId={user!.id}
                disabled={unavailable || !!conversation?.closed}
                onUpdate={(message) => {
                  setQuoted(message);
                  setMessages((old) => merge(old, [message]));
                }}
              />
            )}
            <Files files={quoted.attachments} id={id} />
          </Dialog>
        )}
      </section>
    </AttachmentAccessContext.Provider>
  );
}
function SearchMessages({
  id,
  onClose,
  onSelect,
}: {
  id: string;
  onClose: () => void;
  onSelect: (message: ChatMessage) => void;
}) {
  const [q, setQ] = useState(''),
    [results, setResults] = useState<ChatMessage[]>([]),
    [before, setBefore] = useState<number>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [submitted, setSubmitted] = useState('');
  async function run(older = false) {
    setBusy(true);
    setError('');
    try {
      const result = await messaging.search(id, older ? submitted : q, older ? before : undefined);
      setResults((old) => (older ? [...old, ...result.messages] : result.messages));
      setBefore(result.before);
      if (!older) setSubmitted(q);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="搜索聊天记录" onClose={onClose}>
      <form
        className="im-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          aria-label="搜索关键词"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={100}
          placeholder="输入关键词"
        />
        <button className="primary" disabled={busy || !q.trim()}>
          搜索
        </button>
      </form>
      <Notice text={error} />
      <div className="im-search-results">
        {results.map((m) => (
          <button key={m.id} onClick={() => onSelect(m)}>
            <small>
              {m.sender?.displayName} · {new Date(m.createdAt).toLocaleString('zh-CN')}
            </small>
            <span>{m.text.slice(0, 300)}</span>
          </button>
        ))}
        {submitted && !results.length && !busy && <p className="im-help">没有找到相关消息</p>}
        {before && (
          <button className="secondary" disabled={busy} onClick={() => void run(true)}>
            加载更多结果
          </button>
        )}
      </div>
    </Dialog>
  );
}
