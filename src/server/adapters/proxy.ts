import { EventEmitter } from 'node:events';
import { ResponseError } from 'vscode-jsonrpc/node';
import { randomUUID } from 'node:crypto';
import type { AgentBackend, BackendHistory } from '../backends/types.js';
import type { BackendCommand } from '../backends/commands.js';
import type { AdapterContext } from '../../../packages/adapter-sdk/src/index.js';
import type { BackendInfo, CapabilityName } from '../../shared/backends.js';
import type { GatewayStatus, ThreadView } from '../../shared/types.js';
import { DeliveryError } from '../delivery-error.js';
import { SelectionError } from '../selection-error.js';
import type { AdapterPackage } from './package.js';
import { startHostProcess, type HostProcess } from './process.js';
import { initialize, snapshot, event, fatal, request, type Calls, type RemoteError } from './protocol.js';
const capabilities = [
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
] as CapabilityName[];
const offline = (reason: string): GatewayStatus => ({
  connected: false,
  desktopVersion: null,
  supportedVersion: false,
  writesEnabled: false,
  reason,
  capabilities: {
    send: false,
    steer: false,
    interrupt: false,
    modelSettings: false,
    questions: false,
    approvals: false,
    permissionRequests: false,
    openThread: false,
    elicitationForms: false,
    newThread: false,
    queue: false,
  },
});
/** Stable gateway identity; only the private host behind it is replaceable. */
export class AdapterProxy extends EventEmitter implements AgentBackend {
  readonly id: string;
  readonly history: BackendHistory;
  maxUploadBytes?: number;
  controls?: AgentBackend['controls'];
  exportLog?: AgentBackend['exportLog'];
  fileReferences?: AgentBackend['fileReferences'];
  attachment?: AgentBackend['attachment'];
  private host?: HostProcess;
  private processes = new Set<HostProcess>();
  private generation = 0;
  private requests = new Set<{ write: boolean }>();
  private subscriptions = new Map<string, string>();
  private views = new Map<string, ThreadView>();
  private state = offline('插件正在连接');
  private descriptor: BackendInfo;
  private stopped = true;
  private ready = false;
  private draining = false;
  private replacing = false;
  private attempts = 0;
  private restartTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private lastHeartbeat = 0;
  constructor(
    public packageInfo: AdapterPackage,
    private context: AdapterContext,
    private timing = { startup: 20000, request: 120000, heartbeat: 5000, hang: 20000, restart: 500 },
    private issue?: string,
  ) {
    super();
    this.id = context.id;
    this.descriptor = {
      id: this.id,
      product: packageInfo.agentAdapter.product,
      name: context.name,
      connected: false,
      version: null,
      profile: '',
      presentation: packageInfo.agentAdapter.presentation,
      capabilities: Object.fromEntries(
        capabilities.map((k) => [k, { state: 'unavailable', reason: this.state.reason }]),
      ) as BackendInfo['capabilities'],
    };
    this.history = {
      get: (id) => this.call('history.get', [id]),
      list: (...args) => this.call('history.list', args),
      page: (...args) => this.call('history.page', args),
      projects: () => this.call('history.projects', []),
    };
  }
  get pid() {
    return this.host?.child.pid;
  }
  get activeWrites() {
    return [...this.requests].filter((p) => p.write).length;
  }
  info() {
    return { ...this.descriptor, connected: this.state.connected };
  }
  status() {
    return this.state;
  }
  view(id: string) {
    return this.views.get(id) ?? null;
  }
  async start() {
    this.stopped = false;
    if (this.issue) {
      this.unavailable(this.issue);
      return;
    }
    if (!this.stopped && this.ready) return;
    this.stopped = false;
    await this.launch();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    await this.retire('插件已断开');
    await Promise.all([...this.processes].map((host) => host.finished));
  }
  private publish(info: BackendInfo, status: GatewayStatus) {
    this.descriptor = {
      ...info,
      id: this.id,
      name: this.context.name,
      product: this.packageInfo.agentAdapter.product,
      presentation: this.packageInfo.agentAdapter.presentation,
    };
    this.state = status;
    this.emit('status', this.state);
  }
  private unavailable(reason: string) {
    this.state = offline(reason);
    this.descriptor = {
      ...this.descriptor,
      connected: false,
      capabilities: Object.fromEntries(
        capabilities.map((k) => [k, { state: 'unavailable', reason }]),
      ) as BackendInfo['capabilities'],
    };
    for (const [id, view] of this.views) {
      const stale = { ...view, synchronized: false, canSend: false, canInterrupt: false, reason };
      this.views.set(id, stale);
      this.emit('thread', stale);
    }
    this.emit('status', this.state);
  }
  private retire(reason: string) {
    ++this.generation;
    this.ready = false;
    clearInterval(this.heartbeat);
    const host = this.host;
    this.host = undefined;
    this.unavailable(reason);
    // Execa cancels only our auxiliary host; the native Agent is never its child.
    return host?.close() ?? Promise.resolve();
  }
  private failed(reason: string) {
    void this.retire(reason);
    if (!this.stopped && !this.replacing) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(
        () => void this.launch().catch(() => {}),
        Math.min(30000, this.timing.restart * 2 ** Math.min(6, this.attempts++)),
      );
      this.restartTimer.unref();
    }
  }
  private async launch() {
    clearTimeout(this.restartTimer);
    // Do not overlap old/new hosts against one instance's private state directory.
    await Promise.all([...this.processes].map((host) => host.finished));
    if (this.stopped) throw Error('插件监督器已停止');
    if (this.host) throw Error('Plugin host already running');
    const generation = ++this.generation;
    const host = startHostProcess(this.packageInfo.root, this.context.stateDirectory);
    this.host = host;
    this.processes.add(host);
    const current = () => this.host === host && generation === this.generation;
    void host.finished.then(() => {
      this.processes.delete(host);
      if (current()) this.failed('插件宿主退出，正在恢复');
    });
    const connection = host.connection;
    connection.onClose(() => {
      if (current()) this.failed('插件通信中断，正在恢复');
    });
    connection.onError(() => {
      if (current()) this.failed('插件通信失败，正在恢复');
    });
    connection.onNotification(fatal, (raw) => {
      if (current() && raw.generation === generation) this.failed(`插件初始化失败：${raw.error}`);
    });
    connection.onNotification(snapshot, (raw) => {
      if (current() && raw.generation === generation) this.publish(raw.info, raw.status);
    });
    connection.onNotification(event, (raw) => {
      if (!current() || raw.generation !== generation) return;
      if (raw.event === 'thread') {
        const view = raw.args[0] as ThreadView;
        if (![...this.subscriptions.values()].includes(view.id)) return;
        this.views.set(view.id, view);
      }
      this.emit(raw.event, ...raw.args);
    });
    connection.listen();
    const timer = setTimeout(() => {
      if (current()) this.failed('插件启动超时');
    }, this.timing.startup);
    try {
      const raw = await connection.sendRequest(initialize, { generation, sdk: 1, context: this.context });
      if (!current() || raw.generation !== generation) throw Error('插件连接已更换');
      for (const name of ['controls', 'exportLog', 'fileReferences', 'attachment'] as const)
        (this as any)[name] = raw.optionalMethods.includes(name)
          ? (...args: any[]) => this.call(name, args as any)
          : undefined;
      const subscriptions = [...this.subscriptions];
      this.ready = true;
      this.maxUploadBytes = raw.maxUploadBytes;
      this.publish(raw.info, raw.status);
      this.lastHeartbeat = Date.now();
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        if (Date.now() - this.lastHeartbeat > this.timing.hang) {
          this.failed('插件宿主无响应，正在恢复');
          return;
        }
        void this.call('ping', [])
          .then(() => {
            if (current()) this.lastHeartbeat = Date.now();
          })
          .catch(() => {});
      }, this.timing.heartbeat);
      this.heartbeat.unref();
      await this.restore(subscriptions);
      if (!current()) throw Error('插件订阅恢复时连接已更换');
      this.attempts = 0;
    } catch (error) {
      if (current()) this.failed(`插件初始化失败：${(error as Error).message}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private async restore(subscriptions: [string, string][]) {
    for (const [token, id] of subscriptions) {
      const view = await this.call('subscribe', [token, id]);
      if (view && this.subscriptions.has(token)) {
        this.views.set(id, view);
        this.emit('thread', view);
      }
      if (!this.subscriptions.has(token)) await this.call('unsubscribe', [token]);
    }
  }
  private async call<K extends keyof Calls>(method: K, args: Calls[K]['args']): Promise<Calls[K]['result']> {
    const write = method === 'execute' || method === 'openThread';
    const host = this.host,
      generation = this.generation;
    if (!host || !this.ready || (write && this.draining))
      throw new DeliveryError(
        this.draining ? '此实例正在升级，请稍后重试' : (this.state.reason ?? '插件未连接'),
        true,
      );
    // This set tracks business handoff only. JSON-RPC manages request IDs and promises.
    const pending = { write };
    this.requests.add(pending);
    const timer = setTimeout(() => {
      if (this.host === host) this.failed('插件请求超时，结果待确认');
    }, this.timing.request);
    try {
      const value = await host.connection.sendRequest(request(method), { generation, args });
      if (this.host !== host || generation !== this.generation)
        throw new DeliveryError('插件连接已更换，结果待确认', !write);
      return value;
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      if (this.host !== host || generation !== this.generation)
        throw new DeliveryError(this.state.reason ?? '插件连接已更换，结果待确认', !write);
      if (error instanceof ResponseError) {
        const e = error.data as RemoteError | undefined;
        if (e?.kind === 'delivery') throw new DeliveryError(e.message, e.notSent, e.outcome);
        if (e?.kind === 'selection') throw new SelectionError(e.message);
        if (e?.kind === 'error') throw new Error(error.message);
      }
      throw new DeliveryError(this.state.reason ?? '插件通信中断，结果待确认', !write);
    } finally {
      clearTimeout(timer);
      this.requests.delete(pending);
    }
  }
  async acquire(id: string) {
    const token = randomUUID();
    this.subscriptions.set(token, id);
    try {
      const view = await this.call('subscribe', [token, id]);
      if (view) {
        this.views.set(id, view);
        this.emit('thread', view);
      }
    } catch (error) {
      this.subscriptions.delete(token);
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.subscriptions.delete(token);
      if (![...this.subscriptions.values()].includes(id)) this.views.delete(id);
      void this.call('unsubscribe', [token]).catch(() => {});
    };
  }
  /** Drain before replacing. A timeout leaves the old process alive and accepting work again. */
  async replace(next: AdapterPackage, drainMs = 10000) {
    if (this.stopped) throw Error('插件监督器已停止');
    if (this.replacing) throw Error('此实例已有升级正在进行');
    if (next.name !== this.packageInfo.name) throw Error('实例不能通过升级更换插件类型');
    if (next.agentAdapter.stateVersion !== this.packageInfo.agentAdapter.stateVersion)
      throw Error('插件私有状态版本不兼容，需要显式迁移；未更换宿主');
    this.replacing = true;
    this.draining = true;
    const previous = this.packageInfo,
      generation = this.generation,
      deadline = Date.now() + drainMs;
    try {
      while (this.activeWrites && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.stopped) throw Error('插件监督器已停止');
      if (this.generation !== generation) throw Error('宿主在交接期间断开，升级已延后；正在恢复原版本');
      if (this.activeWrites) throw Error('仍有操作等待原生确认，升级已延后；旧宿主继续运行');
      await this.retire('插件正在升级');
      if (this.stopped) throw Error('插件监督器已停止');
      this.issue = undefined;
      this.stopped = false;
      this.packageInfo = next;
      try {
        await this.launch();
      } catch (error) {
        await this.retire('升级失败，正在恢复旧版本');
        this.packageInfo = previous;
        if (this.stopped) throw error;
        await this.launch();
        throw Error(`升级失败，已恢复旧版本：${(error as Error).message}`);
      }
    } finally {
      this.replacing = false;
      this.draining = false;
      if (!this.host && !this.stopped) this.failed('插件连接中断，正在恢复');
    }
  }
  waitForView(id: string, timeout?: number) {
    return this.call('waitForView', [id, timeout]).then((view) => {
      if (view) this.views.set(id, view);
      return view;
    });
  }
  projects(id: string) {
    return this.call('projects', [id]);
  }
  openThread(id: string) {
    return this.call('openThread', [id]);
  }
  execute(id: string, command: BackendCommand, requestId: string) {
    return this.call('execute', [id, command, requestId]);
  }
  inlineMedia(id: string, reference: string) {
    return this.call('inlineMedia', [id, reference]);
  }
  fullMessage(id: string, messageId: string) {
    return this.call('fullMessage', [id, messageId]);
  }
  models() {
    return this.call('models', []);
  }
  skills(id: string) {
    return this.call('skills', [id]);
  }
  plugins(id: string) {
    return this.call('plugins', [id]);
  }
  validateSelection(id: string, skills: string[], plugins: string[]) {
    return this.call('validateSelection', [id, skills, plugins]);
  }
  validateSettings(value: Parameters<AgentBackend['validateSettings']>[0]) {
    return this.call('validateSettings', [value]);
  }
  validateCreation(value: Parameters<AgentBackend['validateCreation']>[0]) {
    return this.call('validateCreation', [value]);
  }
}
