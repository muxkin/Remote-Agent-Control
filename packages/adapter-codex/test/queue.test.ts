import { expect, test } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopAdapter } from '../src/desktop.js';
import { fixtureConfig, FakeTransport, THREAD } from '../../../test/helpers.js';
import { queueFingerprint } from '../src/queue.js';
import { randomUUID } from 'node:crypto';
test('queue preserves existing native entries and rejects stale or uncertain removal', async () => {
  const c = fixtureConfig(),
    t = new FakeTransport();
  await mkdir(c.codexHome, { recursive: true });
  const message = {
    id: randomUUID(),
    text: 'Desktop-owned draft',
    context: { prompt: 'Desktop-owned draft' },
    submission: { status: 'queued' },
  };
  await writeFile(
    join(c.codexHome, '.codex-global-state.json'),
    JSON.stringify({ 'queued-follow-ups': { [THREAD]: [message] } }),
  );
  const d = new DesktopAdapter(c, () => t);
  await d.start();
  const release = await d.acquire(THREAD);
  try {
    await expect(
      d.control(
        THREAD,
        'queue',
        JSON.stringify({ text: 'new', expectedQueueFingerprint: '0'.repeat(64) }),
        randomUUID(),
      ),
    ).rejects.toThrow('队列已变化');
    const id = randomUUID();
    await d.control(
      THREAD,
      'queue',
      JSON.stringify({ text: 'new', expectedQueueFingerprint: queueFingerprint([message]) }),
      id,
    );
    const call = t.calls.find((c) => c.method === 'thread-follower-set-queued-follow-ups-state');
    expect(call.params.state[THREAD][0]).toEqual(message);
    expect(call.params.state[THREAD][1]).toMatchObject({
      id,
      requiresExistingOwner: true,
      context: { prompt: 'new' },
      submissionOptions: { shouldSendPermissionOverrides: false },
    });
    message.submission.status = 'outcome-unknown';
    await writeFile(
      join(c.codexHome, '.codex-global-state.json'),
      JSON.stringify({ 'queued-follow-ups': { [THREAD]: [message] } }),
    );
    await expect(
      d.control(
        THREAD,
        'queue-remove',
        JSON.stringify({ messageId: message.id, expectedQueueFingerprint: queueFingerprint([message]) }),
        randomUUID(),
      ),
    ).rejects.toThrow('不能删除');
  } finally {
    release();
    d.stop();
    await rm(c.desktopRoot, { recursive: true, force: true });
  }
});
