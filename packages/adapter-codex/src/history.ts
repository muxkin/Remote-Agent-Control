import { userAttachments } from './user-content.js';
import { userMessageText } from './async-questions.js';
import { DatabaseSync } from 'node:sqlite';
import { open, realpath, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import { textOf, skillsOf, pluginsOf } from './timeline.js';
import type { Message, ThreadSummary } from '../../../src/shared/types.js';
import { codexAnswer, isCodexWorkspaceContext } from '../../../src/shared/codex-transcript.js';
import { ProjectIndex } from './projects.js';
import { RolloutFiles } from './rollout-files.js';
import { itemMedia, mediaReference } from '../../../src/server/content-media.js';
import { authorizeFile } from '../../../src/server/media.js';
import { viewedImage } from './recovered-images.js';

const PAGE_BYTES = 512 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
type HistoryPage = { messages: Message[]; nextCursor: string | null };
type TurnEnd = { id: string; answer?: string };
function answerHash(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

// A page can start between a reply and its completion event. Carry just the
// boundary and a digest for legacy replies whose phase was not recorded.
class RolloutPageMessages {
  reply = -1;
  leadingEnd?: TurnEnd;
  private sawTurnContent = false;
  constructor(readonly messages: Message[] = []) {}
  complete(end: TurnEnd) {
    const candidate = this.messages[this.reply];
    if (
      candidate &&
      (candidate.phase === 'final_answer' ||
        (!candidate.phase && end.answer && answerHash(candidate.text) === end.answer))
    )
      this.messages[this.reply] = { ...candidate, turnId: end.id, turnBoundary: true };
    if (!this.sawTurnContent) this.leadingEnd = end;
    this.sawTurnContent = true;
    this.reply = -1;
  }
  append(record: any, fallbackId: string) {
    if (record.type === 'event_msg') {
      const event = record.payload;
      if (event?.type === 'task_complete' && typeof event.turn_id === 'string' && event.turn_id) {
        this.complete({
          id: event.turn_id,
          answer:
            typeof event.last_agent_message === 'string'
              ? answerHash(codexAnswer(event.last_agent_message).text)
              : undefined,
        });
      } else if (['task_started', 'task_complete', 'turn_aborted'].includes(event?.type)) {
        this.sawTurnContent = true;
        this.reply = -1;
      }
    }
    const message = rolloutMessage(record, fallbackId);
    if (!message) return;
    if (message.role !== 'tool') this.sawTurnContent = true;
    if (message.role === 'user') this.reply = -1;
    if (message.role === 'assistant' && (message.phase === 'final_answer' || !message.phase))
      this.reply = this.messages.length;
    this.messages.push(message);
  }
}
export class HistoryIndex {
  private files = new RolloutFiles();
  private db: DatabaseSync | null = null;
  private pendingLatest = new Map<string, Promise<HistoryPage>>();
  private latest = new Map<
    string,
    {
      file: string;
      identity: string;
      start: number;
      size: number;
      tail: JsonlTail;
      page: HistoryPage;
      reply: number;
    }
  >();
  private projectIndex: ProjectIndex;
  constructor(
    private codexHome: string,
    private recoveredImages?: string,
  ) {
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
    const { names, memberships } = this.projectIndex.snapshot(this.database());
    const row = this.database()
      .prepare(
        `SELECT t.id,COALESCE(t.name,t.title) AS title,t.cwd,t.updated_at_ms AS updatedAt,
           t.rollout_path AS rolloutPath,COALESCE(t.project_id,a.value) AS projectId
           FROM threads t LEFT JOIN json_each(?) a ON a.key=t.id WHERE t.id=?`,
      )
      .get(memberships, id) as (ThreadSummary & { rolloutPath: string }) | undefined;
    return row ? { ...row, projectName: names.get(row.projectId!) ?? null } : null;
  }
  async path(id: string): Promise<string> {
    const row = this.get(id);
    if (!row) throw new Error('Thread not found');
    const file = await realpath(row.rolloutPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || !row.rolloutPath.endsWith('.jsonl')) throw error;
      return realpath(`${row.rolloutPath}.zst`).catch((compressedError: NodeJS.ErrnoException) => {
        if (compressedError.code === 'ENOENT')
          throw new Error('找不到此会话的历史记录，请在电脑端确认记录是否仍存在');
        throw compressedError;
      });
    });
    const roots = await Promise.all(
      ['sessions', 'archived_sessions'].map((p) =>
        realpath(join(this.codexHome, p)).catch(() => join(this.codexHome, p)),
      ),
    );
    if (!roots.some((root) => file.startsWith(root + sep)) || !/\.jsonl(?:\.zst)?$/.test(file))
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
    const reader = await this.files.open(file);
    const { handle, identity } = reader;
    try {
      const info = await handle.stat();
      const cached = !cursor ? this.latest.get(id) : undefined;
      if (file.endsWith('.zst') && cached?.file === file && cached.identity === identity) return cached.page;
      if (
        !file.endsWith('.zst') &&
        cached &&
        cached.file === file &&
        cached.identity === identity &&
        info.size >= cached.size &&
        info.size - cached.start <= 2 * PAGE_BYTES
      ) {
        const projection = new RolloutPageMessages([...cached.page.messages]);
        projection.reply = cached.reply;
        const result = await cached.tail.read(file, (record, offset) => {
          projection.append(record, `${id}:${offset}`);
        });
        if (!result.reset) {
          cached.size = info.size;
          cached.reply = projection.reply;
          cached.page = { ...cached.page, messages: projection.messages };
          return cached.page;
        }
      }
      let end = info.size;
      let trailingEnd: TurnEnd | undefined;
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
        if (typeof parsed.turnEnd?.id === 'string' && parsed.turnEnd.id.length <= 200)
          trailingEnd = {
            id: parsed.turnEnd.id,
            answer: typeof parsed.turnEnd.answer === 'string' ? parsed.turnEnd.answer : undefined,
          };
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
      const projection = new RolloutPageMessages();
      let offset = nextEnd;
      const completeEnd = bytes.lastIndexOf(10) + 1;
      for (const line of bytes.subarray(begin, completeEnd).toString('utf8').split('\n')) {
        const lineOffset = offset;
        offset += Buffer.byteLength(line) + 1;
        try {
          projection.append(JSON.parse(line), `${id}:${lineOffset}`);
        } catch {
          /* partial tail or malformed record */
        }
      }
      if (trailingEnd) projection.complete(trailingEnd);
      const page = {
        messages: projection.messages,
        nextCursor:
          nextEnd > 0
            ? Buffer.from(
                JSON.stringify({ identity, end: nextEnd, turnEnd: projection.leadingEnd }),
              ).toString('base64url')
            : null,
      };
      if (!cursor) {
        const tail = new JsonlTail();
        tail.seed(identity, start + bytes.length, bytes.subarray(completeEnd));
        this.latest.delete(id);
        this.latest.set(id, {
          file,
          identity,
          start: nextEnd,
          size: info.size,
          tail,
          page,
          reply: projection.reply,
        });
        if (this.latest.size > 8) this.latest.delete(this.latest.keys().next().value!);
      }
      return page;
    } finally {
      await reader.close();
    }
  }
  close(): void {
    this.db?.close();
    this.latest.clear();
    this.files.close();
  }

  /** Read the owning rollout, including older pages and compressed history. */
  private async *records(id: string) {
    const reader = await this.files.open(await this.path(id));
    try {
      const size = (await reader.handle.stat()).size;
      if (size > 512 * 1024 * 1024) throw Error('历史记录过大，请在电脑端查看附件');
      let pending = Buffer.alloc(0),
        offset = 0,
        skipping = false;
      while (offset < size) {
        const chunk = Buffer.alloc(Math.min(65536, size - offset));
        const { bytesRead } = await reader.handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let from = 0,
          end: number;
        while ((end = data.indexOf(10, from)) >= 0) {
          if (!skipping) {
            try {
              yield JSON.parse(data.subarray(from, end).toString('utf8'));
            } catch {
              /* malformed record */
            }
          }
          skipping = false;
          from = end + 1;
        }
        pending = data.subarray(from);
        if (pending.length > 32 * 1024 * 1024) {
          pending = Buffer.alloc(0);
          skipping = true;
        }
      }
    } finally {
      await reader.close();
    }
  }
  async inlineMedia(id: string, reference: string): Promise<string | null> {
    for await (const record of this.records(id)) {
      if (record.type !== 'response_item') continue;
      for (const source of itemMedia(record.payload))
        if (source.startsWith('data:') && mediaReference(source) === reference) return source;
    }
    return null;
  }
  async attachment(id: string, reference: string, liveMissing?: unknown): Promise<string> {
    const thread = this.get(id);
    if (!thread) throw Error('找不到此会话');
    let missing = liveMissing;
    for await (const record of this.records(id)) {
      const message = rolloutMessage(record, 'history');
      if (!message) continue;
      const file = await authorizeFile(reference, thread.cwd, [message]).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') missing = error;
          return null;
        },
      );
      if (file) return file;
    }
    if (missing) {
      // A missing authorized link may still have its exact viewed bytes in the rollout.
      // Never overwrite the former path or guess a replacement from another conversation.
      if (this.recoveredImages) {
        const source = await viewedImage(this.records(id), id, reference, thread.cwd);
        if (source) {
          await mkdir(this.recoveredImages, { recursive: true, mode: 0o700 });
          const file = join(this.recoveredImages, mediaReference(source).slice('pocket-inline:'.length));
          const temporary = join(this.recoveredImages, randomUUID() + '.tmp');
          try {
            await writeFile(temporary, Buffer.from(source.slice(source.indexOf(',') + 1), 'base64'), {
              mode: 0o600,
              flag: 'wx',
            });
            await rename(temporary, file);
          } finally {
            await rm(temporary, { force: true });
          }
          return file;
        }
      }
      throw missing;
    }
    throw Error('附件未在此会话中找到，或原文件已移除');
  }
}

