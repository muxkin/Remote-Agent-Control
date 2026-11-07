import type { BackendInfo } from '../shared/backends';
import { useEffect, useState } from 'react';
import type { ControlAction, ControlCatalog, ControlState } from '../shared/controls';
import { remoteFetch } from './device-session';
import { exportSessionLog, downloadFile } from './file-client';
import { ComposerPopover } from './ComposerPopover';
import { Icon } from './Icon';

export type ControlSection = 'permission' | 'tools' | 'preset' | 'goal' | 'feedback' | 'file';
const permissionNames: Record<string, string> = {
  ':read-only': '只读',
  'read-only': '只读',
  ':workspace': '工作区内修改',
  'workspace-write': '工作区内修改',
  ':danger-full-access': '完全访问',
  'danger-full-access': '完全访问',
  auto: '自动审批',
  custom: '自定义权限',
};
const permissionHints: Record<string, string> = {
  ':read-only': '查看文件，不修改工作区',
  ':workspace': '在工作区内读写，其他操作按需审批',
  ':danger-full-access': '不受沙箱限制，操作无需逐次审批',
};
const headings = {
  tools: '工具',
  preset: 'Agent 预设',
  goal: '长期目标',
  feedback: '会话反馈',
  file: '工作区文件',
  permission: '会话权限',
};

