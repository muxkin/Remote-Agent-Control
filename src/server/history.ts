import { userContent } from './user-content.js';
import { userMessageText } from './async-questions.js';
import { DatabaseSync } from 'node:sqlite';
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { textOf, skillsOf, pluginsOf } from './timeline.js';
import type { Message, ThreadSummary } from '../shared/types.js';
import { ProjectIndex } from './projects.js';

const PAGE_BYTES = 512 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
type HistoryPage = { messages: Message[]; nextCursor: string | null };
export class HistoryIndex {
  private db: DatabaseSync | null = null;
  private pendingLatest = new Map<string, Promise<HistoryPage>>();
  private latest = new Map<
    string,
    { file: string; identity: string; start: number; size: number; tail: JsonlTail; page: HistoryPage }
  >();
  private projectIndex: ProjectIndex;
  constructor(private codexHome: string) {
    this.projectIndex = new ProjectIndex(codexHome);
  }
  private database(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(join(this.codexHome, 'state_5.sqlite'), { readOnly: true });
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    }
    return this.db;
  }
  projects() {
    const { names, memberships } = this.projectIndex.snapshot(this.database());
    const rows = this.database()
      .prepare(
        `SELECT COALESCE(t.project_id,a.value) AS projectId,COUNT(*) AS count
      FROM threads t LEFT JOIN json_each(?) a ON a.key=t.id
      WHERE t.archived=0 AND (t.thread_source IN ('user','agent_created_thread') OR t.thread_source IS NULL)
      GROUP BY projectId`,
      )
      .all(memberships) as { projectId: string | null; count: number }[];
    const counts = new Map(rows.map((r) => [r.projectId, r.count]));
    return {
      projects: [...names].map(([id, name]) => ({ id, name, count: counts.get(id) ?? 0 })),
      ungrouped: counts.get(null) ?? 0,
      total: rows.reduce((n, r) => n + r.count, 0),
    };
  }
  list(
    cursor?: string,
    limit = 30,
    project?: string,
    query = '',
  ): { threads: ThreadSummary[]; nextCursor: string | null } {
    const { names, memberships } = this.projectIndex.snapshot(this.database());
    let after: { time: number; id: string } | undefined;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      } catch {
        throw new Error('Invalid history cursor');
      }
      if (!after || !Number.isSafeInteger(after.time) || typeof after.id !== 'string')
        throw new Error('Invalid history cursor');
    }
    const where = after ? 'AND (t.updated_at_ms < ? OR (t.updated_at_ms = ? AND t.id < ?))' : '';
    const filter =
      project === 'none'
        ? 'AND COALESCE(t.project_id,a.value) IS NULL'
        : project
          ? 'AND COALESCE(t.project_id,a.value)=?'
          : '';
    const params = [
      memberships,
      ...(project && project !== 'none' ? [project] : []),
      ...(query
        ? [
            query,
            JSON.stringify(
              [...names]
                .filter(([, name]) => name.toLowerCase().includes(query.toLowerCase()))
                .map(([id]) => id),
            ),
          ]
        : []),
      ...(after ? [after.time, after.time, after.id] : []),
      limit + 1,
    ];
    const rows = this.database()
      .prepare(
        `SELECT t.id,COALESCE(t.name,t.title) AS title,t.cwd,t.updated_at_ms AS updatedAt,COALESCE(t.project_id,a.value) AS projectId FROM threads t
      LEFT JOIN json_each(?) a ON a.key=t.id
      WHERE t.archived=0 AND (t.thread_source IN ('user','agent_created_thread') OR t.thread_source IS NULL) ${filter} ${query ? 'AND (instr(lower(COALESCE(t.name,t.title)),lower(?)) > 0 OR COALESCE(t.project_id,a.value) IN (SELECT value FROM json_each(?)))' : ''} ${where} ORDER BY t.updated_at_ms DESC,t.id DESC LIMIT ?`,
      )
      .all(...params) as unknown as ThreadSummary[];
    const hasMore = rows.length > limit;
    const threads = rows.slice(0, limit).map((t) => ({ ...t, projectName: names.get(t.projectId!) ?? null }));
    const last = threads.at(-1);
    return {
      threads,
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ time: last.updatedAt, id: last.id })).toString('base64url')
          : null,
    };
  }
  get(id: string): (ThreadSummary & { rolloutPath: string }) | null {
    return (
      (this.database()
        .prepare(
          'SELECT id,COALESCE(name,title) AS title,cwd,updated_at_ms AS updatedAt,rollout_path AS rolloutPath FROM threads WHERE id=?',
        )
        .get(id) as any) ?? null
    );
  }
  async path(id: string): Promise<string> {
    const row = this.get(id);
    if (!row) throw new Error('Thread not found');
    const file = await realpath(row.rolloutPath);
    const roots = await Promise.all(
      ['sessions', 'archived_sessions'].map((p) =>
        realpath(join(this.codexHome, p)).catch(() => join(this.codexHome, p)),
      ),
    );
    if (!roots.some((root) => file.startsWith(root + sep)) || !file.endsWith('.jsonl'))
      throw new Error('Invalid rollout location');
    return file;
  }
  async page(id: string, cursor?: string): Promise<HistoryPage> {
    if (cursor) return this.readPage(id, cursor);
    const running = this.pendingLatest.get(id);
    if (running) return running;
    const result = this.readPage(id).finally(() => this.pendingLatest.delete(id));
    this.pendingLatest.set(id, result);
    return result;
  }
  private async readPage(id: string, cursor?: string): Promise<HistoryPage> {
    const file = await this.path(id);
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      const identity = `${info.dev}:${info.ino}`;
      const cached = !cursor ? this.latest.get(id) : undefined;
      if (
        cached &&
        cached.file === file &&
        cached.identity === identity &&
        info.size >= cached.size &&
        info.size - cached.start <= 2 * PAGE_BYTES
      ) {
        const appended: Message[] = [];
        const result = await cached.tail.read(file, (record, offset) => {
          const message = rolloutMessage(record, `${id}:${offset}`);
          if (message) appended.push(message);
        });
        if (!result.reset) {
          cached.size = info.size;
          cached.page = { ...cached.page, messages: [...cached.page.messages, ...appended] };
          return cached.page;
        }
      }
      let end = info.size;
      if (cursor) {
        let parsed;
        try {
          parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        } catch {
          throw new Error('Invalid history cursor');
        }
        if (
          parsed.identity !== identity ||
          !Number.isSafeInteger(parsed.end) ||
          parsed.end < 0 ||
          parsed.end > info.size
        )
          throw new Error('History changed; reload from the latest page');
        end = parsed.end;
      }
      let start = Math.max(0, end - PAGE_BYTES);
      let bytes: Buffer;
      let begin: number;
      // Extend the bounded tail window when a single large JSON record spans it.
      while (true) {
        bytes = Buffer.alloc(end - start);
        const read = await handle.read(bytes, 0, bytes.length, start);
        bytes = bytes.subarray(0, read.bytesRead);
        begin = start === 0 ? 0 : bytes.indexOf(10) + 1;
        if (start === 0 || begin > 0) break;
        if (end - start >= MAX_LINE) throw new Error('历史中的单条记录超过 4 MiB，请在桌面查看');
        start = Math.max(0, start - PAGE_BYTES);
      }
      const nextEnd = start + begin;
      const messages: Message[] = [];
      let offset = nextEnd;
      const completeEnd = bytes.lastIndexOf(10) + 1;
      for (const line of bytes.subarray(begin, completeEnd).toString('utf8').split('\n')) {
        const lineOffset = offset;
        offset += Buffer.byteLength(line) + 1;
        try {
          const message = rolloutMessage(JSON.parse(line), `${id}:${lineOffset}`);
          if (message) messages.push(message);
        } catch {
          /* partial tail or malformed record */
        }
      }
      const page = {
        messages,
        nextCursor:
          nextEnd > 0 ? Buffer.from(JSON.stringify({ identity, end: nextEnd })).toString('base64url') : null,
      };
      if (!cursor) {
        const tail = new JsonlTail();
        tail.seed(identity, start + bytes.length, bytes.subarray(completeEnd));
        this.latest.delete(id);
        this.latest.set(id, { file, identity, start: nextEnd, size: info.size, tail, page });
        if (this.latest.size > 8) this.latest.delete(this.latest.keys().next().value!);
      }
      return page;
    } finally {
      await handle.close();
    }
  }
  close(): void {
    this.db?.close();
    this.latest.clear();
  }
}

