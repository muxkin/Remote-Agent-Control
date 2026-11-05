import { z } from 'zod';
import { RPC_ROUTES, RpcError, type RpcCall, type RpcMethod } from '../shared/rpc.js';
import { ConflictError } from './store.js';
import { SelectionError } from './selection-error.js';

export interface CoreRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  device: { id: string; name: string };
}
class CoreReply {
  status = 200;
  code(value: number) {
    this.status = value;
    return this;
  }
  send(value?: any): any {
    if (this.status >= 400) throw new RpcError(value?.error ?? '请求失败', this.status);
    return value;
  }
}
type Handler = (request: CoreRequest, reply: CoreReply) => unknown | Promise<unknown>;
export class CoreRouter {
  private handlers = new Map<RpcMethod, Handler>();
  get(path: string, handler: Handler) {
    this.add('GET', path, handler);
  }
  post(path: string, handler: Handler) {
    this.add('POST', path, handler);
  }
  private add(verb: string, path: string, handler: Handler) {
    const route = Object.entries(RPC_ROUTES).find(([, value]) => value[0] === verb && value[1] === path);
    if (!route) throw Error(`Unregistered business method: ${verb} ${path}`);
    this.handlers.set(route[0] as RpcMethod, handler);
  }
  async call(call: RpcCall, device: CoreRequest['device'], bytes?: Uint8Array) {
    const handler = this.handlers.get(call.method);
    if (!handler) throw new RpcError('不支持此操作', 404);
    try {
      return await handler(
        {
          params: call.params ?? {},
          query: call.query ?? {},
          body: bytes ? Buffer.from(bytes) : call.body,
          device,
        },
        new CoreReply(),
      );
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (error instanceof z.ZodError) throw new RpcError('请求参数无效', 400);
      if (error instanceof SelectionError) throw new RpcError(error.message, 400);
      if (error instanceof ConflictError) throw new RpcError(error.message, 409);
      throw new RpcError('暂时无法读取桌面数据，请检查本机状态');
    }
  }
}
