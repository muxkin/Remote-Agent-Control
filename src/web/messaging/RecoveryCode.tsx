import { writeRef } from '../render-effects';
import { tsxComponent } from '../tsx-component';
import { shallowRef } from 'vue';

import { Icon } from '../Icon';

export const RecoveryCode = tsxComponent(function RecoveryCode(_props: {
  code: string;
  busy: boolean;
  onContinue: () => void;
}) {
  const savedCodeState = shallowRef('');
  const setSavedCode = writeRef(savedCodeState);
  const noticeState = shallowRef('');
  const setNotice = writeRef(noticeState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  return ({ code, busy, onContinue }) => {
    const savedCode = savedCodeState.value;
    const notice = noticeState.value;
    const error = errorState.value;
    return (
      <div class="recovery-backup">
        <div class="recovery-code-box">
          <label for="account-recovery-code">账号恢复码</label>
          <textarea
            id="account-recovery-code"
            readonly
            value={code}
            rows={2}
            autocomplete="off"
            spellcheck={false}
          />
        </div>
        <div class="recovery-actions">
          <button
            class="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setNotice('恢复码已复制');
                setError('');
              } catch {
                setError('无法访问剪贴板，请选中恢复码手动复制，或下载保存。');
              }
            }}
          >
            <Icon name="copy" size={18} />
            复制
          </button>
          <button
            class="secondary"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    `Agent 空间 · 账号恢复码\n${location.origin}\n\n${code}\n\n请保存在安全位置，不要分享给他人。\n`,
                  ],
                  { type: 'text/plain;charset=utf-8' },
                ),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = 'agent-space-recovery-code.txt';
              document.body.append(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setNotice('恢复码已下载，请确认文件已安全保存');
              setError('');
            }}
          >
            <Icon name="download" size={18} />
            下载
          </button>
        </div>
        <label class="recovery-confirm">
          <input
            type="checkbox"
            checked={savedCode === code}
            onChange={(e) => setSavedCode((e.currentTarget as HTMLInputElement).checked ? code : '')}
          />
          <span>我已安全保存恢复码</span>
        </label>
        <button class="primary recovery-continue" disabled={savedCode !== code || busy} onClick={onContinue}>
          保存后继续
        </button>
        <p class="recovery-private">恢复码只属于你，请勿分享给他人。</p>
        {notice && (
          <p class="recovery-feedback" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  };
});
