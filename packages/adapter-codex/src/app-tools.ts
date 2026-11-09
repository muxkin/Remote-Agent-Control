import { connectorFor, type VerifiedPipe } from './connector.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FrameReader, encodeFrame } from './framing.js';
import { DeliveryError } from './transport.js';
import type { CodexConfig as Config } from './config.js';
import { platformRuntime } from '../../../src/server/platform.js';
import { creationBody } from '../../../src/server/control-schemas.js';
import { codexUsage } from './usage.js';
export interface DesktopProject {
  id: string;
  desktopId?: string;
  name: string;
  path: string;
}
class VerifiedAppPipe {
  closed = false;
  private child: VerifiedPipe;
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  ready: Promise<void>;
  constructor(config: Config, path: string) {
    this.child = connectorFor(config).pipe(config, path, true);
    const reader = new FrameReader();
    this.child.stdout.on('data', (bytes) => {
      try {
        reader.push(bytes, (message) => {
          const p = this.pending.get(String(message.id));
          if (!p) return;
          this.pending.delete(String(message.id));
          clearTimeout(p.timer);
          if (message.error) p.reject(new DeliveryError('桌面应用工具拒绝请求'));
          else p.resolve(message.result);
        });
      } catch {
        this.close();
      }
    });
    this.child.stdin.on('error', () => this.close());
    this.child.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new DeliveryError('桌面应用工具连接断开，结果待确认'));
      }
      this.pending.clear();
    });
    this.ready = new Promise((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => {
        this.close();
        reject(new DeliveryError('桌面工具连接超时', true));
      }, 5000);
      const fail = () => {
        clearTimeout(timeout);
        reject(new DeliveryError('桌面工具对端验证失败', true));
      };
      this.child.once('error', fail);
      this.child.once('close', fail);
      this.child.stderr.on('data', (bytes) => {
        buffer += bytes.toString();
        if (buffer.length > 4096) {
          this.close();
          return;
        }
        if (buffer.includes('\n')) {
          try {
            if (JSON.parse(buffer.trim()).type !== 'ready') throw Error();
            clearTimeout(timeout);
            this.child.off('close', fail);
            resolve();
          } catch {
            this.close();
            fail();
          }
        }
      });
    });
  }
  request(
    method: 'tools/list' | 'tools/call',
    params: unknown,
    timeout = 15000,
    closeOnTimeout = true,
  ): Promise<any> {
    if (this.closed || !this.child.stdin.writable)
      return Promise.reject(new DeliveryError('桌面工具连接不可用', true));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeliveryError('桌面工具响应超时，结果待确认'));
        if (closeOnTimeout) this.close();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeFrame({ id, jsonrpc: '2.0', method, params }));
    });
  }
  close() {
    this.closed = true;
    this.child.kill();
  }
}
/** A second Desktop-owned socket, restricted to explicit project, creation, navigation and read-only usage tools. No general tool forwarding. */
export class DesktopAppTools {
  get available() {
    return this.has('create_thread') && this.has('list_projects');
  }
  private tools = new Set<string>();
  has(tool: string) {
    return !!this.client && !this.client.closed && this.tools.has(tool);
  }
  private client?: VerifiedAppPipe;
  private connecting?: Promise<VerifiedAppPipe>;
  private generation = 0;
  private usageCache?: { expires: number; value: import('../../adapter-sdk/src/usage.js').AgentUsage };
  private loadingUsage?: Promise<import('../../adapter-sdk/src/usage.js').AgentUsage>;
  private projectCache?: { value: DesktopProject[]; expires: number };
  private loadingProjects?: Promise<DesktopProject[]>;
  constructor(private config: Config) {}
  private connect(): Promise<VerifiedAppPipe> {
    if (this.connecting) return this.connecting;
    if (this.client && !this.client.closed) return Promise.resolve(this.client);
    const connecting = this.open(this.generation).finally(() => {
      if (this.connecting === connecting) this.connecting = undefined;
    });
    this.connecting = connecting;
    return connecting;
  }
  private async open(generation: number) {
    const files = await connectorFor(this.config).appTools(this.config);
    if (files.length > 1)
      throw new DeliveryError('检测到多个桌面应用工具端点，请配置 POCKET_CODEX_APP_TOOLS', true);
    if (!files.length || generation !== this.generation)
      throw new DeliveryError('本机桌面应用工具不可用', true);
    const client = new VerifiedAppPipe(this.config, files[0]);
    this.client = client;
    this.usageCache = undefined;
    this.tools.clear();
    try {
      await client.ready;
      const catalog = await client.request('tools/list', { threadStartKind: 'all' }, 5000);
      if (client.closed) throw new DeliveryError('桌面工具连接不可用', true);
      this.tools = new Set(
        (catalog.tools ?? []).filter((t: any) => t.namespace === 'codex_app').map((t: any) => t.name),
      );
      if (!this.tools.size) throw new DeliveryError('桌面工具目录尚未就绪', true);
      return client;
    } catch {
      client.close();
      throw new DeliveryError('本机桌面应用工具不可用', true);
    }
  }
  async probe() {
    await this.connect();
  }
  private async call(
    client: VerifiedAppPipe,
    anchor: string,
    requestId: string,
    tool: 'list_projects' | 'create_thread' | 'get_usage_limits' | 'navigate_to_codex_page',
    args: any,
  ) {
    const result = await client.request(
      'tools/call',
      {
        arguments: args,
        callerSource: 'codex',
        callId: `pocket-${requestId}`,
        hostId: 'local',
        namespace: 'codex_app',
        threadId: anchor,
        tool,
        turnId: `pocket-control-${requestId}`,
      },
      tool === 'get_usage_limits' ? 8000 : 30000,
      tool !== 'get_usage_limits',
    );
    if (result?.success !== true) throw new DeliveryError('桌面未确认该会话操作，请检查桌面消息');
    if (tool === 'navigate_to_codex_page') return;
    const text = result.contentItems?.find((item: any) => item.type === 'inputText')?.text;
    try {
      return JSON.parse(text);
    } catch {
      throw new DeliveryError('桌面返回格式未经验证，结果待确认');
    }
  }
  async projects(anchor: string): Promise<DesktopProject[]> {
    if (this.projectCache && this.projectCache.expires > Date.now()) return this.projectCache.value;
    if (this.loadingProjects) return this.loadingProjects;
    this.loadingProjects = this.readProjects(anchor).finally(() => {
      this.loadingProjects = undefined;
    });
    return this.loadingProjects;
  }
  async usage(anchor: string, fresh = false) {
    if (this.loadingUsage) return this.loadingUsage;
    if (!fresh && this.usageCache && this.usageCache.expires > Date.now() && this.has('get_usage_limits'))
      return this.usageCache.value;
    const generation = this.generation;
    const loading = this.readUsage(anchor)
      .then((value) => {
        if (generation !== this.generation) throw new DeliveryError('桌面工具连接已更换', true);
        this.usageCache = { value, expires: Date.now() + 30000 };
        return value;
      })
      .finally(() => {
        if (this.loadingUsage === loading) this.loadingUsage = undefined;
      });
    this.loadingUsage = loading;
    return loading;
  }
  private async readUsage(anchor: string) {
    const client = await this.connect();
    if (!this.has('get_usage_limits'))
      return {
        available: false,
        updatedAt: Date.now(),
        buckets: [],
        reason: '此桌面版本尚未提供用量接口',
      };
    return codexUsage(await this.call(client, anchor, randomUUID(), 'get_usage_limits', {}));
  }
  async openThread(id: string) {
    const client = await this.connect().catch(() => undefined);
    if (!client || !this.has('navigate_to_codex_page')) return false;
    try {
      await this.call(client, id, randomUUID(), 'navigate_to_codex_page', { threadId: id });
      return true;
    } catch (error) {
      if (error instanceof DeliveryError && error.notSent) return false;
      throw error;
    }
  }
  private async readProjects(anchor: string): Promise<DesktopProject[]> {
    const client = await this.connect();
    if (!this.has('list_projects')) throw new DeliveryError('此桌面版本未提供项目列表接口', true);
    const result = await this.call(client, anchor, randomUUID(), 'list_projects', {});
    // The catalog uses migrated app-server IDs; Desktop's tool still expects legacy IDs.
    // Only use Desktop's explicit mapping, never project labels or filesystem paths.
    const state = await readFile(join(this.config.codexHome, '.codex-global-state.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch((error) => {
        if (error.code === 'ENOENT') return {};
        throw error;
      });
    const aliases =
      state['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${this.config.codexHome}`] ?? {};
    const value = (result.projects ?? [])
      .filter(
        (p: any) => p.hostId === 'local' && p.projectKind === 'local' && typeof p.projectId === 'string',
      )
      .map((p: any) => ({
        id: aliases[p.projectId] ?? p.projectId,
        desktopId: p.projectId,
        name: p.label,
        path: p.path,
      }));
    this.projectCache = { value, expires: Date.now() + 30000 };
    return value;
  }
  async create(
    anchor: string,
    requestId: string,
    input: Omit<z.infer<typeof creationBody>, 'requestId'>,
  ): Promise<string> {
    const project = input.projectId
      ? (await this.projects(anchor)).find((p) => p.id === input.projectId || p.desktopId === input.projectId)
      : undefined;
    if (input.projectId && !project) throw new DeliveryError('项目不可用，请重新选择本机项目', true);
    const client = await this.connect();
    if (!this.available) throw new DeliveryError('此桌面版本未提供新建会话接口', true);
    const result = await this.call(client, anchor, requestId, 'create_thread', {
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      prompt: input.prompt,
      target: project
        ? { type: 'project', projectId: project.desktopId ?? project.id, environment: { type: 'local' } }
        : { type: 'projectless' },
    });
    const id = z.string().uuid().safeParse(result.threadId);
    if (!id.success || result.hostId !== 'local')
      throw new DeliveryError('桌面尚未返回本机会话标识，请在列表核对');
    return id.data;
  }
  close() {
    this.generation++;
    this.connecting = undefined;
    this.client?.close();
    this.client = undefined;
    this.tools.clear();
    this.projectCache = undefined;
    this.usageCache = undefined;
    this.loadingUsage = undefined;
  }
}

export { creationBody } from '../../../src/server/control-schemas.js';
