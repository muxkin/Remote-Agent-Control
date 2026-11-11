import { tsxComponent } from './tsx-component';
import { shallowRef, defineAsyncComponent as lazy, Suspense } from 'vue';
import { watchRender, writeRef } from './render-effects';

import type { ConversationRequest, Operation, RequestResponse } from '../shared/types';
import { ChatComposer } from './ChatComposer';
import type { ChatDraft } from './chat-drafts';
import { Icon } from './Icon';
const RichMessage = lazy(() => import('./RichMessage'));
export const PlanRequestCard = tsxComponent(function PlanRequestCard(_props: {
  request: ConversationRequest;
  threadId: string;
  disabled: boolean;
  onRespond: (response: RequestResponse) => void | Promise<string | undefined>;
  onDraftChange?: (id: string, dirty: boolean) => void;
  response?: Operation;
}) {
  const submittedState = shallowRef(false);
  const setSubmitted = writeRef(submittedState);
  const operationIdState = shallowRef<string>();
  const setOperationId = writeRef(operationIdState);
  const revisingState = shallowRef(false);
  const setRevising = writeRef(revisingState);
  const draftState = shallowRef<ChatDraft>({ text: '', uploads: [], skills: [], plugins: [] });
  const setDraft = writeRef(draftState);
  const watchSubmitted = watchRender();
  const watchRequest = watchRender();
  return ({ request, threadId, disabled, onRespond, onDraftChange, response }) => {
    const submitted = submittedState.value;
    const operationId = operationIdState.value;
    watchSubmitted(() => {
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
    const revising = revisingState.value;
    const draft = draftState.value;
    watchRequest(() => {
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
      <section class="plan-request" data-request-kind="plan">
        <h3>
          <Icon name="plan" />
          计划等待批准
        </h3>
        <details open>
          <summary>查看计划</summary>
          <div class="plan-content">
            <Suspense timeout={0}>
              {{
                fallback: () => <pre>{request.description}</pre>,
                default: () => (
                  <>
                    <RichMessage text={request.description} threadId={threadId} />
                  </>
                ),
              }}
            </Suspense>
          </div>
        </details>
        {!request.actionable ? (
          <p class="plan-status">请在桌面查看完整计划并处理。</p>
        ) : (
          <>
            <div class="request-actions">
              <button class="secondary" disabled={blocked} onClick={() => setRevising(!revising)}>
                {revising ? '收起修改' : '提出修改'}
              </button>
              <button
                class="primary"
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
                onSubmit={() =>
                  void submit({ ...target, planDecision: 'revise', feedback: draft.text.trim() })
                }
              />
            )}
            {submitted && (
              <p class="plan-status" role="status">
                正在确认计划操作，请勿重复提交。
              </p>
            )}
          </>
        )}
      </section>
    );
  };
});
