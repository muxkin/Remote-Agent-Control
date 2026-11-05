import { useEffect, useState } from 'react';
export interface NewConversationInput {
  title: string;
  prompt: string;
  projectId?: string;
}
export function NewConversation({
  anchor,
  disabled,
  onCreate,
  initiallyOpen = false,
  defaultProject,
}: {
  anchor: string;
  disabled: boolean;
  onCreate: (input: NewConversationInput) => void;
  initiallyOpen?: boolean;
  defaultProject?: string;
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [title, setTitle] = useState('手机新会话'),
    [prompt, setPrompt] = useState(''),
    [projectId, setProjectId] = useState(defaultProject ?? '');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState('');
  async function show() {
    setOpen((v) => !v);
    if (open) return;
    await loadProjects();
  }
  async function loadProjects() {
    try {
      const response = await fetch(`/api/threads/${anchor}/projects`);
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      setProjects(data.projects);
      if (projectId && !data.projects.some((p: { id: string }) => p.id === projectId)) setProjectId('');
    } catch {
      setError('暂时无法列出项目；仍可创建独立会话。');
    }
  }
  useEffect(() => {
    if (initiallyOpen) void loadProjects();
  }, []);
  return (
    <div className="new-conversation">
      {!initiallyOpen && (
        <button className="secondary" disabled={disabled} onClick={() => void show()}>
          新建会话
        </button>
      )}
      {open && (
        <form
          className="new-conversation-form"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate({ title, prompt, ...(projectId ? { projectId } : {}) });
          }}
        >
          <label>
            会话标题
            <input
              aria-label="新会话标题"
              value={title}
              maxLength={160}
              required
              disabled={disabled}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            项目
            <select
              aria-label="新会话项目"
              value={projectId}
              disabled={disabled}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">独立会话</option>
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            第一条消息
            <textarea
              aria-label="新会话第一条消息"
              value={prompt}
              maxLength={16000}
              required
              disabled={disabled}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <p className="hint">在原桌面创建，使用桌面默认模型和权限。</p>
          {error && <p className="hint">{error}</p>}
          <button className="primary" disabled={disabled || !title.trim() || !prompt.trim()}>
            创建并发送
          </button>
        </form>
      )}
    </div>
  );
}
