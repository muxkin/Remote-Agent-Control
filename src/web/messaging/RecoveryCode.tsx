import { useState } from 'react';
import { Icon } from '../Icon';

export function RecoveryCode({
  code,
  busy,
  onContinue,
}: {
  code: string;
  busy: boolean;
  onContinue: () => void;
}) {
  const [savedCode, setSavedCode] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="recovery-backup">
      <div className="recovery-code-box">
        <label htmlFor="account-recovery-code">账号恢复码</label>
        <textarea
          id="account-recovery-code"
          readOnly
          value={code}
          rows={2}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="recovery-actions">
        <button
          className="secondary"
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
          className="secondary"
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
      <label className="recovery-confirm">
        <input
          type="checkbox"
          checked={savedCode === code}
          onChange={(e) => setSavedCode(e.target.checked ? code : '')}
        />
        <span>我已安全保存恢复码</span>
      </label>
      <button
        className="primary recovery-continue"
        disabled={savedCode !== code || busy}
        onClick={onContinue}
      >
        保存后继续
      </button>
      <p className="recovery-private">恢复码只属于你，请勿分享给他人。</p>
      {notice && (
        <p className="recovery-feedback" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
