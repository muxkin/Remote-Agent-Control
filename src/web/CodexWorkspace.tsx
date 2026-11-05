import { uploadFile } from './file-client';
import { deviceSession } from './device-session';
import { RpcError as ApiError } from '../shared/rpc';
import { WebUpdateNotice } from './WebUpdateNotice';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GatewayStatus,
  ThreadSummary,
  ThreadView,
  Operation,
  ServerEvent,
  Message,
  ProjectSummary,
  SkillChoice,
  PluginChoice,
} from '../shared/types';
import { applyViewDelta } from '../shared/delta';
import { mergeOperation, readPending, rememberOperation } from './operation-state';
import { ModelSettings, modelLabel, settingsUpdate, type ModelUpdate } from './ModelSettings';
import { RequestCards, type RequestResponse } from './RequestCards';
import { NewConversation, type NewConversationInput } from './NewConversation';
import codexAvatar from './assets/codex-avatar.webp';
import { TranscriptMessages } from './TranscriptMessages';
import { ThreadTools } from './ThreadTools';
import { SkillPicker } from './SkillPicker';
import { Icon } from './Icon';
import { ComposerTools } from './ComposerTools';
import { ChatComposer } from './ChatComposer';
import { ThreadNavigation } from './ThreadNavigation';
import { useChatDrafts } from './chat-drafts';
import type { AppRoute } from './shell/routes';

