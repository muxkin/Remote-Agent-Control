import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { ChatDraft } from './chat-drafts';
import { Icon } from './Icon';
import { SendButton } from './SendButton';

/** The existing chat input, shared by first messages and ongoing conversations. */
export function ChatComposer({
  value,
  onChange,
  disabled,
  placeholder = '给 Codex 发消息…',
  uploading = false,
  uploadProgress = '',
  uploadDisabled = false,
  onUpload,
  running = false,
  sendDisabled,
  canQueue = false,
  onSubmit,
  onInterrupt = () => {},
  onQueue = () => {},
  actions,
}: {
  value: ChatDraft;
  onChange: (change: Partial<ChatDraft> | ((draft: ChatDraft) => ChatDraft)) => void;
  disabled: boolean;
  placeholder?: string;
  uploading?: boolean;
  uploadProgress?: string;
  uploadDisabled?: boolean;
  onUpload?: (files: FileList | File[] | null) => void;
  running?: boolean;
  sendDisabled: boolean;
  canQueue?: boolean;
  onSubmit: () => void;
  onInterrupt?: () => void;
  onQueue?: () => void;
  actions?: ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const { text, uploads, skills, plugins } = value;
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }
  }, [text]);
  return (
    <form
      className="composer-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sendDisabled) onSubmit();
      }}
    >
      {uploads.map((file) => (
        <div className="upload-chip" key={file.id}>
          {file.name}
          <button
            type="button"
            aria-label={`移除 ${file.name}`}
            onClick={() =>
              onChange((old) => ({ ...old, uploads: old.uploads.filter((u) => u.id !== file.id) }))
            }
          >
            ×
          </button>
        </div>
      ))}
      {uploadProgress && <p role="status">{uploadProgress}</p>}
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
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith('image/'),
          );
          if (!files.length || !onUpload || disabled || uploadDisabled || uploading) return;
          event.preventDefault();
          // Mixed text and images stay together in the same unsent draft.
          const pastedText = event.clipboardData.getData('text/plain');
          if (pastedText) {
            const { selectionStart, selectionEnd } = event.currentTarget;
            onChange({
              text: (text.slice(0, selectionStart) + pastedText + text.slice(selectionEnd)).slice(0, 16000),
            });
          }
          onUpload(files);
        }}
        placeholder={placeholder}
        aria-label="消息"
        maxLength={16000}
        disabled={disabled}
      />
      <div className="composer-actions">
        {onUpload && (
          <label className="upload-button">
            <Icon name="plusCircle" size={24} />
            <span className="sr-only">添加附件</span>
            <input
              aria-label="添加附件"
              type="file"
              multiple
              disabled={uploadDisabled || uploading}
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
            running={running}
            hasDraft={!!text.trim() || !!uploads.length || !!skills.length || !!plugins.length}
            disabled={sendDisabled}
            canQueue={canQueue}
            onInterrupt={onInterrupt}
            onQueue={onQueue}
            hintId={hintId}
          />
          <span id={hintId} className="sr-only">
            点击直接追加到当前任务；长按或按 Alt 加 Enter 排队下一轮。
          </span>
        </div>
      </div>
    </form>
  );
}
