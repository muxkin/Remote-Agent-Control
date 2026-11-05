import { lazy, Suspense, useEffect, useState } from 'react';
import type { ConversationRequest, Operation, RequestResponse } from '../shared/types';
import { ChatComposer } from './ChatComposer';
import type { ChatDraft } from './chat-drafts';
import { Icon } from './Icon';
const RichMessage = lazy(() => import('./RichMessage'));
export function PlanRequestCard({
  request,
  threadId,
  disabled,
  onRespond,
  onDraftChange,
  response,
}: {
  request: ConversationRequest;
  threadId: string;
  disabled: boolean;
  onRespond: (response: RequestResponse) => void | Promise<string | undefined>;
  onDraftChange?: (id: string, dirty: boolean) => void;
  response?: Operation;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [operationId, setOperationId] = useState<string>();
  useEffect(() => {
    if (response && response.id === operationId && ['failed', 'rejected'].includes(response.state))
      setSubmitted(false);
  }, [response, operationId]);
  async function submit(answer: RequestResponse) {
    if (submitted) return;
    setSubmitted(true);
    try {
      const id = await onRespond(answer);
      if (!id) setSubmitted(false);
      else setOperationId(id);
    } catch {
      setSubmitted(false);
    }
  }
  const [revising, setRevising] = useState(false);
  const [draft, setDraft] = useState<ChatDraft>({ text: '', uploads: [], skills: [], plugins: [] });
  useEffect(() => {
    onDraftChange?.(request.id, !!draft.text.trim());
    return () => onDraftChange?.(request.id, false);
  }, [request.id, draft.text, onDraftChange]);
  const target = {
    targetRequestId: request.id,
    expectedTurnId: request.turnId,
    expectedFingerprint: request.fingerprint,
  };
  const blocked = submitted || disabled || !request.actionable;
  return (
    <section className="plan-request" data-request-kind="plan">
      <h3>
        <Icon name="plan" />
        计划等待批准
      </h3>
      <details open>
        <summary>查看计划</summary>
        <div className="plan-content">
          <Suspense fallback={<pre>{request.description}</pre>}>
            <RichMessage text={request.description} threadId={threadId} />
          </Suspense>
        </div>
      </details>
      {!request.actionable ? (
        <p className="plan-status">请在桌面查看完整计划并处理。</p>
      ) : (
        <>
          <div className="request-actions">
            <button className="secondary" disabled={blocked} onClick={() => setRevising(!revising)}>
              {revising ? '收起修改' : '提出修改'}
            </button>
            <button
              className="primary"
              disabled={blocked || !!draft.text.trim()}
              onClick={() => void submit({ ...target, planDecision: 'implement' })}
            >
              批准并执行
            </button>
          </div>
          {revising && (
            <ChatComposer
              value={draft}
              onChange={(change) =>
                setDraft((old) => (typeof change === 'function' ? change(old) : { ...old, ...change }))
              }
              disabled={blocked}
              placeholder="告诉 Agent 计划需要怎样修改…"
              sendDisabled={blocked || !draft.text.trim()}
              onSubmit={() => void submit({ ...target, planDecision: 'revise', feedback: draft.text.trim() })}
            />
          )}
          {submitted && (
            <p className="plan-status" role="status">
              正在确认计划操作，请勿重复提交。
            </p>
          )}
        </>
      )}
    </section>
  );
}