const api = <T,>(path: string, init?: RequestInit) => deviceSession.api<T>(path, init);
const operationNames: Record<string, string> = {
  create: '新建会话',
  open: '打开会话',
  queue: '排队',
  'queue-remove': '移除排队',
  steer: '追加',
  send: '消息',
  settings: '设置',
  respond: '回复',
  interrupt: '中断',
};
const labels: Record<Operation['state'], string> = {
  received: '网关已接收',
  dispatching: '正在等待桌面确认',
  accepted: '桌面已接受',
  completed: '已完成',
  interrupted: '已中断',
  failed: '执行失败',
  rejected: '未发送',
  uncertain: '结果待确认 · 请勿重复发送',
};
export default function CodexWorkspace({
  route,
  navigate,
  onBusy,
}: {
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [paired, setPaired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('我的手机');
  const [deviceId, setDeviceId] = useState('');
  const [code, setCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('pair') ?? '');
  const [fromPairLink] = useState(() => !!new URLSearchParams(location.hash.slice(1)).get('pair'));
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pickerDirty, setPickerDirty] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newProject, setNewProject] = useState<string>();
  const [newDirty, setNewDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);

  const [projects, setProjects] = useState<{ projects: ProjectSummary[]; total: number; ungrouped: number }>({
    projects: [],
    total: 0,
    ungrouped: 0,
  });
  const [project] = useState('');
  const projectRef = useRef(project);
  projectRef.current = project;
  const listRequest = useRef(0);
  const [listLoading, setListLoading] = useState(false);
  const [selected, updateSelected] = useState<ThreadSummary | null>(null);
  function setSelected(thread: ThreadSummary | null) {
    updateSelected(thread);
    navigate({ page: 'workbench', ...(thread ? { thread: thread.id } : {}) });
  }
  useEffect(() => {
    if (route.page !== 'workbench') return;
    if (route.host && route.host !== deviceSession.host?.hostId) {
      updateSelected(null);
      return;
    }
    if (!route.thread) {
      updateSelected(null);
      return;
    }
    if (selected?.id === route.thread) return;
    let alive = true;
    const known = threads.find((t) => t.id === route.thread);
    if (known) updateSelected(known);
    else
      void deviceSession
        .cachedThread(route.thread)
        .then((cached) => cached ?? api<ThreadView>(`/threads/${encodeURIComponent(route.thread!)}`))
        .then((thread) => {
          if (alive) updateSelected(thread);
        })
        .catch(() => {
          if (alive) navigate({ page: 'workbench' }, true);
        });
    return () => {
      alive = false;
    };
  }, [route.page, route.thread, route.host, paired]);
  const selectedId = useRef<string | null>(null);
  const openedCreations = useRef(new Set<string>());
  selectedId.current = selected?.id ?? null;
  const [view, setView] = useState<ThreadView | null>(null);
  const [stream, setStream] = useState(false);
  const [hostId, setHostId] = useState(() => new URLSearchParams(location.hash.slice(1)).get('host') ?? '');
  const drafts = useChatDrafts(deviceId, selected?.id ?? null);
  const submittedDrafts = useRef(new Map<string, { thread: string; draft: typeof drafts.draft }>());
  const { text: draft, uploads, skills: selectedSkills, plugins: selectedPlugins } = drafts.draft;
  function setSelectedSkills(value: SkillChoice[] | ((old: SkillChoice[]) => SkillChoice[])) {
    if (selected)
      drafts.update(selected.id, (d) => ({
        ...d,
        skills: typeof value === 'function' ? value(d.skills) : value,
      }));
  }
  function setSelectedPlugins(value: PluginChoice[] | ((old: PluginChoice[]) => PluginChoice[])) {
    if (selected)
      drafts.update(selected.id, (d) => ({
        ...d,
        plugins: typeof value === 'function' ? value(d.plugins) : value,
      }));
  }

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');

  useEffect(() => {
    setToolsOpen(false);
    setConfigOpen(false);
    setSkillsOpen(false);
    setPluginsOpen(false);
  }, [selected?.id]);
  const [questionDrafts, setQuestionDrafts] = useState<Set<string>>(() => new Set());
  const questionDraftChanged = useCallback((id: string, dirty: boolean) => {
    setQuestionDrafts((old) => {
      if (old.has(id) === dirty) return old;
      const next = new Set(old);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(timer);
  }, [toast]);
  const [busy, setBusy] = useState(false);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [older, setOlder] = useState<Message[]>([]);
  const transcriptRef = useRef<HTMLElement>(null);
  const followBottom = useRef(true);
  const viewRef = useRef<ThreadView | null>(null);
  function receiveOperation(operation: Operation) {
    rememberOperation(deviceId, operation);
    if (
      operation.kind === 'queue' &&
      operation.state === 'completed' &&
      selectedId.current === operation.threadId
    )
      setToast('已排队，下一轮执行');
    const submission = submittedDrafts.current.get(operation.id);
    if (submission && ['accepted', 'completed', 'interrupted'].includes(operation.state)) {
      drafts.update(submission.thread, (current) =>
        JSON.stringify(current) === JSON.stringify(submission.draft)
          ? { text: '', uploads: [], skills: [], plugins: [] }
          : current,
      );
      submittedDrafts.current.delete(operation.id);
    } else if (['rejected', 'failed'].includes(operation.state)) submittedDrafts.current.delete(operation.id);
    if (
      operation.kind === 'create' &&
      operation.state === 'completed' &&
      operation.resultThreadId &&
      selectedId.current === operation.threadId &&
      !openedCreations.current.has(operation.id)
    ) {
      openedCreations.current.add(operation.id);
      void api<{ thread: ThreadSummary }>(`/threads/${operation.resultThreadId}`)
        .then((result) => {
          if (selectedId.current === operation.threadId) {
            setSelected(result.thread);
            setNewOpen(false);
          }
          void loadThreads();
        })
        .catch(() => setError('新会话已建立，请刷新会话列表查看。'));
    }
    if (selectedId.current === operation.threadId) setOperations((old) => mergeOperation(old, operation));
  }
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    void api<{ device: { id: string }; status: GatewayStatus }>('/session')
      .then((r) => {
        setDeviceId(r.device.id);
        setPaired(true);
        setStatus(r.status);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  const loadThreads = async (next?: string) => {
    const filter = projectRef.current;
    const generation = ++listRequest.current;
    setListLoading(true);
    try {
      const query = new URLSearchParams();
      if (next) query.set('cursor', next);
      if (filter) query.set('project', filter);
      if (!next) {
        const cached = await deviceSession.cached<{ threads: ThreadSummary[]; nextCursor: string | null }>(
          `/threads?${query}`,
        );
        if (cached && generation === listRequest.current) {
          setThreads(cached.threads);
          setCursor(cached.nextCursor);
          setListLoading(false);
        }
        const cachedProjects = await deviceSession.cached<typeof projects>('/projects');
        if (cachedProjects) setProjects(cachedProjects);
      }
      if (!next)
        void api<typeof projects>('/projects')
          .then(setProjects)
          .catch(() => setError('项目目录读取失败，请刷新重试'));
      const data = await api<{ threads: ThreadSummary[]; nextCursor: string | null }>(`/threads?${query}`);
      if (generation !== listRequest.current || projectRef.current !== filter) return;
      setThreads((old) => (next ? [...old, ...data.threads] : data.threads));
      setCursor(data.nextCursor);
    } catch (e) {
      if (generation === listRequest.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (generation === listRequest.current) setListLoading(false);
    }
  };
  useEffect(() => {
    if (paired) void loadThreads();
  }, [paired, project]);
  useEffect(() => {
    const update = () => {
      setStatus(deviceSession.status ?? null);
      setStream(deviceSession.online);
      if (!deviceSession.online)
        setView((old) =>
          old
            ? {
                ...old,
                synchronized: false,
                canSend: false,
                canInterrupt: false,
                reason: '离线缓存 · 电脑尚未连接',
              }
            : old,
        );
    };
    update();
    return deviceSession.onChange(update);
  }, []);
  useEffect(() => {
    if (!selected) return;
    const id = selected.id;
    let disposed = false;
    setView(null);
    viewRef.current = null;
    setOlder([]);
    setHistoryCursor('latest');
    setOperations(readPending(deviceId, id));
    setError('');
    followBottom.current = true;
    for (const operation of readPending(deviceId, id))
      void api<Operation>(`/operations/${operation.id}`)
        .then((result) => {
          if (!disposed) receiveOperation(result);
        })
        .catch(() => {});
    const unsubscribe = deviceSession.subscribe(id, (data) => {
      if (disposed) return;
      if (data.type === 'status') setStatus(data.status);
      else if (data.type === 'thread') {
        viewRef.current = data.thread;
        setView(data.thread);
      } else if (data.type === 'error') setError(data.message);
      else if (data.type === 'operation') receiveOperation(data.operation);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [selected?.id, deviceId]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (followBottom.current && transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [view?.messages]);
  async function pair(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await deviceSession.pair(hostId.trim(), code.trim(), name);
      setDeviceId(result.deviceId);
      setCode('');
      setPaired(true);
      setStatus(await api('/status'));
      navigate({ page: 'workbench' }, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function act(
    kind: Operation['kind'],
    settings?: ModelUpdate | RequestResponse | NewConversationInput | { messageId: string },
  ) {
    if (!selected || (!view && kind !== 'create')) return;
    setBusy(true);
    setError('');
    const requestId = crypto.randomUUID();
    const body =
      kind === 'open'
        ? { requestId }
        : kind === 'queue'
          ? { requestId, text: draft, expectedQueueFingerprint: view?.queueFingerprint }
          : kind === 'queue-remove'
            ? { requestId, ...settings, expectedQueueFingerprint: view?.queueFingerprint }
            : kind === 'settings' || kind === 'respond' || kind === 'create'
              ? { requestId, ...settings }
              : kind === 'send'
                ? {
                    requestId,
                    text: draft,
                    uploadIds: uploads.map((u) => u.id),
                    skillIds: selectedSkills.map((s) => s.id),
                    pluginIds: selectedPlugins.map((s) => s.id),
                  }
                : kind === 'steer'
                  ? {
                      requestId,
                      text: draft,
                      uploadIds: uploads.map((u) => u.id),
                      expectedTurnId: view?.activeTurnId,
                    }
                  : { requestId, expectedTurnId: view?.activeTurnId };
    const pendingOperation: Operation = {
      id: requestId,
      threadId: selected.id,
      kind,
      state: 'received',
      turnId: kind === 'interrupt' ? (view?.activeTurnId ?? null) : null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      if (['send', 'steer', 'queue'].includes(kind))
        submittedDrafts.current.set(requestId, { thread: selected.id, draft: drafts.draft });
      receiveOperation(pendingOperation);
    } catch {
      setError('浏览器无法保存请求标识，本次消息未发送');
      setBusy(false);
      return;
    }
    try {
      const operation = await api<Operation>(
        `/threads/${selected.id}/${kind === 'send' ? 'messages' : kind === 'respond' ? 'responses' : kind}`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      receiveOperation(operation);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        receiveOperation({ ...pendingOperation, state: 'rejected', error: e.message, updatedAt: Date.now() });
        setError(e.message);
        return;
      }
      setError(`请求未获得确认，正在核对状态。请勿重复发送。${(e as Error).message}`);
      try {
        receiveOperation(await api<Operation>(`/operations/${requestId}`));
      } catch {
        receiveOperation({
          ...pendingOperation,
          state: 'uncertain',
          error: '未获得最终结果，请在桌面核对',
          updatedAt: Date.now(),
        });
      }
    } finally {
      setBusy(false);
    }
    return requestId;
  }
  async function uploadFiles(files: FileList | File[] | null) {
    if (!selected || !files) return;
    const threadId = selected.id;
    setUploading(true);
    setError('');
    try {
      if (uploads.length + files.length > 10) throw Error('每条消息最多 10 个附件');
      for (const file of Array.from(files)) {
        if (file.size > 256 * 1024 * 1024) throw Error('单个附件暂时支持至 256 MiB');
        setUploadProgress(`准备 ${file.name}`);
        const done = await uploadFile(threadId, file, setUploadProgress);
        drafts.update(threadId, (d) => ({ ...d, uploads: [...d.uploads, done] }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  }
  async function loadOlder() {
    if (!selected || !historyCursor) return;
    const id = selected.id;
    setBusy(true);
    try {
      const page = await api<{ messages: Message[]; nextCursor: string | null }>(
        `/threads/${id}/history${historyCursor === 'latest' ? '' : `?cursor=${encodeURIComponent(historyCursor)}`}`,
      );
      if (selectedId.current !== id) return;
      setOlder((old) => [...page.messages, ...old]);
      setHistoryCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pending = operations.some((x) => ['received', 'dispatching', 'uncertain'].includes(x.state));
  const canCompose = stream && !!view && (view.canSend || (view.canInterrupt && view.pendingRequests === 0));
  const currentIds = new Set(view?.messages.map((x) => x.id));
  const messages = [...older.filter((x) => !currentIds.has(x.id)), ...(view?.messages ?? [])];
  useEffect(() => {
    onBusy(busy || uploading || pending);
  }, [busy, uploading, pending, onBusy]);
  if (loading)
    return (
      <main className="pair-wrap">
        <p>正在连接…</p>
      </main>
    );
  if (route.page === 'workbench' && route.host && route.host !== deviceSession.host?.hostId)
    return (
      <main className="module-page">
        <section className="module-empty">
          <h2>这段会话属于另一台电脑</h2>
          <p>请从当前电脑的工作台选择会话。</p>
          <button className="secondary" onClick={() => navigate({ page: 'workbench' }, true)}>
            返回工作台
          </button>
        </section>
      </main>
    );
  if (!paired && route.page !== 'pair')
    return (
      <main className="module-page">
        <header className="page-header">
          <h1>工作台</h1>
        </header>
        <section className="module-empty">
          <span className="empty-symbol">
            <Icon name="monitor" size={38} />
          </span>
          <h2>继续电脑上的工作</h2>
          <p>连接你的电脑，查看项目、发送任务和处理审批。</p>
          <button className="primary" onClick={() => navigate({ page: 'pair' })}>
            连接电脑
          </button>
        </section>
      </main>
    );
  if (!paired || route.page === 'pair')
    return (
      <main className="pair-wrap">
        <section className="pair-card">
          <div className="brand-icon">C</div>
          <p className="eyebrow">CODEX POCKET REMOTE</p>
          <h1>
            把桌面的工作
            <br />
            带在身边。
          </h1>
          <p className="muted">连接你的电脑，查看同一会话并控制任务。</p>
          <p className="pair-guide" role="status">
            {fromPairLink && code
              ? '已读取配对链接，点击「连接电脑」即可。'
              : '用手机相机扫描电脑上的配对二维码，即可打开连接页面。'}
          </p>
          <form onSubmit={pair}>
            <label>
              设备名称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                required
                autoComplete="off"
              />
            </label>
            <details className="pair-manual" open={!fromPairLink || !code}>
              <label>
                电脑身份
                <input value={hostId} onChange={(e) => setHostId(e.target.value)} autoComplete="off" />
              </label>
              <summary>手动输入配对码</summary>
              <label>
                一次性配对码
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="粘贴电脑上生成的配对码"
                />
              </label>
            </details>
            <button className="primary" disabled={busy}>
              {busy ? '正在配对…' : '连接电脑'}
            </button>
          </form>
          <p className="hint">
            在电脑运行 <code>npm run pair</code> 显示二维码；五分钟内一次有效。
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </section>
      </main>
    );
  return (
    <div className={`app ${selected ? 'has-thread' : ''}`}>
      <WebUpdateNotice
        serverBuild={status?.webBuildId}
        hasDraft={
          newDirty ||
          drafts.hasDraft ||
          !!questionDrafts.size ||
          !!selectedSkills.length ||
          settingsDirty ||
          pickerDirty
        }
        busy={busy || uploading}
      />
      <ThreadNavigation
        projects={projects}
        threads={threads}
        cursor={cursor}
        selected={selected}
        connected={stream && !!status?.connected}
        loading={listLoading}
        pendingQuestions={view?.pendingRequests ?? 0}
        onSelect={setSelected}
        onRefresh={() => void loadThreads()}
        onMore={() => void loadThreads(cursor ?? undefined)}
        onCreate={(projectId) => {
          setNewProject(projectId);
          if (!selected && threads[0]) setSelected(threads[0]);
          setNewOpen(true);
        }}
      />
      <main className="chat">
        <header className="chat-head">
          <button className="back icon-button" onClick={() => setSelected(null)} aria-label="返回会话列表">
            <Icon name="back" />
          </button>
          <div>
            <h2>
              {selected?.title || '选择一个桌面会话'}
              {selected && (
                <span
                  title={stream && view?.synchronized ? '已连接' : '正在恢复连接'}
                  className={`dot ${stream && view?.synchronized ? 'online' : ''}`}
                />
              )}
            </h2>
            <p className="chat-subtitle">
              <Icon name="folder" size={17} />
              <span>{selected?.projectName ?? '未分类'}</span>
            </p>
          </div>
          {selected && (
            <button
              className="icon-button more-tools"
              aria-label="会话工具"
              onClick={() => setToolsOpen(true)}
            >
              <Icon name="more" />
            </button>
          )}
        </header>
        {!selected ? (
          <section className="empty">
            <div className="brand-icon">C</div>
            <h2>桌面继续工作，手机随时接入</h2>
            <p>从左侧选择会话。尚未在桌面打开的会话可查看历史。</p>
          </section>
        ) : (
          <>
            <section
              ref={transcriptRef}
              className="transcript"
              aria-label="聊天记录"
              onScroll={(e) => {
                const el = e.currentTarget;
                followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
              }}
            >
              {historyCursor && (
                <button className="secondary older" disabled={busy} onClick={() => void loadOlder()}>
                  加载更早的记录
                </button>
              )}
              {!view && <p className="muted center">正在读取桌面会话…</p>}
              <TranscriptMessages
                agent={{ name: 'Codex', avatar: codexAvatar }}
                messages={messages}
                threadId={selected.id}
                activeTurnId={view?.activeTurnId}
                requests={view?.requests}
              />
              {view && messages.length === 0 && <p className="muted center">此会话暂时没有可显示的消息</p>}
              {!!view?.requests?.length && (
                <RequestCards
                  threadId={selected.id}
                  requests={view.requests}
                  onDraftChange={questionDraftChanged}
                  response={operations.find((operation) => operation.kind === 'respond')}
                  disabled={
                    busy || pending || !stream || !view.owner || !view.synchronized || !status?.writesEnabled
                  }
                  onRespond={(response) => act('respond', response)}
                />
              )}
            </section>
            <section className="composer">
              {toast && (
                <p className="composer-toast" role="status">
                  {toast}
                </p>
              )}
              <div
                className={`connection-note ${stream && view?.synchronized && view.owner && view.runtimeStatus !== 'notLoaded' && status?.writesEnabled ? 'sr-only' : ''}`}
              >
                <span className={`dot ${stream && view?.synchronized ? 'online' : ''}`} />
                {!stream ? '连接中断，正在恢复；控制暂不可用' : (view?.reason ?? '与桌面共享同一个会话')}
              </div>
              {view && (!view.owner || view.runtimeStatus === 'notLoaded') && status?.writesEnabled && (
                <button
                  className="secondary"
                  disabled={busy || pending || !stream}
                  onClick={() => void act('open')}
                >
                  {view.owner ? '恢复桌面会话' : '在电脑打开此会话'}
                </button>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {operations.slice(0, 2).map((op) => (
                <p
                  className={`operation ${['accepted', 'completed', 'interrupted'].includes(op.state) ? 'sr-only' : ''} ${op.state === 'uncertain' ? 'error' : ''}`}
                  key={op.id}
                  data-operation-id={op.id}
                  role="status"
                >
                  {op.kind === 'create'
                    ? '新建会话'
                    : op.kind === 'open'
                      ? '打开会话'
                      : op.kind === 'queue'
                        ? '排队'
                        : op.kind === 'queue-remove'
                          ? '移除排队'
                          : op.kind === 'steer'
                            ? '追加'
                            : op.kind === 'send'
                              ? '消息'
                              : op.kind === 'settings'
                                ? '设置'
                                : op.kind === 'respond'
                                  ? '回复'
                                  : '中断'}{' '}
                  · {labels[op.state]}
                  {op.error ? `：${op.error}` : ''}
                </p>
              ))}
              {(!!selectedSkills.length || !!selectedPlugins.length) && !!view?.activeTurnId && (
                <p className="hint">已选插件和技能将在下一轮使用，请等当前任务结束后发送。</p>
              )}
              <ChatComposer
                value={drafts.draft}
                onChange={(change) => drafts.update(selected.id, change)}
                disabled={!stream || !canCompose || pending || busy}
                placeholder={
                  canCompose
                    ? view?.activeTurnId
                      ? '给当前任务追加指令…'
                      : '给 Codex 发消息…'
                    : '当前只读；请查看上方连接状态'
                }
                uploading={uploading}
                uploadProgress={uploadProgress}
                uploadDisabled={busy || uploading || pending || !canCompose}
                onUpload={uploadFiles}
                running={!!view?.activeTurnId}
                sendDisabled={
                  view?.activeTurnId &&
                  !draft.trim() &&
                  !uploads.length &&
                  !selectedSkills.length &&
                  !selectedPlugins.length
                    ? busy || !stream || !view.canInterrupt
                    : busy ||
                      uploading ||
                      pending ||
                      !stream ||
                      !canCompose ||
                      (!draft.trim() && !uploads.length) ||
                      (!!view?.activeTurnId && (!!selectedSkills.length || !!selectedPlugins.length))
                }
                canQueue={
                  !!view?.canInterrupt &&
                  !!view?.queueFingerprint &&
                  !busy &&
                  !pending &&
                  stream &&
                  !!draft.trim() &&
                  !uploads.length &&
                  !selectedSkills.length &&
                  !selectedPlugins.length
                }
                onSubmit={() => {
                  if (view?.activeTurnId && (selectedSkills.length || selectedPlugins.length)) return;
                  void act(view?.activeTurnId ? 'steer' : 'send');
                }}
                onInterrupt={() => void act('interrupt')}
                onQueue={() => void act('queue')}
                actions={
                  <>
                    {view && (
                      <>
                        <ComposerTools
                          plan={view.mode === 'plan'}
                          running={!!view?.activeTurnId}
                          disabled={
                            busy ||
                            pending ||
                            !stream ||
                            (!view.canSend && !view.canInterrupt) ||
                            !view.model ||
                            !view.reasoningEffort
                          }
                          onMode={(mode) => void act('settings', settingsUpdate(view, mode))}
                          onSkills={() => setSkillsOpen(true)}
                          onPlugins={() => setPluginsOpen(true)}
                        />
                        {view.mode === 'plan' && (
                          <button
                            type="button"
                            className="plan-chip"
                            aria-label="取消计划模式"
                            disabled={busy || pending || !stream || (!view.canSend && !view.canInterrupt)}
                            onClick={() => void act('settings', settingsUpdate(view, 'default'))}
                          >
                            计划
                            <Icon name="close" size={14} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="composer-model"
                          aria-label="模型设置"
                          onClick={() => setConfigOpen(true)}
                        >
                          <span>{modelLabel(view.model)}</span>
                          <Icon name="down" size={16} />
                        </button>
                      </>
                    )}
                  </>
                }
              />
            </section>
            {configOpen && view && (
              <ThreadTools
                open
                className="settings-sheet"
                onClose={() => setConfigOpen(false)}
                title="应用于下一轮任务"
                heading="模型设置"
              >
                <ModelSettings
                  view={view}
                  disabled={busy || pending || !stream || (!view.canSend && !view.canInterrupt)}
                  onSave={(settings) => act('settings', settings)}
                  onDirtyChange={setSettingsDirty}
                  response={operations.find((o) => o.kind === 'settings')}
                  onApplied={() => setConfigOpen(false)}
                />
              </ThreadTools>
            )}
            {(skillsOpen || pluginsOpen) && view && (
              <ThreadTools
                open
                className="picker-sheet"
                onClose={() => {
                  setSkillsOpen(false);
                  setPluginsOpen(false);
                }}
                title=""
                heading={pluginsOpen ? '添加插件' : '添加技能'}
              >
                <SkillPicker
                  key={pluginsOpen ? 'plugins' : 'skills'}
                  threadId={view.id}
                  kind={pluginsOpen ? 'plugins' : 'skills'}
                  selected={pluginsOpen ? selectedPlugins : selectedSkills}
                  disabled={busy || pending}
                  onDirtyChange={setPickerDirty}
                  onApply={(value) => {
                    if (pluginsOpen) setSelectedPlugins(value as PluginChoice[]);
                    else setSelectedSkills(value as SkillChoice[]);
                    setSkillsOpen(false);
                    setPluginsOpen(false);
                  }}
                />
              </ThreadTools>
            )}
            <ThreadTools
              open={newOpen}
              className="new-conversation-sheet"
              onClose={() => setNewOpen(false)}
              title="选择项目，发送第一条消息即可开始"
              heading="新会话"
            >
              <NewConversation
                key={`new:${selected.id}`}
                anchor={selected.id}
                active={newOpen}
                defaultProject={newProject}
                knownProjects={projects.projects}
                onDirtyChange={setNewDirty}
                disabled={
                  busy || pending || !stream || !status?.writesEnabled || !status.capabilities.newThread
                }
                feedback={
                  error ||
                  (operations[0]?.kind === 'create'
                    ? labels[operations[0].state]
                    : !status?.writesEnabled
                      ? '电脑连接暂不可用，消息草稿会保留。'
                      : undefined)
                }
                onCreate={(input) => void act('create', input)}
              />
            </ThreadTools>
            <ThreadTools
              key={`tools:${selected.id}`}
              open={toolsOpen}
              onClose={() => setToolsOpen(false)}
              title={selected.title}
            >
              <p className="hint">
                {!stream ? '连接中断，正在恢复' : (view?.reason ?? '与桌面共享同一个会话')}
              </p>
              {operations[0]?.kind === 'settings' && (
                <p className="tools-feedback" role="status">
                  设置 · {labels[operations[0].state]}
                  {operations[0].error ? `：${operations[0].error}` : ''}
                </p>
              )}
              {view && (
                <button
                  className="secondary"
                  onClick={() => {
                    setToolsOpen(false);
                    setConfigOpen(true);
                  }}
                >
                  模型设置
                </button>
              )}
              {status?.capabilities.newThread && (
                <button
                  className="secondary"
                  onClick={() => {
                    setToolsOpen(false);
                    setNewProject(selected.projectId ?? undefined);
                    setNewOpen(true);
                  }}
                >
                  新建会话
                </button>
              )}
              {!!view?.queuedMessages?.length && (
                <details className="native-queue" open>
                  <summary>桌面队列 · {view.queuedMessages.length}</summary>
                  {view.queuedMessages.map((m) => (
                    <div key={m.id}>
                      <p>{m.text}</p>
                      <small>{m.reason ?? m.status}</small>
                      <button
                        type="button"
                        disabled={
                          busy || pending || !stream || ['sending', 'outcome-unknown'].includes(m.status)
                        }
                        onClick={() => void act('queue-remove', { messageId: m.id })}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                </details>
              )}
              <details className="operation-history">
                <summary>操作记录</summary>
                {operations.length ? (
                  operations.map((op) => (
                    <p key={op.id}>
                      {operationNames[op.kind] ?? '操作'} · {labels[op.state]}
                      {op.error ? `：${op.error}` : ''}
                    </p>
                  ))
                ) : (
                  <p className="hint">暂无操作记录</p>
                )}
              </details>
            </ThreadTools>
          </>
        )}
      </main>
    </div>
  );
}
