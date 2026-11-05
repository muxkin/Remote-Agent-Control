/** Verify an explicitly configured adapter using disposable files, without conversation writes. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/server/config.js';
import { loadStorage, signedDownload } from '../src/server/object-storage.js';
import { MediaService } from '../src/server/media.js';
import { Uploads } from '../src/server/uploads.js';
import { uploadToStorage } from '../src/web/storage-upload.js';
import { privateOutput } from './private-output.js';

const config = readConfig();
assert.ok(config.media, 'Configure POCKET_MEDIA_ADAPTER first');
const storage = await loadStorage(config.media, 'media', config.origin);
assert.ok(storage.remove, 'The live test requires adapter.remove to clean up its objects');
const dir = await mkdtemp(join(tmpdir(), 'pocket-storage-'));
const keys = new Set<string>();
const checks: Record<string, boolean> = {};
try {
  const bytes = Buffer.from('UTF-8 中文附件 ✅ 📱\n' + randomUUID());
  const file = join(dir, 'probe.txt');
  await writeFile(file, bytes, { mode: 0o600 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = `${config.media.prefix ?? 'codex-pocket'}/private-media/text-v1/${sha256}.txt`;
  keys.add(key);
  const media = await new MediaService(config).resolve(file, randomUUID());
  assert.equal(media.source, 'object-storage');
  const response = await fetch(media.url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain;\s*charset=utf-8/i);
  const range = await fetch(media.url, {
    headers: { Range: 'bytes=0-4' },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 5));
  const expired = await signedDownload(storage, key, Date.now() - 60000);
  assert.ok([401, 403].includes((await fetch(expired, { signal: AbortSignal.timeout(30000) })).status));
  checks.privateReadChecksumCharsetRangeAndExpiry = true;
  const uploads = new Uploads({ ...config, stateDir: dir });
  const device = randomUUID(),
    thread = randomUUID();
  const plan = await uploads.begin({ name: 'probe.txt', size: bytes.length, sha256 }, device, thread);
  assert.equal(plan.route, 'object-storage');
  if (plan.route !== 'object-storage') throw Error('Expected direct upload');
  keys.add((await uploads.get(plan.id, device, thread)).key);
  await uploadToStorage(plan.upload, new File([bytes], 'probe.txt'));
  await uploads.finish(plan.id, device, thread);
  const [attachment] = await uploads.attachments([plan.id], device, thread);
  assert.deepEqual(await readFile(attachment.path), bytes);
  checks.directUploadAndDesktopChecksum = true;
} catch {
  process.exitCode = 1;
  console.error('Storage acceptance failed; inspect local adapter configuration. No credentials logged.');
} finally {
  const cleanup = await Promise.allSettled([...keys].map((key) => storage.remove!(key)));
  checks.temporaryObjectsRemoved = cleanup.every((result) => result.status === 'fulfilled');
  if (!checks.temporaryObjectsRemoved) process.exitCode = 1;
  await rm(dir, { recursive: true, force: true });
  await privateOutput('.test-output');
  await writeFile(
    '.test-output/storage-results.json',
    JSON.stringify({ date: new Date().toISOString(), checks }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(checks));
}
