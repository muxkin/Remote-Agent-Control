import { tsxComponent } from './tsx-component';
import { useId, shallowRef, type VNodeChild, Teleport } from 'vue';
import { watchRender } from './render-effects';

import { Icon } from './Icon';
export const ThreadTools = tsxComponent(function ThreadTools(_props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: VNodeChild;
  heading?: string;
  className?: string;
}) {
  const labelId = useId();
  const ref = shallowRef<HTMLDialogElement | null>(null);
  const watchOpen = watchRender();
  return ({ open, onClose, title, children, heading = '会话工具', className = '' }) => {
    watchOpen(() => {
      const dialog = ref.value!;
      if (open && !dialog.open) dialog.showModal();
      else if (!open && dialog.open) dialog.close();
    }, [open]);
    return (
      <Teleport to={document.body}>
        <dialog
          ref={ref}
          class={`thread-tools ${className}`}
          aria-labelledby={labelId}
          onCancel={(e) => {
            e.preventDefault();
            onClose();
          }}
        >
          <header class="question-dialog-head">
            <div>
              <h2 id={labelId}>{heading}</h2>
              {title && <p>{title}</p>}
            </div>
            <button class="icon-button" aria-label={`关闭${heading}`} onClick={onClose}>
              <Icon name="close" />
            </button>
          </header>
          <div class="tools-body">{children}</div>
        </dialog>
      </Teleport>
    );
  };
});
