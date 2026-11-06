import type { ControlAction, ControlCatalog, ControlState } from '../../shared/controls.js';
import type { BackendCommand } from './commands.js';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { join, win32, posix } from 'node:path';
import { attachmentLinks } from '../media.js';
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream';
import type { WorkspaceFollowFrame, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types';
import type {
  SessionFollowFrame,
  SessionWireEvent,
  SessionSummary,
  SessionPage,
  ModelCatalog as DshModels,
} from '@deepseek-ai/dsh-api-session-controller/types';
import type { BackendInfo, CapabilityName } from '../../shared/backends.js';
import type {
  ThreadView,
  ThreadSummary,
  Message,
  Operation,
  ConversationRequest,
  RequestResponse,
} from '../../shared/types.js';
import type { AgentBackend, BackendHistory, OperationObservation } from './types.js';
import { DshWebConnection, type DshConnection, type DshConnectionConfig } from '../connectors/dsh-web.js';
import { DeliveryError } from '../delivery-error.js';
import { SelectionError } from '../selection-error.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const address = (id: string) => ({ kind: 'session', sessionId: id });
const text = (blocks: any[] = []) =>
  blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
type Live = {
  refs: number;
  cancel?: () => void;
  recovery?: NodeJS.Timeout;
  view: ThreadView;
  seq: number;
  records: Map<number, SessionWireEvent>;
  projections: Record<string, any>;
  projectionSeq: Map<string, number>;
  projectionCut: number;
  followEpoch: number;
  assistantRevision: number;
  hasMore: boolean;
  attempt?: {
    id: string;
    turn: number;
    step: number;
    committedSeq?: number;
    revision: number;
    next: number;
    assembler: ReturnType<typeof assembleAssistantStream>;
  };
};
type Interaction = {
  generation: number;
  clientId: string;
  nativeId: string;
  sessionId: string;
  event: string;
  request: any;
  card: ConversationRequest;
  replying?: boolean;
  cancelWait?: () => void;
};
export class DshBackend extends EventEmitter implements AgentBackend {
  readonly id: string;
  readonly history: BackendHistory;
  readonly maxUploadBytes = 256 * 1024 * 1024;
  private live = new Map<string, Live>();
  private summaries = new Map<string, ThreadSummary>();
  private interactions = new Map<string, Interaction>();
  private settledEvents = new Set<string>();
  private clientId = '';
  private revision = 0;
  private reconnect?: NodeJS.Timeout;
  private historyMessages = new Map<string, Map<string, Message>>();
  private closed = false;
  private receipts = new Map<string, { generation: number; receiptId: string }>();
  constructor(
    private config: DshConnectionConfig,
    private directory: string,
    private readOnly = false,
    readonly connection: DshConnection = new DshWebConnection(config),
  ) {
    super();
    this.id = config.id;
    this.history = {
      list: (cursor, limit, project, query) => this.list(cursor, limit, project, query),
      get: async (id) => {
        if (!this.summaries.has(id)) await this.list();
        return this.summaries.get(id) ?? null;
      },
      page: (id, cursor) => this.page(id, cursor),
      projects: async () => {
        const projects = await this.projects('');
        const all = await this.list();
        return {
          projects: projects.map((p: { id: string; name: string }) => ({
            id: p.id,
            name: p.name,
            count: all.threads.filter((t) => t.projectId === p.id).length,
          })),
          total: all.threads.length,
          ungrouped: all.threads.filter((t) => !t.projectId).length,
        };
      },
    };
    connection.on('connected', () => this.connected());
    connection.on('disconnected', () => {
      this.clientId = '';
      for (const event of this.interactions.values()) event.cancelWait?.();
      this.interactions.clear();
      this.settledEvents.clear();
      this.receipts.clear();
      for (const [id, live] of this.live) {
        live.cancel = undefined;
        live.followEpoch++;
        live.projectionSeq.clear();
        live.projections = {};
        live.projectionCut = -1;
        live.attempt = undefined;
        live.assistantRevision = -1;
        clearTimeout(live.recovery);
        live.view.synchronized = false;
        this.publish(id);
      }
      this.emit('status');
    });
  }
  async start() {
    this.closed = false;
    await this.connection.start();
  }
  stop() {
    this.closed = true;
    clearTimeout(this.reconnect);
    this.connection.stop();
    this.live.clear();
    this.interactions.clear();
    this.historyMessages.clear();
  }
  info(): BackendInfo {
    const capabilities = {} as BackendInfo['capabilities'];
    for (const name of [
      'history',
      'send',
      'steer',
      'interrupt',
      'respond',
      'settings',
      'queue',
      'create',
      'open',
      'attachments',
      'skills',
      'plugins',
    ] as CapabilityName[]) {
      capabilities[name] =
        name === 'plugins'
          ? { state: 'unsupported', reason: 'DSH 使用原生技能目录' }
          : !this.connection.connected
            ? { state: 'unavailable', reason: 'DSH Web 未连接，请检查实例地址和访问凭据' }
            : name !== 'history' && this.readOnly
              ? { state: 'unavailable', reason: '只读模式' }
              : { state: 'experimental' };
    }
    return {
      id: this.id,
      name: this.config.name,
      product: 'dsh',
      connected: this.connection.connected,
      version: this.config.version,
      profile: `dsh/web/${this.config.version}`,
      capabilities,
    };
  }
  status() {
    const writesEnabled = this.info().capabilities.send.state === 'experimental';
    return {
      connected: this.connection.connected,
      desktopVersion: this.config.version,
      supportedVersion: this.config.version === '0.2.1-rc.5',
      writesEnabled,
      reason: writesEnabled ? null : (this.info().capabilities.send.reason ?? null),
      capabilities: {
        send: writesEnabled,
        steer: writesEnabled,
        interrupt: writesEnabled,
        modelSettings: writesEnabled,
        questions: writesEnabled,
        approvals: writesEnabled,
        permissionRequests: false as const,
        openThread: writesEnabled,
        elicitationForms: false as const,
        newThread: writesEnabled,
        queue: writesEnabled,
      },
    };
  }
  private connected() {
    this.connection.stream(
      '$events',
      {},
      (frame) => this.event(frame),
      () => this.reconnectCarrier(),
    );
    this.connection.stream(
      'session/control',
      {},
      (frame) => {
        if (frame.type === 'baseline')
          for (const [id, baseline] of Object.entries(frame.value.projections) as [string, any][]) {
            const live = this.live.get(id);
            if (live) {
              this.seedProjections(live, baseline);
              this.publish(id);
            }
          }
        if (frame.type === 'projection') {
          const live = this.live.get(frame.sessionId);
          if (live && this.applyProjection(live, frame.key, frame.value, frame.seq))
            this.publish(frame.sessionId);
        }
      },
      () => this.reconnectCarrier(),
    );
    for (const [id, live] of this.live) if (live.refs) this.follow(id, live);
    this.emit('status');
  }
  private reconnectCarrier() {
    if (this.closed) return;
    this.connection.stop();
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => {
      if (!this.closed) void this.connection.start();
    }, 1000);
    this.reconnect.unref();
  }
  // DSH sequence numbers are local to one host connection, separate from mobile revisions.
  private applyProjection(live: Live, key: string, value: any, seq: number) {
    const previous = live.projectionSeq.get(key);
    if (seq <= (previous ?? live.projectionCut)) return false;
    live.projectionSeq.set(key, seq);
    live.projections[key] = value;
    return true;
  }
  private seedProjections(live: Live, baseline: { asOfSeq: number; values: Record<string, any> }) {
    for (const [key, value] of Object.entries(baseline.values)) {
      const previous = live.projectionSeq.get(key);
      if (
        (previous === undefined && baseline.asOfSeq >= live.projectionCut) ||
        (previous !== undefined && baseline.asOfSeq > previous)
      ) {
        live.projectionSeq.set(key, baseline.asOfSeq);
        live.projections[key] = value;
      }
    }
    for (const key of Object.keys(live.projections))
      if (!Object.hasOwn(baseline.values, key) && live.projectionSeq.get(key)! <= baseline.asOfSeq) {
        delete live.projections[key];
        live.projectionSeq.set(key, baseline.asOfSeq);
      }
    live.projectionCut = Math.max(live.projectionCut, baseline.asOfSeq);
  }
  private async list(cursor?: string, limit = 10000, project?: string, query = '') {
    const result = await this.connection.call<{ items: SessionSummary[] }>('session/list', { _request: {} });
    let workspaces: readonly WorkspaceView[] = [];
    try {
      workspaces = await this.workspaces();
    } catch {
      /* Optional native workspace service. */
    }
    const rows = result.items
      .map((item) => {
        const workspace = workspaces.find((w) => w.sessionIds.includes(item.sessionId));
        const summary: ThreadSummary = {
          id: item.sessionId,
          title: String(item.projections?.values.title ?? '新会话'),
          cwd: item.cwd ?? workspace?.path ?? '',
          updatedAt: item.updatedAt,
          projectId: workspace?.workspaceId ?? null,
          projectName: workspace?.title ?? null,
        };
        this.summaries.set(item.sessionId, summary);
        return summary;
      })
      .filter(
        (t) =>
          (!project || (project === 'none' ? !t.projectId : t.projectId === project)) &&
          (!query || t.title.toLowerCase().includes(query.toLowerCase())),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SelectionError('无效历史游标');
    return {
      threads: rows.slice(offset, offset + limit),
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    };
  }
  private workspaces(): Promise<readonly WorkspaceView[]> {
    // The native API exposes a replacement baseline through follow, not a list RPC.
    return new Promise((resolve, reject) => {
      let cancel: (() => void) | undefined,
        settled = false;
      const finish = (items?: readonly WorkspaceView[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connection.off('disconnected', disconnected);
        cancel?.();
        if (items) resolve(items);
        else reject(new DeliveryError('DSH 工作区目录暂不可用', true));
      };
      const disconnected = () => finish();
      const timer = setTimeout(disconnected, 10000);
      this.connection.once('disconnected', disconnected);
      try {
        cancel = this.connection.stream(
          'workspace/follow',
          {},
          (frame: WorkspaceFollowFrame) => {
            if (frame.type === 'baseline') finish(frame.value.items);
          },
          disconnected,
        );
        if (settled) cancel();
      } catch {
        finish();
      }
    });
  }
  async projects(_id: string) {
    return (await this.workspaces()).map((w) => ({ id: w.workspaceId, name: w.title, path: w.path }));
  }
  private initial(id: string): ThreadView {
    return {
      ...(this.summaries.get(id) ?? { id, title: 'DSH', cwd: '', updatedAt: 0 }),
      messages: [],
      revision: 0,
      owner: true,
      synchronized: false,
      activeTurnId: null,
      runtimeStatus: 'notLoaded',
      model: null,
      pendingRequests: 0,
      requests: [],
      canSend: false,
      canInterrupt: false,
      reason: '正在与 DSH 同步',
    };
  }
  async acquire(id: string) {
    let live = this.live.get(id);
    if (!live) {
      live = {
        refs: 0,
        view: this.initial(id),
        seq: -1,
        records: new Map(),
        projections: {},
        projectionSeq: new Map(),
        projectionCut: -1,
        followEpoch: 0,
        assistantRevision: -1,
        hasMore: false,
      };
      this.live.set(id, live);
    }
    live.refs++;
    if (!live.cancel && this.connection.connected) this.follow(id, live);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--live!.refs === 0) {
        clearTimeout(live!.recovery);
        for (const [key, event] of this.interactions)
          if (event.sessionId === id) {
            event.cancelWait?.();
            event.cancelWait = undefined;
            if (!event.replying && event.event !== 'userQuestions/answer') {
              this.settleEvent(event.nativeId);
              void this.connection
                .call('$events/result', {
                  clientId: event.clientId,
                  eventId: event.nativeId,
                  outcome: { kind: 'next' },
                })
                .catch(() => {});
            }
            if (!event.replying) this.interactions.delete(key);
          }
        live!.followEpoch++;
        live!.cancel?.();
        live!.cancel = undefined;
        live!.view.synchronized = false;
        this.live.delete(id);
      }
    };
  }
  private follow(id: string, live: Live) {
    clearTimeout(live.recovery);
    const epoch = ++live.followEpoch;
    live.cancel?.();
    live.view.synchronized = false;
    live.cancel = this.connection.stream(
      'session/follow',
      { request: { address: address(id), maxMessages: 100, assistantStream: true } },
      (frame) => {
        if (epoch !== live.followEpoch) return;
        try {
          this.frame(id, live, frame);
        } catch {
          live.view.synchronized = false;
          live.cancel?.();
          live.cancel = undefined;
          this.publish(id);
          this.recoverFollow(id, live);
        }
      },
      () => {
        if (epoch !== live.followEpoch) return;
        live.cancel = undefined;
        live.view.synchronized = false;
        this.publish(id);
        this.recoverFollow(id, live);
      },
    );
  }
  private recoverFollow(id: string, live: Live) {
    clearTimeout(live.recovery);
    if (!this.closed && live.refs) {
      live.recovery = setTimeout(() => {
        if (!this.closed && live.refs && this.connection.connected) this.follow(id, live);
      }, 1000);
      live.recovery.unref();
    }
  }
  private frame(id: string, live: Live, frame: SessionFollowFrame) {
    if (frame.type === 'snapshot') {
      if (frame.header.id !== id || frame.header.version !== 4) throw Error('Unsupported session format');
      live.records = new Map(frame.records.map((r) => [r.event.seq, r.event]));
      live.seq = frame.cursor;
      live.hasMore = frame.hasMore;
      this.seedProjections(live, frame.projections);
      live.view = { ...live.view, cwd: frame.header.cwd ?? live.view.cwd, synchronized: true };
      live.assistantRevision = frame.assistantStream?.revision ?? -1;
      const attempt = frame.assistantStream?.activeAttempt;
      live.attempt = attempt
        ? {
            id: attempt.attemptId,
            turn: attempt.turn,
            step: attempt.step,
            revision: frame.assistantStream!.revision,
            next: attempt.nextIndex,
            assembler: assembleAssistantStream(attempt.stream as any),
          }
        : undefined;
    } else if (frame.type === 'event') {
      if (frame.event.seq <= live.seq) return;
      if (frame.event.seq !== live.seq + 1) throw Error('History gap');
      live.records.set(frame.event.seq, frame.event);
      live.seq = frame.event.seq;
      const event = frame.event,
        data = event.data as any;
      if (
        live.attempt &&
        (live.attempt.committedSeq === event.seq ||
          (event.type === 'assistant/message' &&
            data.turn === live.attempt.turn &&
            data.step === live.attempt.step))
      )
        live.attempt = undefined;
      // Reopen a bounded native tail at a completed turn; older pages remain in DSH.
      if (event.type === 'turn/end' && live.records.size > 1000) {
        const epoch = live.followEpoch;
        queueMicrotask(() => {
          if (live.refs && live.followEpoch === epoch && this.connection.connected) this.follow(id, live);
        });
      }
    } else {
      const f = frame.frame;
      if (f.revision <= live.assistantRevision) return;
      live.assistantRevision = f.revision;
      if (f.type === 'start')
        live.attempt = {
          id: f.attemptId,
          turn: f.turn,
          step: f.step,
          revision: f.revision,
          next: 0,
          assembler: assembleAssistantStream([]),
        };
      else if (live.attempt?.id === f.attemptId) {
        if (f.revision <= live.attempt.revision) return;
        if (f.type === 'chunk') {
          if (f.index !== live.attempt.next) throw Error('Assistant stream gap');
          live.attempt.assembler.push(f.chunk as any);
          live.attempt.next++;
          live.attempt.revision = f.revision;
        } else if (f.outcome.kind === 'committed' && f.outcome.seq > live.seq)
          live.attempt.committedSeq = f.outcome.seq;
        else live.attempt = undefined;
      }
    }
    this.publish(id);
  }
  private render(events: SessionWireEvent[]) {
    const messages = new Map<number, Message>();
    const observations: OperationObservation[] = [];
    let turnId: string | null = null,
      requests: string[] = [];
    for (const e of events.sort((a, b) => a.seq - b.seq)) {
      const d = (e.data ?? {}) as any;
      if (typeof d.turn === 'number' && e.type !== 'turn/end') turnId = String(d.turn);
      if (e.type === 'turn/start') {
        turnId = String(d.turn);
        requests = [];
      }
      if (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result') {
        const m = e.type === 'user/message' ? d : d.message;
        if (!m) continue;
        if (m.source?.rpcId) {
          requests.push(m.source.rpcId);
          observations.push({
            requestIds: [m.source.rpcId],
            turnId: turnId ?? String(d.turn ?? e.seq),
            state: 'accepted',
          });
        }
        const op = e.surfaceOp as any;
        if (op?.op === 'replace')
          for (const seq of messages.keys()) if (seq >= op.startSeq && seq <= op.endSeq) messages.delete(seq);
        const context = m.role === 'user' && m.source?.kind && m.source.kind !== 'user';
        messages.set(e.seq, {
          id: m.id ?? `event-${e.seq}`,
          role: context ? 'tool' : m.role,
          text: context ? `DSH 上下文 · ${m.source.kind}` : text(m.content),
          turnId: turnId ?? undefined,
          clientMessageId: m.source?.rpcId,
          details: context
            ? text(m.content)
            : m.content
                ?.filter((b: any) => b.type === 'reasoning')
                .map((b: any) => b.text)
                .join('\n') || undefined,
          attachments: m.content
            ?.filter((b: any) => b.type === 'image' || b.type === 'file')
            .map((b: any) => ({
              name: b.attachment.name ?? '图片',
              path: `dsh-${b.type}:${b.attachment.attachmentId}`,
            })),
        });
      }
      if (e.type === 'command/run')
        messages.set(e.seq, {
          id: `command-${d.commandId}`,
          role: 'tool',
          text: `/${d.name}`,
          details: d.args ?? '',
          phase: 'running',
        });
      if (e.type === 'command/done') {
        const entry = [...messages.values()].find((m) => m.id === `command-${d.commandId}`);
        if (entry) {
          entry.phase = d.kind;
          entry.output = d.text ?? (d.kind === 'success' ? '已完成' : '执行失败');
        } else
          messages.set(e.seq, {
            id: `command-${d.commandId}`,
            role: 'tool',
            text: '原生命令',
            phase: d.kind,
            output: d.text,
          });
      }
      if (e.type === 'tool/call')
        messages.set(e.seq, {
          id: `tool-${d.callId}`,
          role: 'tool',
          text: d.name,
          details: d.arguments,
          turnId: String(d.turn),
        });
      if (e.type === 'turn/end') {
        observations.push({
          requestIds: [...requests],
          turnId: String(d.turn),
          state:
            d.reason.kind === 'completed'
              ? 'completed'
              : ['aborted', 'interrupted'].includes(d.reason.kind)
                ? 'interrupted'
                : 'failed',
        });
        turnId = null;
      }
    }
    return { messages: [...messages.values()], observations, turnId };
  }
  private publish(id: string) {
    const live = this.live.get(id);
    if (!live) return;
    const result = this.render([...live.records.values()]);
    const model = live.projections.modelSelection?.next;
    const queue = [
      ...(live.projections.inbox?.['next-turn'] ?? []),
      ...(live.projections.inbox?.['next-step'] ?? []),
    ];
    const continued =
      this.connection.connected && this.clientId ? (live.projections.userQuestions?.active ?? []) : [];
    const keys = new Set<string>();
    for (const question of continued) {
      if (question.state !== 'continued') continue;
      const key = `continued:${this.connection.generation}:${id}:${question.callId}`;
      keys.add(key);
      if (!this.interactions.has(key)) {
        const card: ConversationRequest = {
          id: key,
          fingerprint: digest([key, question.questions]),
          kind: 'async-question',
          title: 'DSH 后续问题',
          description: '原生等待已结束；回答将由 DSH 继续处理。',
          turnId: null,
          actionable: true,
          questions: question.questions.map((q: any) => ({
            id: q.id,
            header: q.header ?? '',
            question: q.question,
            detail: q.detail,
            multiSelect: q.multiSelect,
            intent: q.intent?.kind,
            options: (q.options ?? []).map((o: any) => ({
              label: o.label,
              description: o.description ?? '',
            })),
          })),
        };
        this.interactions.set(key, {
          generation: this.connection.generation,
          clientId: this.clientId,
          nativeId: question.callId,
          sessionId: id,
          event: 'userQuestions/answer',
          request: { questions: question.questions },
          card,
        });
      }
    }
    for (const [key, event] of this.interactions)
      if (event.sessionId === id && event.event === 'userQuestions/answer' && !keys.has(key))
        this.interactions.delete(key);
    const requests = [...this.interactions.values()].filter((r) => r.sessionId === id).map((r) => r.card);
    const messages = result.messages;
    if (live.attempt)
      messages.push({
        id: `stream-${live.attempt.id}`,
        role: 'assistant',
        text: text(live.attempt.assembler.blocks()),
        turnId: String(live.attempt.turn),
      });
    const writable = this.status().writesEnabled && live.view.synchronized;
    live.view = {
      ...live.view,
      title: live.projections.title ?? live.view.title,
      messages: messages.slice(-500).map(compactMessage),
      revision: ++this.revision,
      activeTurnId: result.turnId,
      runtimeStatus: result.turnId ? 'running' : 'idle',
      model: model ? JSON.stringify([model.provider, model.model]) : null,
      reasoningEffort: model?.reasoningEffort ?? 'default',
      controls: this.controlState(id),
      mode: live.projections.plan?.active ? 'plan' : 'default',
      pendingRequests: requests.length,
      requests,
      queuedMessages: queue.map((m: any) => ({ id: m.id, text: text(m.content), status: 'queued' })),
      queueFingerprint: digest(queue),
      canSend: writable && !result.turnId,
      canInterrupt: writable && !!result.turnId,
      reason: writable ? null : 'DSH 未同步或控制不可用',
    };
    this.emit('thread', live.view);
    this.emit('observations', id, result.observations);
  }
  view(id: string) {
    return this.live.get(id)?.view ?? null;
  }
  async waitForView(id: string, timeout = 10000) {
    if (this.view(id)?.synchronized) return this.view(id);
    return new Promise<ThreadView | null>((resolve) => {
      const done = (view: ThreadView) => {
        if (view.id === id && view.synchronized) {
          clearTimeout(timer);
          this.off('thread', done);
          resolve(view);
        }
      };
      const timer = setTimeout(() => {
        this.off('thread', done);
        resolve(this.view(id));
      }, timeout);
      this.on('thread', done);
    });
  }
  async openThread(_id: string) {
    /* Native prompt resumes cold DSH sessions; viewing never activates one. */
  }
  async page(id: string, cursor?: string) {
    const release = await this.acquire(id);
    try {
      await this.waitForView(id);
      const live = this.live.get(id)!;
      if (!live.view.synchronized) throw new DeliveryError('DSH 历史尚未同步', true);
      let events = [...live.records.values()],
        hasMore = live.hasMore,
        through = live.seq;
      if (cursor) {
        const cut = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (cut.id !== id || !Number.isInteger(cut.before)) throw Error('Invalid history cursor');
        through = cut.through;
        const page = await this.connection.call<SessionPage>('session/page', {
          request: { address: address(id), throughSeq: cut.through, beforeSeq: cut.before, maxMessages: 100 },
        });
        events = page.records.map((r) => r.event);
        hasMore = page.hasMore;
      }
      const messages = this.render(events).messages;
      const cached = this.historyMessages.get(id) ?? new Map<string, Message>();
      for (const message of messages) cached.set(message.id, message);
      while (cached.size > 500) cached.delete(cached.keys().next().value!);
      this.historyMessages.delete(id);
      this.historyMessages.set(id, cached);
      while (this.historyMessages.size > 32)
        this.historyMessages.delete(this.historyMessages.keys().next().value!);
      return {
        messages: messages.map(compactMessage),
        nextCursor:
          hasMore && events.length
            ? Buffer.from(
                JSON.stringify({ id, through, before: Math.min(...events.map((e) => e.seq)) }),
              ).toString('base64url')
            : null,
      };
    } finally {
      release();
    }
  }
  inlineMedia() {
    return null;
  }
  fullMessage(id: string, messageId: string) {
    const live = this.live.get(id);
    return (
      (live && this.render([...live.records.values()]).messages.find((m) => m.id === messageId)) ??
      this.historyMessages.get(id)?.get(messageId) ??
      null
    );
  }
  private controlState(id: string): ControlState {
    const p = this.live.get(id)?.projections ?? {};
    return {
      permission: p.permissions?.currentValue ?? null,
      preset: p.agentPreset ?? null,
      presetLocked: Array.isArray(p.turnOutline) && p.turnOutline.length > 0,
      plan: p.plan?.active ?? false,
    };
  }
  async controls(id: string): Promise<ControlCatalog> {
    const [permissions, presets, commands] = await Promise.all([
      this.connection.call('permissionPresets/catalog', {}),
      this.connection.call('agentPresets/list', {}),
      id === 'new' ? Promise.resolve([]) : this.connection.call('commands/list', { agentId: id }),
    ]);
    const p = this.live.get(id)?.projections ?? {};
    const actions: ControlAction['action'][] = [];
    if (id === 'new' || p.permissions) actions.push('permission');
    if (id === 'new' || 'agentPreset' in p) actions.push('preset');
    for (const action of ['plan', 'compact', 'feedback', 'goal'] as const)
      if (commands.some((c: any) => c.name === action)) actions.push(action);
    const goal = actions.includes('goal') ? await this.connection.call('goals/get', { agentId: id }) : null;
    return {
      product: 'dsh',
      permissions: permissions.options.map((p: any) => ({
        id: p.value,
        name: p.name,
        description: p.description,
      })),
      presets: presets.presets
        .filter((p: any) => !p.broken)
        .map((p: any) => ({ id: p.id, name: p.name ?? p.id, description: p.description })),
      actions,
      state:
        id === 'new'
          ? {
              permission: permissions.defaultPreset,
              preset: presets.presets.find((p: any) => p.isDefault)?.id ?? null,
              plan: false,
            }
          : this.controlState(id),
      goal: goal
        ? {
            ref: { id: goal.id, revision: goal.revision },
            objective: goal.objective,
            phase: goal.phase,
            activation: goal.activation,
          }
        : null,
    };
  }
  private async nativeCommand(id: string, line: string) {
    const result = await this.connection.call(
      'commands/execute',
      { agentId: id, line, submittedAttachments: [] },
      true,
    );
    if (!result) throw new DeliveryError('原生命令未返回结果');
    // Record the upstream identity before confirming the gateway operation.
    await mkdir(join(this.directory, 'commands'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.directory, 'commands', digest([id, result.commandId]) + '.json'),
      JSON.stringify({ sessionId: id, ...result }),
      { mode: 0o600 },
    );
    if (result.result.kind === 'error')
      throw new DeliveryError(result.result.text ?? '原生命令执行失败', false, 'failed');
    return result.commandId as string;
  }
  private async applyControl(id: string, control: ControlAction): Promise<string | null> {
    if (!this.status().writesEnabled) throw new DeliveryError('实例未连接或只读', true);
    const catalog = await this.controls(id);
    if (!catalog.actions.includes(control.action)) throw new DeliveryError('此会话未提供该操作', true);
    if (control.action === 'permission') {
      if (catalog.state.permission !== control.expected)
        throw new DeliveryError('原生权限已变化，请重新选择', true);
      if (!catalog.permissions.some((p) => p.id === control.value) || !/^[\w:-]+$/.test(control.value))
        throw new DeliveryError('权限选项不可用', true);
      await this.nativeCommand(id, '/permission ' + control.value);
      await this.confirmControl(id, () => this.controlState(id).permission === control.value);
    } else if (control.action === 'preset') {
      if (catalog.state.presetLocked || !catalog.presets.some((p) => p.id === control.value))
        throw new DeliveryError('Agent 预设已锁定或不可用', true);
      await this.connection.call('agentPresets/select', { agentId: id, agentPreset: control.value }, true);
      await this.confirmControl(id, () => this.controlState(id).preset === control.value);
    } else if (control.action === 'plan') {
      await this.nativeCommand(id, control.enabled ? '/plan' : '/plan off');
      await this.confirmControl(id, () => this.controlState(id).plan === control.enabled);
    } else if (control.action === 'compact') return this.nativeCommand(id, '/compact');
    else if (control.action === 'feedback') {
      const result = await this.connection.call(
        'sessionFeedback/record',
        { request: { sessionId: id, text: control.text } },
        true,
      );
      if (!result.ok) throw new DeliveryError('反馈未保存');
    } else if (control.action === 'goal') {
      const { operation, ref, objective } = control;
      if ((operation !== 'create' && !ref) || (['create', 'edit'].includes(operation) && !objective))
        throw new DeliveryError('目标信息不完整', true);
      await this.connection.call(
        'goals/' + operation,
        {
          agentId: id,
          ...(operation === 'create' ? {} : { ref }),
          ...(['create', 'edit'].includes(operation) ? { request: { objective } } : {}),
        },
        true,
      );
    }
    return null;
  }
  private async confirmControl(id: string, matches: () => boolean) {
    if (matches()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('thread', listener);
        resolve();
      };
      const listener = () => {
        if (matches()) done();
      };
      const timer = setTimeout(done, 8000);
      this.on('thread', listener);
    });
    if (!this.view(id)?.synchronized || !matches()) throw new DeliveryError('原生设置尚未确认');
  }
  async fileReferences(id: string, query: string) {
    const rows = await this.connection.call('fileReferences/list', { agentId: id, query });
    return rows.map((r: any) => ({ path: r.path, name: r.name ?? r.path }));
  }
  private exports = new Map<string, Promise<string>>();
  exportLog(id: string): Promise<string> {
    const existing = this.exports.get(id);
    if (existing) return existing;
    const task = this.downloadExport(id).finally(() => this.exports.delete(id));
    this.exports.set(id, task);
    return task;
  }
  private async downloadExport(id: string) {
    const response = await this.connection.fetch(
      'api/session.export?sessionId=' + encodeURIComponent(id) + '&includeDescendants=true',
    );
    if (!response.ok || !response.body) throw new DeliveryError('原生日志暂不可导出', true);
    const directory = join(this.directory, 'exports');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, randomUUID() + '.zip');
    const handle = await open(file, 'wx', 0o600);
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 256 * 1024 * 1024) {
          await reader.cancel();
          throw Error('日志超过 256 MB 导出限制');
        }
        await handle.writeFile(chunk);
      }
    } catch (e) {
      await handle.close();
      await unlink(file).catch(() => {});
      throw e;
    }
    await handle.close();
    return file;
  }
  async models() {
    const catalog = await this.connection.call<DshModels>('session/modelCatalog', {});
    return {
      source: 'dsh-native',
      fetchedAt: null,
      models: catalog.groups.flatMap((g) =>
        g.models.map((m) => ({
          id: JSON.stringify([g.id, m.id]),
          name: `${g.name} / ${m.name}`,
          efforts: m.reasoning?.efforts.length ? m.reasoning.efforts.map((e) => e.id) : ['default'],
          defaultEffort: m.reasoning?.defaultEffort ?? 'default',
          speeds: [],
        })),
      ),
    };
  }
  async skills(id: string) {
    const result = await this.connection.call('skills/list', { request: { sessionId: id } });
    return result.skills.map((s: any) => ({
      id: s.name,
      name: s.name,
      description: s.description,
      source: s.path ?? 'DSH',
    }));
  }
  async plugins() {
    return [];
  }
  async validateSelection(id: string, skills: string[], plugins: string[]) {
    if (plugins.length) throw new SelectionError('DSH 不支持 Codex 插件');
    const available = skills.length ? await this.skills(id) : [];
    if (skills.some((s) => !available.some((a: any) => a.id === s)))
      throw new SelectionError('技能已失效，请重新选择');
  }
  async validateSettings(value: { model: string; effort: string; serviceTier?: string }) {
    const m = (await this.models()).models.find((m) => m.id === value.model);
    if (!m || !m.efforts.includes(value.effort) || (value.serviceTier && value.serviceTier !== 'default'))
      throw new SelectionError('模型设置不在 DSH 原生目录中');
  }
  async validateCreation(value: { model?: string; thinking?: string }) {
    if (value.model) {
      const m = (await this.models()).models.find((m) => m.id === value.model);
      if (!m || (value.thinking && !m.efforts.includes(value.thinking)))
        throw new SelectionError('模型设置不在 DSH 原生目录中');
    }
  }
  private async content(id: string, value: any) {
    const content: any[] = [];
    const prompt = [...(value.skillIds ?? []).map((name: string) => `/${name}`), value.text ?? '']
      .filter(Boolean)
      .join('\n');
    if (prompt) content.push({ type: 'text', text: prompt });
    let imageCount = 0,
      imageBytes = 0;
    for (const attachment of value.attachments ?? []) {
      const bytes = await readFile(attachment.path);
      const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216
          ? 'image/jpeg'
          : bytes.subarray(0, 6).toString().startsWith('GIF8')
            ? 'image/gif'
            : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
              ? 'image/webp'
              : null;
      if (mime) {
        const limits = this.live.get(id)?.projections.imageLimits;
        imageCount++;
        imageBytes += bytes.length;
        if (
          limits &&
          (bytes.length > limits.maxImageBytes ||
            imageCount > limits.maxImagesPerMessage ||
            imageBytes > limits.maxMessageImageBytes)
        )
          throw new DeliveryError('图片超过 DSH 原生限制', true);
        content.push({
          type: 'image',
          mediaType: mime,
          data: bytes.toString('base64'),
          name: attachment.name,
        });
        continue;
      }
      const key = digest([id, attachment.path]),
        cached = this.receipts.get(key);
      let receiptId = cached?.generation === this.connection.generation ? cached.receiptId : undefined;
      if (!receiptId) {
        if (bytes.length > this.maxUploadBytes) throw new DeliveryError('附件超过大小限制', true);
        const response = await this.connection.fetch(
          `api/session/uploadFileBinary?${new URLSearchParams({ sessionId: id, name: attachment.name })}`,
          { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes },
        );
        const result = (await response.json()) as any;
        if (!response.ok || !result.ok || typeof result.value?.receiptId !== 'string')
          throw new DeliveryError('DSH 拒绝附件，请检查原生文件限制', true);
        receiptId = result.value.receiptId;
        await mkdir(join(this.directory, 'receipts'), { recursive: true, mode: 0o700 });
        await writeFile(
          join(this.directory, 'receipts', digest([id, result.value.file.attachmentId]) + '.json'),
          JSON.stringify({ path: attachment.path }),
          { mode: 0o600 },
        );
        this.receipts.set(key, { generation: this.connection.generation, receiptId: receiptId! });
      }
      content.push({ type: 'file', receiptId });
    }
    return content;
  }
  execute(id: string, command: BackendCommand, requestId: string) {
    const { kind, ...value } = command;
    return this.control(
      id,
      kind,
      command.kind === 'open'
        ? ''
        : command.kind === 'interrupt'
          ? command.expectedTurnId
          : JSON.stringify(command.kind === 'respond' ? command.response : value),
      requestId,
    );
  }
  async control(
    id: string,
    kind: Operation['kind'],
    input: string,
    requestId: string,
  ): Promise<string | null> {
    if (!this.status().writesEnabled) throw new DeliveryError('DSH 控制当前不可用', true);
    const value =
      kind === 'interrupt' || kind === 'open'
        ? {}
        : JSON.parse(input.startsWith('\u001e') ? input.slice(1) : input || '{}');
    const view = this.view(id);
    if (kind === 'control') return this.applyControl(id, value.control);
    if (kind === 'create') {
      const created = await this.connection.call(
        'session/create',
        {
          request: {
            sessionId: requestId,
            ...(value.projectId ? { workspaceId: value.projectId } : {}),
            ...(value.agentPreset ? { agentPreset: value.agentPreset } : {}),
          },
        },
        true,
      );
      this.summaries.set(created.sessionId, {
        id: created.sessionId,
        title: value.title ?? '新会话',
        cwd: '',
        updatedAt: Date.now(),
      });
      this.emit('created', requestId, created.sessionId);
      // A lost create response is uncertain. Operations never retries this sequence automatically.
      const release =
        value.permission || value.plan !== undefined ? await this.acquire(created.sessionId) : undefined;
      try {
        if (release && !(await this.waitForView(created.sessionId))?.synchronized)
          throw new DeliveryError('新会话尚未同步，首条消息未发送');
        if (value.permission)
          await this.applyControl(created.sessionId, {
            action: 'permission',
            value: value.permission,
            expected: this.controlState(created.sessionId).permission,
          });
        if (value.plan !== undefined && value.plan !== this.controlState(created.sessionId).plan)
          await this.applyControl(created.sessionId, { action: 'plan', enabled: value.plan });
        if (value.model) {
          const [provider, model] = JSON.parse(value.model);
          await this.connection.call(
            'session/selectModel',
            {
              request: {
                sessionId: created.sessionId,
                provider,
                model,
                ...(value.thinking && value.thinking !== 'default'
                  ? { reasoningEffort: value.thinking }
                  : {}),
              },
            },
            true,
          );
        }
        if (value.title)
          await this.connection.call(
            'session/rename',
            { request: { sessionId: created.sessionId, title: value.title } },
            true,
          );
        await this.connection.call(
          'session/prompt',
          {
            request: {
              sessionId: created.sessionId,
              requestId,
              mode: 'queue',
              content: [{ type: 'text', text: value.prompt }],
            },
          },
          true,
        );
        return created.sessionId;
      } finally {
        release?.();
      }
    }
    if (!view?.synchronized) throw new DeliveryError('DSH 会话尚未同步', true);
    if (kind === 'open') return null;
    if (kind === 'interrupt' || kind === 'steer')
      if (view.activeTurnId !== (kind === 'interrupt' ? input : value.expectedTurnId))
        throw new DeliveryError('当前回合已变化，请刷新', true);
    if (kind === 'queue' || kind === 'queue-remove')
      if (view.queueFingerprint !== value.expectedQueueFingerprint)
        throw new DeliveryError('队列已变化，请刷新', true);
    if (kind === 'interrupt') {
      await this.connection.call('session/cancel', { request: { sessionId: id } }, true);
      return view.activeTurnId;
    }
    if (kind === 'respond') {
      await this.respond(id, value);
      return view.activeTurnId;
    }
    if (kind === 'settings') {
      if (value.expectedModel !== view.model || value.expectedEffort !== (view.reasoningEffort ?? null))
        throw new DeliveryError('原生设置已变化，请刷新', true);
      if (value.mode && value.mode !== (view.mode ?? 'default'))
        throw new DeliveryError('计划模式已变化，请通过会话控制面板调整', true);
      const [provider, model] = JSON.parse(value.model);
      await this.connection.call(
        'session/selectModel',
        {
          request: {
            sessionId: id,
            provider,
            model,
            ...(value.effort !== 'default' ? { reasoningEffort: value.effort } : {}),
          },
        },
        true,
      );
      return null;
    }
    if (kind === 'queue-remove') {
      await this.connection.call(
        'session/updateQueue',
        { request: { sessionId: id, itemId: value.messageId, action: { kind: 'remove' } } },
        true,
      );
      return null;
    }
    if (kind === 'send' && view.activeTurnId)
      throw new DeliveryError('已有回合正在运行，请使用排队或追加', true);
    const content = await this.content(id, value);
    await this.connection.call(
      'session/prompt',
      { request: { sessionId: id, requestId, mode: kind === 'steer' ? 'steer' : 'queue', content } },
      true,
    );
    return kind === 'steer' ? view.activeTurnId : null;
  }
  private event(frame: any) {
    if (frame.type === 'ready') {
      this.clientId = frame.clientId;
      for (const id of this.live.keys()) this.publish(id);
      return;
    }
    if (frame.type === 'cancel') {
      this.settleEvent(frame.eventId);
      for (const [id, event] of this.interactions)
        if (event.nativeId === frame.eventId) {
          this.interactions.delete(id);
          event.cancelWait?.();
          this.publish(event.sessionId);
        }
      return;
    }
    if (frame.type !== 'waterfall') return;
    const request = frame.request,
      sessionId = frame.agentId,
      generation = this.connection.generation;
    if (!this.clientId) return;
    const id = `${generation}:${this.clientId}:${frame.eventId}`;
    if (this.settledEvents.has(frame.eventId) || this.interactions.has(id)) return;
    // Only claim interactions for an actively observed conversation with enabled control.
    if (
      !['approval/request', 'user-questions/request'].includes(frame.event) ||
      !this.live.get(sessionId)?.refs ||
      !this.status().writesEnabled
    ) {
      this.settleEvent(frame.eventId);
      void this.connection
        .call('$events/result', {
          clientId: this.clientId,
          eventId: frame.eventId,
          outcome: { kind: 'next' },
        })
        .catch(() => {});
      return;
    }
    const turnId = this.view(sessionId)?.activeTurnId ?? null;
    const card: ConversationRequest = {
      id,
      fingerprint: digest([generation, this.clientId, frame.eventId, request]),
      kind: frame.event === 'approval/request' ? 'command' : 'question',
      title: request.toolName ?? 'DSH 提问',
      description: request.displayReason?.zh ?? request.reason ?? '',
      turnId,
      actionable: true,
      ...(frame.event === 'approval/request'
        ? { decisions: ['accept', 'decline', 'cancel'] as const }
        : {
            questions: request.questions.map((q: any) => ({
              id: q.id,
              header: q.header ?? '',
              question: q.question,
              detail: q.detail,
              multiSelect: q.multiSelect,
              intent: q.intent?.kind,
              options: (q.options ?? []).map((o: any) => ({
                label: o.label,
                description: o.description ?? '',
              })),
            })),
          }),
    } as ConversationRequest;
    const interaction: Interaction = {
      generation,
      clientId: this.clientId,
      nativeId: frame.eventId,
      sessionId,
      event: frame.event,
      request,
      card,
    };
    this.interactions.set(id, interaction);
    if (request.wait?.timed)
      interaction.cancelWait = this.connection.stream(
        'userQuestions/attachWait',
        { agentId: sessionId, callId: request.wait.callId },
        () => {},
        () => {
          interaction.cancelWait = undefined;
        },
      );
    this.publish(sessionId);
  }
  private settleEvent(id: string) {
    this.settledEvents.add(id);
    if (this.settledEvents.size > 4096) this.settledEvents.delete(this.settledEvents.values().next().value!);
  }
  private async respond(id: string, response: RequestResponse) {
    const event = this.interactions.get(response.targetRequestId);
    if (
      !event ||
      event.replying ||
      event.sessionId !== id ||
      event.generation !== this.connection.generation ||
      event.clientId !== this.clientId ||
      response.expectedFingerprint !== event.card.fingerprint ||
      response.expectedTurnId !== event.card.turnId
    )
      throw new DeliveryError('请求已回答、取消或连接已更换', true);
    let value: unknown;
    if (event.event === 'approval/request') {
      if (!['accept', 'decline', 'cancel'].includes(response.decision ?? ''))
        throw new DeliveryError('不支持此审批选项', true);
      value =
        response.decision === 'accept'
          ? 'allowed-once'
          : response.decision === 'decline'
            ? 'rejected'
            : 'cancelled';
    } else {
      if (!response.answers || event.request.questions.some((q: any) => !response.answers?.[q.id]?.length))
        throw new DeliveryError('请完整回答所有问题', true);
      value = {
        answers: event.request.questions.map((q: any) => {
          const answer = response.answers![q.id],
            labels = (q.options ?? []).map((o: any) => o.label);
          return {
            id: q.id,
            selected: answer.filter((a: string) => labels.includes(a)),
            custom: answer.filter((a: string) => !labels.includes(a)).join('\n'),
          };
        }),
      };
    }
    event.replying = true;
    try {
      if (event.event === 'userQuestions/answer') {
        const accepted = await this.connection.call(
          'userQuestions/answer',
          { agentId: id, callId: event.nativeId, answer: value },
          true,
        );
        if (!accepted) throw new DeliveryError('原生问题已回答或取消', true);
      } else
        await this.connection.call(
          '$events/result',
          { clientId: event.clientId, eventId: event.nativeId, outcome: { kind: 'result', value } },
          true,
        );
    } finally {
      const current = event.generation === this.connection.generation && event.clientId === this.clientId;
      if (current && event.event !== 'userQuestions/answer') this.settleEvent(event.nativeId);
      if (current && event.event === 'userQuestions/answer') {
        const q = this.live.get(id)?.projections.userQuestions;
        if (q) q.active = q.active.filter((q: any) => q.callId !== event.nativeId);
      }
      event.cancelWait?.();
      this.interactions.delete(response.targetRequestId);
      this.publish(id);
    }
  }
  async attachment(id: string, reference: string) {
    const messages = [
      ...(this.view(id)?.messages ?? []),
      ...(await this.page(id)).messages,
      ...(this.historyMessages.get(id)?.values() ?? []),
    ];
    const attached = messages.some((m) => m.attachments?.some((a) => a.path === reference));
    if (reference.startsWith('dsh-file:')) {
      if (!attached) throw Error('Attachment not in this session');
      const receipt = JSON.parse(
        await readFile(join(this.directory, 'receipts', digest([id, reference.slice(9)]) + '.json'), 'utf8'),
      );
      return receipt.path;
    }
    if (!reference.startsWith('dsh-image:')) {
      const summary = await this.history.get(id);
      if (!summary) throw Error('Unknown session');
      const paths = /^[a-z]:[\\/]/i.test(summary.cwd) ? win32 : posix;
      const resolve = (value: string) => {
        if (!value || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)))
          throw Error('Unsupported remote path');
        return paths.resolve(summary.cwd, decodeURIComponent(value));
      };
      const requested = resolve(reference);
      if (
        !messages.some(
          (m) =>
            m.role === 'assistant' &&
            attachmentLinks(m.text).some((link) => {
              try {
                return resolve(link) === requested;
              } catch {
                return false;
              }
            }),
        )
      )
        throw Error('File not referenced by this conversation');
      const response = await this.connection.fetch(`api/file?${new URLSearchParams({ path: requested })}`);
      if (!response.ok) throw Error('Native file access rejected');
      const reader = response.body?.getReader();
      if (!reader) throw Error('Native file body missing');
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > this.maxUploadBytes) throw Error('Native file too large');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(chunks);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, randomUUID() + '-' + paths.basename(requested));
      await writeFile(file, bytes, { mode: 0o600 });
      return file;
    }
    if (!attached) throw Error('Attachment not in this session');
    const value = await this.connection.call('session/attachment', {
      request: { sessionId: id, attachmentId: reference.slice(10) },
    });
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length !== value.attachment.bytes || bytes.length > this.maxUploadBytes)
      throw Error('Invalid native attachment');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(
      this.directory,
      `${randomUUID()}.${String(value.attachment.mediaType).split('/')[1] ?? 'bin'}`,
    );
    await writeFile(file, bytes, { mode: 0o600 });
    return file;
  }
}

function compactMessage(message: Message): Message {
  if (message.text.length <= 100000 && (message.details?.length ?? 0) <= 100000) return message;
  return {
    ...message,
    text: message.text.slice(0, 100000),
    details: message.details?.slice(0, 100000),
    truncated: true,
  };
}
