import feedbackRemote from '@deepseek-ai/dsh-command-feedback/remote';
import presetRemote from '@deepseek-ai/dsh-agent-preset-registry/remote';
import permissionRemote from '@deepseek-ai/dsh-permission-presets/remote';
import commandRemote from '@deepseek-ai/dsh-commands/remote';
import goalRemote from '@deepseek-ai/dsh-goal/remote';
import questionRemote from '@deepseek-ai/dsh-user-questions/remote';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { installConnection, type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import { parseRemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote';
import workspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote';
import WebSocket from 'ws';
import { DeliveryError } from '../delivery-error.js';

export interface DshConnectionConfig {
  id: string;
  name: string;
  url: string;
  token: string;
  version: string;
}
export interface DshConnection extends EventEmitter {
  connected: boolean;
  generation: number;
  start(): Promise<void>;
  stop(): void;
  call<T = any>(endpoint: string, args: Record<string, unknown>, write?: boolean): Promise<T>;
  stream(
    endpoint: string,
    args: Record<string, unknown>,
    item: (value: any) => void,
    end?: () => void,
  ): () => void;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
const methods = {
  ...goalRemote.methods,
  ...commandRemote.methods,
  ...permissionRemote.methods,
  ...presetRemote.methods,
  ...feedbackRemote.methods,
  ...sessionRemote.methods,
  ...workspaceRemote.methods,
  ...questionRemote.methods,
} as Record<string, any>;
/** Connects only to an existing Web carrier. No DSH host/Agent entry point is imported. */
export class DshWebConnection extends EventEmitter implements DshConnection {
  connected = false;
  generation = 0;
  private socket?: WebSocket;
  private cookie = '';
  private stopped = true;
  private retry?: NodeJS.Timeout;
  private abort = new AbortController();
  private streams = new Map<string, { item: (value: any) => void; end?: () => void }>();
  private ctx = new Context();
  private base: URL;
  constructor(private config: DshConnectionConfig) {
    super();
    this.base = new URL(config.url);
    if (
      !['http:', 'https:'].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash
    )
      throw Error('DSH URL must be an explicit HTTP(S) base URL without credentials');
    if (!this.base.pathname.endsWith('/')) this.base.pathname += '/';
    installConnection(this.ctx, {
      interactions: 'answer',
      location: { hostname: this.base.hostname },
      transport: { fetch: (path, init) => this.fetch(String(path), init) },
    });
  }
  async start() {
    this.stopped = false;
    await this.connect();
  }
  private async connect() {
    if (this.stopped) return;
    const attempt = ++this.generation;
    this.abort.abort();
    this.abort = new AbortController();
    try {
      if (!this.config.token) throw Error('DSH credential unavailable');
      const auth = new URL('connect', this.base);
      auth.searchParams.set('token', this.config.token);
      auth.searchParams.set('interactions', 'answer');
      const response = await fetch(auth, {
        redirect: 'manual',
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]),
      });
      if (response.status !== 302) throw Error('DSH authentication rejected');
      const target = new URL(response.headers.get('location') ?? '', this.base);
      if (target.origin !== this.base.origin || !target.pathname.endsWith('/api/remote.mux'))
        throw Error('DSH authentication redirect rejected');
      const cookies = response.headers.getSetCookie().map((value) => value.split(';', 1)[0]);
      if (!cookies.length) throw Error('DSH API cookie missing');
      if (attempt !== this.generation || this.stopped) return;
      this.cookie = cookies.join('; ');
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(target, {
        headers: { Cookie: this.cookie, Origin: this.base.origin },
        handshakeTimeout: 10000,
        maxPayload: 16 * 1024 * 1024,
        followRedirects: false,
      });
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      if (this.stopped || attempt !== this.generation) {
        socket.close();
        return;
      }
      this.connected = true;
      socket.on('message', (bytes) => {
        if (this.socket !== socket) return;
        try {
          const frame = parseRemoteStreamServerMessage(bytes.toString());
          const stream = this.streams.get(frame.streamId);
          if (frame.type === 'item') stream?.item(frame.value);
          else {
            this.streams.delete(frame.streamId);
            stream?.end?.();
          }
        } catch {
          socket.close(1002, 'Invalid stream frame');
        }
      });
      socket.on('error', () => socket.close());
      socket.once('close', () => {
        if (this.socket === socket) this.disconnected();
      });
      this.emit('connected');
    } catch {
      if (attempt === this.generation && !this.stopped) this.disconnected();
    }
  }
  private disconnected() {
    this.connected = false;
    this.cookie = '';
    this.abort.abort();
    this.socket?.terminate();
    this.socket = undefined;
    this.streams.clear();
    this.emit('disconnected');
    clearTimeout(this.retry);
    if (!this.stopped) {
      this.retry = setTimeout(() => void this.connect(), 3000);
      this.retry.unref();
    }
  }
  async fetch(path: string, init: RequestInit = {}) {
    if (!this.connected) throw new DeliveryError('DSH 实例未连接', true);
    const generation = this.generation;
    const url = new URL(path.replace(/^\//, ''), this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname + 'api/'))
      throw new DeliveryError('非法 DSH 请求地址', true);
    const headers = new Headers(init.headers);
    headers.set('Cookie', this.cookie);
    headers.set('Origin', this.base.origin);
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(30000),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
    if (generation !== this.generation) throw new DeliveryError('DSH 连接已更换，结果待确认');
    if (response.status === 401) {
      this.disconnected();
      throw new DeliveryError('DSH 身份已失效，正在重新连接');
    }
    if (response.status === 403) throw new DeliveryError('DSH 拒绝访问此资源', true);
    return response;
  }
  async call<T = any>(endpoint: string, args: Record<string, unknown>, write = false): Promise<T> {
    const method = methods[endpoint];
    if (!method && endpoint !== '$events/result') throw new DeliveryError('不支持此 DSH 接口', true);
    method?.input({ strict: true }).create().parse(args);
    const result = await (this.ctx.get('connection') as ConnectionHandle).rpc.call('/api', endpoint, {
      args,
    });
    if (!result.ok)
      throw new DeliveryError(
        `DSH 拒绝请求（${result.error.code}）`,
        !write || !['gateway/internal', 'gateway/cancelled'].includes(result.error.code),
      );
    // Generated validators detect drift without importing the Agent runtime.
    return (method?.result?.create ? method.result.create().parse(result.value) : result.value) as T;
  }
  stream(endpoint: string, args: Record<string, unknown>, item: (value: any) => void, end?: () => void) {
    if (!this.connected || !this.socket) throw new DeliveryError('DSH 实例未连接', true);
    const method = methods[endpoint];
    if (!method && endpoint !== '$events') throw new DeliveryError('不支持此 DSH 事件流', true);
    method?.input({ strict: true }).create().parse(args);
    const streamId = randomUUID(),
      generation = this.generation;
    this.streams.set(streamId, {
      item: (value) => item(method?.result?.create ? method.result.create().parse(value) : value),
      end,
    });
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    this.socket.send(JSON.stringify({ type: 'end', streamId }));
    return () => {
      if (generation !== this.generation || !this.streams.delete(streamId)) return;
      if (this.connected) this.socket?.send(JSON.stringify({ type: 'cancel', streamId }));
    };
  }
  stop() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.retry);
    this.disconnected();
  }
}