export function rolloutMessage(record: any, fallbackId: string): Message | null {
  const item = record.type === 'response_item' ? record.payload : null;
  if (!item) return null;
  if (
    [
      'function_call',
      'custom_tool_call',
      'function_call_output',
      'custom_tool_call_output',
      'web_search_call',
    ].includes(item.type)
  ) {
    const output = ['function_call_output', 'custom_tool_call_output'].includes(item.type);
    const details =
      typeof item.output === 'string'
        ? item.output
        : typeof item.arguments === 'string'
          ? item.arguments
          : typeof item.input === 'string'
            ? item.input
            : JSON.stringify(item.output ?? item.arguments ?? item.input ?? {});
    return {
      id: item.id ?? `${item.call_id ?? fallbackId}:${output ? 'output' : 'call'}`,
      role: 'tool',
      text: `${output ? '工具结果' : '工具调用'} · ${item.name ?? item.type}`,
      details,
      output: output ? details : undefined,
    };
  }
  if (item.type !== 'message' || !['user', 'assistant'].includes(item.role)) return null;
  if (item.role === 'assistant' && [item.channel, item.phase].includes('analysis')) return null;
  const text = textOf(item.content);
  if (!text) return null;
  // Desktop persists its injected workspace context as a user-role message.
  // Recognize only the complete generated envelope, not normal prompts mentioning it.
  if (
    item.role === 'user' &&
    /^# AGENTS\.md instructions\b/.test(text) &&
    /<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*<environment_context>[\s\S]*<\/environment_context>\s*$/.test(
      text,
    )
  )
    return null;
  return {
    id: item.id ?? fallbackId,
    role: item.role,
    ...(item.role === 'user' ? { ...userContent(text), text: userMessageText(text) } : { text }),
    phase: item.phase ?? item.channel,
    ...(item.role === 'user' ? { skills: skillsOf(item.content) } : {}),
    ...(item.role === 'user' ? { plugins: pluginsOf(item.content) } : {}),
  };
}

