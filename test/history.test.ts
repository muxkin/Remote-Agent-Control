import { it, expect, afterEach } from 'vitest';
import { rmSync, writeFileSync, appendFileSync, renameSync, readFileSync, symlinkSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { HistoryIndex, JsonlTail, rolloutMessage } from '../packages/adapter-codex/src/history.js';
import { messagesOf } from '../packages/adapter-codex/src/timeline.js';
import { codexDisplayMessage } from '../src/shared/codex-transcript.js';
import { fixtureConfig, historyFixture, THREAD } from './helpers.js';
const callbacks: (() => void)[] = [];
afterEach(() => callbacks.splice(0).forEach((x) => x()));
function setup() {
  const c = fixtureConfig();
  const file = historyFixture(c);
  const h = new HistoryIndex(c.codexHome);
  callbacks.push(() => {
    h.close();
    rmSync(c.desktopRoot, { recursive: true, force: true });
  });
  return { c, h, file };
}
it('reads indexed history without executing or modifying it', async () => {
  const { h } = setup();
  expect(h.list().threads[0].id).toBe(THREAD);
  expect((await h.page(THREAD)).messages[0].text).toBe('历史消息');
});
it('reads compressed desktop rollouts using the existing JSONL index path without changing the source', async () => {
  const { h, file } = setup();
  const compressed = zstdCompressSync(readFileSync(file));
  writeFileSync(`${file}.zst`, compressed);
  rmSync(file);
  expect((await h.page(THREAD)).messages[0].text).toBe('历史消息');
  expect((await h.page(THREAD)).messages[0].text).toBe('历史消息');
  expect(readFileSync(`${file}.zst`)).toEqual(compressed);
});
it('paginates compressed rollouts with stable message IDs and rejects stale cursors', async () => {
  const { h, c, file } = setup();
  const rows =
    Array.from({ length: 1500 }, (_, i) =>
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${i}:` + '字'.repeat(200) }],
        },
      }),
    ).join('\n') + '\n';
  writeFileSync(`${file}.zst`, zstdCompressSync(rows));
  rmSync(file);
  const db = new DatabaseSync(join(c.codexHome, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET rollout_path=?').run(`${file}.zst`);
  db.close();
  const first = await h.page(THREAD);
  expect(first.nextCursor).toBeTruthy();
  const second = await h.page(THREAD, first.nextCursor!);
  let page = second;
  let messages = [...second.messages, ...first.messages];
  while (page.nextCursor) {
    page = await h.page(THREAD, page.nextCursor);
    messages = [...page.messages, ...messages];
  }
  expect(messages).toHaveLength(1500);
  expect(new Set(messages.map((m) => m.id)).size).toBe(1500);
  expect(messages[0].text).toMatch(/^0:/);
  expect(messages.at(-1)?.text).toMatch(/^1499:/);
  expect((await h.page(THREAD, first.nextCursor!)).messages).toEqual(second.messages);
  writeFileSync(`${file}.zst`, zstdCompressSync(rows + rows));
  await expect(h.page(THREAD, first.nextCursor!)).rejects.toThrow('History changed');
});
it('reports missing/corrupt compressed records and keeps the rollout directory boundary', async () => {
  const { h, c, file } = setup();
  rmSync(file);
  await expect(h.page(THREAD)).rejects.toThrow('找不到此会话的历史记录');
  writeFileSync(`${file}.zst`, 'not zstd');
  await expect(h.page(THREAD)).rejects.toThrow();
  rmSync(`${file}.zst`);
  const outside = join(c.desktopRoot, 'outside.jsonl.zst');
  writeFileSync(outside, zstdCompressSync('{}\n'));
  symlinkSync(outside, `${file}.zst`);
  await expect(h.page(THREAD)).rejects.toThrow('Invalid rollout location');
});
it('includes user-visible native chats created through desktop tools', () => {
  const { h, c } = setup();
  const db = new DatabaseSync(join(c.codexHome, 'state_5.sqlite'));
  db.exec("UPDATE threads SET thread_source='agent_created_thread'");
  expect(h.list().threads.map((x) => x.id)).toEqual([THREAD]);
  db.exec("UPDATE threads SET thread_source='subagent'");
  expect(h.list().threads).toEqual([]);
  db.close();
});
it('drops the generated workspace envelope and preserves ordinary user text', () => {
  const record = (text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
  expect(
    rolloutMessage(
      record(
        '# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS><environment_context>cwd</environment_context>',
      ),
      'id',
    ),
  ).toBeNull();
  expect(rolloutMessage(record('请检查 # AGENTS.md instructions 的内容'), 'id')?.role).toBe('user');
});
it('keeps the real prompt when a native record includes generated environment context', () => {
  const context =
    '<environment_context>\n<current_date>2026-11-09</current_date>\n<timezone>Asia/Shanghai</timezone>\n<filesystem><workspace_roots><root>/fixture</root></workspace_roots></filesystem>\n</environment_context>';
  const record = (texts: string[], kinds?: string[]) => ({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: texts.map((text) => ({ type: 'input_text', text })),
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    },
  });
  expect(rolloutMessage(record([context], ['environments.environment_context']), 'ctx')).toBeNull();
  expect(rolloutMessage(record([context]), 'old-ctx')).toBeNull();
  expect(
    rolloutMessage(record([context, '继续分析'], ['environments.environment_context', 'user.text']), 'real')
      ?.text,
  ).toBe('继续分析');
  const quoted = '请解释这段 XML：\n\n```xml\n' + context + '\n```';
  expect(rolloutMessage(record([quoted]), 'quoted')?.text).toBe(quoted);
  expect(codexDisplayMessage({ id: 'cached', role: 'user', text: context })).toBeNull();
  const cached = JSON.parse('{"id":"cached","role":"user","text":"","codex":{"kind":"environment"}}');
  expect(codexDisplayMessage(cached)).toBeNull();
  expect(
    messagesOf({
      turns: [
        {
          id: 'first',
          params: { input: context },
          items: [{ id: 'answer', type: 'agentMessage', text: '正文' }],
        },
        {
          id: 'second',
          items: [{ id: 'context', type: 'userMessage', content: context }],
        },
      ],
    }),
  ).toMatchObject([{ text: '正文' }]);
});

it('separates a Codex memory footer from history, live snapshots and old cached views', () => {
  const citation = [
    '<oai-mem-citation>',
    '<citation_entries>',
    '/fixture/notes/MEMORY.md:5-6|note=[Fixture note]',
    '</citation_entries>',
    '<rollout_ids>',
    '01234567-89ab-cdef-0123-456789abcdef',
    '</rollout_ids>',
    '</oai-mem-citation>',
  ].join('\n');
  const answer = '正文含有 [普通引用](https://example.com/source) 和 \\(x=1\\)。';
  const raw = answer + '\n\n' + citation;
  const record = (text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
  const summary = {
    text: answer,
    codex: {
      kind: 'memory',
      entries: [{ source: 'MEMORY.md', lineStart: 5, lineEnd: 6, note: 'Fixture note' }],
    },
  };
  expect(rolloutMessage(record(raw), 'history')).toMatchObject(summary);
  const live = (text: string) => ({
    turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text }] }],
  });
  expect(messagesOf(live(raw))[0]).toMatchObject(summary);
  expect(messagesOf(live(raw.slice(0, raw.indexOf('</citation_entries>'))), true)[0].text).toBe(answer);
  expect(codexDisplayMessage({ id: 'cached', role: 'assistant', text: raw })).toMatchObject(summary);
  const example = '示例：\n\n```xml\n' + citation + '\n```';
  expect(rolloutMessage(record(example), 'example')?.text).toBe(example);
  const unfinishedExample = example.slice(0, -4);
  expect(messagesOf(live(unfinishedExample))[0].text).toBe(unfinishedExample);
});
it('paginates by byte boundaries without dropping or duplicating records', async () => {
  const { h, file } = setup();
  const rows = Array.from({ length: 1500 }, (_, i) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: `m${i}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: `${i}:` + '字'.repeat(200) }],
      },
    }),
  );
  writeFileSync(file, rows.join('\n') + '\n');
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await h.page(THREAD, cursor);
    ids.push(...page.messages.map((x) => x.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids.length).toBe(1500);
  expect(new Set(ids).size).toBe(1500);
});
it('rejects forged history cursors and replaced files', async () => {
  const { h, file } = setup();
  await expect(
    h.page(THREAD, Buffer.from(JSON.stringify({ identity: 'wrong', end: 20 })).toString('base64url')),
  ).rejects.toThrow();
});
it('incremental reader handles UTF-8 splits, partial lines and no-change reads', async () => {
  const { file } = setup();
  writeFileSync(file, '');
  const reader = new JsonlTail();
  const bytes = Buffer.from(JSON.stringify({ text: '中文🙂' }) + '\n');
  appendFileSync(file, bytes.subarray(0, 12));
  expect((await reader.read(file)).records).toEqual([]);
  appendFileSync(file, bytes.subarray(12));
  expect((await reader.read(file)).records).toEqual([{ text: '中文🙂' }]);
  expect((await reader.read(file)).records).toEqual([]);
});
it('resets the incremental cursor on truncation and rotation', async () => {
  const { file } = setup();
  const reader = new JsonlTail();
  await reader.read(file);
  writeFileSync(file, '{"new":1}\n');
  expect(await reader.read(file)).toEqual({ reset: true, records: [{ new: 1 }] });
  renameSync(file, `${file}.old`);
  writeFileSync(file, '{"rotated":2}\n');
  expect(await reader.read(file)).toEqual({ reset: true, records: [{ rotated: 2 }] });
});
it('updates the bounded latest-page cache from complete appended records only', async () => {
  const { h, file } = setup();
  const original = await h.page(THREAD);
  const line =
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'appended',
        role: 'assistant',
        content: [{ type: 'output_text', text: '增量🙂' }],
      },
    }) + '\n';
  appendFileSync(file, line.slice(0, -4));
  expect(await h.page(THREAD)).toEqual(original);
  appendFileSync(file, line.slice(-4));
  const updated = await h.page(THREAD);
  expect(updated.messages.at(-1)?.text).toBe('增量🙂');
  expect((await h.page(THREAD)).messages).toHaveLength(original.messages.length + 1);
  renameSync(file, `${file}.old`);
  writeFileSync(file, line);
  expect((await h.page(THREAD)).messages.map((x) => x.id)).toEqual(['appended']);
});

