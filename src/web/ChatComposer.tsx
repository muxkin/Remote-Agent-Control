import { clipboardFiles } from './clipboard-files';
import { UploadProgress, type UploadItem } from './UploadProgress';
import './composer-progress.css';
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ChatDraft } from './chat-drafts';
import { Icon } from './Icon';
import { SendButton } from './SendButton';
import { deviceSession } from './device-session';
import { useDesktopKeyboard } from './desktop-keyboard';
const UserAttachments = lazy(() => import('./UserAttachments'));

function DraftAttachment({
  file,
  threadId,
  onRemove,
}: {
  file: ChatDraft['uploads'][number];
  threadId?: string;
  onRemove: () => void;
}) {
  const [path, setPath] = useState(file.path);
  useEffect(() => {
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
    <span className="attachment-draft-placeholder">
      <Icon name="document" size={24} />
      <span>{file.name}</span>
      <button type="button" className="attachment-remove" aria-label={`移除 ${file.name}`} onClick={onRemove}>
        <Icon name="close" size={16} />
      </button>
    </span>
  );
  return path && threadId ? (
    <Suspense fallback={placeholder}>
      <UserAttachments files={[{ name: file.name, path }]} threadId={threadId} compact onRemove={onRemove} />
    </Suspense>
  ) : (
    placeholder
  );
}

/** The existing chat input, shared by first messages and ongoing conversations. */
export function ChatComposer({
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
}: {
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
  actions?: ReactNode;
  attachmentPreview?: ReactNode;
  messageLabel?: string;
  maxLength?: number;
  sendLabels?: { send: string; stop: string; running: string };
  activity?: string;
  feedback?: ReactNode;
  mobileSendLabel?: string;
  insertText?: { key: string; text: string; focus?: boolean };
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const desktopKeyboard = useDesktopKeyboard();
  const composing = useRef(false);
  const hintId = useId();
  const { text, uploads, skills, plugins } = value;
  const hasDraft = !!text.trim() || !!uploads.length || !!skills.length || !!plugins.length;
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      const limit = Math.min(parseFloat(getComputedStyle(el).maxHeight) || 140, 140);
      el.style.height = `${Math.min(el.scrollHeight, limit)}px`;
      el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : 'hidden';
    }
  }, [text]);
  useEffect(() => {
    const input = textareaRef.current;
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
      className="composer-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !sendDisabled && hasDraft) onSubmit();
      }}
    >
      {attachmentPreview}
      {attachmentPreview === undefined && !!uploads.length && (
        <div className="composer-attachments" aria-label="待发送的附件">
          {uploads.map((file) => (
            <div className="upload-chip" key={file.id}>
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
        <div className="selected-skills">
          {skills.map((skill) => (
            <span className="skill-chip" key={skill.id}>
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
        <div className="selected-skills">
          {plugins.map((plugin) => (
            <span className="skill-chip" key={plugin.id}>
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
        onChange={(e) => onChange({ text: e.target.value })}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          // IME confirmation is text input, including Safari's legacy keyCode 229.
          if (
            !desktopKeyboard ||
            event.key !== 'Enter' ||
            composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          if (event.ctrlKey) {
            event.preventDefault();
            const input = event.currentTarget;
            const { selectionStart, selectionEnd } = input;
            if (input.value.length - (selectionEnd - selectionStart) + 1 > input.maxLength) return;
            input.setRangeText('\n', selectionStart, selectionEnd, 'end');
            onChange({ text: input.value });
            return;
          }
          // Keep native modified-Enter behavior (such as Shift+Enter for a newline).
          if (event.shiftKey || event.altKey || event.metaKey) return;
          event.preventDefault();
          if (!event.repeat && !disabled && !sendDisabled && hasDraft)
            event.currentTarget.form?.requestSubmit();
        }}
        onPaste={(event) => {
          const files = clipboardFiles(event.clipboardData);
          if (!files.length || !onUpload || disabled || uploadDisabled || uploading) return;
          event.preventDefault();
          // Preserve text with pasted files. Plain-text-only pastes retain native behavior.
          const pastedText = event.clipboardData.getData('text/plain');
          if (pastedText) {
            const { selectionStart, selectionEnd } = event.currentTarget;
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
        enterKeyHint={desktopKeyboard ? 'send' : 'enter'}
        maxLength={maxLength}
        disabled={disabled}
      />
      {feedback}
      <div className="composer-actions">
        {onUpload && showUploadButton && (
          <label className="upload-button" title="添加附件">
            <Icon name="attach" size={22} />
            <span className="sr-only">添加附件</span>
            <input
              aria-label="添加附件"
              type="file"
              multiple
              disabled={disabled || uploadDisabled || uploading}
              onChange={(event) => {
                onUpload(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
        )}
        {actions}
        <div className="composer-send">
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
            <span id={hintId} className="sr-only">
              点击直接追加到当前任务；长按或按 Alt 加 Enter 排队下一轮。
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