/** Incremental UTF-8 JSONL cursor for file-watch consumers; never rewrites rollouts. */
export class JsonlTail {
  private identity = '';
  private offset = 0;
  private pending = Buffer.alloc(0);
  seed(identity: string, offset: number, pending: Buffer): void {
    this.identity = identity;
    this.offset = offset;
    this.pending = Buffer.from(pending);
  }
  async read(
    file: string,
    onRecord?: (record: any, offset: number) => void,
  ): Promise<{ reset: boolean; records: any[] }> {
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      const identity = `${info.dev}:${info.ino}`;
      const reset = identity !== this.identity || info.size < this.offset;
      if (reset) {
        this.identity = identity;
        this.offset = 0;
        this.pending = Buffer.alloc(0);
      }
      const records: any[] = [];
      while (this.offset < info.size) {
        const data = Buffer.alloc(Math.min(65536, info.size - this.offset));
        const { bytesRead } = await handle.read(data, 0, data.length, this.offset);
        if (!bytesRead) break;
        const base = this.offset - this.pending.length;
        this.offset += bytesRead;
        const joined = Buffer.concat([this.pending, data.subarray(0, bytesRead)]);
        let from = 0;
        let next;
        while ((next = joined.indexOf(10, from)) !== -1) {
          if (next - from > MAX_LINE) throw new Error('JSONL record exceeds limit');
          try {
            const record = JSON.parse(joined.subarray(from, next).toString('utf8'));
            records.push(record);
            onRecord?.(record, base + from);
          } catch {
            /* ignore malformed complete lines */
          }
          from = next + 1;
        }
        this.pending = Buffer.from(joined.subarray(from));
        if (this.pending.length > MAX_LINE) throw new Error('JSONL record exceeds limit');
      }
      return { reset, records };
    } finally {
      await handle.close();
    }
  }
}
