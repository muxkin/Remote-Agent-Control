import { tsxComponent } from './tsx-component';
import { onScopeDispose, shallowRef } from 'vue';
import { watchRender, writeRef, useExternalSnapshot } from './render-effects';
import { UsagePanel } from './UsagePanel';
import { uploadItems, type UploadItem } from './UploadProgress';
import { ConversationHeader } from './shell/ConversationHeader';
import { ConversationControls, type ControlSection } from './ConversationControls';
import type { ControlAction } from '../shared/controls';
import { DEFAULT_BACKEND, type BackendInfo } from '../shared/backends';
import { codexDisplayMessage } from '../shared/codex-transcript';
import { uploadFile } from './file-client';
import { deviceSession } from './device-session';
import { RpcError as ApiError } from '../shared/rpc';
import { WebUpdateNotice } from './WebUpdateNotice';
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
import { TranscriptMessages } from './TranscriptMessages';
import { TurnNavigation } from './TurnNavigation';
import { ThreadTools } from './ThreadTools';
import { SkillPicker } from './SkillPicker';
import { Icon } from './Icon';
import { PairScanner } from './PairScanner';
import { ChatComposer } from './ChatComposer';
import { OperationFeedback, operationActivity } from './OperationFeedback';
import { OutgoingContent, OutgoingStatus } from './OutgoingMessage';
import { ThreadNavigation } from './ThreadNavigation';
import { useChatDrafts, type ChatDraft } from './chat-drafts';
import { backTo, type AppRoute } from './shell/routes';

const subscribeConnection = (notify: () => void) => deviceSession.onChange(notify);
const connectionSnapshot = () => deviceSession.online;
const HISTORY_TOP_THRESHOLD = 160;
const HISTORY_PAGES_PER_LOAD = 8;
const HISTORY_VISIBLE_TARGET = 40;