export function ConversationControls({
  id,
  state,
  backend,
  disabled,
  modeDisabled,
  running,
  plan,
  onMode,
  onSkills,
  onPlugins,
  onAction,
  onFile,
  refresh = 0,
  request,
}: {
  id: string;
  state?: ControlState;
  backend?: BackendInfo;
  disabled: boolean;
  modeDisabled?: boolean;
  running: boolean;
  plan: boolean;
  onMode: (mode: 'default' | 'plan') => void;
  onSkills: () => void;
  onPlugins: () => void;
  onAction: (action: ControlAction) => void;
  onFile: (path: string) => void;
  refresh?: number;
  request?: { target: ControlSection; sequence: number };
}) {
  const [catalog, setCatalog] = useState<ControlCatalog>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [section, setSection] = useState<ControlSection>('tools');
  const [objective, setObjective] = useState('');
  const [feedback, setFeedback] = useState('');
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const [searched, setSearched] = useState(false);
  const [working, setWorking] = useState<'files' | 'export' | null>(null);
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
  }, [id, state?.permission, state?.preset, state?.plan, refresh, reload]);
  useEffect(() => {
    if (request && request.target !== 'permission') setSection(request.target);
  }, [request]);
  const current = state ?? catalog?.state;
  const locked = disabled || !!working;
  const has = (name: ControlAction['action']) => catalog?.actions.includes(name);
  const permission = catalog?.permissions.find((p) => p.id === current?.permission);
  const permissionName =
    permissionNames[current?.permission ?? ''] ?? permission?.name ?? current?.permission ?? '原生默认';
  const action = (a: ControlAction) => {
    setError('');
    onAction(a);
  };
  const openSection = (next: ControlSection) => {
    setSection(next);
    setError('');
    if (next === 'goal') setObjective(catalog?.goal?.objective ?? '');
  };
  const search = async () => {
    setWorking('files');
    setError('');
    try {
      const r = await remoteFetch(
        `/api/threads/${encodeURIComponent(id)}/references?q=${encodeURIComponent(query)}`,
      );
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setFiles(data.files);
      setSearched(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };
  return (
    <>
      <ComposerPopover
        label="会话权限"
        title={`会话权限：${permissionName}`}
        menu
        className="permission-trigger"
        openRequest={request?.target === 'permission' ? request.sequence : 0}
        onOpen={() => setReload((n) => n + 1)}
        trigger={
          <>
            <Icon name="shield" size={17} />
            <span title={permissionName}>
              {permissionName === '工作区内修改' ? '工作区' : permissionName}
            </span>
            <Icon name="down" size={13} />
          </>
        }
      >
        {(close) => (
          <>
            <p className="popover-eyebrow">会话权限</p>
            {error && (
              <p className="popover-error" role="alert">
                {error}
                <button type="button" onClick={() => setReload((n) => n + 1)}>
                  重试
                </button>
              </p>
            )}
            {!catalog && !error && <p className="popover-note">正在读取权限…</p>}
            {catalog && !permission && (
              <p className="permission-custom">
                <strong>{permissionName}</strong>
                <span>{current?.permissionDescription || '保留当前原生配置'}</span>
              </p>
            )}
            {has('permission') &&
              catalog?.permissions.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current?.permission === p.id}
                  disabled={locked}
                  className="permission-option"
                  onClick={() => {
                    if (current?.permission !== p.id)
                      action({
                        action: 'permission',
                        value: p.id,
                        expected: current?.permission ?? null,
                        expectedRevision: current?.permissionRevision,
                      });
                    close();
                  }}
                >
                  <span>
                    <strong>{permissionNames[p.id] ?? p.name}</strong>
                    {(p.description || permissionHints[p.id]) && (
                      <small>{p.description || permissionHints[p.id]}</small>
                    )}
                  </span>
                  {current?.permission === p.id && <Icon name="check" size={18} />}
                </button>
              ))}
            {catalog && !has('permission') && <p className="popover-note">当前会话不支持修改权限</p>}
            {running && <p className="popover-note permission-timing">正在执行的任务遵守原生生效时机</p>}
          </>
        )}
      </ComposerPopover>
      <ComposerPopover
        label="工具"
        className="composer-tool-trigger"
        openRequest={request && request.target !== 'permission' ? request.sequence : 0}
        onOpen={() => setReload((n) => n + 1)}
        trigger={
          <>
            <Icon name="grid" size={18} />
            <span>工具</span>
          </>
        }
      >
        {(close) => (
          <>
            <header className="popover-heading">
              {section !== 'tools' && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="返回工具"
                  onClick={() => setSection('tools')}
                >
                  <Icon name="back" size={18} />
                </button>
              )}
              <h2>{headings[section]}</h2>
              <button type="button" className="icon-button" aria-label="关闭工具" onClick={close}>
                <Icon name="close" size={18} />
              </button>
            </header>
            {error && (
              <p className="popover-error" role="alert">
                {error}
              </p>
            )}
            {section === 'tools' && (
              <>
                {(backend?.presentation?.plan === 'settings' || has('plan')) && (
                  <button
                    type="button"
                    className="control-row"
                    role="switch"
                    aria-label="计划模式"
                    aria-checked={plan}
                    disabled={disabled || modeDisabled}
                    onClick={() => onMode(plan ? 'default' : 'plan')}
                  >
                    <Icon name="plan" size={19} />
                    <span>
                      <strong>计划模式</strong>
                      <small>
                        {running && backend?.presentation?.plan === 'settings'
                          ? '应用到下一轮'
                          : '先讨论方案，再开始实施'}
                      </small>
                    </span>
                    <span className={`mode-switch ${plan ? 'on' : ''}`} />
                  </button>
                )}
                {has('preset') && (
                  <button type="button" className="control-row" onClick={() => openSection('preset')}>
                    <Icon name="user" size={19} />
                    <span>
                      <strong>Agent 预设</strong>
                      <small>
                        {catalog?.presets.find((p) => p.id === current?.preset)?.name ||
                          current?.preset ||
                          '原生默认'}
                      </small>
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                )}
                <div className="control-divider" />
                <button
                  type="button"
                  className="control-row compact"
                  onClick={() => {
                    close();
                    onSkills();
                  }}
                >
                  <Icon name="book" size={19} />
                  <span>技能</span>
                  <Icon name="chevron" size={16} />
                </button>
                {['supported', 'experimental'].includes(backend?.capabilities.plugins.state ?? '') && (
                  <button
                    type="button"
                    className="control-row compact"
                    onClick={() => {
                      close();
                      onPlugins();
                    }}
                  >
                    <Icon name="puzzle" size={19} />
                    <span>插件</span>
                    <Icon name="chevron" size={16} />
                  </button>
                )}
                {has('goal') && (
                  <button type="button" className="control-row compact" onClick={() => openSection('goal')}>
                    <Icon name="target" size={19} />
                    <span>目标</span>
                    <Icon name="chevron" size={16} />
                  </button>
                )}
                {backend?.presentation?.fileReferences && (
                  <button type="button" className="control-row compact" onClick={() => openSection('file')}>
                    <Icon name="folder" size={19} />
                    <span>工作区文件</span>
                    <Icon name="chevron" size={16} />
                  </button>
                )}
                {has('compact') && (
                  <button
                    type="button"
                    className="control-row compact"
                    disabled={locked}
                    onClick={() => {
                      action({ action: 'compact' });
                      close();
                    }}
                  >
                    <Icon name="stack" size={19} />
                    <span>压缩上下文</span>
                  </button>
                )}
                {has('feedback') && (
                  <button
                    type="button"
                    className="control-row compact"
                    onClick={() => openSection('feedback')}
                  >
                    <Icon name="chat" size={19} />
                    <span>反馈</span>
                    <Icon name="chevron" size={16} />
                  </button>
                )}
                {backend?.presentation?.exportLog && (
                  <button
                    type="button"
                    className="control-row compact"
                    disabled={locked}
                    onClick={async () => {
                      setWorking('export');
                      setError('');
                      try {
                        downloadFile(await exportSessionLog(id));
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setWorking(null);
                      }
                    }}
                  >
                    <Icon name="download" size={19} />
                    <span>{working === 'export' ? '正在导出…' : '下载日志 ZIP'}</span>
                  </button>
                )}
              </>
            )}
            {section === 'preset' && (
              <>
                {current?.presetLocked && (
                  <p className="popover-note">首轮已开始，Agent 预设由原实例固定。</p>
                )}
                {catalog?.presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="permission-option"
                    disabled={locked || current?.presetLocked}
                    onClick={() => action({ action: 'preset', value: p.id })}
                  >
                    <span>
                      <strong>{p.name}</strong>
                      {p.description && <small>{p.description}</small>}
                    </span>
                    {current?.preset === p.id && <Icon name="check" size={18} />}
                  </button>
                ))}
              </>
            )}
            {section === 'goal' && (
              <div className="control-form">
                {catalog?.goal && (
                  <p className="popover-note">
                    {catalog.goal.objective} · {catalog.goal.phase}
                    {catalog.goal.activation === 'disarmed' ? ' · 未自动继续' : ''}
                  </p>
                )}
                <label htmlFor={`goal-${id}`}>目标内容</label>
                <textarea
                  id={`goal-${id}`}
                  aria-label="目标内容"
                  placeholder="希望这个会话持续完成什么？"
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                />
                <button
                  type="button"
                  className="primary"
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
                  {catalog?.goal ? '保存修改' : '创建目标'}
                </button>
                {catalog?.goal && (
                  <div className="control-form-actions">
                    {(['pause', 'resume', 'complete', 'clear'] as const).map((operation, i) => (
                      <button
                        type="button"
                        key={operation}
                        disabled={locked}
                        onClick={() => action({ action: 'goal', operation, ref: catalog.goal!.ref })}
                      >
                        {['暂停', '继续', '完成', '清除'][i]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {section === 'feedback' && (
              <div className="control-form">
                <p className="popover-note">提交到 DSH 原生反馈服务，按原实例设置可能附带会话日志。</p>
                <label htmlFor={`feedback-${id}`}>反馈内容</label>
                <textarea
                  id={`feedback-${id}`}
                  aria-label="反馈内容"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={locked || !feedback.trim()}
                  onClick={() => action({ action: 'feedback', text: feedback })}
                >
                  提交反馈
                </button>
              </div>
            )}
            {section === 'file' && (
              <div className="control-form">
                <label htmlFor={`file-${id}`}>查找工作区文件</label>
                <div className="control-search">
                  <input
                    id={`file-${id}`}
                    aria-label="查找工作区文件"
                    placeholder="输入文件名或路径"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (!locked) void search();
                      }
                    }}
                  />
                  <button type="button" disabled={locked} onClick={() => void search()}>
                    {working === 'files' ? '查找中…' : '查找'}
                  </button>
                </div>
                {searched && !files.length && <p className="popover-note">没有找到匹配文件</p>}
                {files.map((f) => (
                  <button
                    type="button"
                    className="control-file"
                    key={f.path}
                    title={f.path}
                    onClick={() => {
                      onFile(f.path);
                      close();
                    }}
                  >
                    <Icon name="attach" size={17} />
                    <span>{f.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </ComposerPopover>
    </>
  );
}
