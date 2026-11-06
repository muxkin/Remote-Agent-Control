import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentBackend, BackendHistory } from '../backends/types.js';
import type { BackendCommand } from '../backends/commands.js';
import type { AdapterContext } from '../../../packages/adapter-sdk/src/index.js';
import type { BackendInfo, CapabilityName } from '../../shared/backends.js';
import type { GatewayStatus, ThreadView } from '../../shared/types.js';
import { DeliveryError } from '../delivery-error.js';
import { SelectionError } from '../selection-error.js';
import { hostEnvironment, type AdapterPackage } from './package.js';
import type { Calls, FromHost, ToHost } from './protocol.js';
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
export function hostLaunch() {
  const development = import.meta.url.endsWith('.ts');
  const path = development
    ? fileURLToPath(new URL('./host.ts', import.meta.url))
    : ['./adapters/host.js', './host.js']
        .map((p) => fileURLToPath(new URL(p, import.meta.url)))
        .find(existsSync)!;
  return { path, execArgv: development ? ['--import', import.meta.resolve('tsx')] : [] };
}
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  write: boolean;
};
/** Stable gateway identity; only the private host behind it is replaceable. */
export class AdapterProxy extends EventEmitter implements AgentBackend {
  readonly id: string;
  readonly history: BackendHistory;
  maxUploadBytes?: number;
  controls?: AgentBackend['controls'];
  exportLog?: AgentBackend['exportLog'];
  fileReferences?: AgentBackend['fileReferences'];
  attachment?: AgentBackend['attachment'];
  private child?: ChildProcess;
  private processes = new Set<ChildProcess>();
  private generation = 0;
  private sequence = 0;
  private pending = new Map<number, Pending>();
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
  private starting?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
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
    return this.child?.pid;
  }
  get activeWrites() {
    return [...this.pending.values()].filter((p) => p.write).length;
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
    this.retire('插件已断开');
    await Promise.all(
      [...this.processes].map(
        (child) => new Promise<void>((resolve) => child.once('close', () => resolve())),
      ),
    );
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
    const child = this.child;
    this.child = undefined;
    // Kill only our auxiliary host. It never owns the native Agent process.
    child?.kill('SIGKILL');
    if (this.starting) {
      clearTimeout(this.starting.timer);
      this.starting.reject(Error(reason));
      this.starting = undefined;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DeliveryError(reason, !pending.write));
    }
    this.pending.clear();
    this.unavailable(reason);
  }
  private failed(reason: string) {
    this.retire(reason);
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
    if (this.child) throw Error('Plugin host already running');
    clearTimeout(this.restartTimer);
    const generation = ++this.generation,
      launch = hostLaunch();
    const child = fork(launch.path, [this.packageInfo.root], {
      execArgv: launch.execArgv,
      env: hostEnvironment(),
      cwd: this.context.stateDirectory,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    });
    this.child = child;
    this.processes.add(child);
    child.once('close', () => this.processes.delete(child));
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failed('插件启动超时'), this.timing.startup);
      this.starting = { resolve, reject, timer };
    });
    child.on('error', () => {
      if (this.child === child) this.failed('插件宿主无法启动');
    });
    child.on('exit', () => {
      if (this.child === child) this.failed('插件宿主退出，正在恢复');
    });
    child.on('message', (raw: FromHost) => {
      if (this.child !== child || generation !== this.generation || !raw || raw.generation !== generation)
        return;
      if (raw.type === 'fatal') {
        this.failed(`插件初始化失败：${raw.error}`);
        return;
      }
      if (raw.type === 'ready') {
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
          if (Date.now() - this.lastHeartbeat > this.timing.hang) {
            this.failed('插件宿主无响应，正在恢复');
            return;
          }
          void this.call('ping', [])
            .then(() => {
              if (this.child === child) this.lastHeartbeat = Date.now();
            })
            .catch(() => {});
        }, this.timing.heartbeat);
        this.heartbeat.unref();
        void this.restore(subscriptions)
          .then(() => {
            if (this.child !== child) return;
            this.attempts = 0;
            if (this.starting) {
              clearTimeout(this.starting.timer);
              this.starting.resolve();
              this.starting = undefined;
            }
          })
          .catch(() => {
            if (this.child === child) this.failed('插件订阅恢复失败');
          });
      } else if (raw.type === 'snapshot') {
        this.publish(raw.info, raw.status);
      } else if (raw.type === 'reply') {
        const pending = this.pending.get(raw.id);
        if (!pending) return;
        this.pending.delete(raw.id);
        clearTimeout(pending.timer);
        if (raw.error) {
          const e = raw.error;
          pending.reject(
            e.kind === 'delivery'
              ? new DeliveryError(e.message, e.notSent, e.outcome)
              : e.kind === 'selection'
                ? new SelectionError(e.message)
                : new Error(e.message),
          );
        } else pending.resolve(raw.value);
      } else if (raw.type === 'event') {
        if (raw.event === 'thread') {
          const view = raw.args[0] as ThreadView;
          if (![...this.subscriptions.values()].includes(view.id)) return;
          this.views.set(view.id, view);
        }
        this.emit(raw.event, ...raw.args);
      }
    });
    const init: ToHost = { type: 'init', generation, sdk: 1, context: this.context };
    child.send(init, (error) => {
      if (error && this.child === child) this.failed('插件初始化通道中断');
    });
    await promise;
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
  private call<K extends keyof Calls>(method: K, args: Calls[K]['args']): Promise<Calls[K]['result']> {
    const write = method === 'execute' || method === 'openThread';
    if (!this.child || !this.ready || (write && this.draining))
      return Promise.reject(
        new DeliveryError(
          this.draining ? '此实例正在升级，请稍后重试' : (this.state.reason ?? '插件未连接'),
          true,
        ),
      );
    const id = ++this.sequence,
      child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) this.failed('插件请求超时，结果待确认');
      }, this.timing.request);
      this.pending.set(id, { resolve, reject, timer, write });
      const message: ToHost = { type: 'call', generation: this.generation, id, method, args };
      child.send(message, (error) => {
        if (error && this.child === child) this.failed('插件通信中断，结果待确认');
      });
    });
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
    if (this.replacing) throw Error('此实例已有升级正在进行');
    if (next.name !== this.packageInfo.name) throw Error('实例不能通过升级更换插件类型');
    if (next.agentAdapter.stateVersion !== this.packageInfo.agentAdapter.stateVersion)
      throw Error('插件私有状态版本不兼容，需要显式迁移；未更换宿主');
    this.replacing = true;
    this.draining = true;
    const previous = this.packageInfo,
      deadline = Date.now() + drainMs;
    try {
      while (this.activeWrites && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.activeWrites) throw Error('仍有操作等待原生确认，升级已延后；旧宿主继续运行');
      this.retire('插件正在升级');
      this.issue = undefined;
      this.stopped = false;
      this.packageInfo = next;
      try {
        await this.launch();
      } catch (error) {
        this.retire('升级失败，正在恢复旧版本');
        this.packageInfo = previous;
        await this.launch();
        throw Error(`升级失败，已恢复旧版本：${(error as Error).message}`);
      }
    } finally {
      this.replacing = false;
      this.draining = false;
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
