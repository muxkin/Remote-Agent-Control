import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from './render-effects';

import { Icon } from './Icon';

export const CodexReplyActions = tsxComponent(function CodexReplyActions(_props: {
  text: string;
  loadText?: () => Promise<string>;
  onFork?: () => void;
  forkDisabled?: boolean;
}) {
  const copyState = shallowRef<'idle' | 'loading' | 'copied' | 'failed'>('idle');
  const setCopy = writeRef(copyState);
  const watchTimeout = watchRender();
  return ({ text, loadText, onFork, forkDisabled }) => {
    const copy = copyState.value;
    watchTimeout(() => {
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
      <div class="codex-reply-actions" role="group" aria-label="回复操作">
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
        <span class="codex-reply-feedback" role="status">
          {copy === 'copied' ? '已复制' : copy === 'failed' ? '复制失败，请选中回复后复制' : ''}
        </span>
      </div>
    );
  };
});
