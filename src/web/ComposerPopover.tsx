import { useEffect, useId, useRef, type ReactNode } from 'react';

/** A light-dismiss surface anchored to the composer, without a modal backdrop. */
export function ComposerPopover({
  label,
  title,
  trigger,
  className = '',
  menu = false,
  openRequest = 0,
  onOpen,
  children,
}: {
  label: string;
  title?: string;
  trigger: ReactNode;
  className?: string;
  menu?: boolean;
  openRequest?: number;
  onOpen?: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const close = () => {
    panel.current?.hidePopover();
    button.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const el = panel.current;
    const anchor = button.current;
    const composer = anchor?.closest('.composer-box');
    if (!el || !anchor || !composer) return;
    const position = () => {
      const box = composer.getBoundingClientRect();
      const triggerBox = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = Math.min(menu ? 304 : 344, (viewport?.width ?? innerWidth) - 24);
      el.style.width = `${width}px`;
      el.style.left = `${Math.max(left + 12, Math.min(triggerBox.left, left + (viewport?.width ?? innerWidth) - width - 12))}px`;
      el.style.bottom = `${innerHeight - box.top + 8}px`;
      el.style.maxHeight = `${Math.max(80, box.top - top - 20)}px`;
    };
    const before = (event: Event) => {
      if ((event as ToggleEvent).newState === 'open') {
        position();
        onOpenRef.current?.();
      }
    };
    const toggle = () => {
      const open = el.matches(':popover-open');
      anchor.setAttribute('aria-expanded', String(open));
      if (open) {
        const target = el.querySelector<HTMLElement>(
          '[aria-checked="true"], button:not(:disabled), input, textarea',
        );
        target?.focus({ preventScroll: true });
      }
    };
    const observer = new ResizeObserver(position);
    observer.observe(composer);
    el.addEventListener('beforetoggle', before);
    el.addEventListener('toggle', toggle);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      el.removeEventListener('beforetoggle', before);
      el.removeEventListener('toggle', toggle);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [menu]);
  useEffect(() => {
    if (openRequest) panel.current?.showPopover();
  }, [openRequest]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`composer-control-trigger ${className}`}
        popoverTarget={id}
        aria-label={label}
        title={title ?? label}
        aria-haspopup={menu ? 'menu' : 'dialog'}
        aria-expanded="false"
      >
        {trigger}
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role={menu ? 'menu' : 'dialog'}
        aria-label={label}
        className={`composer-popover ${menu ? 'permission-menu' : ''}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
          if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitemradio"]:not(:disabled)',
            ),
          ];
          if (!items.length) return;
          event.preventDefault();
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        {children(close)}
      </div>
    </>
  );
}
