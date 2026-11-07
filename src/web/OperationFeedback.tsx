import { useEffect, useState } from 'react';
import type { Operation } from '../shared/types';
import { Icon } from './Icon';

const actions: Record<Operation['kind'], string> = {
  send: '发送',
  steer: '追加指令',
  queue: '加入队列',
  'queue-remove': '移除排队',
  create: '创建会话',
  open: '打开会话',
  interrupt: '停止任务',
  respond: '提交回复',
  settings: '保存设置',
  control: '应用设置',
};
export function operationActivity(operation?: Operation): string | undefined {
  return operation && ['received', 'dispatching'].includes(operation.state)
    ? `正在${actions[operation.kind]}…`
    : undefined;
}

/** Delivery feedback is separate from task execution and from transport failures. */
export function OperationFeedback({
  operation,
  onCheck,
  onRetry,
}: {
  operation?: Operation;
  onCheck?: () => Promise<void>;
  onRetry?: () => void;
}) {
  const [now, setNow] = useState(Date.now),
    [checking, setChecking] = useState(false),
    [checkError, setCheckError] = useState('');
  const id = operation?.id,
    state = operation?.state,
    created = operation?.createdAt ?? 0,
    updated = operation?.updatedAt ?? 0;
  useEffect(() => {
    setNow(Date.now());
    setCheckError('');
    // Brief sends only animate the button. Success fades; old history never reappears.
    const times =
      state === 'received' || state === 'dispatching' ? [created + 350, created + 8000] : [updated + 1800];
    const timers = times
      .filter((at) => at > Date.now())
      .map((at) => setTimeout(() => setNow(Date.now()), at - Date.now() + 10));
    return () => timers.forEach(clearTimeout);
  }, [id, state, created, updated]);
  if (!operation) return null;
  const pending = !!operationActivity(operation),
    uncertain = state === 'uncertain';
  const sending = ['send', 'steer', 'queue'].includes(operation.kind);
  const failed = state === 'failed' || state === 'rejected';
  const success = !pending && !uncertain && !failed;
  if ((pending && now - created < 350) || (success && now - updated > 1800)) return null;
  const message = uncertain
    ? `${sending ? '发送' : '操作'}结果待确认`
    : failed
      ? state === 'rejected'
        ? `未能${actions[operation.kind]}`
        : '任务未完成'
      : pending
        ? now - created >= 8000
          ? '接收确认稍慢'
          : state === 'received'
            ? operationActivity(operation)!
            : '等待接收确认…'
        : sending && state === 'accepted'
          ? '已发送'
          : state === 'interrupted'
            ? '已停止'
            : sending && state === 'completed'
              ? '任务已完成'
              : `${actions[operation.kind]}成功`;
  const detail = uncertain
    ? `${sending ? '草稿已保留，' : ''}请先核对状态，避免重复${sending ? '发送' : '操作'}。`
    : pending && now - created >= 8000
      ? '请稍候，无需重复操作。'
      : failed
        ? operation.error ||
          (state === 'rejected' ? '草稿已保留，可检查后重试。' : '可在操作记录中查看详情。')
        : '';
  return (
    <div
      className={`delivery-feedback ${uncertain ? 'waiting' : failed ? 'failed' : success ? 'confirmed' : 'pending'}`}
      data-operation-id={id}
    >
      <span className="delivery-indicator" aria-hidden="true">
        {pending ? (
          <span className="sending-spinner" />
        ) : (
          <Icon name={uncertain ? 'clock' : failed ? 'info' : 'check'} size={16} />
        )}
      </span>
      <div
        className="delivery-copy"
        role={failed ? 'alert' : 'status'}
        aria-live={failed ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        <span>{message}</span>
        {detail && <small>{detail}</small>}
        {checkError && <small>{checkError}</small>}
      </div>
      {uncertain && onCheck && (
        <button
          type="button"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            setCheckError('');
            void onCheck()
              .catch(() => setCheckError('暂时无法核对，请恢复连接后再试。'))
              .finally(() => setChecking(false));
          }}
        >
          {checking ? '核对中…' : '核对状态'}
        </button>
      )}
      {state === 'rejected' && onRetry && (
        <button type="button" onClick={onRetry}>
          发送草稿
        </button>
      )}
    </div>
  );
}
