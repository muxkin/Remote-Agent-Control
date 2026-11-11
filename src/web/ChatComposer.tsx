import { tsxComponent } from './tsx-component';
import { shallowRef, useId, defineAsyncComponent as lazy, Suspense, type VNodeChild } from 'vue';
import { watchRender, writeRef } from './render-effects';
import { clipboardFiles } from './clipboard-files';
import { UploadProgress, type UploadItem } from './UploadProgress';
import './composer-progress.css';
import type { ChatDraft } from './chat-drafts';
import { Icon } from './Icon';
import { SendButton } from './SendButton';
import { deviceSession } from './device-session';
import { useDesktopKeyboard } from './desktop-keyboard';
const UserAttachments = lazy(() => import('./UserAttachments'));

const DraftAttachment = tsxComponent(function DraftAttachment(initialProps: {
  file: ChatDraft['uploads'][number];
  threadId?: string;
  onRemove: () => void;
}) {
  const { file } = initialProps;

  const pathState = shallowRef(file.path);
  const setPath = writeRef(pathState);
  const watchPath = watchRender();
  return ({ file, threadId, onRemove }) => {
    const path = pathState.value;
    watchPath(() => {
      if (file.path) {
        setPath(file.path);
        return;
      }
      if (!threadId) return;
      let disposed = false;
      // Older saved drafts contain only the completed upload ID and name.
      void deviceSession
        .api<{ path?: string }>(
          `/threads/${encodeURIComponent(threadId)}/uploads/${encodeURIComponent(file.id)}/complete`,
          { method: 'POST' },
        )
        .then((result) => {
          if (!disposed) setPath(result.path);
        })
        .catch(() => {});
      return () => {
        disposed = true;
      };
    }, [file.id, file.path, threadId]);
    const placeholder = (
      <span class="attachment-draft-placeholder">
        <Icon name="document" size={24} />
        <span>{file.name}</span>
        <button type="button" class="attachment-remove" aria-label={`移除 ${file.name}`} onClick={onRemove}>
          <Icon name="close" size={16} />
        </button>
      </span>
    );
    return path && threadId ? (
      <Suspense timeout={0}>
        {{
          fallback: () => placeholder,
          default: () => (
            <>
              <UserAttachments
                files={[{ name: file.name, path }]}
                threadId={threadId}
                compact
                onRemove={onRemove}
              />
            </>
          ),
        }}
      </Suspense>
    ) : (
      placeholder
    );
  };
});

