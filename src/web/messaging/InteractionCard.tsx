import { useEffect, useRef, useState } from 'react';
import type {
  ChatConversation,
  ChatMessage,
  InteractionInput,
  InteractionResponse,
} from '../../shared/messaging';
import type { ConversationRequest, Operation, RequestResponse } from '../../shared/types';
import { RequestCards } from '../RequestCards';
import { Icon } from '../Icon';
import { messaging } from './context';
import { Dialog, Notice, errorText } from './ui';

const labels = {
  pending: '等待处理',
  answered: '已回答',
  approved: '已允许本次',
  rejected: '已拒绝',
  cancelled: '已撤回',
  expired: '已过期',
};
export function InteractionCard({
  message,
  userId,
  onUpdate,
  disabled = false,
}: {
  message: ChatMessage;
  userId: string;
  onUpdate: (message: ChatMessage) => void;
  disabled?: boolean;
}) {
  const interaction = message.interaction!;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [review, setReview] = useState(false);
  const [operation, setOperation] = useState<Operation>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, interaction.expiresAt - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [interaction.expiresAt]);
  const status =
    interaction.status === 'pending' && now >= interaction.expiresAt ? 'expired' : interaction.status;
  const mine = interaction.recipientId === userId,
    pending = status === 'pending';
  const request: ConversationRequest = {
    id: interaction.id,
    kind: interaction.kind === 'question' ? 'question' : 'command',
    title: interaction.title,
    description: interaction.description,
    turnId: null,
    actionable: pending && mine && !disabled,
    questions: interaction.questions,
    decisions: ['accept', 'decline'],
    fingerprint: interaction.id,
  };
  async function act(response?: RequestResponse) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = response
        ? await messaging.respond(
            message.conversationId,
            message.id,
            (interaction.kind === 'question'
              ? { answers: response.answers! }
              : { decision: response.decision === 'accept' ? 'approve' : 'reject' }) as InteractionResponse,
          )
        : await messaging.cancelInteraction(message.conversationId, message.id);
      onUpdate(result.message);
      setReview(false);
    } catch (e) {
      const error = errorText(e);
      setError(error);
      setOperation({
        id: interaction.id,
        threadId: message.conversationId,
        turnId: null,
        kind: 'respond',
        state: 'failed',
        error,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`im-interaction ${status}`}
      aria-label={interaction.kind === 'approval' ? '授权确认' : '问题卡片'}
    >
      <div className="im-interaction-heading">
        <Icon name={interaction.kind === 'approval' ? 'shield' : 'chat'} size={19} />
        <span>{interaction.kind === 'approval' ? '授权确认' : '需要回答'}</span>
        <strong role="status">{labels[status]}</strong>
      </div>
      <h3>{interaction.title}</h3>
      <p className="im-interaction-description">{interaction.description}</p>
      {pending ? (
        <>
          <p className="im-help">
            {mine ? '由你处理' : `等待 UID ${interaction.recipientId} 处理`} ·{' '}
            {new Date(interaction.expiresAt).toLocaleString('zh-CN')} 到期
          </p>
          {mine && interaction.kind === 'question' && (
            <RequestCards
              requests={[request]}
              disabled={busy || disabled}
              onRespond={(response) => {
                void act(response);
              }}
              response={operation}
              receiptLabel="对方"
            />
          )}
          <div className="im-interaction-actions">
            {mine && interaction.kind === 'approval' && (
              <button className="primary" disabled={busy || disabled} onClick={() => setReview(true)}>
                查看并确认
              </button>
            )}
            {(mine || message.senderId === userId) && (
              <button className="secondary" disabled={busy} onClick={() => void act()}>
                撤回请求
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          {interaction.response && 'answers' in interaction.response && (
            <dl className="im-answer-summary">
              {interaction.questions?.map((q) => (
                <div key={q.id}>
                  <dt>{q.question}</dt>
                  <dd>
                    {(interaction.response as { answers: Record<string, string[]> }).answers[q.id]?.join(
                      '、',
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {interaction.respondedBy && (
            <p className="im-help">
              由 UID {interaction.respondedBy} 于 {new Date(interaction.respondedAt!).toLocaleString('zh-CN')}{' '}
              确认
            </p>
          )}
        </>
      )}
      <Notice text={error} />
      {review && pending && (
        <Dialog title="核对授权" onClose={() => !busy && setReview(false)}>
          <p className="im-help">
            来自 {message.sender.displayName} · UID {message.senderId}。仅授权下面列出的这一次操作。
          </p>
          <RequestCards
            requests={[request]}
            disabled={busy || disabled}
            onRespond={(response) => {
              void act(response);
            }}
          />
          <Notice text={error} />
        </Dialog>
      )}
    </section>
  );
}

export function CreateInteraction({
  conversation,
  userId,
  onClose,
  onSend,
}: {
  conversation: ChatConversation;
  userId: string;
  onClose: () => void;
  onSend: (input: InteractionInput) => Promise<void>;
}) {
  const recipients = conversation.members.filter((m) => m.id !== userId && m.kind === 'human');
  const expiry = useRef<{ key: string; value: number } | undefined>(undefined);
  const [kind, setKind] = useState<'question' | 'approval'>('question'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog title="发起交互请求" onClose={() => !busy && onClose()}>
      <form
        className="im-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          const title = String(data.get('title')).trim(),
            description = String(data.get('description')).trim();
          const key = JSON.stringify([kind, ...data.entries()]);
          if (expiry.current?.key !== key)
            expiry.current = { key, value: Date.now() + Number(data.get('expiry')) * 3600000 };
          try {
            await onSend({
              kind,
              recipientId: String(data.get('recipient')),
              title,
              description,
              ...(kind === 'question'
                ? {
                    questions: [
                      {
                        id: 'question',
                        header: title,
                        question: description,
                        multiSelect: data.get('multiple') === 'on',
                        options: String(data.get('options') ?? '')
                          .split('\n')
                          .map((v) => v.trim())
                          .filter(Boolean)
                          .map((label) => ({ label, description: '' })),
                      },
                    ],
                  }
                : {}),
              expiresAt: expiry.current.value,
            });
            onClose();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          请求类型
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="question">回答问题</option>
            <option value="approval">授权确认</option>
          </select>
        </label>
        <label>
          由谁处理
          <select name="recipient" required disabled={busy}>
            {recipients.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} · UID {m.id}
              </option>
            ))}
          </select>
        </label>
        {!recipients.length && (
          <p className="im-help">当前会话中没有其他个人用户，Agent 可以向你发起请求。</p>
        )}
        <label>
          请求标题
          <input
            name="title"
            required
            maxLength={200}
            placeholder={kind === 'question' ? '确认下一步安排' : '确认本次操作'}
          />
        </label>
        <label>
          {kind === 'question' ? '问题说明' : '具体操作与影响'}
          <textarea
            name="description"
            required
            maxLength={12000}
            rows={4}
            placeholder={
              kind === 'question' ? '请说明需要对方回答的问题' : '写清将执行的动作、对象和影响，供对方核对'
            }
          />
        </label>
        {kind === 'question' && (
          <>
            <label>
              备选答案（可选，每行一个）
              <textarea
                name="options"
                rows={3}
                placeholder="选项一&#10;选项二"
              />
            </label>
            <label className="im-checkbox">
              <input type="checkbox" name="multiple" />
              允许多选
            </label>
            <p className="im-help">回答者也可以自行填写。</p>
          </>
        )}
        <label>
          有效期
          <select name="expiry" defaultValue="24">
            <option value="1">1 小时</option>
            <option value="24">24 小时</option>
            <option value="168">7 天</option>
          </select>
        </label>
        <Notice text={error} />
        <button className="primary" disabled={busy || !recipients.length}>
          {busy ? '正在发送…' : '发送请求'}
        </button>
      </form>
    </Dialog>
  );
}
