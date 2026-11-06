import { useEffect, useState } from 'react';
import type { ControlAction, ControlCatalog, ControlState } from '../shared/controls';
import { remoteFetch } from './device-session';
import { exportSessionLog } from './file-client';
export function ConversationControls({
  id,
  state,
  disabled,
  onAction,
  onFile,
  onModel,
  refresh = 0,
}: {
  id: string;
  state?: ControlState;
  disabled: boolean;
  onAction: (action: ControlAction) => void;
  onFile?: (path: string) => void;
  onModel?: () => void;
  refresh?: number;
}) {
  const [catalog, setCatalog] = useState<ControlCatalog>();
  const [error, setError] = useState('');
  const [objective, setObjective] = useState('');
  const [feedback, setFeedback] = useState('');
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    remoteFetch(`/api/threads/${encodeURIComponent(id)}/controls`, { signal: controller.signal })
      .then(async (r) => {
        const c = await r.json();
        if (!r.ok) throw Error(c.error);
        setCatalog(c);
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [id, state?.permission, state?.preset, state?.plan, refresh]);
  const current = state ?? catalog?.state;
  const action = (a: ControlAction) => {
    setError('');
    onAction(a);
  };
  const locked = disabled || working;
  const has = (name: ControlAction['action']) => catalog?.actions.includes(name);
  return (
    <div className="conversation-controls">
      {error && <p role="alert">{error}</p>}
      {has('permission') && (
        <label>
          权限
          <select
            aria-label="会话权限"
            disabled={locked}
            value={current?.permission ?? ''}
            onChange={(e) =>
              action({
                action: 'permission',
                value: e.target.value,
                expected: current?.permission ?? null,
                expectedRevision: current?.permissionRevision,
              })
            }
          >
            {!catalog?.permissions.some((p) => p.id === current?.permission) && (
              <option value={current?.permission ?? ''}>{current?.permission ?? '原生默认'}</option>
            )}
            {catalog?.permissions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {current?.permissionDescription && <small>{current.permissionDescription}</small>}
      {has('preset') && (
        <label>
          Agent 预设
          <select
            aria-label="Agent 预设"
            value={current?.preset ?? ''}
            disabled={locked || current?.presetLocked}
            onChange={(e) => action({ action: 'preset', value: e.target.value })}
          >
            <option value="">原生默认</option>
            {catalog?.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {current?.presetLocked && <small>会话开始后由原实例固定</small>}
        </label>
      )}
      {has('plan') && (
        <button disabled={locked} onClick={() => action({ action: 'plan', enabled: !current?.plan })}>
          {current?.plan ? '退出计划模式' : '进入计划模式'}
        </button>
      )}
      {onModel && <button onClick={onModel}>模型</button>}
      {has('compact') && (
        <button disabled={locked} onClick={() => action({ action: 'compact' })}>
          压缩上下文
        </button>
      )}
      {has('goal') && (
        <details>
          <summary>目标</summary>
          {catalog?.goal && (
            <p>
              {catalog.goal.objective} · {catalog.goal.phase}{' '}
              {catalog.goal.activation === 'disarmed' ? '（未自动继续）' : ''}
            </p>
          )}
          <textarea
            aria-label="目标内容"
            placeholder="设置长期任务目标"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
          <button
            disabled={locked || !objective.trim()}
            onClick={() =>
              action({
                action: 'goal',
                operation: catalog?.goal ? 'edit' : 'create',
                ref: catalog?.goal?.ref,
                objective,
              })
            }
          >
            {catalog?.goal ? '修改目标' : '创建目标'}
          </button>
          {catalog?.goal &&
            (['pause', 'resume', 'complete', 'clear'] as const).map((operation, i) => (
              <button
                key={operation}
                disabled={locked}
                onClick={() => action({ action: 'goal', operation, ref: catalog.goal!.ref })}
              >
                {['暂停', '继续', '完成', '清除'][i]}
              </button>
            ))}
        </details>
      )}
      {has('feedback') && (
        <details>
          <summary>反馈</summary>
          <p>提交到 DSH 原生反馈服务，按原实例设置可能附带会话日志。</p>
          <textarea aria-label="反馈内容" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <button
            disabled={locked || !feedback.trim()}
            onClick={() => action({ action: 'feedback', text: feedback })}
          >
            提交反馈
          </button>
        </details>
      )}
      {catalog?.product === 'dsh' && (
        <>
          <details>
            <summary>工作区文件</summary>
            <input aria-label="查找工作区文件" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button
              disabled={locked}
              onClick={async () => {
                try {
                  const r = await remoteFetch(
                    `/api/threads/${encodeURIComponent(id)}/references?q=${encodeURIComponent(query)}`,
                  );
                  const data = await r.json();
                  if (!r.ok) throw Error(data.error);
                  setFiles(data.files);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              查找
            </button>
            {files.map((f) => (
              <button key={f.path} onClick={() => onFile?.(f.path)}>
                {f.name}
              </button>
            ))}
          </details>
          <button
            disabled={locked}
            onClick={async () => {
              setWorking(true);
              try {
                const file = await exportSessionLog(id);
                const a = document.createElement('a');
                a.href = file.url;
                a.download = file.name;
                a.click();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setWorking(false);
              }
            }}
          >
            {working ? '正在导出…' : '下载日志 ZIP'}
          </button>
        </>
      )}
      <small>设置以原实例确认为准；正在进行的任务遵守原生生效时机。</small>
    </div>
  );
}
