import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { AttachmentIdentity } from './AttachmentIdentity';
import { attachmentPath } from '../shared/attachments';

type OpenDetails = (anchor: HTMLElement) => void;

/** Same content, actions and focus handling; CSS presents a desktop popover or a mobile sheet. */
export function AttachmentActions({
  path,
  name,
  onDownload,
  onPreview,
  onRemove,
  onCopyImage,
  surface = 'card',
  children,
}: {
  path: string;
  name: string;
  onDownload: () => void | Promise<void>;
  onPreview?: () => void | Promise<void>;
  onRemove?: () => void;
  onCopyImage?: () => Promise<void>;
  surface?: 'inline' | 'card' | 'media' | 'compact';
  children: ReactNode | ((open: OpenDetails) => ReactNode);
}) {
  const [position, setPosition] = useState<{ x: number; y: number; bottom: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const displayPath = attachmentPath(path);
  useLayoutEffect(() => {
    if (!position) return;
    const element = panel.current!;
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
      className={`attachment-actions attachment-${surface}`}
      onContextMenu={(event) => {
        // Preserve the browser's Copy Image / Save Image menu on actual image pixels.
        // React portals bubble through this wrapper too; previews stop propagation themselves.
        if ((event.target as HTMLElement).closest('img')) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const anchor = (event.target as HTMLElement).closest<HTMLElement>('button') ?? event.currentTarget;
        show(anchor, { x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (panel.current?.contains(event.target as Node)) return;
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          show(event.target as HTMLElement);
        }
      }}
    >
      {typeof children === 'function' ? children(show) : children}
      {onRemove ? (
        <button type="button" className="attachment-remove" aria-label={`移除 ${name}`} onClick={onRemove}>
          <Icon name="close" size={16} />
        </button>
      ) : (
        surface !== 'inline' && (
          <button
            type="button"
            className="attachment-more"
            aria-label={`附件操作：${name}`}
            aria-haspopup="dialog"
            aria-expanded={!!position}
            aria-controls={position ? id : undefined}
            onClick={(event) => show(event.currentTarget)}
          >
            <Icon name="more" size={18} />
          </button>
        )
      )}
      {position &&
        createPortal(
          <dialog
            id={id}
            ref={panel}
            aria-label={`附件操作：${name}`}
            className="attachment-menu"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
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
              if (event.target !== event.currentTarget) return;
              const box = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < box.left ||
                event.clientX > box.right ||
                event.clientY < box.top ||
                event.clientY > box.bottom
              )
                close();
            }}
            onContextMenu={(event) => event.stopPropagation()}
          >
            <header className="attachment-menu-header">
              <AttachmentIdentity
                path={path}
                name={name}
                action={
                  onPreview && (
                    <button
                      type="button"
                      className="attachment-preview-action"
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
              <button type="button" className="attachment-dismiss" aria-label="关闭" onClick={close}>
                <Icon name="close" size={20} />
              </button>
            </header>
            <div className="attachment-menu-body">
              {!onCopyImage && (
                <>
                  <span className="attachment-path-label">文件路径</span>
                  <div
                    className="attachment-path"
                    role="textbox"
                    aria-label="文件路径"
                    aria-readonly="true"
                    tabIndex={0}
                  >
                    {displayPath}
                  </div>
                </>
              )}
              <div className="attachment-menu-buttons">
                <button
                  type="button"
                  className="attachment-copy"
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
                    {onCopyImage ? (copied ? '图片已复制' : '复制图片') : copied ? '已复制路径' : '复制路径'}
                  </span>
                </button>
                <button
                  type="button"
                  className="attachment-download"
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
                <p className="attachment-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </dialog>,
          document.body,
        )}
    </span>
  );
}
