import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import type { ConversationRequest, Operation, RequestResponse } from '../shared/types';

type Props = {
  onDraftChange?: (id: string, dirty: boolean) => void;
  request: ConversationRequest;
  disabled: boolean;
  onRespond: (response: RequestResponse) => void;
  response?: Operation;
};
export function QuestionCard({ request, disabled, onRespond, response, onDraftChange }: Props) {
  const questions = request.questions!;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multiple, setMultiple] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [customDrafts, setCustomDrafts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [review, setReview] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const answered = questions.filter((q) => answers[q.id]?.trim()).length;
  useEffect(() => {
    onDraftChange?.(request.id, answered > 0);
  }, [request.id, answered, onDraftChange]);
  useEffect(() => () => onDraftChange?.(request.id, false), [request.id, onDraftChange]);
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
          ? '桌面已收到回答，正在同步…'
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
      className="request-card question-card"
      data-request-kind={request.kind}
      data-question-mode={request.kind === 'async-question' ? 'async' : 'blocking'}
    >
      <div className="question-card-heading">
        <h3>有 {questions.length} 个问题需要你确认</h3>
        <span>{questions.length} 题</span>
      </div>
      <p className="question-preview sr-only">{questions[0].question}</p>
      <p className="question-hint">
        {answered ? `已答 ${answered}/${questions.length}` : '帮助我确定下一步'}
      </p>
      <button
        className="primary question-open"
        aria-label={`${answered ? '继续回答' : '回答问题'}${questions.length > 1 ? `（${questions.length} 题）` : ''}`}
        onClick={() => setOpen(true)}
      >
        {answered ? '继续回答' : '回答'}
      </button>
      {open &&
        createPortal(
          <QuestionDialog onClose={() => setOpen(false)}>
            <header className="question-dialog-head">
              <div>
                <h2 id="question-dialog-title">回答问题</h2>
                <p>
                  {review ? '核对答案' : `第 ${step + 1} / ${questions.length} 题`} · 已答 {answered}/
                  {questions.length}
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="收起答题面板"
                onClick={() => setOpen(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            {questions.length > 1 && (
              <nav className="question-progress" aria-label="问题进度">
                {questions.map((q, index) => (
                  <button
                    type="button"
                    key={q.id}
                    className={step === index && !review ? 'current' : ''}
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
            <div className="question-dialog-body" key={review ? 'review' : question.id}>
              {review ? (
                <ol className="answer-review">
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
                        className="secondary"
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
                  <p className="question-title">{question.question}</p>
                  {question.detail && <pre className="question-detail">{question.detail}</pre>}
                  {question.options.map((option, index) => (
                    <label className="question-option" key={`${index}:${option.label}`}>
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`answer-${request.id}-${question.id}`}
                        checked={
                          !custom[question.id] &&
                          (question.multiSelect
                            ? (multiple[question.id]?.includes(option.label) ?? false)
                            : answers[question.id] === option.label)
                        }
                        onChange={() => {
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
                    <label className="question-option">
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
                    <label className="question-freeform">
                      {question.options.length ? '自定义回答' : '你的回答'}
                      {question.secret ? (
                        <input
                          type="password"
                          autoComplete="off"
                          aria-label="你的回答"
                          value={answers[question.id] ?? ''}
                          onChange={(event) => {
                            update(event.target.value);
                            setCustomDrafts((old) => ({ ...old, [question.id]: event.target.value }));
                          }}
                        />
                      ) : (
                        <textarea
                          aria-label="你的回答"
                          rows={4}
                          placeholder="输入你的回答…"
                          value={answers[question.id] ?? ''}
                          onChange={(event) => {
                            update(event.target.value);
                            setCustomDrafts((old) => ({ ...old, [question.id]: event.target.value }));
                          }}
                        />
                      )}
                    </label>
                  )}
                </fieldset>
              )}
            </div>
            <footer className="question-dialog-footer">
              <p className="question-feedback" role="status">
                {status ||
                  (locked
                    ? '正在同步或确认其他操作，请稍候。'
                    : review
                      ? answered === questions.length
                        ? '确认无误后，点击下方按钮提交所有答案。'
                        : `还有 ${questions.length - answered} 题未回答，请先补全。`
                      : '选择或填写后，再点击下方按钮。')}
              </p>
              <div className="question-dialog-actions">
                {questions.length > 1 && (review || step > 0) && (
                  <button
                    className="secondary"
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
                    className="primary"
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
                    className="primary"
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
          </QuestionDialog>,
          document.body,
        )}
    </section>
  );
}
function QuestionDialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="question-dialog"
      aria-labelledby="question-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
