import { remoteFetch, deviceSession } from './device-session';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { Message } from '../shared/types';
import { codexDisplayMessage } from '../shared/codex-transcript';
import { MemoryCitations } from './CodexTranscriptMetadata';
import { CodexReplyActions } from './CodexReplyActions';
import { DiffView } from './DiffView';
const UserAttachments = lazy(() => import('./UserAttachments'));
const RichMessage = lazy(() => import('./RichMessage'));

export function MessageContent({
  message,
  threadId,
  streaming,
  codex,
  onFork,
  forkDisabled,
}: {
  message: Message;
  threadId: string;
  streaming: boolean;
  codex: boolean;
  onFork?: () => void;
  forkDisabled?: boolean;
}) {
  const [full, setFull] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setFull(null);
    setError('');
  }, [message.id, message.text, message.details]);
  const displayed = (full && codex ? codexDisplayMessage(full) : full) ?? message;
  const metadata = displayed.codex ?? message.codex;
  const contentPath = `/threads/${encodeURIComponent(threadId)}/content?messageId=${encodeURIComponent(message.id)}`;
  async function fetchFull(backendId: string): Promise<Message> {
    const response = await remoteFetch(`/api${contentPath}`, undefined, backendId);
    const data = await response.json();
    if (!response.ok) throw Error(data.error ?? '无法获取完整内容');
    return data.message;
  }
  async function expand() {
    const backendId = deviceSession.backendId;
    setBusy(true);
    try {
      const cached = await deviceSession.cached<{ message: Message }>(contentPath, backendId);
      if (cached) {
        setFull(cached.message);
        setBusy(false);
      }
      setFull(await fetchFull(backendId));
      setError('');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!!displayed.plugins?.length && (
        <div className="selected-skills" aria-label="本条消息使用的插件">
          {displayed.plugins.map((name, index) => (
            <span className="skill-chip" key={`${index}:${name}`}>
              @{name}
            </span>
          ))}
        </div>
      )}
      {!!displayed.skills?.length && (
        <div className="selected-skills" aria-label="本条消息使用的技能">
          {displayed.skills.map((name, index) => (
            <span className="skill-chip" key={`${index}:${name}`}>
              ${name}
            </span>
          ))}
        </div>
      )}
      <div className="message-text">
        {displayed.role !== 'tool' || displayed.id.includes(':media:') ? (
          <Suspense fallback={displayed.text}>
            <RichMessage
              preserveLineBreaks={displayed.role === 'user'}
              text={displayed.text}
              threadId={threadId}
              streaming={streaming}
            />
          </Suspense>
        ) : (
          displayed.text
        )}
      </div>
      {!!displayed.attachments?.length && (
        <Suspense fallback={<p>正在加载附件…</p>}>
          <UserAttachments files={displayed.attachments} threadId={threadId} />
        </Suspense>
      )}
      {metadata?.kind === 'memory' && <MemoryCitations entries={metadata.entries} />}
      {displayed.changes && <DiffView changes={displayed.changes} />}
      {displayed.output && (
        <details className="tool-details">
          <summary>命令输出</summary>
          <pre>{displayed.output}</pre>
        </details>
      )}
      {displayed.details && (
        <details className="tool-details">
          <summary>查看活动内容</summary>
          <pre>{displayed.details}</pre>
        </details>
      )}
      {(displayed.truncated || displayed.deferred) && (
        <div className="content-expansion">
          {!displayed.deferred && (
            <p className="hint">这条内容较长，当前显示预览。{streaming ? '任务完成后可展开全文。' : ''}</p>
          )}
          <button
            className="secondary"
            disabled={busy || (streaming && !displayed.deferred)}
            onClick={() => void expand()}
          >
            {busy ? '正在读取…' : displayed.deferred ? '展开活动详情' : '展开完整内容'}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
      {codex && displayed.role === 'assistant' && !streaming && (displayed.text || onFork) && (
        <CodexReplyActions
          text={displayed.text}
          loadText={
            displayed.truncated
              ? async () => {
                  const full = codexDisplayMessage(await fetchFull(deviceSession.backendId));
                  if (!full?.text || full.truncated) throw Error('无法获取完整回复');
                  return full.text;
                }
              : undefined
          }
          onFork={onFork}
          forkDisabled={forkDisabled}
        />
      )}
    </>
  );
}
