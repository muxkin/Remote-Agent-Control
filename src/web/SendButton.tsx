import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
/** One action surface: send/steer, interrupt while empty, hold to queue a text draft. */
export function SendButton({
  running,
  hasDraft,
  disabled,
  canQueue,
  onInterrupt,
  onQueue,
}: {
  running: boolean;
  hasDraft: boolean;
  disabled: boolean;
  canQueue: boolean;
  onInterrupt: () => void;
  onQueue: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined),
    handled = useRef(false);
  const origin = useRef<{ x: number; y: number }>(undefined);
  const [holding, setHolding] = useState(false);
  const pause = running && !hasDraft;
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (disabled || !canQueue) cancel();
  }, [disabled, canQueue]);
  return (
    <button
      type="submit"
      className={`primary send-button ${pause ? 'pause-button' : ''} ${holding ? 'holding' : ''}`}
      aria-label={pause ? '中断任务' : running ? '追加指令 ↑' : '发送 ↑'}
      title={pause ? '中断当前任务' : canQueue ? '点击直接发送；长按排队下一轮' : '发送'}
      aria-describedby={canQueue ? 'send-queue-hint' : undefined}
      disabled={disabled}
      onPointerDown={(e) => {
        handled.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        if (!canQueue || disabled || e.button !== 0) return;
        setHolding(true);
        timer.current = setTimeout(() => {
          timer.current = undefined;
          handled.current = true;
          setHolding(false);
          onQueue();
        }, 650);
      }}
      onPointerMove={(e) => {
        if (
          timer.current &&
          origin.current &&
          Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 12
        ) {
          handled.current = true;
          cancel();
        }
      }}
      onPointerUp={cancel}
      onPointerCancel={() => {
        handled.current = true;
        cancel();
      }}
      onPointerLeave={() => {
        if (timer.current) {
          handled.current = true;
          cancel();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handled.current = false;
        if (canQueue && e.altKey && e.key === 'Enter') {
          e.preventDefault();
          handled.current = true;
          onQueue();
        }
      }}
      onClick={(e) => {
        if (handled.current) {
          handled.current = false;
          e.preventDefault();
          return;
        }
        if (pause) {
          e.preventDefault();
          onInterrupt();
        }
      }}
    >
      <Icon name={pause ? 'pause' : 'up'} size={23} />
    </button>
  );
}
