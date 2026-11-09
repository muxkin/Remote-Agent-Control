import { useEffect, useState } from 'react';
import type { Operation } from '../shared/types';
import { Icon } from './Icon';

const actions: Record<Operation['kind'], string> = {
  send: '发送',
  steer: '追加指令',
  queue: '加入队列',
  'queue-remove': '移除排队',
  create: '创建会话',
  rename: '会话改名',
  fork: '创建分支',
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
  const [checking, setChecking] = useState(false),
    [checkError, setCheckError] = useState('');
  const id = operation?.id,
    state = operation?.state;
  useEffect(() => {
    setCheckError('');
  }, [id, state]);
  if (!operation) return null;
  const uncertain = state === 'uncertain';
  const sending = ['send', 'steer', 'queue'].includes(operation.kind);
  const failed = state === 'failed' || state === 'rejected';
  // Normal progress belongs to the send button; only actionable problems need a banner.
  if (!uncertain && !failed) return null;
  const message = uncertain
    ? `${sending ? '发送' : '操作'}结果待确认`
    : state === 'rejected'
      ? `未能${actions[operation.kind]}`
      : '任务未完成';
  const detail = uncertain
    ? `${sending ? '草稿已保留，' : ''}请先核对状态，避免重复${sending ? '发送' : '操作'}。`
    : operation.error || (state === 'rejected' ? '草稿已保留，可检查后重试。' : '可在操作记录中查看详情。');
  return (
    <div className={`delivery-feedback ${uncertain ? 'waiting' : 'failed'}`} data-operation-id={id}>
      <span className="delivery-indicator" aria-hidden="true">
        <Icon name={uncertain ? 'clock' : 'info'} size={16} />
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
