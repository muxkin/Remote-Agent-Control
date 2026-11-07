import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StorageAdapter } from '../src/server/object-storage.js';
import { MessagingStore } from './messaging-fixtures.js';
import { MessagingStore as SecureStore } from '../src/server/messaging/store.js';
import { buildRelay } from '../src/server/relay.js';
import { protectAccount, decryptFor, decode64, unseal } from '../src/shared/account-crypto.js';
import { assertEncryptedDatabase } from '../src/server/messaging/encryption-state.js';
import { exportJob, encryptJob, applyParts, snapshotId } from '../scripts/lib/im-encryption-migration.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllGlobals();
});
it('migrates existing identities, message history, attachments, stickers and signed answers into the same encrypted format', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-encryption-migration-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'source.sqlite'),
    candidatePath = join(dir, 'encrypted.sqlite');
  const store = new MessagingStore(sourcePath);
  cleanup.push(() => store.close());
  const alice = store.createUser('human', 'alice', 'Alice', 'old-password-hash'),
    bob = store.createUser('human', 'bob', 'Bob', 'old-password-hash');
  const agent = store.registerAgent(store.invite(alice.id).invitation, 'agent', 'Agent').user;
  store.addContact(alice.id, bob.id);
  const group = store.createGroup(alice.id, 'Group', [bob.id, agent.id]);
  const file = store.upload(
    alice.id,
    group.id,
    'migration-private-file.txt',
    Buffer.from('migration-private-bytes'),
  );
  const first = store.send(alice.id, group.id, 'first', 'migration-private-text', {
    attachmentIds: [file.id],
    mentions: [bob.id],
  });
  const second = store.send(bob.id, group.id, 'reply', 'migration-private-reply', { replyTo: first.id });
  const approval = store.send(agent.id, group.id, 'approve', 'migration-private-task', {
    interaction: {
      kind: 'approval',
      recipientId: alice.id,
      title: 'migration-private-title',
      description: 'migration-private-description',
    },
  });
  store.respond(alice.id, group.id, approval.id, {
    decision: 'approve',
    comment: 'migration-private-response',
  });
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const image = store.upload(alice.id, group.id, 'migration-private-image.png', png);
  const imageMessage = store.send(alice.id, group.id, 'image', '', { attachmentIds: [image.id] });
  store.saveSticker(alice.id, group.id, image.id);
  expect(() => assertEncryptedDatabase(store.db)).toThrow('一次性');
  await expect(
    buildRelay({
      origin: 'https://chat.test',
      webRoot: '/missing',
      assetOrigin: null,
      uploadOrigins: [],
      enrollmentSecret: 'migration-test-secret-enrollment-32',
      messaging: { database: sourcePath },
    }),
  ).rejects.toThrow('一次性');
  const originalBytes = Buffer.from('migration-private-bytes'),
    objectKey = 'old-media-object',
    hash = createHash('sha256').update(originalBytes).digest('hex');
  store.db.prepare('INSERT INTO im_media_objects VALUES (?,?,?)').run(
    'file',
    file.id,
    JSON.stringify({
      key: objectKey,
      previewKey: objectKey,
      hash,
      previewHash: hash,
      previewMime: 'text/plain',
      previewSize: originalBytes.length,
    }),
  );
  store.db.prepare("UPDATE im_files SET data=x'' WHERE id=?").run(file.id);
  const storage = {
    version: 1,
    visibility: 'private',
    uploadOrigins: [],
    downloadUrl: async () => 'https://media.test/old',
  } as unknown as StorageAdapter;
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(originalBytes)));
  const snapshot = snapshotId(store.db),
    users = [alice, bob, agent];
  const protectedAccounts = await Promise.all(
    users.map((user) => protectAccount(`new-password-for-${user.username}`)),
  );
  const directory = Object.fromEntries(
    users.map((user, i) => [user.id, protectedAccounts[i].secrets.publicKeys]),
  );
  const jobs = await Promise.all(users.map((user) => exportJob(store, user.id, storage)));
  const parts = await Promise.all(
    jobs.map((job, i) =>
      encryptJob(
        job,
        protectedAccounts[i].secrets,
        {
          userId: job.user.id,
          vault: protectedAccounts[i].vault,
          auth: protectedAccounts[i].auth,
          recoveryAuth: protectedAccounts[i].recoveryAuth,
        },
        directory,
      ),
    ),
  );
  expect(jobs[1].messages.some((m) => m.id === first.id)).toBe(false);
  store.db.prepare('VACUUM INTO ?').run(candidatePath);
  const candidate = new SecureStore(candidatePath);
  cleanup.push(() => candidate.close());
  await expect(applyParts(candidate, parts.slice(1))).rejects.toThrow('each account');
  expect(snapshotId(candidate.db)).toBe(snapshot);
  const tampered = structuredClone(parts);
  tampered[0].messages[0].text += 'x';
  await expect(applyParts(candidate, tampered)).rejects.toThrow('signature');
  expect(snapshotId(candidate.db)).toBe(snapshot);
  const receipt = await applyParts(candidate, parts);
  expect(receipt.retiredObjects).toEqual([objectKey]);
  expect(receipt.messages).toBe(4);
  expect(receipt.attachments).toBe(3);
  expect(() => assertEncryptedDatabase(candidate.db)).not.toThrow();
  expect(snapshotId(store.db)).toBe(snapshot); // Source remains intact until explicit atomic cutover.
  const history = candidate.history(alice.id, group.id).messages;
  expect(history.map((m) => m.id)).toEqual([first.id, second.id, approval.id, imageMessage.id]);
  for (const recipient of [0, 1]) {
    const message = history[0];
    const content = await decryptFor<any>(
      protectedAccounts[recipient].secrets,
      users[recipient].id,
      alice.id,
      directory[alice.id],
      `message:${group.id}:first:0`,
      message.text,
    );
    expect(content.text).toBe('migration-private-text');
    expect(content.options.attachmentIds).toEqual([file.id]);
    const meta = candidate.file(users[recipient].id, group.id, file.id);
    const secret = await decryptFor<any>(
      protectedAccounts[recipient].secrets,
      users[recipient].id,
      alice.id,
      directory[alice.id],
      `attachment:${group.id}:${file.id}`,
      meta.encrypted!,
    );
    expect(secret.name).toBe('migration-private-file.txt');
    expect(
      new TextDecoder().decode(
        await unseal(
          decode64(secret.key),
          { iv: secret.iv, data: Buffer.from(meta.data).toString('base64') },
          secret.context,
        ),
      ),
    ).toBe('migration-private-bytes');
  }
  const response = history[2].interaction!.response!;
  expect(
    await decryptFor(
      protectedAccounts[2].secrets,
      agent.id,
      alice.id,
      directory[alice.id],
      `response:${group.id}:${approval.id}:${approval.interaction!.id}`,
      'decision' in response ? response.comment! : '',
    ),
  ).toEqual({ decision: 'approve', comment: 'migration-private-response' });
  const text = readFileSync(candidatePath).toString('latin1');
  expect(text).not.toContain('migration-private-');
  expect(text).not.toContain(protectedAccounts[0].secrets.root);
  const relay = await buildRelay({
    origin: 'https://chat.test',
    webRoot: '/missing',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'migration-test-secret-enrollment-32',
    messaging: { database: candidatePath },
  });
  cleanup.push(() => relay.app.close());
  for (const path of ['/register', '/login', '/password', '/crypto/upgrade', '/crypto/agent'])
    expect(
      (
        await relay.app.inject({
          method: 'POST',
          url: `/api/im${path}`,
          headers: { host: 'chat.test', origin: 'https://chat.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
});

it('CLI verifies the frozen source and atomically switches once, with safe retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'im-migration-cli-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'source.sqlite'),
    output = join(dir, 'encrypted.sqlite'),
    receipt = join(dir, 'receipt.json');
  const store = new MessagingStore(sourcePath);
  const user = store.createUser('human', 'alice', 'Alice', 'previous-password-hash');
  const keys = await protectAccount('new-password-for-cli');
  const job = await exportJob(store, user.id);
  const part = await encryptJob(
    job,
    keys.secrets,
    { userId: user.id, vault: keys.vault, auth: keys.auth, recoveryAuth: keys.recoveryAuth },
    { [user.id]: keys.secrets.publicKeys },
  );
  store.close();
  const partPath = join(dir, 'part.json'),
    partsPath = join(dir, 'parts.json');
  writeFileSync(partPath, JSON.stringify(part));
  writeFileSync(partsPath, JSON.stringify([partPath]));
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/im-encryption-migrate.ts', ...args]);
  await run('apply', '--database', sourcePath, '--parts', partsPath, '--out', output, '--receipt', receipt);
  const changed = new MessagingStore(sourcePath);
  changed.db.prepare('UPDATE im_users SET display_name=? WHERE id=?').run('Changed', user.id);
  changed.close();
  await expect(run('commit', '--database', sourcePath, '--receipt', receipt)).rejects.toThrow(
    'Source changed',
  );
  const restored = new MessagingStore(sourcePath);
  restored.db.prepare('UPDATE im_users SET display_name=? WHERE id=?').run('Alice', user.id);
  restored.close();
  expect(
    JSON.parse((await run('commit', '--database', sourcePath, '--receipt', receipt)).stdout).committed,
  ).toBe(true);
  expect(
    JSON.parse((await run('commit', '--database', sourcePath, '--receipt', receipt)).stdout).committed,
  ).toBe(true);
  const migrated = new SecureStore(sourcePath);
  expect(() => assertEncryptedDatabase(migrated.db)).not.toThrow();
  migrated.close();
});
