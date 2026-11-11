import { tsxComponent } from './tsx-component';
import { shallowRef, useId } from 'vue';
import { writeRef, watchRender } from './render-effects';

import type { UsageSnapshot } from '../shared/usage';
import { deviceSession } from './device-session';
import { Icon } from './Icon';
import { Dialog } from './shell/Dialog';
import './usage.css';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });

function resetTime(value: number) {
  return new Date(value).toDateString() === new Date().toDateString()
    ? `今天 ${timeFormat.format(value)} 重置`
    : `${dateFormat.format(value)} ${timeFormat.format(value)} 重置`;
}

function remaining(used: number) {
  return Math.floor(Math.max(0, Math.min(100, 100 - used)));
}

export const UsagePanel = tsxComponent(function UsagePanel(_props: {
  backendId: string;
  name: string;
  active: boolean;
  online: boolean;
}) {
  const snapshotState = shallowRef<UsageSnapshot>({ state: 'loading' });
  const setSnapshot = writeRef(snapshotState);
  const mobileOpenState = shallowRef(false);
  const setMobileOpen = writeRef(mobileOpenState);
  const desktopOpenState = shallowRef(false);
  const setDesktopOpen = writeRef(desktopOpenState);
  const trigger = shallowRef<HTMLButtonElement | null>(null);
  const popover = shallowRef<HTMLDivElement | null>(null);
  const id = useId();
  const watchSnapshot = watchRender();
  const watchMobileOpen = watchRender();
  const watchResize = watchRender();
  return ({ backendId, name, active, online }) => {
    const snapshot = snapshotState.value;
    const mobileOpen = mobileOpenState.value;
    const desktopOpen = desktopOpenState.value;

    watchSnapshot(() => {
      if (!active) return;
      return deviceSession.watchUsage(backendId, (next) =>
        setSnapshot((previous) =>
          !next.value && next.state !== 'unavailable' && previous.value?.available
            ? { state: 'stale', value: previous.value }
            : next,
        ),
      );
    }, [active, backendId]);

    watchMobileOpen(() => {
      if (!active) {
        popover.value?.hidePopover();
        setMobileOpen(false);
      }
    }, [active]);

    const position = () => {
      const box = trigger.value?.getBoundingClientRect();
      const panel = popover.value;
      if (!box || !panel) return;
      panel.style.top = `${box.bottom + 8}px`;
      panel.style.right = `${Math.max(12, window.innerWidth - box.right)}px`;
    };
    watchResize(() => {
      if (!desktopOpen) return;
      const closeAtMobile = () => {
        if (window.matchMedia('(max-width: 640px)').matches) popover.value?.hidePopover();
        else position();
      };
      window.addEventListener('resize', closeAtMobile);
      return () => window.removeEventListener('resize', closeAtMobile);
    }, [desktopOpen]);

    const value = snapshot.value;
    const state = online ? snapshot.state : 'stale';
    const mainBucket = value?.buckets.find(({ id }) => id === 'codex') ?? value?.buckets[0];
    const summary = mainBucket?.windows[0];
    const summaryPercent = summary && remaining(summary.usedPercent);
    const summaryName = summary?.label.replace(/用量$/, '');
    const triggerLabel =
      summaryPercent === undefined || state !== 'current'
        ? `${name} 用量`
        : `${name} 用量，${summaryName}剩余 ${summaryPercent}%`;
    const status = !online
      ? '等待电脑连接'
      : {
          loading: '正在同步用量',
          current: '自动更新',
          stale: '暂未同步，正在重试',
          unavailable: '用量暂不可用',
        }[state];

    const content = (
      <section class="usage-panel" aria-label="账户用量">
        <p class="usage-subtitle">{name} · 账户共享额度</p>
        <p class="usage-status" data-state={state} role="status">
          <span aria-hidden="true" />
          {status}
        </p>
        {value?.available ? (
          <div class="usage-buckets">
            {value.buckets.map((bucket) => (
              <div class="usage-bucket" key={bucket.id}>
                {(value.buckets.length > 1 || bucket.plan) && (
                  <h3>
                    {bucket.name === 'codex' ? name : bucket.name}
                    {bucket.plan && <span> · {bucket.plan}</span>}
                  </h3>
                )}
                {bucket.windows.map((window, i) => {
                  const left = remaining(window.usedPercent);
                  const label = window.label.replace(/用量$/, '') || window.label;
                  return (
                    <div class="usage-window" key={i}>
                      <div class="usage-window-line">
                        <div>
                          <strong class="usage-window-label">{label}</strong>
                          {window.resetsAt && <small>{resetTime(window.resetsAt)}</small>}
                        </div>
                        <div class="usage-remaining">
                          <strong>{left}%</strong>
                          <span>剩余</span>
                        </div>
                      </div>
                      <div
                        class="usage-meter"
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={left}
                        data-low={left <= 15}
                        aria-label={`${bucket.name} ${label}剩余额度`}
                        aria-valuetext={`剩余 ${left}%`}
                      >
                        <span style={{ width: `${left}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : state === 'unavailable' ? (
          <p class="usage-empty">{value?.reason ?? '此实例暂未提供用量信息'}</p>
        ) : null}
        {value?.available && (
          <footer>
            {state === 'current' ? '更新于 ' : '上次更新于 '}
            <time
              datetime={new Date(value.updatedAt).toISOString()}
              title={new Date(value.updatedAt).toLocaleString()}
            >
              {timeFormat.format(value.updatedAt)}
            </time>
          </footer>
        )}
      </section>
    );
    return (
      <div class="usage-control">
        <button
          ref={trigger}
          type="button"
          class="usage-trigger secondary"
          aria-label={triggerLabel}
          title={triggerLabel}
          aria-haspopup="dialog"
          aria-expanded={mobileOpen || desktopOpen}
          popovertarget={id}
          data-current={state === 'current'}
          onClick={(event) => {
            if (window.matchMedia('(max-width: 640px)').matches) {
              event.preventDefault();
              setMobileOpen(true);
            } else position();
          }}
        >
          <Icon name="gauge" size={18} />
          <span class="usage-trigger-label">用量</span>
          {summaryPercent !== undefined && state === 'current' && (
            <span class="usage-trigger-percent" aria-hidden="true">
              {summaryPercent}%
            </span>
          )}
        </button>
        <div
          ref={popover}
          id={id}
          popover="auto"
          role="dialog"
          aria-label={`${name} 用量`}
          class="usage-popover"
          tabindex={-1}
          onToggle={(event) => {
            const open = (event.currentTarget as HTMLDivElement).matches(':popover-open');
            setDesktopOpen(open);
            if (open) (event.currentTarget as HTMLDivElement).focus({ preventScroll: true });
          }}
        >
          <h2>用量</h2>
          {desktopOpen && content}
        </div>
        {active && mobileOpen && (
          <Dialog title="用量" className="usage-sheet" onClose={() => setMobileOpen(false)}>
            {() => <>{content}</>}
          </Dialog>
        )}
      </div>
    );
  };
});
