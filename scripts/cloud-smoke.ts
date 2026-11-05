/** Read-only acceptance of the public v2 relay. Revokes its disposable device. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';
import { hostIdentity } from '../src/server/device-identity.js';
import { createIdentity } from '../src/shared/secure-channel.js';
import { apiCall } from '../src/shared/rpc.js';
import { applySync, checkpoint, type CachedThread } from '../src/shared/sync.js';
import { nodeSession } from '../src/client/node-session.js';
import { privateOutput } from './private-output.js';
const config = readConfig(),
  threadId = process.argv[2];
assert.match(threadId ?? '', /^[a-f0-9-]{36}$/);
const store = new Store(config.stateDir),
  host = await hostIdentity(config.stateDir),
  phone = await createIdentity();
const pair = store.mintPairing(),
  checks: Record<string, boolean> = {};
let deviceId: string | undefined, link: Awaited<ReturnType<typeof nodeSession>> | undefined;
try {
  link = await nodeSession(
    config.origin,
    host.peerId,
    phone,
    createHash('sha256').update(pair.code).digest('hex'),
    {
      type: 'pair',
      protocol: 2,
      sessionId: crypto.randomUUID(),
      code: pair.code,
      name: 'v2-public-read-only-QA',
    },
  );
  const ready = await link.ready;
  deviceId = ready.device.id;
  assert.equal(ready.protocol, 2);
  checks.encryptedPairing = true;
  const projects = await link.rpc<any>(apiCall('/projects'));
  assert.ok(Array.isArray(projects.projects));
  checks.unifiedBusinessReads = true;
  let current: CachedThread | null = null,
    changed = 0;
  link.onEvent((event) => {
    if (event.type === 'sync')
      for (const update of event.updates) {
        changed += update.changed?.length ?? 0;
        current = applySync(current, update);
      }
  });
  await link.request('watch', { threadId });
  const deadline = Date.now() + 20000;
  while (!current && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(current);
  checks.historyOverCiphertextRelay = true;
  const before = changed;
  await link.request('watch', { threadId, known: checkpoint(current) });
  await new Promise((r) => setTimeout(r, 300));
  checks.unchangedBodiesNotRepeated = changed === before;
  const raw = await fetch(new URL('/api/projects', config.origin));
  assert.equal(raw.status, 404);
  checks.noPublicBusinessHttp = true;
  const health = await fetch(new URL('/health', config.origin));
  assert.ok(health.ok);
  checks.independentCloudEntry = true;
} finally {
  link?.close();
  if (deviceId) store.revoke(deviceId);
  store.close();
  await privateOutput('.test-output');
  await writeFile(
    '.test-output/cloud-results.json',
    JSON.stringify({ date: new Date().toISOString(), checks }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(checks));
}
