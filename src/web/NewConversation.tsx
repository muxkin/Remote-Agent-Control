import { remoteFetch, deviceSession } from './device-session';
import { useEffect, useState } from 'react';
import type { ProjectSummary, ThreadView } from '../shared/types';
import { ChatComposer } from './ChatComposer';
import type { ChatDraft } from './chat-drafts';
import { ModelSettings, modelLabel, type ModelUpdate } from './ModelSettings';
import { ThreadTools } from './ThreadTools';
import { Icon } from './Icon';

export interface NewConversationInput {
  title?: string;
  prompt: string;
  projectId?: string;
  model?: string;
  thinking?: string;
}
export function NewConversation({
  anchor,
  disabled,
  active,
  onCreate,
  defaultProject,
  knownProjects,
  onDirtyChange,
  feedback,
}: {
  anchor: string;
  disabled: boolean;
  active: boolean;
  onCreate: (input: NewConversationInput) => void;
  defaultProject?: string;
  knownProjects: ProjectSummary[];
  onDirtyChange: (dirty: boolean) => void;
  feedback?: string;
}) {
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState<ChatDraft>({ text: '', uploads: [], skills: [], plugins: [] });
  const [projectId, setProjectId] = useState(defaultProject ?? '');
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const choices = projects ?? knownProjects;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [settings, setSettings] = useState<ModelUpdate>();
  useEffect(() => {
    setProjectId(defaultProject ?? '');
  }, [defaultProject]);
  useEffect(() => {
    onDirtyChange(!!draft.text.trim() || !!title.trim() || !!settings);
    return () => onDirtyChange(false);
  }, [draft.text, title, settings, onDirtyChange]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setLoading(true);
    setError('');
    let disposed = false;
    void deviceSession
      .cached<{ projects: { id: string; name: string }[] }>(`/threads/${encodeURIComponent(anchor)}/projects`)
      .then((cached) => {
        if (cached && !disposed) {
          setProjects(cached.projects);
          setLoading(false);
        }
      });
    remoteFetch(`/api/threads/${encodeURIComponent(anchor)}/projects`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw Error();
        if (!disposed) setProjects(data.projects);
      })
      .catch(() => {
        if (!disposed) setError('项目目录更新失败，可以重试；已填写的消息会保留。');
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [active, anchor, refresh]);
  if (!active) return null;
  const modelView: ThreadView = {
    id: anchor,
    title: '',
    cwd: '',
    updatedAt: 0,
    revision: 0,
    owner: true,
    synchronized: true,
    activeTurnId: null,
    runtimeStatus: 'idle',
    messages: [],
    pendingRequests: 0,
    canSend: true,
    canInterrupt: false,
    reason: null,
    model: settings?.model ?? null,
    reasoningEffort: settings?.effort ?? null,
    mode: 'default',
  };
  return (
    <div className="new-conversation">
      <div className="new-conversation-fields">
        <label>
          项目
          <select
            aria-label="新会话项目"
            value={projectId}
            disabled={disabled}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">独立会话</option>
            {projectId && !choices.some((p) => p.id === projectId) && (
              <option value={projectId}>当前项目</option>
            )}
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <details className="optional-title">
          <summary>自定义标题（可选）</summary>
          <input
            aria-label="新会话标题（可选）"
            placeholder="留空，由 Agent 自动命名"
            value={title}
            maxLength={160}
            disabled={disabled}
            onChange={(e) => setTitle(e.target.value)}
          />
        </details>
        <div className="project-load-status" role="status">
          {loading
            ? '正在更新项目目录，你可以先写消息。'
            : error || (title.trim() ? '将使用自定义标题。' : '标题会根据第一条消息自动生成。')}
          {error && (
            <button className="text-button" onClick={() => setRefresh((n) => n + 1)}>
              重试
            </button>
          )}
        </div>
      </div>
      <section className="composer new-conversation-composer">
        {feedback && (
          <p className="hint" role="status">
            {feedback}
          </p>
        )}
        <ChatComposer
          value={draft}
          onChange={(change) =>
            setDraft((old) => (typeof change === 'function' ? change(old) : { ...old, ...change }))
          }
          disabled={disabled}
          sendDisabled={disabled || !draft.text.trim()}
          placeholder="发送第一条消息，开始新会话…"
          onSubmit={() =>
            onCreate({
              prompt: draft.text,
              ...(title.trim() ? { title: title.trim() } : {}),
              ...(projectId ? { projectId } : {}),
              ...(settings ? { model: settings.model, thinking: settings.effort } : {}),
            })
          }
          actions={
            <button
              type="button"
              className="composer-model"
              aria-label="模型设置"
              onClick={() => setModelOpen(true)}
              disabled={disabled}
            >
              <span>{settings ? modelLabel(settings.model) : '实例默认模型'}</span>
              <Icon name="down" size={16} />
            </button>
          }
        />
        <p className="hint creation-capabilities">首条消息支持文字；附件与技能可在创建后使用。</p>
      </section>
      {modelOpen && (
        <ThreadTools
          open
          className="settings-sheet"
          onClose={() => setModelOpen(false)}
          title="用于新会话的第一轮任务"
          heading="模型设置"
        >
          <ModelSettings
            view={modelView}
            disabled={disabled}
            creation
            onSave={async (value) => {
              setSettings(value);
              setModelOpen(false);
              return undefined;
            }}
            onApplied={() => setModelOpen(false)}
          />
          {settings && (
            <button
              className="secondary"
              onClick={() => {
                setSettings(undefined);
                setModelOpen(false);
              }}
            >
              使用实例默认模型
            </button>
          )}
        </ThreadTools>
      )}
    </div>
  );
}
