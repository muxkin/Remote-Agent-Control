import { tsxComponent } from '../tsx-component';
import { shallowRef, useId, type VNodeChild, Teleport } from 'vue';
import { watchRender } from '../render-effects';

import { Icon } from '../Icon';
import './dialog.css';

export const Dialog = tsxComponent(function Dialog(_props: {
  title: string;
  titleIcon?: VNodeChild;
  className?: string;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  children?: VNodeChild;
}) {
  const ref = shallowRef<HTMLDialogElement | null>(null);
  const id = useId();
  const watchReturnFocus = watchRender();
  return ({ title, titleIcon, className, returnFocus, onClose, children }) => {
    watchReturnFocus(() => {
      const dialog = ref.value!,
        trigger = returnFocus ?? document.activeElement;
      dialog.showModal();
      return () => {
        dialog.close();
        if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
      };
    }, [returnFocus]);
    return (
      <Teleport to={document.body}>
        <dialog
          class={className ? `im-dialog ${className}` : 'im-dialog'}
          ref={ref}
          aria-labelledby={id}
          onCancel={(e) => {
            e.preventDefault();
            onClose();
          }}
          onClick={(e) => {
            if (e.target === (e.currentTarget as HTMLDialogElement)) {
              const r = (e.currentTarget as HTMLDialogElement).getBoundingClientRect();
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
            <button class="icon-button" aria-label="关闭" onClick={onClose}>
              <Icon name="close" />
            </button>
          </header>
          <div class="im-dialog-body">{children}</div>
        </dialog>
      </Teleport>
    );
  };
});
