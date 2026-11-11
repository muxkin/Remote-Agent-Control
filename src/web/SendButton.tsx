import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from './render-effects';

import { Icon } from './Icon';
/** One action surface: send/steer, interrupt while empty, hold to queue a text draft. */
export const SendButton = tsxComponent(function SendButton(_props: {
  running: boolean;
  hasDraft: boolean;
  disabled: boolean;
  canQueue: boolean;
  onInterrupt: () => void;
  onQueue: () => void;
  hintId?: string;
  labels?: { send: string; stop: string; running: string };
  activity?: string;
  mobileLabel?: string;
}) {
  const timer: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
  const handled = { current: false };
  const origin: { current: { x: number; y: number } | undefined } = { current: undefined };
  const holdingState = shallowRef(false);
  const setHolding = writeRef(holdingState);
  const afterRender = watchRender();
  const watchDisabled = watchRender();
  return ({
    running,
    hasDraft,
    disabled,
    canQueue,
    onInterrupt,
    onQueue,
    hintId = 'send-queue-hint',
    labels,
    activity,
    mobileLabel,
  }) => {
    const holding = holdingState.value;
    const pause = running && !hasDraft;
    const cancel = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      setHolding(false);
    };
    afterRender(() => () => clearTimeout(timer.current), []);
    watchDisabled(() => {
      if (disabled || activity || !canQueue) cancel();
    }, [disabled, activity, canQueue]);
    return (
      <button
        type="submit"
        class={`primary send-button ${pause ? 'pause-button' : ''} ${holding ? 'holding' : ''}`}
        aria-busy={!!activity}
        aria-label={
          activity ??
          (pause
            ? (labels?.stop ?? '中断任务')
            : running
              ? (labels?.running ?? '追加指令 ↑')
              : (labels?.send ?? '发送 ↑'))
        }
        title={pause ? (labels?.stop ?? '中断当前任务') : canQueue ? '点击直接发送；长按排队下一轮' : '发送'}
        aria-describedby={canQueue ? hintId : undefined}
        disabled={disabled || !!activity}
        onPointerdown={(e) => {
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
        onPointermove={(e) => {
          if (
            timer.current &&
            origin.current &&
            Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 12
          ) {
            handled.current = true;
            cancel();
          }
        }}
        onPointerup={cancel}
        onPointercancel={() => {
          handled.current = true;
          cancel();
        }}
        onPointerleave={() => {
          if (timer.current) {
            handled.current = true;
            cancel();
          }
        }}
        onContextmenu={(e) => e.preventDefault()}
        onKeydown={(e) => {
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
        {activity ? (
          <span class="sending-spinner" aria-hidden="true" />
        ) : (
          <>
            <Icon name={pause ? 'pause' : 'up'} size={23} />
            {mobileLabel && !pause && <span class="send-mobile-label">{mobileLabel}</span>}
          </>
        )}
      </button>
    );
  };
});
