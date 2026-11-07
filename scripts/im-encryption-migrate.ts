/** Run offline on a stopped relay, except prepare/encrypt which run on each owner's device. */
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, chmod, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { MessagingStore } from '../src/server/messaging/store.js';
import { assertEncryptedDatabase } from '../src/server/messaging/encryption-state.js';
import { loadStorage } from '../src/server/object-storage.js';
import {
  protectAccount,
  unlockAccount,
  canonical,
  type AccountSecrets,
  type PublicAccountKeys,
} from '../src/shared/account-crypto.js';
import {
  exportJob,
  encryptJob,
  applyParts,
  snapshotId,
  type MigrationJob,
  type Enrollment,
  type MigrationPart,
} from './lib/im-encryption-migration.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    [
      'database',
      'out',
      'job',
      'state',
      'directory',
      'enrollments',
      'parts',
      'candidate',
      'receipt',
      'origin',
      'adapter',
      'agent-state',
    ].map((name) => [name, { type: 'string' as const }]),
  ),
});
const required = (name: keyof typeof values) => {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw Error(`Missing --${name}`);
  return value;
};
const json = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
async function password(prompt: string) {
  if (!process.stdin.isTTY)
    throw Error(
      'Password entry requires an interactive terminal; passwords are never command-line arguments',
    );
  process.stderr.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let result = '';
    const done = () => {
      process.stdin.off('keypress', key);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    const key = (text: string, event: { name?: string; ctrl?: boolean }) => {
      if (event.ctrl && event.name === 'c') {
        done();
        reject(Error('Cancelled'));
      } else if (event.name === 'return') {
        done();
        resolve(result);
      } else if (event.name === 'backspace') result = result.slice(0, -1);
      else if (text && !event.ctrl && !text.includes('\x1b')) result += text;
    };
    process.stdin.on('keypress', key);
  });
}
async function adapter() {
  return values.adapter
    ? loadStorage({ adapterPath: resolve(String(values.adapter)) }, 'media', required('origin'))
    : undefined;
}
async function main() {
  switch (positionals[0]) {
    case 'export': {
      const store = new MessagingStore(required('database'));
      try {
        const storage = await adapter(),
          out = required('out');
        for (const row of store.db.prepare('SELECT id FROM im_users ORDER BY id').all())
          await save(
            `${out}/${row.id}.json`,
            await exportJob(
              store,
              String(row.id),
              storage,
              String(values.origin ?? 'https://migration.invalid'),
            ),
          );
        return { exported: true, directory: out };
      } finally {
        store.close();
      }
    }
    case 'prepare': {
      const job = await json<MigrationJob>(required('job'));
      const existing = values['agent-state']
        ? await json<{ user?: { id: string }; secrets?: AccountSecrets }>(String(values['agent-state']))
        : {};
      if (existing.user && existing.user.id !== job.user.id)
        throw Error('Agent state belongs to another account');
      let secrets: AccountSecrets,
        enrollment: Enrollment,
        recoveryCode = '';
      if (job.vault) {
        if (job.user.kind === 'agent' && existing.secrets) {
          secrets = existing.secrets;
          if (canonical(secrets.publicKeys) !== canonical(job.vault.publicKeys))
            throw Error('Agent key mismatch');
        } else ({ secrets } = await unlockAccount(job.vault, await password('当前账号密码（不回显）：')));
        enrollment = { userId: job.user.id, vault: job.vault };
      } else {
        const first =
          job.user.kind === 'agent'
            ? randomUUID() + randomUUID()
            : await password('新的账号密码，至少 10 位（不回显）：');
        if (job.user.kind !== 'agent' && first !== (await password('再次输入新密码：')))
          throw Error('Passwords differ');
        if (job.previousPasswordHash) {
          const [salt, digest] = job.previousPasswordHash.split(':');
          if (!/^[a-f0-9]{128}$/.test(digest ?? '')) throw Error('Invalid previous password verifier');
          if (
            timingSafeEqual(
              scryptSync(first, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }),
              Buffer.from(digest, 'hex'),
            )
          )
            throw Error('请选择一个不同于旧密码的新密码');
        }
        const result = await protectAccount(first);
        ({ secrets, recoveryCode } = result);
        enrollment = {
          userId: job.user.id,
          vault: result.vault,
          auth: result.auth,
          recoveryAuth: result.recoveryAuth,
        };
      }
      await save(required('state'), {
        ...existing,
        user: { ...job.user, encrypted: true },
        secrets,
        vault: enrollment.vault,
        enrollment,
        recoveryCode,
      });
      await save(required('out'), enrollment);
      return {
        prepared: true,
        privateState: required('state'),
        enrollment: required('out'),
        recovery: '恢复码保存在本机 privateState 中；不要上传此文件。',
      };
    }
    case 'directory': {
      const files = await json<string[]>(required('enrollments'));
      const directory: Record<string, PublicAccountKeys> = {};
      for (const file of files) {
        const value = await json<Enrollment>(file);
        if (directory[value.userId]) throw Error('Duplicate account');
        directory[value.userId] = value.vault.publicKeys;
      }
      await save(required('out'), directory);
      return { directory: required('out') };
    }
    case 'encrypt': {
      const state = await json<{ secrets: AccountSecrets; enrollment: Enrollment }>(required('state'));
      const result = await encryptJob(
        await json<MigrationJob>(required('job')),
        state.secrets,
        state.enrollment,
        await json<Record<string, PublicAccountKeys>>(required('directory')),
      );
      await save(required('out'), result);
      return { encrypted: true, roundTripVerified: true, part: required('out') };
    }
    case 'apply': {
      const output = resolve(required('out'));
      if (output === resolve(required('database'))) throw Error('Output must be a new database');
      const files = await json<string[]>(required('parts')),
        parts = await Promise.all(files.map((file) => json<MigrationPart>(file)));
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, '', { flag: 'wx', mode: 0o600 });
      const source = new MessagingStore(required('database'));
      try {
        source.db.prepare('VACUUM INTO ?').run(output);
      } finally {
        source.close();
      }
      const candidate = new MessagingStore(output);
      let completed = false;
      try {
        const receipt = await applyParts(candidate, parts);
        await save(required('receipt'), {
          ...receipt,
          candidateSnapshot: snapshotId(candidate.db),
          candidate: output,
        });
        completed = true;
        return { verified: true, candidate: output, receipt: required('receipt') };
      } finally {
        candidate.close();
        if (completed) await chmod(output, 0o600);
        else
          for (const suffix of ['', '-wal', '-shm'])
            await unlink(output + suffix).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
      }
    }
    case 'commit': {
      const sourcePath = resolve(required('database'));
      const receipt = await json<{
        snapshot: string;
        candidateSnapshot: string;
        candidate: string;
        retiredObjects: string[];
      }>(required('receipt'));
      const storage = await adapter();
      if (receipt.retiredObjects.length && !storage?.remove)
        throw Error('Old media objects need an adapter with remove() before cutover');
      const source = new MessagingStore(sourcePath);
      let committed = false;
      try {
        source.db.exec('PRAGMA wal_checkpoint(TRUNCATE); BEGIN EXCLUSIVE');
        const current = snapshotId(source.db);
        committed = current === receipt.candidateSnapshot;
        if (!committed && current !== receipt.snapshot)
          throw Error('Source changed since export; refusing cutover');
        source.db.exec('COMMIT');
      } finally {
        source.close();
      }
      if (!committed) {
        const candidate = new MessagingStore(receipt.candidate);
        try {
          assertEncryptedDatabase(candidate.db);
          if (snapshotId(candidate.db) !== receipt.candidateSnapshot)
            throw Error('Candidate changed after validation');
          candidate.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally {
          candidate.close();
        }
        for (const suffix of ['-wal', '-shm'])
          await unlink(sourcePath + suffix).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        await rename(receipt.candidate, sourcePath);
      }
      for (const key of receipt.retiredObjects) await storage!.remove!(key);
      return { committed: true, encryptedOnly: true, retiredMediaRemoved: receipt.retiredObjects.length };
    }
    default:
      return {
        usage: 'im:migrate export | prepare | directory | encrypt | apply | commit',
        instructions: 'docs/ACCOUNT_MIGRATION.md',
        note: '私钥仅用于 prepare/encrypt；不要把 --state 文件上传至中继。',
      };
  }
}
main()
  .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Migration failed') + '\n');
    process.exitCode = 1;
  });