export function rolloutMessage(record: any, fallbackId: string): Message | null {
  let item = record.type === 'response_item' ? record.payload : null;
  if (!item) return null;
  const kinds = item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (item.role === 'user' && Array.isArray(item.content) && Array.isArray(kinds)) {
    item = {
      ...item,
      content: item.content.filter(
        (_part: unknown, index: number) => kinds[index] !== 'environments.environment_context',
      ),
    };
  }
  const media = itemMedia(item);
  if (media.length && item.type !== 'message')
    return {
      id: `${item.id ?? fallbackId}:media:history`,
      role: 'tool',
      text: media.map((source) => `![附件](<${mediaReference(source)}>)`).join('\n'),
    };
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
  const input = textOf(item.content);
  const raw = item.role === 'user' && isCodexWorkspaceContext(input) ? '' : input;
  const id = item.id ?? fallbackId;
  const { text, codex } = item.role === 'assistant' ? codexAnswer(raw) : { text: raw, codex: undefined };
  if (!text && !media.length && !codex) return null;
  return {
    id,
    role: item.role,
    ...(item.role === 'user'
      ? {
          text: userMessageText(text),
          attachments: userAttachments(text, media),
        }
      : {
          text: [text, ...media.map((source) => `![附件](<${mediaReference(source)}>)`)]
            .filter(Boolean)
            .join('\n'),
          codex,
        }),
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
