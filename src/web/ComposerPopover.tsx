import { tsxComponent } from './tsx-component';
import { useId, shallowRef, type VNodeChild } from 'vue';
import { watchRender } from './render-effects';

/** A light-dismiss surface anchored to the composer, without a modal backdrop. */
export const ComposerPopover = tsxComponent(function ComposerPopover(initialProps: {
  label: string;
  title?: string;
  trigger: VNodeChild;
  className?: string;
  disabled?: boolean;
  menu?: boolean;
  maxWidth?: number;
  openRequest?: number;
  onOpen?: () => void;
  children: (close: (restoreFocus?: boolean) => void) => VNodeChild;
}) {
  const { onOpen } = initialProps;

  const id = useId();
  const panel = shallowRef<HTMLDivElement | null>(null);
  const button = shallowRef<HTMLButtonElement | null>(null);
  const onOpenRef = { current: onOpen };
  const watchAttribute = watchRender();
  const watchOpenRequest = watchRender();
  return ({
    label,
    title,
    trigger,
    className = '',
    disabled = false,
    menu = false,
    maxWidth = menu ? 304 : 344,
    openRequest = 0,
    onOpen,
    children,
  }) => {
    onOpenRef.current = onOpen;
    const close = (restoreFocus = true) => {
      panel.value?.hidePopover();
      if (restoreFocus) button.value?.focus({ preventScroll: true });
    };
    watchAttribute(() => {
      const el = panel.value;
      const anchor = button.value;
      const composer = anchor?.closest('.composer-box');
      if (!el || !anchor || !composer) return;
      const viewport = window.visualViewport;
      const position = () => {
        const box = composer.getBoundingClientRect();
        const triggerBox = anchor.getBoundingClientRect();
        const left = viewport?.offsetLeft ?? 0;
        const top = viewport?.offsetTop ?? 0;
        const width = Math.min(maxWidth, (viewport?.width ?? innerWidth) - 24);
        el.style.width = `${width}px`;
        el.style.left = `${Math.max(left + 12, Math.min(triggerBox.left, left + (viewport?.width ?? innerWidth) - width - 12))}px`;
        el.style.bottom = `${innerHeight - box.top + 8}px`;
        el.style.maxHeight = `${Math.max(80, box.top - top - 20)}px`;
      };
      let frame = 0;
      const reposition = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (el.matches(':popover-open')) position();
        });
      };
      const observer = new ResizeObserver(reposition);
      const stopTracking = () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        frame = 0;
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
        viewport?.removeEventListener('resize', reposition);
        viewport?.removeEventListener('scroll', reposition);
      };
      const before = (event: Event) => {
        if ((event as ToggleEvent).newState === 'open') {
          position();
          onOpenRef.current?.();
        } else stopTracking();
      };
      const toggle = () => {
        const open = el.matches(':popover-open');
        anchor.setAttribute('aria-expanded', String(open));
        if (open) {
          observer.observe(composer);
          window.addEventListener('resize', reposition);
          window.addEventListener('scroll', reposition, true);
          viewport?.addEventListener('resize', reposition);
          viewport?.addEventListener('scroll', reposition);
          const target = el.querySelector<HTMLElement>(
            '[aria-checked="true"], button:not(:disabled), input, textarea',
          );
          target?.focus({ preventScroll: true });
        }
      };
      el.addEventListener('beforetoggle', before);
      el.addEventListener('toggle', toggle);
      return () => {
        stopTracking();
        el.removeEventListener('beforetoggle', before);
        el.removeEventListener('toggle', toggle);
      };
    }, [maxWidth]);
    watchOpenRequest(() => {
      if (openRequest) panel.value?.showPopover();
    }, [openRequest]);
    return (
      <>
        <button
          ref={button}
          type="button"
          class={`composer-control-trigger ${className}`}
          popovertarget={id}
          aria-label={label}
          title={title ?? label}
          aria-haspopup={menu ? 'menu' : 'dialog'}
          aria-expanded="false"
          disabled={disabled}
        >
          {trigger}
        </button>
        <div
          ref={panel}
          id={id}
          popover="auto"
          role={menu ? 'menu' : 'dialog'}
          aria-label={label}
          class={`composer-popover ${menu ? 'permission-menu' : ''}`}
          onKeydown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
            if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = [
              ...(event.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
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
  };
});
