import { useEffect, useRef, useId } from 'react';
import { Icon } from './Icon';

export function ComposerTools({
  plan,
  disabled,
  running,
  onMode,
  onSkills,
  onPlugins,
}: {
  plan: boolean;
  disabled: boolean;
  running: boolean;
  onMode: (mode: 'default' | 'plan') => void;
  onSkills: () => void;
  onPlugins: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    id = useId(),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    const composer = el?.closest('.composer-box');
    const position = () => {
      if (!el || !composer) return;
      const box = composer.getBoundingClientRect();
      el.style.left = `${box.left}px`;
      el.style.width = `${box.width}px`;
      el.style.bottom = `${innerHeight - box.top + 8}px`;
      el.style.maxHeight = `${Math.max(100, box.top - 16)}px`;
    };
    const observer = new ResizeObserver(position);
    if (composer) observer.observe(composer);
    el?.addEventListener('beforetoggle', position);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        el?.hidePopover();
        trigger.current?.focus();
      }
    };
    el?.addEventListener('keydown', close);
    return () => {
      el?.removeEventListener('keydown', close);
      el?.removeEventListener('beforetoggle', position);
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
    };
  }, []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="composer-tool-trigger"
        popoverTarget={id}
        aria-label="工具"
        aria-haspopup="dialog"
      >
        <Icon name="grid" size={18} />
        <span>工具</span>
      </button>
      <div ref={ref} popover="auto" id={id} role="dialog" aria-label="工具" className="composer-tools-menu">
        <header>
          <h2>工具</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭工具"
            popoverTarget={id}
            popoverTargetAction="hide"
          >
            <Icon name="close" size={20} />
          </button>
        </header>
        <p className="tools-section-label">模式</p>
        <button
          type="button"
          className="tool-menu-row mode-row"
          role="switch"
          aria-checked={plan}
          aria-label="计划模式"
          disabled={disabled}
          onClick={() => onMode(plan ? 'default' : 'plan')}
        >
          <Icon name="plan" />
          <span>
            <strong>计划模式</strong>
            <small>{running ? '应用到下一轮，当前任务不变' : '先讨论方案，再开始实施'}</small>
          </span>
          <span className={`mode-switch ${plan ? 'on' : ''}`} />
        </button>
        <button
          type="button"
          className="tool-menu-row"
          onClick={() => {
            ref.current?.hidePopover();
            onPlugins();
          }}
        >
          <Icon name="puzzle" />
          <span>
            <strong>插件</strong>
            <small>浏览与选择插件</small>
          </span>
          <Icon name="chevron" size={18} />
        </button>
        <button
          type="button"
          className="tool-menu-row"
          onClick={() => {
            ref.current?.hidePopover();
            onSkills();
          }}
        >
          <Icon name="book" />
          <span>
            <strong>技能</strong>
            <small>选择本次使用的技能</small>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      </div>
    </>
  );
}
