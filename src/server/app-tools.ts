import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FrameReader, encodeFrame } from './framing.js';
import { DeliveryError } from './transport.js';
import type { Config } from './config.js';
export const creationBody = z
  .object({
    requestId: z.string().uuid(),
    title: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(16000),
    projectId: z.string().min(1).max(200).optional(),
  })
  .strict();
export interface DesktopProject {
  id: string;
  name: string;
  path: string;
}
class VerifiedAppPipe {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  ready: Promise<void>;
  constructor(config: Config, path: string) {
    this.child = spawn(
      'python3',
      ['-I', '-B', config.bridgePath, path, `${config.desktopRoot}/ChatGPT`, '--app-tools'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
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
  request(method: 'tools/list' | 'tools/call', params: unknown, timeout = 15000): Promise<any> {
    if (!this.child.stdin.writable) return Promise.reject(new DeliveryError('桌面工具连接不可用', true));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeliveryError('桌面工具响应超时，结果待确认'));
        this.close();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeFrame({ id, jsonrpc: '2.0', method, params }));
    });
  }
  close() {
    this.child.kill();
  }
}
/** A second Desktop-owned socket, restricted here to project listing and native creation. No general tool forwarding. */
export class DesktopAppTools {
  available = false;
  constructor(private config: Config) {}
  private async connect() {
    const files = await readdir('/tmp/codex-app-tools').catch(() => []);
    for (const file of files.filter((f) => /^[a-f0-9-]{36}\.sock$/.test(f)).slice(0, 10)) {
      const client = new VerifiedAppPipe(this.config, `/tmp/codex-app-tools/${file}`);
      try {
        await client.ready;
        const catalog = await client.request('tools/list', { threadStartKind: 'all' }, 5000);
        if (
          !['create_thread', 'list_projects'].every((name) =>
            catalog.tools?.some((tool: any) => tool.name === name && tool.namespace === 'codex_app'),
          )
        )
          throw Error();
        this.available = true;
        return client;
      } catch {
        client.close();
      }
    }
    this.available = false;
    throw new DeliveryError('本机桌面应用工具不可用，无法新建会话', true);
  }
  async probe() {
    const client = await this.connect();
    client.close();
  }
  private async call(
    client: VerifiedAppPipe,
    anchor: string,
    requestId: string,
    tool: 'list_projects' | 'create_thread',
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
      30000,
    );
    if (!result.success) throw new DeliveryError('桌面未确认该会话操作，请检查桌面消息');
    const text = result.contentItems?.find((item: any) => item.type === 'inputText')?.text;
    try {
      return JSON.parse(text);
    } catch {
      throw new DeliveryError('桌面返回格式未经验证，结果待确认');
    }
  }
  async projects(anchor: string): Promise<DesktopProject[]> {
    const client = await this.connect();
    try {
      const result = await this.call(client, anchor, randomUUID(), 'list_projects', {});
      return (result.projects ?? [])
        .filter(
          (p: any) => p.hostId === 'local' && p.projectKind === 'local' && typeof p.projectId === 'string',
        )
        .map((p: any) => ({ id: p.projectId, name: p.label, path: p.path }));
    } finally {
      client.close();
    }
  }
  async create(
    anchor: string,
    requestId: string,
    input: { title: string; prompt: string; projectId?: string },
  ): Promise<string> {
    if (input.projectId && !(await this.projects(anchor)).some((p) => p.id === input.projectId))
      throw new DeliveryError('项目不可用，请重新选择本机项目', true);
    const client = await this.connect();
    try {
      const result = await this.call(client, anchor, requestId, 'create_thread', {
        title: input.title,
        prompt: input.prompt,
        target: input.projectId
          ? { type: 'project', projectId: input.projectId, environment: { type: 'local' } }
          : { type: 'projectless' },
      });
      const id = z.string().uuid().safeParse(result.threadId);
      if (!id.success || result.hostId !== 'local')
        throw new DeliveryError('桌面尚未返回本机会话标识，请在列表核对');
      return id.data;
    } finally {
      client.close();
    }
  }
}
