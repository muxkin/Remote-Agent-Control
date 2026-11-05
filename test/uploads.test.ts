import { test, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { Uploads, uploadSpec } from '../src/server/uploads.js';
import { fixtureConfig, THREAD } from './helpers.js';
import * as storage from '../src/server/object-storage.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(['valid', 'checksum', 'oversized'])(
  'direct uploads preserve ownership and reject %s data when invalid',
  async (kind) => {
    const config = fixtureConfig();
    config.media = { adapterPath: '/test/adapter.mjs' };
    const bytes = Buffer.from('中文附件 ✅');
    const createUpload = vi
      .fn()
      .mockResolvedValue({ url: 'https://upload.example.com/object', method: 'PUT', encoding: 'raw' });
    vi.spyOn(storage, 'loadStorage').mockResolvedValue({
      version: 1,
      visibility: 'private',
      uploadOrigins: ['https://upload.example.com'],
      putFile: vi.fn(),
      createUpload,
      downloadUrl: async () => 'https://media.example.com/object?grant=fixture',
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(kind === 'valid' ? bytes : Buffer.alloc(bytes.length + (kind === 'oversized' ? 1 : 0))),
      );
    vi.stubGlobal('fetch', fetcher);
    const uploads = new Uploads(config);
    try {
      const plan = await uploads.begin(
        { name: 'sample.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        'device',
        THREAD,
      );
      expect(plan).toMatchObject({ route: 'object-storage', upload: { method: 'PUT', encoding: 'raw' } });
      expect(createUpload.mock.calls[0][0]).toMatchObject({ size: bytes.length });
      await expect(uploads.finish(plan.id, 'another-device', THREAD)).rejects.toThrow();
      await expect(uploads.finish(plan.id, 'device', 'another-thread')).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      await expect(uploads.chunk(plan.id, 'device', THREAD, 0, bytes)).rejects.toThrow();
      if (kind === 'valid') {
        await uploads.finish(plan.id, 'device', THREAD);
        const [attachment] = await uploads.attachments([plan.id], 'device', THREAD);
        expect(await readFile(attachment.path)).toEqual(bytes);
      } else {
        await expect(uploads.finish(plan.id, 'device', THREAD)).rejects.toThrow(
          kind === 'checksum' ? 'checksum' : 'size',
        );
        await expect(uploads.attachments([plan.id], 'device', THREAD)).rejects.toThrow();
      }
      expect(fetcher.mock.calls[0][1].redirect).toBe('error');
    } finally {
      await rm(config.desktopRoot, { recursive: true, force: true });
    }
  },
);
test('uploads enforce device, thread, offsets, hash and completed attachment ownership', async () => {
  const config = fixtureConfig(),
    uploads = new Uploads(config),
    bytes = Buffer.from('手机附件\n');
  try {
    const plan = await uploads.begin(
      { name: '材料.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      'device',
      THREAD,
    );
    await expect(uploads.get(plan.id, 'other', THREAD)).rejects.toThrow();
    await expect(uploads.get(plan.id, 'device', 'other-thread')).rejects.toThrow();
    await expect(uploads.attachments([plan.id], 'device', THREAD)).rejects.toThrow();
    await expect(uploads.chunk(plan.id, 'device', THREAD, 1, bytes)).rejects.toThrow();
    await uploads.chunk(plan.id, 'device', THREAD, 0, bytes.subarray(0, 3));
    await expect(uploads.finish(plan.id, 'device', THREAD)).rejects.toThrow();
    await uploads.chunk(plan.id, 'device', THREAD, 3, bytes.subarray(3));
    await uploads.finish(plan.id, 'device', THREAD);
    expect(await uploads.finish(plan.id, 'device', THREAD)).toMatchObject({ id: plan.id });
    const [file] = await uploads.attachments([plan.id], 'device', THREAD);
    expect(await readFile(file.path)).toEqual(bytes);
    await expect(uploads.chunk(plan.id, 'device', THREAD, bytes.length, Buffer.from('x'))).rejects.toThrow();
  } finally {
    await rm(config.desktopRoot, { recursive: true, force: true });
  }
});
test('corrupted upload never becomes an attachment; unsafe paths and oversized files rejected', async () => {
  const c = fixtureConfig(),
    u = new Uploads(c);
  try {
    const p = await u.begin({ name: 'file.txt', size: 3, sha256: '0'.repeat(64) }, 'd', THREAD);
    await u.chunk(p.id, 'd', THREAD, 0, Buffer.from('bad'));
    await expect(u.finish(p.id, 'd', THREAD)).rejects.toThrow('checksum');
    await expect(u.attachments([p.id], 'd', THREAD)).rejects.toThrow();
    for (const name of ['../key', '/tmp/key', 'bad\nname', 'a\\b'])
      expect(uploadSpec.safeParse({ name, size: 1, sha256: '0'.repeat(64) }).success).toBe(false);
  } finally {
    await rm(c.desktopRoot, { recursive: true, force: true });
  }
});
