import { tsxComponent } from './tsx-component';
import { shallowRef, Teleport, type VNodeChild } from 'vue';
import { writeRef, watchRender } from './render-effects';

import { Icon } from './Icon';
import type { ConversationRequest, Operation, RequestResponse } from '../shared/types';

type Props = {
  onDraftChange?: (id: string, dirty: boolean) => void;
  request: ConversationRequest;
  disabled: boolean;
  onRespond: (response: RequestResponse) => void;
  response?: Operation;
  receiptLabel?: string;
};
export const QuestionCard = tsxComponent(function QuestionCard(_props: Props) {
  const answersState = shallowRef<Record<string, string>>({});
  const setAnswers = writeRef(answersState);
  const multipleState = shallowRef<Record<string, string[]>>({});
  const setMultiple = writeRef(multipleState);
  const customState = shallowRef<Record<string, boolean>>({});
  const setCustom = writeRef(customState);
  const customDraftsState = shallowRef<Record<string, string>>({});
  const setCustomDrafts = writeRef(customDraftsState);
  const openState = shallowRef(false);
  const setOpen = writeRef(openState);
  const stepState = shallowRef(0);
  const setStep = writeRef(stepState);
  const reviewState = shallowRef(false);
  const setReview = writeRef(reviewState);
  const submittedState = shallowRef(false);
  const setSubmitted = writeRef(submittedState);
  const watchRequest = watchRender();
  const watchRequest2 = watchRender();
  return ({ request, disabled, onRespond, response, onDraftChange, receiptLabel = '桌面' }) => {
    const questions = request.questions!;
    const answers = answersState.value;
    const multiple = multipleState.value;
    const custom = customState.value;
    const customDrafts = customDraftsState.value;
    const open = openState.value;
    const step = stepState.value;
    const review = reviewState.value;
    const submitted = submittedState.value;
    const answered = questions.filter((q) => answers[q.id]?.trim()).length;
    watchRequest(() => {
      onDraftChange?.(request.id, answered > 0);
    }, [request.id, answered, onDraftChange]);
    watchRequest2(() => () => onDraftChange?.(request.id, false), [request.id, onDraftChange]);
    const waiting = submitted && response && !['rejected', 'failed'].includes(response.state);
    const locked = disabled || !!waiting || !request.actionable;
    const question = questions[step] ?? questions[0];
    const status = !submitted
      ? ''
      : response?.state === 'rejected' || response?.state === 'failed'
        ? `未提交成功：${response.error ?? '请核对后重试'}`
        : response?.state === 'uncertain'
          ? '结果待确认，请勿重复提交。重新连接后会核对桌面状态。'
          : ['accepted', 'completed'].includes(response?.state ?? '')
            ? `${receiptLabel}已收到回答，正在同步…`
            : '正在提交回答…';
    const update = (value: string) => setAnswers((old) => ({ ...old, [question.id]: value }));
    function submit() {
      if (locked || answered !== questions.length) return;
      setSubmitted(true);
      onRespond({
        targetRequestId: request.id,
        expectedTurnId: request.turnId,
        expectedFingerprint: request.fingerprint,
        answers: Object.fromEntries(
          questions.map((q) => [
            q.id,
            q.multiSelect && !custom[q.id] ? (multiple[q.id] ?? []) : [answers[q.id]],
          ]),
        ),
      });
    }
    return (
      <section
        class="request-card question-card"
        data-request-kind={request.kind}
        data-question-mode={request.kind === 'async-question' ? 'async' : 'blocking'}
      >
        <div class="question-card-heading">
          <h3>有 {questions.length} 个问题需要你确认</h3>
          <span>{questions.length} 题</span>
        </div>
        <p class="question-preview sr-only">{questions[0].question}</p>
        <p class="question-hint">{answered ? `已答 ${answered}/${questions.length}` : '帮助我确定下一步'}</p>
        <button
          class="primary question-open"
          aria-label={`${answered ? '继续回答' : '回答问题'}${questions.length > 1 ? `（${questions.length} 题）` : ''}`}
          onClick={() => setOpen(true)}
        >
          {answered ? '继续回答' : '回答'}
        </button>
        {open && (
          <Teleport to={document.body}>
            <QuestionDialog onClose={() => setOpen(false)}>
              {() => (
                <>
                  <header class="question-dialog-head">
                    <div>
                      <h2 id="question-dialog-title">回答问题</h2>
                      <p>
                        {review ? '核对答案' : `第 ${step + 1} / ${questions.length} 题`} · 已答 {answered}/
                        {questions.length}
                      </p>
                    </div>
                    <button
                      type="button"
                      class="icon-button"
                      aria-label="收起答题面板"
                      onClick={() => setOpen(false)}
                    >
                      <Icon name="close" />
                    </button>
                  </header>
                  {questions.length > 1 && (
                    <nav class="question-progress" aria-label="问题进度">
                      {questions.map((q, index) => (
                        <button
                          type="button"
                          key={q.id}
                          class={step === index && !review ? 'current' : ''}
                          aria-current={step === index && !review ? 'step' : undefined}
                          aria-label={`第 ${index + 1} 题${answers[q.id]?.trim() ? '，已回答' : '，未回答'}`}
                          onClick={() => {
                            setStep(index);
                            setReview(false);
                          }}
                        >
                          {answers[q.id]?.trim() ? '✓ ' : ''}
                          {index + 1}
                        </button>
                      ))}
                    </nav>
                  )}
                  <div class="question-dialog-body" key={review ? 'review' : question.id}>
                    {review ? (
                      <ol class="answer-review">
                        {questions.map((q, index) => (
                          <li key={q.id}>
                            <h3>
                              {index + 1}. {q.question}
                            </h3>
                            <p>
                              {q.secret
                                ? answers[q.id]
                                  ? '已填写（隐藏内容）'
                                  : '尚未回答'
                                : answers[q.id] || '尚未回答'}
                            </p>
                            <button
                              class="secondary"
                              onClick={() => {
                                setStep(index);
                                setReview(false);
                              }}
                            >
                              修改第 {index + 1} 题
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <fieldset disabled={locked}>
                        <legend>{question.header || `问题 ${step + 1}`}</legend>
                        <p class="question-title">{question.question}</p>
                        {question.detail && <pre class="question-detail">{question.detail}</pre>}
                        {question.options.map((option, index) => (
                          <label class="question-option" key={`${index}:${option.label}`}>
                            <input
                              type={question.multiSelect ? 'checkbox' : 'radio'}
                              name={`answer-${request.id}-${question.id}`}
                              checked={
                                !custom[question.id] &&
                                (question.multiSelect
                                  ? (multiple[question.id]?.includes(option.label) ?? false)
                                  : answers[question.id] === option.label)
                              }
                              onInput={() => {
                                setCustom((old) => ({ ...old, [question.id]: false }));
                                if (question.multiSelect) {
                                  const values = multiple[question.id] ?? [];
                                  const next = values.includes(option.label)
                                    ? values.filter((v) => v !== option.label)
                                    : [...values, option.label];
                                  setMultiple((old) => ({ ...old, [question.id]: next }));
                                  update(next.join('、'));
                                } else update(option.label);
                              }}
                            />
                            <span>
                              <strong>{option.label}</strong>
                              {option.description && <small>{option.description}</small>}
                            </span>
                          </label>
                        ))}
                        {!!question.options.length && (
                          <label class="question-option">
                            <input
                              type="radio"
                              name={`answer-${request.id}-${question.id}`}
                              checked={!!custom[question.id]}
                              onChange={() => {
                                setCustom((old) => ({ ...old, [question.id]: true }));
                                update(customDrafts[question.id] ?? '');
                              }}
                            />
                            <span>自行填写</span>
                          </label>
                        )}
                        {(!question.options.length || custom[question.id]) && (
                          <label class="question-freeform">
                            {question.options.length ? '自定义回答' : '你的回答'}
                            {question.secret ? (
                              <input
                                type="password"
                                autocomplete="off"
                                aria-label="你的回答"
                                value={answers[question.id] ?? ''}
                                onInput={(event) => {
                                  update((event.currentTarget as HTMLInputElement).value);
                                  setCustomDrafts((old) => ({
                                    ...old,
                                    [question.id]: (event.currentTarget as HTMLInputElement).value,
                                  }));
                                }}
                              />
                            ) : (
                              <textarea
                                aria-label="你的回答"
                                rows={4}
                                placeholder="输入你的回答…"
                                value={answers[question.id] ?? ''}
                                onInput={(event) => {
                                  update((event.currentTarget as HTMLTextAreaElement).value);
                                  setCustomDrafts((old) => ({
                                    ...old,
                                    [question.id]: (event.currentTarget as HTMLTextAreaElement).value,
                                  }));
                                }}
                              />
                            )}
                          </label>
                        )}
                      </fieldset>
                    )}
                  </div>
                  <footer class="question-dialog-footer">
                    <p class="question-feedback" role="status">
                      {status ||
                        (locked
                          ? '正在同步或确认其他操作，请稍候。'
                          : review
                            ? answered === questions.length
                              ? '确认无误后，点击下方按钮提交所有答案。'
                              : `还有 ${questions.length - answered} 题未回答，请先补全。`
                            : '选择或填写后，再点击下方按钮。')}
                    </p>
                    <div class="question-dialog-actions">
                      {questions.length > 1 && (review || step > 0) && (
                        <button
                          class="secondary"
                          onClick={() => {
                            if (review) setReview(false);
                            else setStep((value) => value - 1);
                          }}
                        >
                          上一题
                        </button>
                      )}
                      {questions.length === 1 || review ? (
                        <button
                          class="primary"
                          disabled={locked || answered !== questions.length}
                          onClick={submit}
                        >
                          {waiting
                            ? '正在确认…'
                            : questions.length === 1
                              ? '提交回答'
                              : `提交全部回答（${questions.length} 题）`}
                        </button>
                      ) : (
                        <button
                          class="primary"
                          disabled={locked || !answers[question.id]?.trim()}
                          onClick={() => {
                            if (step + 1 === questions.length) setReview(true);
                            else setStep((value) => value + 1);
                          }}
                        >
                          {step + 1 === questions.length ? '核对答案' : '下一题'}
                          <Icon name="arrow" size={20} />
                        </button>
                      )}
                    </div>
                  </footer>
                </>
              )}
            </QuestionDialog>
          </Teleport>
        )}
      </section>
    );
  };
});
const QuestionDialog = tsxComponent(function QuestionDialog(_props: {
  children?: VNodeChild;
  onClose: () => void;
}) {
  const ref = shallowRef<HTMLDialogElement | null>(null);
  const afterRender = watchRender();
  return ({ children, onClose }) => {
    afterRender(() => {
      const dialog = ref.value!;
      dialog.showModal();
      return () => dialog.close();
    }, []);
    return (
      <dialog
        ref={ref}
        class="question-dialog"
        aria-labelledby="question-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        {children}
      </dialog>
    );
  };
});
