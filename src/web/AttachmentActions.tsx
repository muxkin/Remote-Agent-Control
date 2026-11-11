import { tsxComponent } from './tsx-component';
import { shallowRef, useId, type VNodeChild, Teleport } from 'vue';
import { watchRender, writeRef } from './render-effects';

import { Icon } from './Icon';
import { AttachmentIdentity } from './AttachmentIdentity';
import { attachmentPath } from '../shared/attachments';

type OpenDetails = (anchor: HTMLElement) => void;

/** Same content, actions and focus handling; CSS presents a desktop popover or a mobile sheet. */
export const AttachmentActions = tsxComponent(function AttachmentActions(_props: {
  path: string;
  name: string;
  onDownload: () => void | Promise<void>;
  onPreview?: () => void | Promise<void>;
  onRemove?: () => void;
  onCopyImage?: () => Promise<void>;
  hideMore?: boolean;
  surface?: 'inline' | 'card' | 'media' | 'compact';
  children?: VNodeChild | ((open: OpenDetails) => VNodeChild);
}) {
  const positionState = shallowRef<{ x: number; y: number; bottom: number } | null>(null);
  const setPosition = writeRef(positionState);
  const copiedState = shallowRef(false);
  const setCopied = writeRef(copiedState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const panel = shallowRef<HTMLDialogElement | null>(null);
  const returnFocus: { current: HTMLElement | null } = { current: null };
  const id = useId();
  const watchResize = watchRender();
  return ({
    path,
    name,
    onDownload,
    onPreview,
    onRemove,
    onCopyImage,
    hideMore = false,
    surface = 'card',
    children,
  }) => {
    const position = positionState.value;
    const copied = copiedState.value;
    const error = errorState.value;
    const busy = busyState.value;

    const displayPath = attachmentPath(path);
    watchResize(() => {
      if (!position) return;
      const element = panel.value!;
      const place = () => {
        const viewport = window.visualViewport;
        const width = viewport?.width ?? innerWidth;
        const height = viewport?.height ?? innerHeight;
        const left = viewport?.offsetLeft ?? 0;
        const top = viewport?.offsetTop ?? 0;
        const mobile = matchMedia('(max-width: 600px)').matches;
        element.style.width = mobile ? `${width}px` : `${Math.min(368, width - 24)}px`;
        element.style.maxHeight = `${height - (mobile ? 24 : 16)}px`;
        const box = element.getBoundingClientRect();
        element.style.left = `${mobile ? left : Math.max(left + 12, Math.min(position.x, left + width - box.width - 12))}px`;
        const above = position.y - box.height - 8;
        const y = position.bottom + box.height + 8 <= top + height ? position.bottom + 8 : above;
        element.style.top = `${mobile ? top + height - box.height : Math.max(top + 8, Math.min(y, top + height - box.height - 8))}px`;
      };
      element.showModal();
      place();
      const observer = new ResizeObserver(place);
      observer.observe(element);
      window.addEventListener('resize', place);
      window.visualViewport?.addEventListener('resize', place);
      window.visualViewport?.addEventListener('scroll', place);
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', place);
        window.visualViewport?.removeEventListener('resize', place);
        window.visualViewport?.removeEventListener('scroll', place);
        element.close();
        if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
      };
    }, [position]);
    function show(anchor: HTMLElement, point?: { x: number; y: number }) {
      returnFocus.current = anchor;
      const rect = anchor.getBoundingClientRect();
      setCopied(false);
      setError('');
      setPosition(point ? { ...point, bottom: point.y } : { x: rect.left, y: rect.top, bottom: rect.bottom });
    }
    const close = () => setPosition(null);
    return (
      <span
        class={`attachment-actions attachment-${surface}`}
        onContextmenu={(event) => {
          // Preserve the browser's Copy Image / Save Image menu on actual image pixels.
          if ((event.target as HTMLElement).closest('img')) {
            event.stopPropagation();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const anchor =
            (event.target as HTMLElement).closest<HTMLElement>('button') ??
            (event.currentTarget as HTMLSpanElement);
          show(anchor, { x: event.clientX, y: event.clientY });
        }}
        onKeydown={(event) => {
          if (panel.value?.contains(event.target as Node)) return;
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            show(event.target as HTMLElement);
          }
        }}
      >
        {typeof children === 'function' ? children(show) : children}
        {onRemove ? (
          <button type="button" class="attachment-remove" aria-label={`移除 ${name}`} onClick={onRemove}>
            <Icon name="close" size={16} />
          </button>
        ) : (
          !hideMore &&
          surface !== 'inline' && (
            <button
              type="button"
              class="attachment-more"
              aria-label={`附件操作：${name}`}
              aria-haspopup="dialog"
              aria-expanded={!!position}
              aria-controls={position ? id : undefined}
              onClick={(event) => show(event.currentTarget as HTMLButtonElement)}
            >
              <Icon name="more" size={18} />
            </button>
          )
        )}
        {position && (
          <Teleport to={document.body}>
            <dialog
              id={id}
              ref={panel}
              aria-label={`附件操作：${name}`}
              class="attachment-menu"
              onKeydown={(event) => {
                if (event.key !== 'Tab') return;
                const items = [
                  ...(event.currentTarget as HTMLDialogElement).querySelectorAll<HTMLElement>(
                    'button:not(:disabled), [tabindex="0"]',
                  ),
                ];
                const edge = event.shiftKey ? items[0] : items.at(-1);
                if (document.activeElement === edge) {
                  event.preventDefault();
                  (event.shiftKey ? items.at(-1) : items[0])?.focus();
                }
              }}
              onCancel={(event) => {
                event.preventDefault();
                close();
              }}
              onClick={(event) => {
                if (event.target !== (event.currentTarget as HTMLDialogElement)) return;
                const box = (event.currentTarget as HTMLDialogElement).getBoundingClientRect();
                if (
                  event.clientX < box.left ||
                  event.clientX > box.right ||
                  event.clientY < box.top ||
                  event.clientY > box.bottom
                )
                  close();
              }}
              onContextmenu={(event) => event.stopPropagation()}
            >
              <header class="attachment-menu-header">
                <AttachmentIdentity
                  path={path}
                  name={name}
                  action={
                    onPreview && (
                      <button
                        type="button"
                        class="attachment-preview-action"
                        onClick={() => {
                          close();
                          void onPreview();
                        }}
                      >
                        预览
                      </button>
                    )
                  }
                />
                <button type="button" class="attachment-dismiss" aria-label="关闭" onClick={close}>
                  <Icon name="close" size={20} />
                </button>
              </header>
              <div class="attachment-menu-body">
                {!onCopyImage && (
                  <>
                    <span class="attachment-path-label">文件路径</span>
                    <div
                      class="attachment-path"
                      role="textbox"
                      aria-label="文件路径"
                      aria-readonly="true"
                      tabindex={0}
                    >
                      {displayPath}
                    </div>
                  </>
                )}
                <div class="attachment-menu-buttons">
                  <button
                    type="button"
                    class="attachment-copy"
                    onClick={async () => {
                      try {
                        if (onCopyImage) await onCopyImage();
                        else await navigator.clipboard.writeText(displayPath);
                        setCopied(true);
                        setError('');
                      } catch {
                        setError(
                          onCopyImage
                            ? '复制失败，请在图片上右键复制，或下载保存'
                            : '复制失败，可选中上方路径手动复制',
                        );
                      }
                    }}
                  >
                    <Icon name={copied ? 'check' : 'copy'} size={18} />
                    <span aria-live="polite">
                      {onCopyImage
                        ? copied
                          ? '图片已复制'
                          : '复制图片'
                        : copied
                          ? '已复制路径'
                          : '复制路径'}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="attachment-download"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await onDownload();
                        setError('');
                      } catch (error) {
                        setError(error instanceof Error ? error.message : '下载失败，请重试');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Icon name="download" size={18} />
                    <span aria-live="polite">{busy ? '正在准备…' : '下载文件'}</span>
                  </button>
                </div>
                {error && (
                  <p class="attachment-error" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </dialog>
          </Teleport>
        )}
      </span>
    );
  };
});
