/** Matched synthetic views: application JSON sizes, not WAN latency or billing estimates. */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { DesktopAdapter } from '../src/server/desktop.js';
import { SyncJournal } from '../src/server/sync-journal.js';
import { applySync, checkpoint, type CachedThread } from '../src/shared/sync.js';
import { FakeTransport, fixtureConfig, THREAD } from '../test/helpers.js';
const config = fixtureConfig(),
  native = new FakeTransport();
native.current.turnHistory.history.entitiesByKey.one.items = Array.from({ length: 100 }, (_, i) => ({
  type: 'agentMessage',
  id: `message-${i}`,
  text: `${i}:` + 'synthetic fixture '.repeat(120),
}));
const desktop = new DesktopAdapter(config, () => native);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
try {
  await desktop.start();
  const release = await desktop.acquire(THREAD);
  const original = (await desktop.waitForView(THREAD))!;
  const journal = new SyncJournal();
  const cold = journal.resume(original);
  let cached: CachedThread | null = null;
  for (const update of cold) cached = applySync(cached, update);
  assert.ok(cached);
  const known = checkpoint(cached)!;
  const warm = journal.resume(original, known);
  assert.equal(warm[0].kind === 'manifest' && warm[0].changed.length, 0);
  const changed = structuredClone(original);
  changed.revision++;
  changed.messages.at(-1)!.text += ' one edit';
  const edit = journal.resume(changed, known);
  for (const update of edit) cached = applySync(cached, update);
  assert.equal(cached!.view.messages.at(-1)!.text, changed.messages.at(-1)!.text);
  const packet = (updates: unknown) => ({ type: 'sync', threadId: THREAD, updates });
  const report = {
    measurement:
      'Uncompressed server application JSON; excludes transport framing, Noise, handshakes, static assets and WAN timing. v1 uses its snapshot-on-reconnect envelope; v2 uses actual SyncJournal output.',
    messages: original.messages.length,
    cold: { v1: size({ type: 'thread', thread: original }), v2: size(packet(cold)) },
    unchangedReopen: { v1: size({ type: 'thread', thread: original }), v2: size(packet(warm)) },
    reopenAfterOneEdit: { v1: size({ type: 'thread', thread: changed }), v2: size(packet(edit)) },
    v2ClientCheckpointBytes: size(known),
  };
  await mkdir('.test-output', { recursive: true });
  await writeFile('.test-output/v2-sync-comparison.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
  release();
} finally {
  desktop.stop();
  await rm(config.desktopRoot, { recursive: true, force: true });
}
