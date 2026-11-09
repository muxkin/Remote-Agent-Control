import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import './dialog.css';

export function Dialog({
  title,
  titleIcon,
  className,
  onClose,
  children,
}: {
  title: string;
  titleIcon?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!,
      trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      className={className ? `im-dialog ${className}` : 'im-dialog'}
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
            onClose();
        }
      }}
    >
      <header>
        <h2 id={id}>
          {titleIcon}
          {title}
        </h2>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="im-dialog-body">{children}</div>
    </dialog>,
    document.body,
  );
}