it('historical tool calls and outputs remain visible, private reasoning is skipped', () => {
  expect(
    rolloutMessage(
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: '{"cmd":"echo hi"}',
        },
      },
      'fallback',
    ),
  ).toMatchObject({ id: 'call-1:call', role: 'tool', details: '{"cmd":"echo hi"}' });
  expect(
    rolloutMessage(
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'hi' } },
      'fallback',
    ),
  ).toMatchObject({ id: 'call-1:output', output: 'hi' });
  expect(
    rolloutMessage(
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          channel: 'analysis',
          content: [{ type: 'output_text', text: 'private' }],
        },
      },
      'fallback',
    ),
  ).toBeNull();
  expect(
    rolloutMessage(
      { type: 'response_item', payload: { type: 'reasoning', summary: [], content: 'private' } },
      'fallback',
    ),
  ).toBeNull();
});

it('resolves older local attachments and inline images without a desktop owner, including compressed rollouts', async () => {
  const { h, c, file } = setup();
  const attachment = join(c.desktopRoot, 'older.png'),
    secret = join(c.desktopRoot, 'unmentioned.png');
  writeFileSync(attachment, 'image');
  writeFileSync(secret, 'private');
  const inline = 'data:image/png;base64,aGVsbG8=';
  const records = [
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `![old](<${attachment}>)` }],
      },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: inline }] },
    },
    ...Array.from({ length: 1000 }, () => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'later '.repeat(200) }],
      },
    })),
  ];
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  expect((await h.page(THREAD)).messages.some((m) => m.text.includes('older.png'))).toBe(false);
  expect(await h.attachment(THREAD, attachment)).toBe(attachment);
  await expect(h.attachment(THREAD, secret)).rejects.toThrow();
  const { mediaReference } = await import('../src/server/content-media.js');
  expect(await h.inlineMedia(THREAD, mediaReference(inline))).toBe(inline);
  writeFileSync(`${file}.zst`, zstdCompressSync(readFileSync(file)));
  rmSync(file);
  expect(await h.attachment(THREAD, attachment)).toBe(attachment);
  expect(await h.inlineMedia(THREAD, mediaReference(inline))).toBe(inline);
  expect(await h.inlineMedia(THREAD, mediaReference('data:image/png;base64,bm8='))).toBeNull();
});
