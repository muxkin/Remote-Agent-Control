import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentActivityTracker,
  createStreamWriter,
  incomingContent,
  outgoingFiles,
  stripDirectives,
} from '../scripts/im-bot-media.mjs';
test('reports ACP tool milestones without raw tool data or model thoughts', () => {
  const tracker = createAgentActivityTracker();
  tracker.update({ sessionUpdate: 'agent_thought_chunk', content: { text: 'private thinking' } });
  tracker.update({ sessionUpdate: 'tool_call', toolCallId: 'hidden', kind: 'think' });
  tracker.update({ sessionUpdate: 'tool_call_update', toolCallId: 'hidden', status: 'completed' });
  tracker.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'search',
    kind: 'search',
    status: 'in_progress',
    title: 'private path',
    rawInput: { secret: 'private' },
  });
  assert.deepEqual(tracker.snapshot(), [{ kind: 'search', status: 'in_progress' }]);
  tracker.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'search',
    status: 'completed',
    rawOutput: 'private',
  });
  assert.deepEqual(tracker.snapshot(), [{ kind: 'search', status: 'completed' }]);
});
test('serializes chunks and final commit with committed revisions', async () => {
  let active = 0,
    max = 0,
    current = { revision: 0, state: 'streaming', text: '' };
  const writer = createStreamWriter({
    initial: current,
    read: async () => current,
    patch: async (input) => {
      max = Math.max(max, ++active);
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(input.revision, current.revision + 1);
      current = input;
      active--;
      return current;
    },
  });
  await Promise.all([writer.write('a'), writer.write('abc'), writer.write('complete', 'complete')]);
  assert.equal(max, 1);
  assert.equal(current.revision, 3);
  assert.equal(current.state, 'complete');
});
test('recovers an acknowledged update whose response was lost and stops after cancellation', async () => {
  let current = { revision: 0, state: 'streaming', text: '' },
    cancelled = false,
    calls = 0;
  const writer = createStreamWriter({
    initial: current,
    read: async () => current,
    onCancelled: () => (cancelled = true),
    patch: async (input) => {
      calls++;
      if (calls === 1) {
        current = input;
        throw Error('network');
      }
      throw Error('409');
    },
  });
  await writer.write('hello');
  assert.equal(calls, 1);
  current = { ...current, state: 'cancelled', revision: 2 };
  await assert.rejects(writer.write('later'));
  assert.equal(cancelled, true);
  assert.equal(writer.ended, true);
});
test('passes pure image messages as ACP image blocks and explicitly flags unsupported voice', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'im-bot-test-'));
  try {
    const response = () => Promise.resolve({ data: new Uint8Array([1, 2, 3]) });
    const blocks = await incomingContent({
      message: {
        conversationId: 'c',
        attachments: [
          { id: 'a', name: 'image.png', mime: 'image/png', url: '/api/im/conversations/c/files/a' },
        ],
      },
      origin: 'https://im.test',
      inbox: folder,
      capabilities: { image: true },
      download: response,
    });
    assert.equal(blocks[1].type, 'image');
    assert.equal(blocks[1].data, 'AQID');
    const voice = await incomingContent({
      message: {
        conversationId: 'c',
        attachments: [
          { id: 'b', name: 'voice.wav', mime: 'audio/wav', url: '/api/im/conversations/c/files/b' },
        ],
      },
      origin: 'https://im.test',
      inbox: folder,
      capabilities: { audio: false },
      download: response,
    });
    assert.match(voice[1].text, /不支持音频/);
    await assert.rejects(
      incomingContent({
        message: { conversationId: 'c', attachments: [{ id: 'x', url: 'https://evil.test/a' }] },
        origin: 'https://im.test',
        inbox: folder,
        capabilities: {},
        download: response,
      }),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('sends only explicit local artifacts and rejects symlink escape', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'im-bot-test-'));
  try {
    const cwd = path.join(folder, 'work');
    await mkdir(cwd);
    await writeFile(path.join(cwd, 'plot.png'), 'image');
    await writeFile(path.join(folder, 'secret'), 'private');
    await symlink(path.join(folder, 'secret'), path.join(cwd, 'escape'));
    assert.equal((await outgoingFiles('plot.png', cwd)).length, 0);
    assert.equal((await outgoingFiles('[[附件:plot.png]]', cwd))[0].name, 'plot.png');
    await assert.rejects(outgoingFiles('[[附件:escape]]', cwd));
    assert.equal(stripDirectives('hello [[贴图:早安]] [[附件:plot.png]]'), 'hello');
    assert.equal(stripDirectives('hello [[贴图:早'), 'hello');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
