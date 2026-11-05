import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../src/server/config.js';
import { FileService } from '../src/server/file-service.js';
import { Uploads } from '../src/server/uploads.js';
import { BLOCK_SIZE, hashBytes, encryptBlock, decryptBlock } from '../src/shared/files.js';
import { uploadToStorage } from '../src/web/storage-upload.js';
import { loadStorage } from '../src/server/object-storage.js';
const base = readConfig();
if (!base.media) throw Error('Private storage not configured');
const stateDir = await mkdtemp(join(tmpdir(), 'pocket-v2-storage-')),
  config = { ...base, stateDir };
const uploads = new Uploads({ ...config, media: undefined }),
  files = new FileService(config, uploads);
const device = crypto.randomUUID(),
  threadId = crypto.randomUUID(),
  checks: Record<string, boolean> = {};
const storage = await loadStorage(base.media, 'media', base.origin);
try {
  const bytes = Buffer.alloc(BLOCK_SIZE * 9 + 39, 21);
  bytes.write('PRIVATE_PAYLOAD_ONLY_ENDPOINTS_CAN_READ');
  const hashes = [];
  for (let i = 0; i < bytes.length; i += BLOCK_SIZE)
    hashes.push(hashBytes(bytes.subarray(i, i + BLOCK_SIZE)));
  const manifest = await files.begin(
    { name: 'private-file-name.txt', size: bytes.length, sha256: hashBytes(bytes), hashes },
    device,
    threadId,
  );
  const indices = hashes.map((_, i) => i),
    body = { fileId: manifest.id, threadId };
  const { value: plan } = await files.handle('storage-plan', { ...body, indices }, device);
  const parts = [];
  for (const i of indices)
    parts.push(
      (await encryptBlock(
        manifest,
        i,
        bytes.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE),
      )) as Uint8Array<ArrayBuffer>,
    );
  const encrypted = Buffer.concat(parts);
  assert.ok(!encrypted.includes('PRIVATE_PAYLOAD_ONLY_ENDPOINTS_CAN_READ'));
  assert.ok(!encrypted.includes(manifest.name));
  await uploadToStorage(plan.upload, new File(parts, 'data', { type: 'application/octet-stream' }));
  await files.handle('storage-import', { ...body, objectId: plan.objectId }, device);
  await files.handle('finish', body, device);
  const [attachment] = await uploads.attachments([manifest.id], device, threadId);
  assert.equal(hashBytes(await readFile(attachment.path)), manifest.sha256);
  checks.encryptedUploadAndDesktopIntegrity = true;
  const download = await files.describe(attachment.path, device, threadId);
  const { value: dp } = await files.handle(
    'storage-plan',
    { fileId: download.id, threadId, indices: [0, 1] },
    device,
  );
  const range = await fetch(dp.url, {
    headers: { Range: `bytes=0-${BLOCK_SIZE + 15}` },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(range.status, 206);
  assert.match(range.headers.get('content-type') ?? '', /application\/octet-stream/);
  const chunk = new Uint8Array(await range.arrayBuffer());
  assert.equal(hashBytes(await decryptBlock(download, 0, chunk)), hashes[0]);
  await files.handle('storage-done', { fileId: download.id, threadId, objectId: dp.objectId }, device);
  checks.encryptedDownloadRangeAndIntegrity = true;
  checks.noNamesOrPlaintextInObjects = true;
} catch (error) {
  process.exitCode = 1;
  checks.failed = false;
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : 'Encrypted storage test failed (credentials and URLs redacted)',
  );
} finally {
  files.close();
  for (const name of await readdir(join(stateDir, 'transfers-v2')))
    if (name.endsWith('.object')) {
      const object = JSON.parse(await readFile(join(stateDir, 'transfers-v2', name), 'utf8'));
      await storage.remove?.(object.key);
    }
  await rm(stateDir, { recursive: true, force: true });
  await writeFile(
    '.test-output/v2-storage-results.json',
    JSON.stringify({ checks, metrics: files.metrics }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ checks, metrics: files.metrics }));
}