const operationNames: Record<string, string> = {
  create: '新建会话',
  open: '打开会话',
  queue: '排队',
  'queue-remove': '移除排队',
  steer: '追加',
  send: '消息',
  settings: '设置',
  control: '会话控制',
  respond: '回复',
  interrupt: '中断',
};
const labels: Record<Operation['state'], string> = {
  received: '网关已接收',
  dispatching: '正在等待原实例确认',
  accepted: '原实例已接受',
  completed: '已完成',
  interrupted: '已中断',
  failed: '执行失败',
  rejected: '未发送',
  uncertain: '结果待确认 · 请勿重复发送',
};
export default tsxComponent(function AgentWorkspace(_props: {
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
  onBusy: (busy: boolean) => void;
  active?: boolean;
}) {
  onScopeDispose(() => _props.onBusy(false));
  const backendState = shallowRef<BackendInfo>();
  const setBackend = writeRef(backendState);
  const pairedState = shallowRef(false);
  const setPaired = writeRef(pairedState);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const nameState = shallowRef('我的手机');
  const setName = writeRef(nameState);
  const deviceIdState = shallowRef('');
  const setDeviceId = writeRef(deviceIdState);
  const pairLink = new URLSearchParams(location.hash.slice(1));
  const codeState = shallowRef(pairLink.get('pair') ?? '');
  const setCode = writeRef(codeState);
  const fromPairLinkState = shallowRef(pairLink.has('pair') && !!pairLink.get('pair'));
  const setFromPairLink = writeRef(fromPairLinkState);
  const statusState = shallowRef<GatewayStatus | null>(null);
  const setStatus = writeRef(statusState);
  const threadsState = shallowRef<ThreadSummary[]>([]);
  const setThreads = writeRef(threadsState);
  const cursorState = shallowRef<string | null>(null);
  const setCursor = writeRef(cursorState);
  const toolsOpenState = shallowRef(false);
  const setToolsOpen = writeRef(toolsOpenState);
  const threadActionState = shallowRef<{
    kind: 'rename' | 'fork';
    threadId: string;
    title: string;
    lastTurnId?: string;
    requestId?: string;
  }>();
  const setThreadAction = writeRef(threadActionState);
  const configOpenState = shallowRef(false);
  const setConfigOpen = writeRef(configOpenState);
  const skillsOpenState = shallowRef(false);
  const setSkillsOpen = writeRef(skillsOpenState);
  const pluginsOpenState = shallowRef(false);
  const setPluginsOpen = writeRef(pluginsOpenState);
  const pickerDirtyState = shallowRef(false);
  const setPickerDirty = writeRef(pickerDirtyState);
  const newOpenState = shallowRef(false);
  const setNewOpen = writeRef(newOpenState);
  const newProjectState = shallowRef<string>();
  const setNewProject = writeRef(newProjectState);
  const newDirtyState = shallowRef(false);
  const setNewDirty = writeRef(newDirtyState);
  const controlRequestState = shallowRef<{
    target: ControlSection;
    sequence: number;
    threadId: string;
  }>();
  const setControlRequest = writeRef(controlRequestState);
  const settingsDirtyState = shallowRef(false);
  const setSettingsDirty = writeRef(settingsDirtyState);
  const projectsState = shallowRef<{ projects: ProjectSummary[]; total: number; ungrouped: number }>({
    projects: [],
    total: 0,
    ungrouped: 0,
  });
  const setProjects = writeRef(projectsState);
  const projectState = shallowRef('');
  const projectRef = { current: projectState.value };
  const listRequest = { current: 0 };
  const listLoadingState = shallowRef(false);
  const setListLoading = writeRef(listLoadingState);
  const selectedThread = shallowRef<ThreadSummary | null>(null);
  const updateSelected = writeRef(selectedThread);
  const creationRequest: { current: string | undefined } = { current: undefined };
  const selectedId: { current: string | null } = { current: null };
  const openedCreations = { current: new Set<string>() };
  const receivedViewState = shallowRef<ThreadView | null>(null);
  const setView = writeRef(receivedViewState);
  const connection = useExternalSnapshot(subscribeConnection, connectionSnapshot);
  const hostIdState = shallowRef(pairLink.get('host') ?? '');
  const setHostId = writeRef(hostIdState);
  const readChatDrafts = useChatDrafts();
  const dispatchingDraft = { current: false };
  const uploadingState = shallowRef(false);
  const setUploading = writeRef(uploadingState);
  const uploadJobsState = shallowRef<UploadItem[]>([]);
  const setUploadJobs = writeRef(uploadJobsState);
  const uploadThreadState = shallowRef('');
  const setUploadThread = writeRef(uploadThreadState);
  const uploadLock = { current: false };
  const questionDraftsState = shallowRef(new Set<string>());
  const setQuestionDrafts = writeRef(questionDraftsState);
  const questionDraftChanged = (id: string, dirty: boolean) => {
    setQuestionDrafts((old) => {
      if (old.has(id) === dirty) return old;
      const next = new Set(old);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const threadErrorState = shallowRef('');
  const setThreadError = writeRef(threadErrorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const operationsState = shallowRef<Operation[]>([]);
  const setOperations = writeRef(operationsState);
  const historyCursorState = shallowRef<string | null>(null);
  const setHistoryCursor = writeRef(historyCursorState);
  const historyLoadingState = shallowRef(false);
  const setHistoryLoading = writeRef(historyLoadingState);
  const historyError = shallowRef('');
  const subscriptionAttemptState = shallowRef(0);
  const setSubscriptionAttempt = writeRef(subscriptionAttemptState);
  const historyGeneration = { current: 0 };
  const historyScroll: { current: { top: number; height: number } | null } = { current: null };
  const olderState = shallowRef<Message[]>([]);
  const setOlder = writeRef(olderState);
  const transcriptRef = shallowRef<HTMLElement | null>(null);
  const followBottom = { current: true };
  const transcriptScroll = { top: 0, height: 0 };
  function scrollToLatest(transcript: HTMLElement) {
    transcript.scrollTop = transcript.scrollHeight;
    transcriptScroll.top = transcript.scrollTop;
    transcriptScroll.height = transcript.clientHeight;
  }
  const viewRef: { current: ThreadView | null } = { current: null };
  const operationSnapshots = { current: new Map<string, Operation>() };
  const recoveredDraft: { current: string | undefined } = { current: undefined };
  const watchBackend = watchRender();
  const watchRoute = watchRender();
  const watchControlRequest = watchRender();
  const watchRoute2 = watchRender();
  const watchToolsOpen = watchRender();
  const watchBackend2 = watchRender();
  const watchPaired = watchRender();
  const watchStatus = watchRender();
  const watchView = watchRender();
  const watchOlder = watchRender();
  const watchView2 = watchRender();
  const watchTranscript = watchRender();
  const watchDeviceId = watchRender();
  const watchOutgoingOperation = watchRender();
  const watchOutgoingOperation2 = watchRender();
  const watchBusy = watchRender();
  return ({ route, navigate, onBusy, active = true }) => {
    const backendId = route.backend ?? DEFAULT_BACKEND;
    const backend = backendState.value;
    const presentation = backend?.presentation;
    const emptyCreation = presentation?.creation.empty ?? false;
    const controlPlan = presentation?.plan === 'control';
    const agentName = backend?.name ?? 'Agent';
    const api = <T,>(path: string, init?: RequestInit) => deviceSession.api<T>(path, init, backendId);
    const paired = pairedState.value;
    watchBackend(() => {
      if (!paired) return;
      let alive = true;
      const refresh = () =>
        void deviceSession
          .api<{ backends: BackendInfo[] }>('/backends', undefined, backendId)
          .then((result) => {
            if (alive) setBackend(result.backends.find((b) => b.id === backendId));
          })
          .catch(() => {});
      refresh();
      const timer = setInterval(refresh, 15000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [paired, backendId]);
    const loading = loadingState.value;
    const name = nameState.value;
    const deviceId = deviceIdState.value;
    const code = codeState.value;
    const fromPairLink = fromPairLinkState.value;
    const status = statusState.value;
    const threads = threadsState.value;
    const cursor = cursorState.value;
    const toolsOpen = toolsOpenState.value;
    const threadAction = threadActionState.value;
    const configOpen = configOpenState.value;
    const skillsOpen = skillsOpenState.value;
    const pluginsOpen = pluginsOpenState.value;
    const pickerDirty = pickerDirtyState.value;
    const newOpen = newOpenState.value;
    const newProject = newProjectState.value;
    const newDirty = newDirtyState.value;
    const controlRequest = controlRequestState.value;
    const settingsDirty = settingsDirtyState.value;

    const projects = projectsState.value;
    const project = projectState.value;

    projectRef.current = project;

    const listLoading = listLoadingState.value;
    const selectedState = selectedThread.value;
    // Replayed operation history is not a new navigation request.

    watchRoute(() => {
      creationRequest.current = undefined;
    }, [route.thread, route.host, backendId, active]);
    // The URL is the selection authority; previous cached metadata must never win a click.
    const selected =
      route.thread && (!route.host || route.host === deviceSession.host?.hostId)
        ? selectedState?.id === route.thread
          ? selectedState
          : (threads.find((thread) => thread.id === route.thread) ?? null)
        : null;
    watchControlRequest(() => {
      setControlRequest(undefined);
      setToolsOpen(false);
      setThreadAction(undefined);
    }, [selected?.id]);
    function setSelected(thread: ThreadSummary | null) {
      creationRequest.current = undefined;
      updateSelected(thread);
      navigate({ page: 'workbench', backend: backendId, ...(thread ? { thread: thread.id } : {}) });
    }
    watchRoute2(() => {
      if (route.page !== 'workbench') return;
      if (route.host && route.host !== deviceSession.host?.hostId) {
        updateSelected(null);
        return;
      }
      if (route.thread === 'new' && emptyCreation) {
        updateSelected({ id: 'new', title: `新建 ${agentName} 会话`, cwd: '', updatedAt: Date.now() });
        return;
      }
      if (!route.thread) {
        updateSelected(null);
        return;
      }
      if (selectedState?.id === route.thread) return;
      let alive = true;
      const known = threads.find((t) => t.id === route.thread);
      if (known) updateSelected(known);
      else
        void deviceSession
          .cachedThread(route.thread, backendId)
          .then(
            (cached) =>
              cached ??
              api<{ thread: ThreadSummary }>(`/threads/${encodeURIComponent(route.thread!)}`).then(
                (result) => result.thread,
              ),
          )
          .then((thread) => {
            if (alive && thread.id === route.thread) updateSelected(thread);
          })
          .catch(() => {
            if (alive) navigate({ page: 'workbench', backend: backendId }, true);
          });
      return () => {
        alive = false;
      };
    }, [route.page, route.thread, route.host, backendId, paired, emptyCreation, threads, selectedState?.id]);

    selectedId.current = selected?.id ?? null;
    const receivedView = receivedViewState.value;
    const view = receivedView?.id === selected?.id ? receivedView : null;
    const stream = connection.value;
    const hostId = hostIdState.value;
    const drafts = readChatDrafts(deviceId, selected?.id ?? null);

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

    const uploading = uploadingState.value;
    const uploadJobs = uploadJobsState.value;
    const uploadThread = uploadThreadState.value;

    watchToolsOpen(() => {
      setToolsOpen(false);
      setConfigOpen(false);
      setSkillsOpen(false);
      setPluginsOpen(false);
    }, [selected?.id]);
    const questionDrafts = questionDraftsState.value;

    const error = errorState.value;
    const threadError = threadErrorState.value;
    const busy = busyState.value;
    const operations = operationsState.value;
    const historyCursor = historyCursorState.value;
    const historyLoading = historyLoadingState.value;
    const subscriptionAttempt = subscriptionAttemptState.value;

    const older = olderState.value;

    function receiveOperation(operation: Operation) {
      const previous = operationSnapshots.current.get(operation.id);
      // Apply the same ordering rule before journal writes and draft side effects.
      // Otherwise a late receipt could resurrect a confirmed request after reload.
      if (previous && mergeOperation([previous], operation)[0] !== operation) return;
      operationSnapshots.current.set(operation.id, operation);
      if (creationRequest.current === operation.id && ['failed', 'rejected'].includes(operation.state))
        creationRequest.current = undefined;
      if (operationSnapshots.current.size > 256)
        operationSnapshots.current.delete(operationSnapshots.current.keys().next().value!);
      rememberOperation(deviceId, operation);
      drafts.settle(operation);
      if (operation.kind === 'rename' && operation.state === 'completed' && previous?.state !== 'completed') {
        void api<{ thread: ThreadSummary }>(`/threads/${encodeURIComponent(operation.threadId)}`)
          .then(({ thread }) => {
            updateSelected((old) => (old?.id === thread.id ? thread : old));
            setThreads((old) => old.map((item) => (item.id === thread.id ? thread : item)));
            setThreadAction((old) => (old?.requestId === operation.id ? undefined : old));
          })
          .catch(() => {
            if (selectedId.current === operation.threadId) setError('改名已确认，请刷新会话列表查看。');
          });
      }
      if (
        (operation.kind === 'create' || operation.kind === 'fork') &&
        creationRequest.current === operation.id &&
        operation.state === 'completed' &&
        operation.resultThreadId &&
        selectedId.current === operation.threadId &&
        !openedCreations.current.has(operation.id)
      ) {
        openedCreations.current.add(operation.id);
        if (operation.kind === 'create') {
          try {
            localStorage.removeItem(deviceSession.contentKey(`new-conversation:${operation.threadId}`));
          } catch {
            /* Keep live confirmation usable when storage is unavailable. */
          }
        }
        void api<{ thread: ThreadSummary }>(`/threads/${encodeURIComponent(operation.resultThreadId)}`)
          .then((result) => {
            if (creationRequest.current === operation.id && selectedId.current === operation.threadId) {
              setSelected(result.thread);
              setNewOpen(false);
            }
            void loadThreads();
          })
          .catch(() => {
            if (creationRequest.current === operation.id) setError('新会话已建立，请刷新会话列表查看。');
          });
      }
      if (selectedId.current === operation.threadId) setOperations((old) => mergeOperation(old, operation));
    }
    watchBackend2(() => {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      void api<{ device: { id: string }; status: GatewayStatus; backend?: BackendInfo }>('/session')
        .then((r) => {
          setBackend(r.backend);
          setDeviceId(backendId === DEFAULT_BACKEND ? r.device.id : `${r.device.id}:${backendId}`);
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
            backendId,
          );
          if (cached && generation === listRequest.current) {
            setThreads(cached.threads);
            setCursor(cached.nextCursor);
            setListLoading(false);
          }
          const cachedProjects = await deviceSession.cached<typeof projects>('/projects', backendId);
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
    watchPaired(() => {
      if (paired) void loadThreads();
    }, [paired, project]);
    watchStatus(() => {
      const update = () => {
        setStatus(deviceSession.status ?? null);
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
    watchView(() => {
      if (!selected) return;
      const id = selected.id;
      let disposed = false;
      setView(null);
      viewRef.current = null;
      setOlder([]);
      historyGeneration.current++;
      historyScroll.current = null;
      setHistoryLoading(false);
      setHistoryCursor('latest');
      historyError.value = '';
      transcriptScroll.top = 0;
      setOperations(readPending(deviceId, id));
      setError('');
      setThreadError('');
      followBottom.current = true;
      for (const operation of readPending(deviceId, id))
        void api<Operation>(`/operations/${operation.id}`)
          .then((result) => {
            if (!disposed) receiveOperation(result);
          })
          .catch(() => {});
      const unsubscribe = deviceSession.subscribe(
        id,
        (data) => {
          if (disposed || selectedId.current !== id) return;
          if (data.type === 'status') setStatus(data.status);
          else if (data.type === 'thread' && data.thread.id === id) {
            viewRef.current = data.thread;
            setView(data.thread);
            setThreadError('');
          } else if (data.type === 'error') setThreadError(data.message);
          else if (data.type === 'operation') receiveOperation(data.operation);
        },
        backendId,
      );
      return () => {
        disposed = true;
        historyGeneration.current++;
        unsubscribe();
      };
    }, [selected?.id, deviceId, backendId, subscriptionAttempt]);
    watchOlder(() => {
      const previous = historyScroll.current;
      const transcript = transcriptRef.value;
      if (previous && transcript) {
        transcript.scrollTop = previous.top + transcript.scrollHeight - previous.height;
        transcriptScroll.top = transcript.scrollTop;
        transcriptScroll.height = transcript.clientHeight;
      }
      historyScroll.current = null;
    }, [older]);
    watchView2(() => {
      const transcript = transcriptRef.value;
      if (followBottom.current && transcript) scrollToLatest(transcript);
    }, [view?.messages]);
    const transcript = transcriptRef.value;
    watchTranscript(() => {
      if (!transcript) return;
      transcriptScroll.height = transcript.clientHeight;
      const observer = new ResizeObserver(() => {
        const height = transcript.clientHeight;
        if (!height || height === transcriptScroll.height) return;
        if (followBottom.current) scrollToLatest(transcript);
        else {
          transcriptScroll.height = height;
          transcriptScroll.top = transcript.scrollTop;
        }
      });
      observer.observe(transcript);
      return () => observer.disconnect();
    }, [transcript]);
    async function pair(e: SubmitEvent) {
      e.preventDefault();
      setBusy(true);
      setError('');
      try {
        const result = await deviceSession.pair(hostId.trim(), code.trim(), name);
        setDeviceId(backendId === DEFAULT_BACKEND ? result.deviceId : `${result.deviceId}:${backendId}`);
        setCode('');
        setPaired(true);
        setStatus(await api('/status'));
        navigate({ page: 'workbench', backend: backendId }, true);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }
    async function act(
      kind: Operation['kind'],
      settings?:
        | ModelUpdate
        | RequestResponse
        | NewConversationInput
        | { messageId: string }
        | { title: string }
        | { lastTurnId: string }
        | { control: ControlAction },
      retryDraft?: ChatDraft,
    ) {
      if (!selected || (!view && !['create', 'rename', 'fork'].includes(kind))) return;
      const isSend = kind === 'send' || kind === 'steer' || kind === 'queue';
      if (isSend && dispatchingDraft.current) return;
      const submitted = retryDraft ?? drafts.draft;
      setBusy(true);
      setError('');
      const requestId = crypto.randomUUID();
      const body =
        kind === 'open'
          ? { requestId }
          : kind === 'queue'
            ? { requestId, text: submitted.text, expectedQueueFingerprint: view?.queueFingerprint }
            : kind === 'queue-remove'
              ? { requestId, ...settings, expectedQueueFingerprint: view?.queueFingerprint }
              : ['control', 'settings', 'respond', 'create', 'rename', 'fork'].includes(kind)
                ? { requestId, ...settings }
                : kind === 'send'
                  ? {
                      requestId,
                      text: submitted.text,
                      uploadIds: submitted.uploads.map((u) => u.id),
                      skillIds: submitted.skills.map((s) => s.id),
                      pluginIds: submitted.plugins.map((s) => s.id),
                    }
                  : kind === 'steer'
                    ? {
                        requestId,
                        text: submitted.text,
                        uploadIds: submitted.uploads.map((u) => u.id),
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
        if (kind === 'create' || kind === 'fork') creationRequest.current = requestId;
        if (kind === 'rename' || kind === 'fork') {
          setThreadAction((old) => (old?.kind === kind ? { ...old, requestId } : old));
        }
        receiveOperation(pendingOperation);
        if (isSend) {
          drafts.submit(pendingOperation, submitted, !!retryDraft);
          dispatchingDraft.current = true;
          followBottom.current = true;
          if (!retryDraft) setUploadJobs([]);
        }
      } catch {
        if (creationRequest.current === requestId) creationRequest.current = undefined;
        if (operationSnapshots.current.has(requestId)) {
          // The request was never dispatched. Clean up its journal entry if the draft write failed.
          try {
            receiveOperation({ ...pendingOperation, state: 'rejected', updatedAt: Date.now() });
          } catch {}
        }
        setError('浏览器无法保存草稿或请求标识，本次操作未发送');
        setBusy(false);
        return;
      }
      try {
        const operation = await api<Operation>(
          `/threads/${encodeURIComponent(selected.id)}/${kind === 'send' ? 'messages' : kind === 'respond' ? 'responses' : kind}`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        receiveOperation(operation);
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          receiveOperation({
            ...pendingOperation,
            state: 'rejected',
            error: e.message,
            updatedAt: Date.now(),
          });
          return;
        }
        try {
          receiveOperation(await api<Operation>(`/operations/${requestId}`));
        } catch {
          receiveOperation({
            ...pendingOperation,
            state: 'uncertain',
            error: '未获得最终结果，请在原实例核对',
            updatedAt: Date.now(),
          });
        }
      } finally {
        if (isSend) dispatchingDraft.current = false;
        setBusy(false);
      }
      return requestId;
    }
    async function uploadFiles(files: FileList | File[] | null) {
      if (!selected || !files || uploadLock.current) return;
      const threadId = selected.id,
        list = Array.from(files);
      if (!list.length) return;
      if (uploads.length + list.length > 10) {
        setError('每条消息最多 10 个附件');
        return;
      }
      const jobs = uploadItems(list);
      uploadLock.current = true;
      setUploadThread(threadId);
      setUploadJobs(jobs);
      setUploading(true);
      setError('');
      const update = (index: number, value: Partial<UploadItem>) =>
        setUploadJobs((old) => old.map((job) => (job.id === jobs[index].id ? { ...job, ...value } : job)));
      try {
        for (let i = 0; i < list.length; i++) {
          update(i, { state: 'active' });
          try {
            const done = await uploadFile(threadId, list[i], (progress) => update(i, progress));
            drafts.update(threadId, (d) => ({ ...d, uploads: [...d.uploads, done] }));
            update(i, { state: 'done' });
          } catch (e) {
            update(i, { state: 'failed', error: (e as Error).message });
          }
        }
      } finally {
        uploadLock.current = false;
        setUploading(false);
      }
    }
    async function loadOlder() {
      let cursor = historyCursorState.value;
      if (!selected || !view || !cursor || historyLoadingState.value) return;
      const id = selected.id;
      const generation = ++historyGeneration.current;
      const known = new Set([...olderState.value, ...(viewRef.current?.messages ?? [])].map((m) => m.id));
      let added: Message[] = [];
      let visible = 0;
      setHistoryLoading(true);
      historyError.value = '';
      try {
        for (
          let index = 0;
          cursor && index < HISTORY_PAGES_PER_LOAD && visible < HISTORY_VISIBLE_TARGET;
          index++
        ) {
          const query: string = cursor === 'latest' ? '' : `?cursor=${encodeURIComponent(cursor)}`;
          const page: { messages: Message[]; nextCursor: string | null } = await api(
            `/threads/${encodeURIComponent(id)}/history${query}`,
          );
          if (selectedId.current !== id || generation !== historyGeneration.current) return;
          const unique = page.messages.filter((message) => {
            if (known.has(message.id)) return false;
            known.add(message.id);
            return true;
          });
          added = [...unique, ...added];
          visible += unique.filter((message) => !codex || codexDisplayMessage(message, false)).length;
          cursor = page.nextCursor === cursor ? null : page.nextCursor;
        }
      } catch (e) {
        if (generation === historyGeneration.current) historyError.value = (e as Error).message;
      } finally {
        if (selectedId.current === id && generation === historyGeneration.current) {
          const transcript = transcriptRef.value;
          if (transcript && (added.length || cursor !== historyCursorState.value)) {
            historyScroll.current = { top: transcript.scrollTop, height: transcript.scrollHeight };
            followBottom.current = false;
            setOlder((old) => [...added, ...old]);
          }
          setHistoryCursor(cursor);
          if (visible > 0 || !cursor)
            setView((previous) =>
              previous?.historyUnavailable
                ? {
                    ...previous,
                    historyUnavailable: false,
                    reason: '历史记录已读取。请在电脑上的 Codex 打开此会话后开始控制。',
                  }
                : previous,
            );
          setHistoryLoading(false);
        }
      }
    }
    const currentOperations = operations.filter((operation) => operation.threadId === selected?.id);
    const threadActionOperation = currentOperations.find(
      (operation) => operation.id === threadAction?.requestId,
    );
    const pending = [drafts.outgoing?.operation, ...currentOperations].some(
      (x) => x && ['received', 'dispatching', 'uncertain'].includes(x.state),
    );
    const delivery =
      currentOperations.find((x) => ['received', 'dispatching', 'uncertain'].includes(x.state)) ??
      currentOperations[0];
    const canCompose =
      stream && !!view && (view.canSend || (view.canInterrupt && view.pendingRequests === 0));
    const currentIds = new Set(view?.messages.map((x) => x.id));
    const codex = backend?.product === 'codex' || (!backend && backendId === DEFAULT_BACKEND);
    const combined = view ? [...older.filter((x) => !currentIds.has(x.id)), ...view.messages] : [];
    const messages = codex
      ? combined.flatMap(
          (message) =>
            codexDisplayMessage(message, !!view?.activeTurnId && message.turnId === view.activeTurnId) ?? [],
        )
      : combined;
    const outgoing = drafts.outgoing;
    const outgoingOperation = outgoing?.operation;
    watchDeviceId(() => {
      if (
        !outgoingOperation ||
        outgoingOperation.state !== 'uncertain' ||
        !stream ||
        operationSnapshots.current.has(outgoingOperation.id) ||
        recoveredDraft.current === outgoingOperation.id ||
        readPending(deviceId, outgoingOperation.threadId).some((x) => x.id === outgoingOperation.id)
      )
        return;
      // A receipt can remove the journal entry just before the browser saves the updated draft.
      recoveredDraft.current = outgoingOperation.id;
      void api<Operation>(`/operations/${outgoingOperation.id}`)
        .then(receiveOperation)
        .catch(() => {});
    }, [deviceId, outgoingOperation, stream]);
    const hasOutgoingFailure =
      outgoingOperation?.state === 'rejected' || outgoingOperation?.state === 'failed';
    const echoed =
      outgoingOperation &&
      messages.some(
        (message) =>
          message.role === 'user' &&
          (message.clientMessageId === outgoingOperation.id ||
            (outgoingOperation.kind === 'send' &&
              !!outgoingOperation.turnId &&
              message.turnId === outgoingOperation.turnId)),
      );
    watchOutgoingOperation(() => {
      if (outgoingOperation?.state === 'accepted' && echoed) drafts.clearOutgoing(outgoingOperation);
    }, [outgoingOperation, echoed]);
    watchOutgoingOperation2(() => {
      if (outgoingOperation && followBottom.current && transcriptRef.value)
        scrollToLatest(transcriptRef.value);
    }, [outgoingOperation]);
    const canEdit =
      stream &&
      !!view?.synchronized &&
      (canCompose || (!!outgoingOperation && view.owner && !!status?.writesEnabled));
    const composerDelivery = delivery?.id === outgoingOperation?.id ? undefined : delivery;
    const draftHasContent = !!(
      draft.trim() ||
      uploads.length ||
      selectedSkills.length ||
      selectedPlugins.length
    );
    watchBusy(() => {
      onBusy(busy || uploading || pending);
    }, [busy, uploading, pending, onBusy]);
    if (loading)
      return (
        <main class="pair-wrap">
          <p>正在连接…</p>
        </main>
      );
    if (route.page === 'workbench' && route.host && route.host !== deviceSession.host?.hostId)
      return (
        <main class="module-page">
          <section class="module-empty">
            <h2>正在打开对应的电脑</h2>
            <button class="secondary" onClick={() => navigate({ page: 'workbench' }, true)}>
              返回工作台
            </button>
          </section>
        </main>
      );
    if (!paired && route.page !== 'pair')
      return (
        <main class="module-page">
          <header class="page-header">
            <h1>工作台</h1>
          </header>
          <section class="module-empty">
            <span class="empty-symbol">
              <Icon name="monitor" size={38} />
            </span>
            <h2>继续电脑上的工作</h2>
            <p>连接你的电脑，查看项目、发送任务和处理审批。</p>
            <button class="primary" onClick={() => navigate({ page: 'pair' })}>
              连接电脑
            </button>
          </section>
        </main>
      );
    if (!paired || route.page === 'pair')
      return (
        <main class="pair-wrap">
          <section class="pair-card">
            <div class="brand-icon">C</div>
            <p class="eyebrow">CODEX POCKET REMOTE</p>
            <h1>
              把桌面的工作
              <br />
              带在身边。
            </h1>
            <p class="muted">连接你的电脑，查看同一会话并控制任务。</p>
            <p class="pair-guide" role="status">
              {fromPairLink && code
                ? '已读取配对链接，点击「连接电脑」即可。'
                : '在要添加的电脑上打开适配器，点击「登录并连接」，使用同一账号授权。也可以扫描电脑上的配对二维码。'}
            </p>
            {!fromPairLink && (
              <button class="text-button" onClick={() => navigate({ page: 'downloads' })}>
                下载电脑适配器
              </button>
            )}
            <PairScanner
              onScan={(host, code) => {
                setHostId(host);
                setCode(code);
                setFromPairLink(true);
                setError('');
              }}
            />
            <form onSubmit={pair}>
              <label>
                设备名称
                <input
                  value={name}
                  onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
                  maxlength={80}
                  required
                  autocomplete="off"
                />
              </label>
              <details class="pair-manual">
                <summary>手动输入配对码</summary>
                <label>
                  电脑身份
                  <input
                    value={hostId}
                    onInput={(e) => setHostId((e.currentTarget as HTMLInputElement).value)}
                    autocomplete="off"
                  />
                </label>
                <label>
                  一次性配对码
                  <input
                    value={code}
                    onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)}
                    required
                    autocomplete="off"
                    spellcheck={false}
                    placeholder="粘贴电脑上生成的配对码"
                  />
                </label>
              </details>
              <button class="primary" disabled={busy || !hostId.trim() || !code.trim()}>
                {busy ? '正在配对…' : '连接电脑'}
              </button>
            </form>
            <p class="hint">
              在电脑运行 <code>npm run pair</code> 显示二维码；五分钟内一次有效。
            </p>
            {error && (
              <p role="alert" class="error">
                {error}
              </p>
            )}
          </section>
        </main>
      );
    return (
      <div class={`app ${selected ? 'has-thread' : ''}`}>
        <WebUpdateNotice
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
          backend={backend}
          agentName={agentName}
          onWorkbench={() => navigate({ page: 'workbench' })}
          canCreate={!!status?.capabilities.newThread && !busy && !uploading}
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
            else if (!selected && emptyCreation) {
              updateSelected({ id: 'new', title: `新建 ${agentName} 会话`, cwd: '', updatedAt: Date.now() });
              navigate({ page: 'workbench', backend: backendId, thread: 'new' });
            }
            setNewOpen(true);
          }}
        />
        <main class="chat">
          <ConversationHeader
            className="chat-head"
            level={2}
            title={selected?.title || '选择一个会话'}
            backLabel="返回会话列表"
            onBack={() => backTo({ page: 'workbench', backend: backendId, host: route.host }, navigate)}
            subtitle={
              <>
                <Icon name="monitor" size={14} />
                <span>{deviceSession.host?.name}</span>
                {selected && (
                  <>
                    <Icon name="folder" size={14} />
                    <span>{selected.projectName ?? '未分类'}</span>
                  </>
                )}
              </>
            }
            status={
              selected ? (
                <span
                  title={stream && view?.synchronized ? '已连接' : '正在恢复连接'}
                  class={`dot ${stream && view?.synchronized ? 'online' : ''}`}
                />
              ) : undefined
            }
          >
            {() => (
              <>
                <UsagePanel backendId={backendId} name={agentName} active={active} online={stream} />
                {selected && (
                  <button
                    class="icon-button more-tools"
                    aria-label="会话工具"
                    onClick={() => setToolsOpen(true)}
                  >
                    <Icon name="more" />
                  </button>
                )}
              </>
            )}
          </ConversationHeader>
          {!selected ? (
            <section class="empty">
              <div class="brand-icon">C</div>
              <h2>Agent 继续工作，手机随时接入</h2>
              <p>从左侧选择会话，查看历史并继续工作。</p>
            </section>
          ) : (
            <>
              <div class="transcript-stage">
                <section
                  ref={transcriptRef}
                  class="transcript"
                  aria-label="聊天记录"
                  onScroll={(e) => {
                    const el = e.currentTarget as HTMLElement;
                    const top = el.scrollTop;
                    // A keyboard or composer resize can move the scroll position
                    // without the reader navigating away from the latest message.
                    if (el.clientHeight !== transcriptScroll.height || top === transcriptScroll.top)
                      return;
                    const movingUp = top < transcriptScroll.top;
                    transcriptScroll.top = top;
                    followBottom.current = el.scrollHeight - top - el.clientHeight < 100;
                    if (
                      movingUp &&
                      top <= HISTORY_TOP_THRESHOLD &&
                      !historyError.value &&
                      !view?.historyUnavailable
                    )
                      void loadOlder();
                  }}
                >
                  {view && historyCursor && (
                    <div class="older">
                      {historyError.value && <span role="status">{historyError.value}</span>}
                      <button class="older-button" disabled={historyLoading} onClick={() => void loadOlder()}>
                        {historyLoading
                          ? '正在加载历史记录…'
                          : view.historyUnavailable || historyError.value
                            ? '重试读取历史'
                            : '更早记录'}
                      </button>
                    </div>
                  )}
                  {!view &&
                    (threadError ? (
                      <div class="center">
                        <p>会话暂时无法读取</p>
                        <button
                          class="secondary"
                          onClick={() => setSubscriptionAttempt((value) => value + 1)}
                        >
                          重新加载会话
                        </button>
                      </div>
                    ) : (
                      <p class="muted center">正在读取会话…</p>
                    ))}
                  <TranscriptMessages
                    agent={{ name: agentName }}
                    messages={messages}
                    threadId={selected.id}
                    activeTurnId={view?.activeTurnId}
                    requests={view?.requests}
                    codex={codex}
                    onFork={
                      status?.capabilities.forkFromTurn
                        ? (lastTurnId) =>
                            setThreadAction({
                              kind: 'fork',
                              threadId: selected.id,
                              title: selected.title,
                              lastTurnId,
                            })
                        : undefined
                    }
                    forkDisabled={!stream || busy || pending}
                  />
                  {outgoing && !echoed && (
                    <article class="message user outgoing-message" data-outgoing-id={outgoing.operation.id}>
                      <div class="message-role">你</div>
                      <OutgoingContent text={outgoing.draft.text} files={outgoing.draft.uploads}>
                        {() => (
                          <>
                            {(!!outgoing.draft.skills.length || !!outgoing.draft.plugins.length) && (
                              <div class="selected-skills">
                                {[...outgoing.draft.skills, ...outgoing.draft.plugins].map((item) => (
                                  <span class="skill-chip" key={item.id}>
                                    {item.name}
                                  </span>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </OutgoingContent>
                      <OutgoingStatus activity={operationActivity(outgoing.operation)}>
                        {() => (
                          <>
                            {outgoing.operation.state === 'accepted' && <span>已发送</span>}
                            <OperationFeedback
                              operation={outgoing.operation}
                              onCheck={async () =>
                                receiveOperation(await api<Operation>(`/operations/${outgoing.operation.id}`))
                              }
                              onRetry={
                                outgoing.operation.state === 'rejected' &&
                                canCompose &&
                                !busy &&
                                !pending &&
                                (outgoing.operation.kind !== 'queue' || !!view?.queueFingerprint) &&
                                (!view?.activeTurnId ||
                                  (!outgoing.draft.skills.length && !outgoing.draft.plugins.length))
                                  ? () =>
                                      void act(
                                        outgoing.operation.kind === 'queue'
                                          ? 'queue'
                                          : view?.activeTurnId
                                            ? 'steer'
                                            : 'send',
                                        undefined,
                                        outgoing.draft,
                                      )
                                  : undefined
                              }
                            />
                            {hasOutgoingFailure && (
                              <div class="outgoing-actions">
                                {outgoing.operation.state === 'rejected' && !draftHasContent && (
                                  <button
                                    type="button"
                                    onClick={() => drafts.clearOutgoing(outgoing.operation, true)}
                                  >
                                    移回输入框
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => drafts.clearOutgoing(outgoing.operation)}
                                >
                                  移除发送记录
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </OutgoingStatus>
                    </article>
                  )}
                  {view && messages.length === 0 && !outgoing && (
                    <p class="muted center">
                      {view.historyUnavailable
                        ? '暂时无法读取此会话的历史记录'
                        : '此会话暂时没有可显示的消息'}
                    </p>
                  )}
                  {!!view?.requests?.length && (
                    <RequestCards
                      threadId={selected.id}
                      requests={view.requests}
                      onDraftChange={questionDraftChanged}
                      response={operations.find((operation) => operation.kind === 'respond')}
                      disabled={
                        busy ||
                        pending ||
                        !stream ||
                        !view.owner ||
                        !view.synchronized ||
                        !status?.writesEnabled
                      }
                      onRespond={(response) => act('respond', response)}
                    />
                  )}
                </section>
                <TurnNavigation
                  key={selected.id}
                  messages={messages}
                  transcript={transcriptRef}
                  onNavigate={() => {
                    followBottom.current = false;
                  }}
                />
              </div>
              <section class="composer">
                <div
                  class={`connection-note ${stream && view?.synchronized && view.owner && view.runtimeStatus !== 'notLoaded' && status?.writesEnabled ? 'sr-only' : ''}`}
                >
                  <span class={`dot ${stream && view?.synchronized ? 'online' : ''}`} />
                  {!stream ? '连接中断，正在恢复；控制暂不可用' : (view?.reason ?? '与原实例共享同一个会话')}
                </div>
                {view &&
                  (!view.owner || view.runtimeStatus === 'notLoaded') &&
                  status?.capabilities.openThread && (
                    <button
                      class="secondary"
                      disabled={busy || pending || !stream}
                      onClick={() => void act('open')}
                    >
                      {busy || pending ? '正在连接会话…' : '继续此会话'}
                    </button>
                  )}
                {(error || threadError) && (
                  <p class="error" role="alert">
                    {error || threadError}
                  </p>
                )}
                {(!!selectedSkills.length || !!selectedPlugins.length) && !!view?.activeTurnId && (
                  <p class="hint">已选插件和技能将在下一轮使用，请等当前任务结束后发送。</p>
                )}
                <ChatComposer
                  activity={operationActivity(outgoingOperation) ?? operationActivity(composerDelivery)}
                  feedback={
                    <OperationFeedback
                      operation={composerDelivery}
                      onCheck={
                        delivery
                          ? async () => receiveOperation(await api<Operation>(`/operations/${delivery.id}`))
                          : undefined
                      }
                      onRetry={
                        delivery?.state === 'rejected' &&
                        ['send', 'steer'].includes(delivery.kind) &&
                        (draft.trim() || uploads.length) &&
                        canCompose &&
                        !busy &&
                        !pending
                          ? () => void act(view?.activeTurnId ? 'steer' : 'send')
                          : undefined
                      }
                    />
                  }
                  threadId={selected.id}
                  value={drafts.draft}
                  onChange={(change) => drafts.update(selected.id, change)}
                  disabled={!canEdit}
                  placeholder={
                    canEdit
                      ? view?.activeTurnId
                        ? '给当前任务追加指令…'
                        : `给 ${agentName} 发消息…`
                      : '当前只读；请查看上方连接状态'
                  }
                  uploading={uploading}
                  uploadItems={uploadThread === selected.id ? uploadJobs : []}
                  onDismissUploads={() => setUploadJobs([])}
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
                        hasOutgoingFailure ||
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
                    if (
                      presentation?.nativeCommands &&
                      /^\/(permission|goal|plan|compact|feedback|export|model|file)(?:\s|$)/.test(
                        draft.trim(),
                      ) &&
                      !selectedSkills.length
                    ) {
                      const command = draft.trim().split(/\s/)[0].slice(1);
                      if (command === 'model') setConfigOpen(true);
                      else
                        setControlRequest((previous) => ({
                          threadId: view!.id,
                          target: ['permission', 'goal', 'feedback', 'file'].includes(command)
                            ? (command as ControlSection)
                            : 'tools',
                          sequence: (previous?.sequence ?? 0) + 1,
                        }));
                      return;
                    }
                    void act(view?.activeTurnId ? 'steer' : 'send');
                  }}
                  onInterrupt={() => void act('interrupt')}
                  onQueue={() => void act('queue')}
                  actions={
                    <>
                      {view && (
                        <>
                          <ConversationControls
                            key={view.id}
                            id={view.id}
                            state={view.controls}
                            backend={backend}
                            plan={controlPlan ? !!view.controls?.plan : view.mode === 'plan'}
                            running={!!view.activeTurnId}
                            disabled={busy || pending || !stream}
                            modeDisabled={
                              presentation?.plan === 'settings' &&
                              ((!view.canSend && !view.canInterrupt) || !view.model || !view.reasoningEffort)
                            }
                            refresh={operations[0]?.updatedAt ?? 0}
                            request={controlRequest?.threadId === view.id ? controlRequest : undefined}
                            onAction={(control) => void act('control', { control })}
                            onMode={(mode) =>
                              void (controlPlan
                                ? act('control', { control: { action: 'plan', enabled: mode === 'plan' } })
                                : act('settings', settingsUpdate(view, mode)))
                            }
                            onSkills={() => setSkillsOpen(true)}
                            onPlugins={() => setPluginsOpen(true)}
                            onFile={(path) =>
                              drafts.update(view.id, (old) => ({
                                ...old,
                                text: old.text + ' @' + path + ' ',
                              }))
                            }
                          />
                          {view.mode === 'plan' && (
                            <button
                              type="button"
                              class="plan-chip"
                              aria-label="取消计划模式"
                              disabled={busy || pending || !stream || (!view.canSend && !view.canInterrupt)}
                              onClick={() =>
                                void (controlPlan
                                  ? act('control', { control: { action: 'plan', enabled: false } })
                                  : act('settings', settingsUpdate(view, 'default')))
                              }
                            >
                              计划
                              <Icon name="close" size={14} />
                            </button>
                          )}
                          <button
                            type="button"
                            class="composer-model"
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
                  {() => (
                    <>
                      <ModelSettings
                        view={view}
                        disabled={busy || pending || !stream || (!view.canSend && !view.canInterrupt)}
                        onSave={(settings) => act('settings', settings)}
                        onDirtyChange={setSettingsDirty}
                        response={operations.find((o) => o.kind === 'settings')}
                        onApplied={() => setConfigOpen(false)}
                      />
                    </>
                  )}
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
                  {() => (
                    <>
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
                    </>
                  )}
                </ThreadTools>
              )}
              <ThreadTools
                open={newOpen}
                className="new-conversation-sheet"
                onClose={() => {
                  creationRequest.current = undefined;
                  setNewOpen(false);
                }}
                title="选择项目，发送第一条消息即可开始"
                heading="新会话"
              >
                {() => (
                  <>
                    <NewConversation
                      key={`new:${selected.id}`}
                      anchor={selected.id}
                      creation={presentation?.creation}
                      active={newOpen}
                      defaultProject={newProject}
                      knownProjects={projects.projects}
                      onDirtyChange={setNewDirty}
                      disabled={
                        busy ||
                        pending ||
                        (!stream && !emptyCreation) ||
                        !status?.writesEnabled ||
                        !status.capabilities.newThread
                      }
                      feedback={
                        error || (!status?.writesEnabled ? '电脑连接暂不可用，消息草稿会保留。' : undefined)
                      }
                      operation={delivery?.kind === 'create' ? delivery : undefined}
                      onCheck={
                        delivery
                          ? async () => receiveOperation(await api<Operation>(`/operations/${delivery.id}`))
                          : undefined
                      }
                      onCreate={(input) => void act('create', input)}
                    />
                    {operations.find(
                      (o) => o.kind === 'create' && o.state === 'uncertain' && o.resultThreadId,
                    ) && (
                      <button
                        class="secondary"
                        onClick={async () => {
                          const op = operations.find(
                            (o) => o.kind === 'create' && o.state === 'uncertain' && o.resultThreadId,
                          )!;
                          try {
                            const result = await api<{ thread: ThreadSummary }>(
                              `/threads/${encodeURIComponent(op.resultThreadId!)}`,
                            );
                            setSelected(result.thread);
                            setNewOpen(false);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        查看已创建会话；结果待确认，请勿重复发送
                      </button>
                    )}
                  </>
                )}
              </ThreadTools>
              {active && threadAction?.threadId === selected.id && (
                <ThreadTools
                  open
                  title={selected.title}
                  heading={threadAction.kind === 'rename' ? '会话改名' : '创建会话分支'}
                  onClose={() => {
                    if (threadAction.kind === 'fork') creationRequest.current = undefined;
                    setThreadAction(undefined);
                  }}
                >
                  {() => (
                    <>
                      <form
                        class="thread-action-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (busy || pending || threadActionOperation?.state === 'completed') return;
                          if (threadAction.kind === 'rename') {
                            const title = threadAction.title.trim();
                            if (!title || title === selected.title) return;
                            void act('rename', { title });
                          } else {
                            const { lastTurnId } = threadAction;
                            void act('fork', lastTurnId ? { lastTurnId } : undefined);
                          }
                        }}
                      >
                        {threadAction.kind === 'rename' ? (
                          <label>
                            会话名称
                            <input
                              required
                              autofocus
                              onVnodeMounted={(vnode) => (vnode.el as HTMLElement).focus()}
                              maxlength={160}
                              value={threadAction.title}
                              onInput={(event) => {
                                const title = (event.currentTarget as HTMLInputElement).value;
                                setThreadAction((old) => old && { ...old, title });
                              }}
                              disabled={busy || pending}
                            />
                          </label>
                        ) : (
                          <p class="hint">
                            {threadAction.lastTurnId
                              ? '保留截至这条回复的历史，在同一目录创建一条独立的 Codex 会话。'
                              : '使用当前会话历史，在同一目录创建一条独立的 Codex 会话。'}
                          </p>
                        )}
                        <OperationFeedback
                          operation={threadActionOperation}
                          onCheck={
                            threadActionOperation
                              ? async () =>
                                  receiveOperation(
                                    await api<Operation>(`/operations/${threadActionOperation.id}`),
                                  )
                              : undefined
                          }
                        />
                        {error && (
                          <p class="error" role="alert">
                            {error}
                          </p>
                        )}
                        <button
                          class="primary"
                          disabled={
                            !stream ||
                            busy ||
                            pending ||
                            threadActionOperation?.state === 'completed' ||
                            (threadAction.kind === 'rename' &&
                              (!threadAction.title.trim() || threadAction.title.trim() === selected.title))
                          }
                          type="submit"
                        >
                          {operationActivity(threadActionOperation) ??
                            (threadAction.kind === 'rename' ? '保存名称' : '创建分支')}
                        </button>
                      </form>
                    </>
                  )}
                </ThreadTools>
              )}
              <ThreadTools
                key={`tools:${selected.id}`}
                open={toolsOpen}
                onClose={() => setToolsOpen(false)}
                title={selected.title}
              >
                {() => (
                  <>
                    <p class="hint">
                      {!stream ? '连接中断，正在恢复' : (view?.reason ?? '与原实例共享同一个会话')}
                    </p>
                    {(['rename', 'fork'] as const).map(
                      (kind) =>
                        selected.id !== 'new' &&
                        status?.capabilities[kind === 'rename' ? 'renameThread' : 'forkThread'] && (
                          <button
                            class="secondary"
                            type="button"
                            key={kind}
                            disabled={busy || pending || !stream}
                            onClick={() => {
                              setToolsOpen(false);
                              setError('');
                              setThreadAction({ kind, threadId: selected.id, title: selected.title });
                            }}
                          >
                            {kind === 'rename' ? '会话改名' : '创建会话分支'}
                          </button>
                        ),
                    )}
                    {operations[0]?.kind === 'settings' && (
                      <OperationFeedback
                        operation={operations[0]}
                        onCheck={async () =>
                          receiveOperation(await api<Operation>(`/operations/${operations[0].id}`))
                        }
                      />
                    )}
                    {view && (
                      <button
                        class="secondary"
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
                        class="secondary"
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
                      <details class="native-queue" open>
                        <summary>会话队列 · {view.queuedMessages.length}</summary>
                        {view.queuedMessages.map((m) => (
                          <div key={m.id}>
                            <p>{m.text}</p>
                            <small>{m.reason ?? m.status}</small>
                            <button
                              type="button"
                              disabled={
                                busy ||
                                pending ||
                                !stream ||
                                ['sending', 'outcome-unknown'].includes(m.status)
                              }
                              onClick={() => void act('queue-remove', { messageId: m.id })}
                            >
                              移除
                            </button>
                          </div>
                        ))}
                      </details>
                    )}
                    <details class="operation-history">
                      <summary>操作记录</summary>
                      {operations.length ? (
                        operations.map((op) => (
                          <p key={op.id}>
                            {operationNames[op.kind] ?? '操作'} · {labels[op.state]}
                            {op.error ? `：${op.error}` : ''}
                            {op.kind === 'create' && op.resultThreadId && op.state === 'uncertain' && (
                              <button
                                type="button"
                                onClick={() =>
                                  navigate({
                                    page: 'workbench',
                                    backend: backendId,
                                    thread: op.resultThreadId!,
                                  })
                                }
                              >
                                查看已建立的会话
                              </button>
                            )}
                          </p>
                        ))
                      ) : (
                        <p class="hint">暂无操作记录</p>
                      )}
                    </details>
                  </>
                )}
              </ThreadTools>
            </>
          )}
        </main>
      </div>
    );
  };
});
