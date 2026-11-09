import { useEffect, useState } from 'react';
import { Icon } from './Icon';

export function CodexReplyActions({
  text,
  loadText,
  onFork,
  forkDisabled,
}: {
  text: string;
  loadText?: () => Promise<string>;
  onFork?: () => void;
  forkDisabled?: boolean;
}) {
  const [copy, setCopy] = useState<'idle' | 'loading' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copy !== 'copied' && copy !== 'failed') return;
    const timer = setTimeout(() => setCopy('idle'), 2500);
    return () => clearTimeout(timer);
  }, [copy]);

  async function copyReply() {
    setCopy('loading');
    try {
      if (loadText && typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
        // Safari requires the clipboard write to start within the original click.
        const value = loadText().then((content) => new Blob([content], { type: 'text/plain' }));
        void value.catch(() => {});
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': value })]);
      } else {
        await navigator.clipboard.writeText(loadText ? await loadText() : text);
      }
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <div className="codex-reply-actions" role="group" aria-label="回复操作">
      {text && (
        <button
          type="button"
          title={copy === 'copied' ? '已复制' : '复制回复'}
          aria-label="复制回复"
          disabled={copy === 'loading'}
          onClick={() => void copyReply()}
        >
          <Icon name={copy === 'copied' ? 'check' : 'copy'} size={16} />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          title="从这里创建分支"
          aria-label="从这里创建分支"
          disabled={forkDisabled}
          onClick={onFork}
        >
          <Icon name="branch" size={17} />
        </button>
      )}
      <span className="codex-reply-feedback" role="status">
        {copy === 'copied' ? '已复制' : copy === 'failed' ? '复制失败，请选中回复后复制' : ''}
      </span>
    </div>
  );
}
