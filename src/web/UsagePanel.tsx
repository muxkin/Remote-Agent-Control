import { useEffect, useId, useRef, useState } from 'react';
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

export function UsagePanel({
  backendId,
  name,
  active,
  online,
}: {
  backendId: string;
  name: string;
  active: boolean;
  online: boolean;
}) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>({ state: 'loading' });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!active) return;
    return deviceSession.watchUsage(backendId, (next) =>
      setSnapshot((previous) =>
        !next.value && next.state !== 'unavailable' && previous.value?.available
          ? { state: 'stale', value: previous.value }
          : next,
      ),
    );
  }, [active, backendId]);

  useEffect(() => {
    if (!active) {
      popover.current?.hidePopover();
      setMobileOpen(false);
    }
  }, [active]);

  const position = () => {
    const box = trigger.current?.getBoundingClientRect();
    const panel = popover.current;
    if (!box || !panel) return;
    panel.style.top = `${box.bottom + 8}px`;
    panel.style.right = `${Math.max(12, window.innerWidth - box.right)}px`;
  };
  useEffect(() => {
    if (!desktopOpen) return;
    const closeAtMobile = () => {
      if (window.matchMedia('(max-width: 640px)').matches) popover.current?.hidePopover();
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
    <section className="usage-panel" aria-label="账户用量">
      <p className="usage-subtitle">{name} · 账户共享额度</p>
      <p className="usage-status" data-state={state} role="status">
        <span aria-hidden="true" />
        {status}
      </p>
      {value?.available ? (
        <div className="usage-buckets">
          {value.buckets.map((bucket) => (
            <div className="usage-bucket" key={bucket.id}>
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
                  <div className="usage-window" key={i}>
                    <div className="usage-window-line">
                      <div>
                        <strong className="usage-window-label">{label}</strong>
                        {window.resetsAt && <small>{resetTime(window.resetsAt)}</small>}
                      </div>
                      <div className="usage-remaining">
                        <strong>{left}%</strong>
                        <span>剩余</span>
                      </div>
                    </div>
                    <div
                      className="usage-meter"
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
        <p className="usage-empty">{value?.reason ?? '此实例暂未提供用量信息'}</p>
      ) : null}
      {value?.available && (
        <footer>
          {state === 'current' ? '更新于 ' : '上次更新于 '}
          <time
            dateTime={new Date(value.updatedAt).toISOString()}
            title={new Date(value.updatedAt).toLocaleString()}
          >
            {timeFormat.format(value.updatedAt)}
          </time>
        </footer>
      )}
    </section>
  );
  return (
    <div className="usage-control">
      <button
        ref={trigger}
        type="button"
        className="usage-trigger secondary"
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={mobileOpen || desktopOpen}
        popoverTarget={id}
        data-current={state === 'current'}
        onClick={(event) => {
          if (window.matchMedia('(max-width: 640px)').matches) {
            event.preventDefault();
            setMobileOpen(true);
          } else position();
        }}
      >
        <Icon name="gauge" size={18} />
        <span className="usage-trigger-label">用量</span>
        {summaryPercent !== undefined && state === 'current' && (
          <span className="usage-trigger-percent" aria-hidden="true">
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
        className="usage-popover"
        tabIndex={-1}
        onToggle={(event) => {
          const open = event.currentTarget.matches(':popover-open');
          setDesktopOpen(open);
          if (open) event.currentTarget.focus({ preventScroll: true });
        }}
      >
        <h2>用量</h2>
        {desktopOpen && content}
      </div>
      {active && mobileOpen && (
        <Dialog title="用量" className="usage-sheet" onClose={() => setMobileOpen(false)}>
          {content}
        </Dialog>
      )}
    </div>
  );
}
