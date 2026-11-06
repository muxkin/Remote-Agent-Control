import { afterEach, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileService } from '../src/server/file-service.js';
import { Uploads } from '../src/server/uploads.js';
import { BLOCK_SIZE, hashBytes, encryptBlock, decryptBlock, fileRoute } from '../src/shared/files.js';
import { fixtureConfig, THREAD } from './helpers.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
it('resumes noncontiguous validated chunks and preserves existing desktop upload references', async () => {
  const config = fixtureConfig(),
    uploads = new Uploads(config),
    files = new FileService(config, uploads);
  cleanups.push(async () => {
    files.close();
    await rm(config.desktopRoot, { recursive: true, force: true });
  });
  const bytes = new Uint8Array(BLOCK_SIZE * 2 + 37).fill(19),
    hashes = [];
  for (let i = 0; i < bytes.length; i += BLOCK_SIZE)
    hashes.push(hashBytes(bytes.subarray(i, i + BLOCK_SIZE)));
  const manifest = await files.begin(
    { name: 'sample.bin', size: bytes.length, sha256: hashBytes(bytes), hashes },
    'phone',
    THREAD,
  );
  const call = (action: string, extra = {}, block?: Uint8Array) =>
    files.handle(action, { threadId: THREAD, fileId: manifest.id, ...extra }, 'phone', block);
  await call('write', { index: 2 }, bytes.subarray(BLOCK_SIZE * 2));
  await call('write', { index: 0 }, bytes.subarray(0, BLOCK_SIZE));
  expect((await call('missing')).value.missing).toEqual([1]);
  await expect(call('finish')).rejects.toThrow('incomplete');
  await expect(call('write', { index: 1 }, new Uint8Array(BLOCK_SIZE))).rejects.toThrow('Invalid');
  await call('write', { index: 1 }, bytes.subarray(BLOCK_SIZE, BLOCK_SIZE * 2));
  await call('finish');
  const [attachment] = await uploads.attachments([manifest.id], 'phone', THREAD);
  expect(hashBytes(await readFile(attachment.path))).toBe(manifest.sha256);
  await expect(
    files.handle('read', { fileId: manifest.id, threadId: THREAD, index: 0 }, 'stranger'),
  ).rejects.toThrow();
});
it('rejects ciphertext substitution, mutation, and truncation and detects original file changes', async () => {
  const config = fixtureConfig(),
    files = new FileService(config, new Uploads(config));
  cleanups.push(async () => {
    files.close();
    await rm(config.desktopRoot, { recursive: true, force: true });
  });
  const file = join(config.desktopRoot, 'file.bin'),
    bytes = new Uint8Array(BLOCK_SIZE * 2).fill(6);
  await writeFile(file, bytes);
  const m = await files.describe(file, 'phone', THREAD),
    block = bytes.subarray(0, BLOCK_SIZE),
    encrypted = await encryptBlock(m, 0, block);
  expect(await decryptBlock(m, 0, encrypted)).toEqual(block);
  await expect(decryptBlock(m, 1, encrypted)).rejects.toThrow();
  await expect(decryptBlock(m, 0, encrypted.subarray(1))).rejects.toThrow();
  encrypted[30] ^= 1;
  await expect(decryptBlock(m, 0, encrypted)).rejects.toThrow();
  await writeFile(file, new Uint8Array(3));
  await expect(files.handle('read', { threadId: THREAD, fileId: m.id, index: 0 }, 'phone')).rejects.toThrow(
    'changed',
  );
  expect(fileRoute(9 * BLOCK_SIZE, true, true)).toBe('direct');
  expect(fileRoute(9 * BLOCK_SIZE, false, true)).toBe('storage');
  expect(fileRoute(8 * BLOCK_SIZE, false, true)).toBe('relay');
  expect(fileRoute(9 * BLOCK_SIZE, false, false)).toBe('relay');
});
it.each([
  [
    '化学势参考修正.docx',
    Buffer.from('PK\x03\x04word-bytes'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  ['热修复包.tar.gz', Buffer.from([0x1f, 0x8b, 0, 255, 128, 32]), 'application/gzip'],
  ['中文说明.txt', Buffer.from('中文说明，保持 UTF-8。'), 'text/plain; charset=utf-8'],
])('keeps %s filename, MIME and exact bytes through the transfer manifest', async (name, bytes, mime) => {
  const config = fixtureConfig(),
    files = new FileService(config, new Uploads(config));
  cleanups.push(async () => {
    files.close();
    await rm(config.desktopRoot, { recursive: true, force: true });
  });
  const path = join(config.desktopRoot, name);
  await writeFile(path, bytes);
  const manifest = await files.describe(path, 'phone', THREAD);
  expect(manifest).toMatchObject({ name, mime, size: bytes.length, sha256: hashBytes(bytes) });
  const result = await files.handle('read', { threadId: THREAD, fileId: manifest.id, index: 0 }, 'phone');
  expect(result.bytes).toEqual(bytes);
});
