import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from './render-effects';
import type { BackendPresentation } from '../shared/backends';
import type { ControlCatalog } from '../shared/controls';
import { remoteFetch, deviceSession } from './device-session';
import type { Operation, ProjectSummary, ThreadView } from '../shared/types';
import { OperationFeedback, operationActivity } from './OperationFeedback';
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
  permission?: string;
  agentPreset?: string;
  plan?: boolean;
}
export const NewConversation = tsxComponent(function NewConversation(initialProps: {
  anchor: string;
  creation?: BackendPresentation['creation'];
  disabled: boolean;
  active: boolean;
  onCreate: (input: NewConversationInput) => void;
  defaultProject?: string;
  knownProjects: ProjectSummary[];
  onDirtyChange: (dirty: boolean) => void;
  feedback?: string;
  operation?: Operation;
  onCheck?: () => Promise<void>;
}) {
  const { defaultProject } = initialProps;

  const catalogState = shallowRef<ControlCatalog>();
  const setCatalog = writeRef(catalogState);
  const permissionState = shallowRef('');
  const setPermission = writeRef(permissionState);
  const presetState = shallowRef('');
  const setPreset = writeRef(presetState);
  const planState = shallowRef(false);
  const setPlan = writeRef(planState);
  const titleState = shallowRef('');
  const setTitle = writeRef(titleState);
  const draftState = shallowRef<ChatDraft>({ text: '', uploads: [], skills: [], plugins: [] });
  const setDraft = writeRef(draftState);
  const projectIdState = shallowRef(defaultProject ?? '');
  const setProjectId = writeRef(projectIdState);
  const projectsState = shallowRef<{ id: string; name: string }[] | null>(null);
  const setProjects = writeRef(projectsState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const loadingState = shallowRef(false);
  const setLoading = writeRef(loadingState);
  const refreshState = shallowRef(0);
  const setRefresh = writeRef(refreshState);
  const modelOpenState = shallowRef(false);
  const setModelOpen = writeRef(modelOpenState);
  const settingsState = shallowRef<ModelUpdate>();
  const setSettings = writeRef(settingsState);
  const restoredState = shallowRef(false);
  const setRestored = writeRef(restoredState);
  const watchCatalog = watchRender();
  const watchTitle = watchRender();
  const watchItem = watchRender();
  const watchProjectId = watchRender();
  const watchDraft = watchRender();
  const watchTimeout = watchRender();
  return ({
    anchor,
    creation,
    disabled,
    active,
    onCreate,
    defaultProject,
    knownProjects,
    onDirtyChange,
    feedback,
    operation,
    onCheck,
  }) => {
    const catalog = catalogState.value;
    const permission = permissionState.value;
    const preset = presetState.value;
    const plan = planState.value;
    watchCatalog(() => {
      const c = new AbortController();
      remoteFetch('/api/threads/new/controls', { signal: c.signal })
        .then(async (r) => {
          if (r.ok) setCatalog(await r.json());
        })
        .catch(() => {});
      return () => c.abort();
    }, []);
    const title = titleState.value;
    const draft = draftState.value;
    const projectId = projectIdState.value;
    const projects = projectsState.value;
    const choices = projects ?? knownProjects;
    const error = errorState.value;
    const loading = loadingState.value;
    const refresh = refreshState.value;
    const modelOpen = modelOpenState.value;
    const settings = settingsState.value;
    const draftKey = deviceSession.contentKey(`new-conversation:${anchor}`);
    const restored = restoredState.value;
    watchTitle(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
        if (saved) {
          setTitle(typeof saved.title === 'string' ? saved.title : '');
          setDraft({
            text: typeof saved.text === 'string' ? saved.text : '',
            uploads: [],
            skills: [],
            plugins: [],
          });
          setPermission(saved.permission ?? '');
          setPreset(saved.preset ?? '');
          setPlan(saved.plan === true);
          if (saved.settings) setSettings(saved.settings);
        }
      } catch {
      } finally {
        setRestored(true);
      }
    }, [draftKey]);
    watchItem(() => {
      if (!restored) return;
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ title, text: draft.text, permission, preset, plan, settings }),
        );
      } catch {}
    }, [draftKey, restored, title, draft.text, permission, preset, plan, settings]);

    watchProjectId(() => {
      setProjectId(defaultProject ?? '');
    }, [defaultProject]);
    watchDraft(() => {
      onDirtyChange(!!draft.text.trim() || !!title.trim() || !!settings || !!permission || !!preset || plan);
      return () => onDirtyChange(false);
    }, [draft.text, title, settings, permission, preset, plan, onDirtyChange]);
    watchTimeout(() => {
      if (!active) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      setLoading(true);
      setError('');
      let disposed = false;
      void deviceSession
        .cached<{ projects: { id: string; name: string }[] }>(
          `/threads/${encodeURIComponent(anchor)}/projects`,
        )
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
      <div class="new-conversation">
        <div class="new-conversation-fields">
          <label>
            项目
            <select
              aria-label="新会话项目"
              value={projectId}
              disabled={disabled}
              onChange={(e) => setProjectId((e.currentTarget as HTMLSelectElement).value)}
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
          {catalog && creation ? (
            <>
              {creation.preset && (
                <label>
                  Agent 预设
                  <select
                    aria-label="新会话 Agent 预设"
                    value={preset}
                    disabled={disabled}
                    onChange={(e) => setPreset((e.currentTarget as HTMLSelectElement).value)}
                  >
                    <option value="">原生默认</option>
                    {catalog.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {creation.permission === 'select' && (
                <label>
                  权限
                  <select
                    aria-label="新会话权限"
                    value={permission}
                    disabled={disabled}
                    onChange={(e) => setPermission((e.currentTarget as HTMLSelectElement).value)}
                  >
                    <option value="">原生默认</option>
                    {catalog.permissions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {creation.plan && (
                <label>
                  <input
                    type="checkbox"
                    checked={plan}
                    disabled={disabled}
                    onChange={(e) => setPlan((e.currentTarget as HTMLInputElement).checked)}
                  />
                  计划模式
                </label>
              )}
              {creation.notice && <p class="hint">{creation.notice}</p>}
            </>
          ) : (
            <p class="hint">{creation?.notice ?? '沿用原生创建设置'}</p>
          )}
          <details class="optional-title">
            <summary>自定义标题（可选）</summary>
            <input
              aria-label="新会话标题（可选）"
              placeholder="留空，由 Agent 自动命名"
              value={title}
              maxlength={160}
              disabled={disabled}
              onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)}
            />
          </details>
          <div class="project-load-status" role="status">
            {loading
              ? '正在更新项目目录，你可以先写消息。'
              : error || (title.trim() ? '将使用自定义标题。' : '标题会根据第一条消息自动生成。')}
            {error && (
              <button class="text-button" onClick={() => setRefresh((n) => n + 1)}>
                重试
              </button>
            )}
          </div>
        </div>
        <section class="composer new-conversation-composer">
          <OperationFeedback operation={operation} onCheck={onCheck} />
          {feedback && (
            <p class="hint" role="status">
              {feedback}
            </p>
          )}
          <ChatComposer
            activity={operationActivity(operation)}
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
                ...(creation?.permission === 'select' ? { permission: permission || undefined } : {}),
                ...(creation?.preset ? { agentPreset: preset || undefined } : {}),
                ...(creation?.plan ? { plan } : {}),
                ...(title.trim() ? { title: title.trim() } : {}),
                ...(projectId ? { projectId } : {}),
                ...(settings ? { model: settings.model, thinking: settings.effort } : {}),
              })
            }
            actions={
              <button
                type="button"
                class="composer-model"
                aria-label="模型设置"
                onClick={() => setModelOpen(true)}
                disabled={disabled}
              >
                <span>{settings ? modelLabel(settings.model) : '实例默认模型'}</span>
                <Icon name="down" size={16} />
              </button>
            }
          />
          <p class="hint creation-capabilities">首条消息支持文字；附件与技能可在创建后使用。</p>
        </section>
        {modelOpen && (
          <ThreadTools
            open
            className="settings-sheet"
            onClose={() => setModelOpen(false)}
            title="用于新会话的第一轮任务"
            heading="模型设置"
          >
            {() => (
              <>
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
                    class="secondary"
                    onClick={() => {
                      setSettings(undefined);
                      setModelOpen(false);
                    }}
                  >
                    使用实例默认模型
                  </button>
                )}
              </>
            )}
          </ThreadTools>
        )}
      </div>
    );
  };
});
