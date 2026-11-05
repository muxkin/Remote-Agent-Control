import { SecureChannel, type SecurePacket } from './secure-channel.js';
import { RpcError, type RpcCall } from './rpc.js';
import type { GatewayStatus } from './types.js';
export interface DeviceReady {
  protocol: 2;
  sessionId: string;
  device: { id: string; name: string };
  ticket: string;
  hostName: string;
  status: GatewayStatus;
  p2p: { enabled: boolean; stunUrls: string[] };
}
export interface DeviceAuth {
  type: 'pair' | 'authenticate';
  protocol: 2;
  sessionId: string;
  code?: string;
  name?: string;
}
export class DeviceLink {
  private requests = new Map<
    string,
    {
      resolve: (value: { value: any; bytes?: Uint8Array }) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(message: Record<string, any>) => void>();
  private closedListeners = new Set<() => void>();
  private backlog: Record<string, any>[] = [];
  private readyResolve!: (value: DeviceReady) => void;
  private readyReject!: (error: Error) => void;
  readonly ready = new Promise<DeviceReady>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  closed = false;
  private constructor(readonly channel: SecureChannel) {
    channel.onPacket(({ message, bytes }) => {
      if (message.type === 'ready') {
        this.readyResolve(message as DeviceReady);
        return;
      }
      if (message.type === 'response') {
        const pending = this.requests.get(message.id);
        if (!pending) return;
        this.requests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new RpcError(message.error, message.status));
        else pending.resolve({ value: message.result, bytes });
      } else if (this.listeners.size) for (const listener of this.listeners) listener(message);
      else if (this.backlog.length < 32) this.backlog.push(message);
    });
    channel.onClose(() => {
      this.closed = true;
      this.readyReject(new RpcError('设备连接已关闭', 0));
      for (const pending of this.requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new RpcError('连接中断，操作结果待确认', 0));
      }
      this.requests.clear();
      for (const listener of this.closedListeners) listener();
    });
  }
  static async authenticate(channel: SecureChannel, auth: DeviceAuth) {
    const link = new DeviceLink(channel);
    const timer = setTimeout(() => channel.close(), 12000);
    try {
      await channel.send(auth);
      await link.ready;
      return link;
    } catch (error) {
      channel.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  onEvent(listener: (message: Record<string, any>) => void) {
    this.listeners.add(listener);
    const queued = this.backlog;
    this.backlog = [];
    for (const message of queued) listener(message);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: () => void) {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }
  request(
    type: string,
    data: Record<string, unknown> = {},
    bytes?: Uint8Array,
    timeout = 30000,
  ): Promise<{ value: any; bytes?: Uint8Array }> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      if (this.closed || this.requests.size >= 64) {
        reject(new RpcError('设备尚未连接或请求过多', 0));
        return;
      }
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new RpcError('请求超时，操作结果待确认', 0));
      }, timeout);
      this.requests.set(id, { resolve, reject, timer });
      void this.channel.send({ ...data, type, id }, bytes).catch(() => {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(new RpcError('连接中断，操作结果待确认', 0));
      });
    });
  }
  async rpc<T>(call: RpcCall, bytes?: Uint8Array): Promise<T> {
    return (await this.request('rpc', { call }, bytes)).value;
  }
  close() {
    this.channel.close();
  }
}
