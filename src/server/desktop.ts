import { connectorFor, codexProfile } from './connectors/codex-local.js';
import { codexObservations } from './backends/codex-observations.js';
import { nativeUserInput } from './user-content.js';
import { SkillCatalog } from './skills.js';
import { PluginCatalog } from './plugins.js';
import { SelectionError } from './selection-error.js';
import { asyncReply } from './async-questions.js';
import { DesktopAppTools } from './app-tools.js';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { applyPatches, enablePatches, type Patch } from 'immer';
import { z } from 'zod';
import type { Config } from './config.js';
import { DesktopTransport, type RpcTransport, DeliveryError } from './transport.js';
import { normalizedView, turnsOf, orderedEntities, messagesOf } from './timeline.js';
import { itemMedia, mediaReference } from './content-media.js';
import { readNativeQueue, queueFingerprint, queuedMessage } from './queue.js';
import { approvalResponse, requestFingerprint, normalizeRequest } from './approvals.js';
import type { GatewayStatus, ThreadView, Operation } from '../shared/types.js';
import type { DesktopBackend } from './desktop-backend.js';
import { platformRuntime } from './platform.js';

enablePatches();
export const SUPPORTED_VERSION = '26.1029.61003';
const patchSchema = z.object({
  op: z.enum(['add', 'remove', 'replace']),
  path: z.array(z.union([z.string(), z.number()])),
  value: z.unknown().optional(),
});
const changeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    revision: z.number().int().nonnegative(),
    conversationState: z.record(z.string(), z.any()),
  }),
  z.object({
    type: z.literal('patches'),
    baseRevision: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    patches: z.array(patchSchema),
    acceptedTextChanges: z.unknown().optional(),
  }),
]);
interface Subscription {
  refs: number;
  owner: string | null;
  state: any;
  revision: number;
  synced: boolean;
  reason: string | null;
  discovering?: Promise<void>;
  queue?: any[];
}
export class DesktopAdapter extends EventEmitter implements DesktopBackend {
  get capabilities() {
    return {
      platform: (this.config.platform ?? platformRuntime()).id,
      protocolVerified: this.status().supportedVersion,
      files: true,
      controls: this.status().writesEnabled,
      creation: this.status().writesEnabled,
    };
  }
  private transport: RpcTransport | null = null;
  private appTools: DesktopAppTools;
  private skillCatalog: SkillCatalog;
  private pluginCatalog: PluginCatalog;
  private subscriptions = new Map<string, Subscription>();
  private stopped = true;
  private reconnect?: NodeJS.Timeout;
  private attempt = 0;
  private version: string | null = null;
  private ready = false;
  private lastError: string | null = '尚未连接桌面';
  constructor(
    private config: Config,
    private factory: () => RpcTransport = () => new DesktopTransport(config),
  ) {
    super();
    this.appTools = new DesktopAppTools(config);
    this.skillCatalog = new SkillCatalog(config.codexHome);
    this.pluginCatalog = new PluginCatalog(config.codexHome);
  }
  status(): GatewayStatus {
    const profile = codexProfile((this.config.platform ?? platformRuntime()).id, this.version);
    const supportedVersion = profile.verified;
    const writesEnabled = this.ready && profile.controls && !this.config.readOnly;
    return {
      connected: this.ready,
      desktopVersion: this.version,
      supportedVersion,
      writesEnabled,
      reason: this.lastError ?? (this.config.readOnly ? '只读模式' : null),
      capabilities: {
        send: writesEnabled,
        steer: writesEnabled,
        interrupt: writesEnabled,
        modelSettings: writesEnabled,
        questions: writesEnabled,
        approvals: writesEnabled,
        permissionRequests: writesEnabled ? 'experimental' : false,
        openThread: writesEnabled && profile.nativeOpen,
        elicitationForms: writesEnabled ? 'experimental' : false,
        newThread: writesEnabled && this.appTools.available,
        queue: writesEnabled,
      },
    };
  }
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }
  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      this.version = await connectorFor(this.config)
        .version(this.config.desktopRoot)
        .catch(() => null);
      const transport = this.factory();
      this.transport = transport;
      transport.on('broadcast', (message) => this.receive(message));
      transport.on('disconnect', (reason: string) => {
        if (this.transport !== transport) return;
        this.ready = false;
        this.lastError = reason;
        for (const [id, sub] of this.subscriptions) {
          sub.owner = null;
          sub.synced = false;
          sub.reason = '桌面已断开';
          this.emitView(id);
        }
        this.emit('status', this.status());
        this.scheduleReconnect();
      });
      await transport.connect();
      if (this.stopped) {
        transport.close();
        return;
      }
      this.ready = true;
      await this.appTools.probe().catch(() => {});
      this.lastError = null;
      this.attempt = 0;
      this.emit('status', this.status());
      await Promise.allSettled([...this.subscriptions.keys()].map((id) => this.discover(id)));
    } catch (error) {
      this.ready = false;
      this.lastError = error instanceof Error ? error.message : '连接失败';
      this.emit('status', this.status());
      this.scheduleReconnect();
    }
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.connect();
    }, delay);
    this.reconnect.unref();
  }
  async acquire(id: string): Promise<() => void> {
    let sub = this.subscriptions.get(id);
    if (!sub) {
      sub = { refs: 0, owner: null, state: null, revision: -1, synced: false, reason: '正在查找桌面会话' };
      this.subscriptions.set(id, sub);
    }
    sub.refs++;
    if (!sub.queue) sub.queue = await readNativeQueue(this.config.codexHome, id).catch(() => undefined);
    await this.discover(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.subscriptions.get(id);
      if (!current || --current.refs > 0) return;
      if (current.owner && this.ready) this.follow(id, current, false);
      this.subscriptions.delete(id);
    };
  }
  private async discover(id: string): Promise<void> {
    const sub = this.subscriptions.get(id);
    if (!sub || !this.ready || !this.transport) return;
    if (sub.discovering) return sub.discovering;
    if (sub.owner && sub.synced) return;
    const transport = this.transport;
    sub.discovering = (async () => {
      try {
        const response = await transport.request(
          'thread-owner-discovery',
          { hostId: 'local', conversationId: id },
          1,
        );
        if (this.transport !== transport || this.subscriptions.get(id) !== sub) return;
        if (typeof response.handledByClientId !== 'string') throw new Error('Invalid owner discovery');
        sub.owner = response.handledByClientId;
        sub.synced = false;
        sub.reason = '正在同步桌面状态';
        sub.revision = -1;
        this.follow(id, sub, true);
      } catch {
        if (this.transport !== transport || this.subscriptions.get(id) !== sub) return;
        sub.owner = null;
        sub.synced = false;
        sub.reason = '请先在桌面打开此会话';
        this.emitView(id);
      }
    })().finally(() => {
      sub.discovering = undefined;
    });
    return sub.discovering;
  }
  private follow(id: string, sub: Subscription, following: boolean): void {
    if (!sub.owner) return;
    try {
      this.transport?.broadcast(
        'thread-stream-following-changed',
        { hostId: 'local', conversationId: id, following },
        1,
        sub.owner,
      );
    } catch {
      sub.synced = false;
      sub.reason = '订阅连接已断开';
    }
  }
  private receive(message: any): void {
    if (message.method === 'client-status-changed') {
      for (const [id, sub] of this.subscriptions) {
        if (message.params?.status === 'disconnected' && message.params?.clientId === sub.owner) {
          sub.owner = null;
          sub.synced = false;
          sub.reason = '桌面会话拥有者已离线';
          this.emitView(id);
        } else if (message.params?.status === 'connected' && !sub.owner) void this.discover(id);
      }
      return;
    }
    const p = message.params;
    if (!p || p.hostId !== 'local' || typeof p.conversationId !== 'string') return;
    const sub = this.subscriptions.get(p.conversationId);
    if (!sub || sub.owner !== message.sourceClientId) return;
    if (message.method === 'thread-stream-following-status-requested') {
      this.follow(p.conversationId, sub, true);
      return;
    }
    if (
      message.method === 'thread-queued-followups-changed' &&
      message.version === 2 &&
      Array.isArray(p.messages)
    ) {
      sub.queue = p.messages;
      this.emitView(p.conversationId);
      return;
    }
    if (message.method !== 'thread-stream-state-changed') return;
    if (message.version !== 11) {
      sub.synced = false;
      sub.reason = '桌面事件协议版本不兼容';
      this.emitView(p.conversationId);
      return;
    }
    const parsed = changeSchema.safeParse(p.change);
    if (!parsed.success) {
      sub.synced = false;
      sub.reason = '桌面事件格式不兼容';
      this.emitView(p.conversationId);
      return;
    }
    const c = parsed.data;
    if (c.type === 'snapshot') {
      if (
        c.conversationState.id !== p.conversationId ||
        (c.conversationState.hostId && c.conversationState.hostId !== 'local')
      )
        return;
      if (sub.synced && c.revision < sub.revision) return;
      sub.state = c.conversationState;
      sub.revision = c.revision;
      sub.synced = true;
      sub.reason = null;
    } else {
      if (c.revision <= sub.revision) return;
      if (!sub.synced) return;
      if (c.baseRevision !== sub.revision || c.revision <= c.baseRevision) {
        sub.synced = false;
        sub.reason = '正在恢复遗漏的状态';
        this.follow(p.conversationId, sub, true);
      } else {
        try {
          if (
            c.patches.some((p) =>
              p.path.some((k) => ['__proto__', 'constructor', 'prototype'].includes(String(k))),
            )
          )
            throw new Error('Unsafe patch');
          sub.state = applyPatches(sub.state, c.patches as Patch[]);
          sub.revision = c.revision;
        } catch {
          sub.synced = false;
          sub.reason = '正在重新同步桌面状态';
          this.follow(p.conversationId, sub, true);
        }
      }
    }
    this.emitView(p.conversationId);
  }
  view(id: string): ThreadView | null {
    const sub = this.subscriptions.get(id);
    if (!sub?.state) return null;
    const view = normalizedView(
      sub.state,
      sub.revision,
      this.status().writesEnabled && sub.synced && !!sub.owner,
    );
    return {
      ...view,
      queuedMessages: sub.queue?.map((m) => ({
        id: m.id,
        text: m.text ?? m.context?.prompt ?? '',
        status: m.submission?.status ?? 'queued',
        reason: m.pausedReason,
      })),
      queueFingerprint: sub.queue ? queueFingerprint(sub.queue) : undefined,
      owner: !!sub.owner,
      synchronized: sub.synced,
      reason: sub.reason ?? view.reason,
    };
  }
  observation(id: string): { owner: boolean; reason: string | null } {
    const sub = this.subscriptions.get(id);
    return { owner: !!sub?.owner, reason: sub?.reason ?? this.status().reason ?? '请先在桌面打开此会话' };
  }
  private emitView(id: string): void {
    const view = this.view(id);
    if (view) this.emit('thread', view);
    if (this.subscriptions.get(id)?.synced) {
      this.emit('state', id, this.subscriptions.get(id)!.state);
      this.emit('observations', id, codexObservations(this.subscriptions.get(id)!.state));
    }
  }
  async waitForView(id: string, timeout = 3000): Promise<ThreadView | null> {
    const current = this.view(id);
    if (current?.synchronized) return current;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('thread', listener);
        resolve(this.view(id));
      };
      const listener = (view: ThreadView) => {
        if (view.id === id && view.synchronized) done();
      };
      const timer = setTimeout(done, timeout);
      this.on('thread', listener);
    });
  }
  async projects(id: string) {
    if (!this.status().writesEnabled) throw new DeliveryError('桌面不可用', true);
    return this.appTools.projects(id);
  }
  disabledPlugins(id: string): string[] {
    return this.subscriptions.get(id)?.state?.latestThreadSettings?.disabledPluginIds ?? [];
  }
  async openThread(id: string): Promise<void> {
    if (!this.status().writesEnabled || !z.string().uuid().safeParse(id).success)
      throw new DeliveryError('桌面未连接或版本不兼容', true);
    const sub = this.subscriptions.get(id);
    if (!sub) throw new DeliveryError('尚未订阅此会话', true);
    const ready = () => {
      const view = this.view(id);
      return !!view?.owner && view.synchronized && view.runtimeStatus !== 'notLoaded';
    };
    if (ready()) return;
    try {
      await connectorFor(this.config).openThread(id);
    } catch {
      throw new DeliveryError('本机桌面链接处理程序不可用', true);
    }
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await this.discover(id);
      await this.waitForView(id, 800);
      if (ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new DeliveryError('已请求桌面打开，但尚未取得会话状态');
  }
  async control(
    id: string,
    kind: Operation['kind'],
    input: string,
    requestId: string,
  ): Promise<string | null> {
    if (kind === 'create') {
      if (!this.status().writesEnabled) throw new DeliveryError('桌面未连接或处于只读模式', true);
      return this.appTools.create(id, requestId, JSON.parse(input));
    }
    const sub = this.subscriptions.get(id);
    const view = this.view(id);
    if (!sub?.owner || !view?.synchronized || !this.status().writesEnabled || !this.transport)
      throw new DeliveryError('Desktop owner is unavailable or incompatible', true);
    if (kind === 'open') return null;
    if (kind === 'queue' || kind === 'queue-remove') {
      const value = JSON.parse(input);
      const current = await readNativeQueue(this.config.codexHome, id).catch(() => null);
      if (!current || queueFingerprint(current) !== value.expectedQueueFingerprint)
        throw new DeliveryError('桌面队列已变化，请刷新后重试', true);
      if (kind === 'queue') {
        if (current.some((m) => m.id === requestId)) return null;
        if (current.length >= 30) throw new DeliveryError('队列已达到 30 条，请先处理已有消息', true);
        await this.transport.request(
          'thread-follower-set-queued-follow-ups-state',
          {
            conversationId: id,
            state: { [id]: [...current, queuedMessage(requestId, value.text, sub.state)] },
            discardedMessageIds: [],
          },
          1,
          sub.owner,
          15000,
        );
      } else {
        const target = current.find((m) => m.id === value.messageId);
        if (!target || ['sending', 'outcome-unknown'].includes(target.submission?.status))
          throw new DeliveryError('消息已发送或结果待确认，不能删除', true);
        await this.transport.request(
          'thread-follower-remove-queued-message',
          { conversationId: id, messageId: value.messageId },
          1,
          sub.owner,
          15000,
        );
      }
      sub.queue = await readNativeQueue(this.config.codexHome, id);
      this.emitView(id);
      return null;
    }
    if (kind === 'settings') {
      if (!view.canSend && !view.canInterrupt) throw new DeliveryError('当前会话尚不能修改下一轮设置', true);
      const settings = JSON.parse(input);
      if (
        (settings.expectedServiceTier !== undefined &&
          (view.serviceTier ?? null) !== settings.expectedServiceTier) ||
        (settings.expectedMode !== undefined && view.mode !== settings.expectedMode)
      )
        throw new DeliveryError('桌面设置已变化，请重新打开设置', true);
      const response = await this.transport.request(
        'thread-follower-update-thread-settings',
        {
          conversationId: id,
          threadSettings: {
            model: settings.model,
            effort: settings.effort,
            ...(settings.serviceTier !== undefined ? { serviceTier: settings.serviceTier } : {}),
            ...(settings.mode
              ? {
                  collaborationMode: {
                    mode: settings.mode,
                    settings: {
                      model: settings.model,
                      reasoning_effort: settings.effort,
                      developer_instructions: null,
                    },
                  },
                }
              : {}),
          },
          condition: { ifModelEquals: settings.expectedModel, ifEffortEquals: settings.expectedEffort },
        },
        2,
        sub.owner,
        15000,
      );
      if (response.result?.applied === false)
        throw new DeliveryError('桌面设置已变化，请重新读取后操作', true);
      if (response.result?.applied !== true) throw new DeliveryError('桌面设置响应尚未确认');
      const confirmed = await this.transport.request(
        'thread-follower-read-model-settings',
        { conversationId: id },
        1,
        sub.owner,
      );
      const actual = confirmed.result?.settings;
      if (actual?.model !== settings.model || actual?.reasoningEffort !== settings.effort)
        throw new DeliveryError('设置尚未确认');
      // read-model-settings omits serviceTier and collaboration mode. Confirm them from
      // the owner's revision stream instead; an applied response alone is insufficient.
      if (settings.mode !== undefined || settings.serviceTier !== undefined) {
        const matches = () => {
          const current = this.view(id);
          return (
            current?.synchronized &&
            current.owner &&
            (settings.mode === undefined || current.mode === settings.mode) &&
            (settings.serviceTier === undefined || current.serviceTier === settings.serviceTier)
          );
        };
        if (!matches())
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              this.off('thread', listener);
              resolve();
            };
            const listener = (next: ThreadView) => {
              if (next.id === id && matches()) finish();
            };
            const timer = setTimeout(finish, 5000);
            this.on('thread', listener);
          });
        if (!matches()) throw new DeliveryError('桌面速度或工作模式尚未确认');
      }
      return null;
    }
    if (kind === 'respond') {
      const inputData = JSON.parse(input);
      if (inputData.targetRequestId.startsWith('async:')) {
        const question = view.requests?.find((request) => request.id === inputData.targetRequestId);
        if (!question) throw new DeliveryError('此问题已回答或过期', true);
        const text = asyncReply(question, inputData);
        // Replies are native user messages; preserve their source question IDs and operation ID.
        return this.control(
          id,
          view.activeTurnId ? 'steer' : 'send',
          view.activeTurnId ? JSON.stringify({ expectedTurnId: view.activeTurnId, text }) : text,
          requestId,
        );
      }
      const requests = Array.isArray(sub.state.requests)
        ? sub.state.requests
        : Object.values(sub.state.requests ?? {});
      const request: any = requests.find(
        (r: any) => String(r.id) === inputData.targetRequestId && !r.completed,
      );
      if (!request) throw new DeliveryError('此请求已处理或过期', true);
      if (request.method === 'item/plan/requestImplementation') {
        const lastTurn = turnsOf(sub.state).at(-1);
        if (
          view.activeTurnId ||
          view.runtimeStatus !== 'idle' ||
          !view.model ||
          requests.filter((r: any) => !r.completed).length !== 1 ||
          request.params?.threadId !== id ||
          request.params?.turnId !== lastTurn?.turnId ||
          inputData.expectedTurnId !== request.params.turnId ||
          inputData.expectedFingerprint !== requestFingerprint(request) ||
          !normalizeRequest(request, []).actionable ||
          !['implement', 'revise'].includes(inputData.planDecision) ||
          (inputData.planDecision === 'revise' && !inputData.feedback?.trim())
        )
          throw new DeliveryError('计划已变化或当前正在执行，请重新核对', true);
        // The desktop's native plan action is a follow-up turn, not a command approval.
        // Starting that turn completes the synthetic implementation request in the owner stream.
        const text =
          inputData.planDecision === 'implement'
            ? `PLEASE IMPLEMENT THIS PLAN:\n${request.params.planContent}`
            : inputData.feedback.trim();
        const response = await this.transport.request(
          'thread-follower-start-turn',
          {
            conversationId: id,
            turnStart: {
              request: {
                threadId: id,
                input: nativeUserInput(text, []).input,
                clientUserMessageId: requestId,
                collaborationMode: {
                  mode: inputData.planDecision === 'implement' ? 'default' : 'plan',
                  settings: {
                    model: view.model,
                    reasoning_effort: view.reasoningEffort ?? null,
                    developer_instructions: null,
                  },
                },
              },
              context: { inheritThreadSettings: true, attachments: [] },
            },
          },
          2,
          sub.owner,
          30000,
        );
        const turnId = response.result?.result?.turn?.id;
        if (!turnId) throw new DeliveryError('计划操作尚未获得桌面确认');
        return turnId;
      }
      const response = approvalResponse(request, inputData);
      await this.transport.request(
        response.method,
        { conversationId: id, ...response.payload },
        1,
        sub.owner,
        15000,
      );
      return inputData.expectedTurnId;
    }
    if (kind === 'steer') {
      const value = JSON.parse(input);
      if (!view.activeTurnId || view.activeTurnId !== value.expectedTurnId || view.pendingRequests)
        throw new DeliveryError('目标任务已变化或正在等待交互', true);
      const native = nativeUserInput(value.text, value.attachments ?? []);
      await this.transport.request(
        'thread-follower-steer-turn',
        {
          conversationId: id,
          input: native.input,
          attachments: native.attachments,
          clientUserMessageId: requestId,
          restoreMessage: {
            id: requestId,
            text: value.text,
            cwd: view.cwd,
            context: { fileAttachments: native.attachments },
          },
        },
        1,
        sub.owner,
        30000,
      );
      return view.activeTurnId;
    }
    if (kind === 'send') {
      const payload = input.startsWith('\u001e')
        ? JSON.parse(input.slice(1))
        : { text: input, attachments: [] };
      const files = (payload.attachments ?? []) as { name: string; path: string }[];
      const native = nativeUserInput(payload.text, files);
      const selectedSkills = payload.skillIds
        ? await this.skillCatalog
            .selected(view.cwd, payload.skillIds, this.disabledPlugins(id))
            .catch((error) => {
              throw new DeliveryError(
                error instanceof SelectionError ? error.message : '无法读取技能，本次消息未发送',
                true,
              );
            })
        : (payload.skills ?? []);
      native.input.push(
        ...selectedSkills.map((skill: { name: string; path: string }) => ({
          type: 'skill',
          name: skill.name,
          path: skill.path,
        })),
      );
      const selectedPlugins = await this.pluginCatalog
        .selected(view.cwd, payload.pluginIds ?? [], this.disabledPlugins(id))
        .catch((error) => {
          throw new DeliveryError(
            error instanceof SelectionError ? error.message : '无法读取插件，本次消息未发送',
            true,
          );
        });
      native.input.push(...selectedPlugins.map((plugin) => ({ type: 'mention' as const, ...plugin })));
      if (!view.canSend) throw new DeliveryError(view.reason ?? 'Conversation is not idle', true);
      const response = await this.transport.request(
        'thread-follower-start-turn',
        {
          conversationId: id,
          turnStart: {
            request: {
              threadId: id,
              input: native.input,
              clientUserMessageId: requestId,
            },
            context: { inheritThreadSettings: true, attachments: native.attachments },
          },
        },
        2,
        sub.owner,
        30000,
      );
      const result = response.result?.result;
      return result?.turn?.id ?? result?.turnId ?? result?.id ?? null;
    }
    if (!view.canInterrupt || view.activeTurnId !== input)
      throw new DeliveryError('Target turn is no longer active', true);
    const response = await this.transport.request(
      'thread-follower-interrupt-turn',
      {
        conversationId: id,
        expectedTurnId: input,
        mode: 'user-stop',
      },
      4,
      sub.owner,
      15000,
    );
    return response.result?.interruptedTurnId ?? input;
  }
  findOperationTurn(id: string, clientMessageId: string): { id: string; status: string } | null {
    const state = this.subscriptions.get(id)?.state;
    if (!state) return null;
    const turn = turnsOf(state).find((t) => t.params?.clientUserMessageId === clientMessageId);
    return turn ? { id: turn.turnId ?? turn.id, status: turn.status } : null;
  }
  inlineMedia(id: string, reference: string): string | null {
    const state = this.subscriptions.get(id)?.state;
    if (!state) return null;
    for (const turn of turnsOf(state))
      for (const item of orderedEntities(turn.items))
        for (const source of itemMedia(item))
          if (source.startsWith('data:') && mediaReference(source) === reference) return source;
    return null;
  }
  fullMessage(id: string, messageId: string) {
    const state = this.subscriptions.get(id)?.state;
    return state ? (messagesOf(state, true).find((message) => message.id === messageId) ?? null) : null;
  }
  stop(): void {
    this.stopped = true;
    this.appTools.close();
    clearTimeout(this.reconnect);
    for (const [id, sub] of this.subscriptions) this.follow(id, sub, false);
    this.transport?.close();
    this.ready = false;
  }
}