/** The existing chat input, shared by first messages and ongoing conversations. */
export const ChatComposer = tsxComponent(function ChatComposer(_props: {
  value: ChatDraft;
  threadId?: string;
  onChange: (change: Partial<ChatDraft> | ((draft: ChatDraft) => ChatDraft)) => void;
  disabled: boolean;
  placeholder?: string;
  uploading?: boolean;
  uploadItems?: UploadItem[];
  onDismissUploads?: () => void;
  uploadDisabled?: boolean;
  showUploadButton?: boolean;
  onUpload?: (files: FileList | File[] | null) => void;
  running?: boolean;
  sendDisabled: boolean;
  canQueue?: boolean;
  onSubmit: () => void;
  onInterrupt?: () => void;
  onQueue?: () => void;
  actions?: VNodeChild;
  attachmentPreview?: VNodeChild;
  messageLabel?: string;
  maxLength?: number;
  sendLabels?: { send: string; stop: string; running: string };
  activity?: string;
  feedback?: VNodeChild;
  mobileSendLabel?: string;
  insertText?: { key: string; text: string; focus?: boolean };
}) {
  const textareaRef = shallowRef<HTMLTextAreaElement | null>(null);
  const readDesktopKeyboard = useDesktopKeyboard();
  const composing = { current: false };
  const hintId = useId();
  const watchText = watchRender();
  const watchSelectionRange = watchRender();
  return ({
    value,
    threadId,
    onChange,
    disabled,
    placeholder = '给 Codex 发消息…',
    uploading = false,
    uploadItems = [],
    onDismissUploads,
    uploadDisabled = false,
    showUploadButton = true,
    onUpload,
    running = false,
    sendDisabled,
    canQueue = false,
    onSubmit,
    onInterrupt = () => {},
    onQueue = () => {},
    actions,
    attachmentPreview,
    messageLabel = '消息',
    maxLength = 16000,
    sendLabels,
    activity,
    feedback,
    insertText,
    mobileSendLabel,
  }) => {
    const desktopKeyboard = readDesktopKeyboard.value;

    const { text, uploads, skills, plugins } = value;
    const hasDraft = !!text.trim() || !!uploads.length || !!skills.length || !!plugins.length;
    const canSubmit = !disabled && !sendDisabled && !activity && hasDraft;
    watchText(() => {
      const el = textareaRef.value;
      if (el) {
        el.style.height = 'auto';
        const limit = Math.min(parseFloat(getComputedStyle(el).maxHeight) || 140, 140);
        el.style.height = `${Math.min(el.scrollHeight, limit)}px`;
        el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden';
      }
    }, [text]);
    watchSelectionRange(() => {
      const input = textareaRef.value;
      if (!insertText || !input || disabled) return;
      const start = input.selectionStart,
        end = input.selectionEnd;
      const next = input.value.slice(0, start) + insertText.text + input.value.slice(end);
      if (next.length > maxLength) return;
      onChange({ text: next });
      requestAnimationFrame(() => {
        if (!input.isConnected) return;
        if (insertText.focus !== false) input.focus({ preventScroll: true });
        input.setSelectionRange(start + insertText.text.length, start + insertText.text.length);
      });
    }, [insertText]);
    return (
      <form
        class="composer-box"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onSubmit();
        }}
      >
        {attachmentPreview}
        {attachmentPreview === undefined && !!uploads.length && (
          <div class="composer-attachments" aria-label="待发送的附件">
            {uploads.map((file) => (
              <div class="upload-chip" key={file.id}>
                <DraftAttachment
                  file={file}
                  threadId={threadId}
                  onRemove={() =>
                    onChange((old) => ({ ...old, uploads: old.uploads.filter((u) => u.id !== file.id) }))
                  }
                />
              </div>
            ))}
          </div>
        )}
        <UploadProgress items={uploadItems} onDismiss={onDismissUploads} />
        {!!skills.length && (
          <div class="selected-skills">
            {skills.map((skill) => (
              <span class="skill-chip" key={skill.id}>
                {skill.displayName || skill.name}
                <button
                  type="button"
                  aria-label={`移除技能 ${skill.displayName || skill.name}`}
                  onClick={() =>
                    onChange((old) => ({ ...old, skills: old.skills.filter((s) => s.id !== skill.id) }))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {!!plugins.length && (
          <div class="selected-skills">
            {plugins.map((plugin) => (
              <span class="skill-chip" key={plugin.id}>
                <Icon name="puzzle" size={16} />
                {plugin.name}
                <button
                  type="button"
                  aria-label={`移除插件 ${plugin.name}`}
                  onClick={() =>
                    onChange((old) => ({ ...old, plugins: old.plugins.filter((p) => p.id !== plugin.id) }))
                  }
                >
                  <Icon name="close" size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onInput={(e) => onChange({ text: (e.currentTarget as HTMLTextAreaElement).value })}
          onCompositionstart={() => {
            composing.current = true;
          }}
          onCompositionend={() => {
            composing.current = false;
          }}
          onKeydown={(event) => {
            // IME confirmation is text input, including Safari's legacy keyCode 229.
            if (
              !desktopKeyboard ||
              event.key !== 'Enter' ||
              composing.current ||
              event.isComposing ||
              event.keyCode === 229
            )
              return;
            if (event.ctrlKey) {
              event.preventDefault();
              const input = event.currentTarget as HTMLTextAreaElement;
              const { selectionStart, selectionEnd } = input;
              if (input.value.length - (selectionEnd - selectionStart) + 1 > input.maxLength) return;
              input.setRangeText('\n', selectionStart, selectionEnd, 'end');
              onChange({ text: input.value });
              return;
            }
            // Keep native modified-Enter behavior (such as Shift+Enter for a newline).
            if (event.shiftKey || event.altKey || event.metaKey) return;
            event.preventDefault();
            if (!event.repeat && canSubmit)
              (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
          }}
          onPaste={(event) => {
            const clipboard = event.clipboardData;
            if (!clipboard) return;
            const files = clipboardFiles(clipboard);
            if (!files.length || !onUpload || disabled || uploadDisabled || uploading) return;
            event.preventDefault();
            // Preserve text with pasted files. Plain-text-only pastes retain native behavior.
            const pastedText = clipboard.getData('text/plain');
            if (pastedText) {
              const { selectionStart, selectionEnd } = event.currentTarget as HTMLTextAreaElement;
              onChange({
                text: (text.slice(0, selectionStart) + pastedText + text.slice(selectionEnd)).slice(
                  0,
                  maxLength,
                ),
              });
            }
            onUpload(files);
          }}
          placeholder={placeholder}
          aria-label={messageLabel}
          aria-description={desktopKeyboard ? 'Enter 发送，Ctrl+Enter 换行' : '回车换行，点击发送按钮发送'}
          enterkeyhint={desktopKeyboard ? 'send' : 'enter'}
          maxlength={maxLength}
          disabled={disabled}
        />
        {feedback}
        <div class="composer-actions">
          {onUpload && showUploadButton && (
            <label class="upload-button" title="添加附件">
              <Icon name="attach" size={22} />
              <span class="sr-only">添加附件</span>
              <input
                aria-label="添加附件"
                type="file"
                multiple
                disabled={disabled || uploadDisabled || uploading}
                onChange={(event) => {
                  onUpload((event.currentTarget as HTMLInputElement).files);
                  (event.currentTarget as HTMLInputElement).value = '';
                }}
              />
            </label>
          )}
          {actions}
          <div
            class="composer-send"
            onMousedown={(event) => {
              if (document.activeElement === textareaRef.value) event.preventDefault();
            }}
          >
            <SendButton
              activity={activity}
              mobileLabel={mobileSendLabel}
              labels={sendLabels}
              running={running}
              hasDraft={hasDraft}
              disabled={sendDisabled}
              canQueue={canQueue}
              onInterrupt={onInterrupt}
              onQueue={onQueue}
              hintId={hintId}
            />
            {canQueue && (
              <span id={hintId} class="sr-only">
                点击直接追加到当前任务；长按或按 Alt 加 Enter 排队下一轮。
              </span>
            )}
          </div>
        </div>
      </form>
    );
  };
});
