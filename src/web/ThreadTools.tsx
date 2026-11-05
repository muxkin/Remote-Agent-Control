import { useEffect, useRef, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
export function ThreadTools({
  open,
  onClose,
  title,
  children,
  heading = '会话工具',
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  heading?: string;
  className?: string;
}) {
  const labelId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return createPortal(
    <dialog
      ref={ref}
      className={`thread-tools ${className}`}
      aria-labelledby={labelId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="question-dialog-head">
        <div>
          <h2 id={labelId}>{heading}</h2>
          {title && <p>{title}</p>}
        </div>
        <button className="icon-button" aria-label={`关闭${heading}`} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="tools-body">{children}</div>
    </dialog>,
    document.body,
  );
}
