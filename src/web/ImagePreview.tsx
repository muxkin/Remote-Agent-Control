import { useLayoutEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export function ImagePreview({
  src,
  label,
  error,
  reload,
  onClose,
  onError,
  onRetry,
}: {
  src: string;
  label: string;
  error: string;
  reload: number;
  onClose: () => void;
  onError: () => void;
  onRetry: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="image-preview"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{label || '图片预览'}</h2>
        <button className="icon-button" aria-label="关闭图片预览" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <img key={reload} src={src} alt={label} referrerPolicy="no-referrer" onError={onError} />
      {error && (
        <div className="image-preview-error" role="alert">
          <p>{error}</p>
          <button className="secondary" onClick={onRetry}>
            重新加载图片
          </button>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
