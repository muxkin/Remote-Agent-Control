import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStorage, validateUpload } from '../src/server/object-storage.js';
import { readStorageSettings } from '../src/server/config.js';
import { uploadToStorage } from '../src/web/storage-upload.js';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture(overrides = '') {
  const root = mkdtempSync(join(tmpdir(), 'pocket-adapter-'));
  roots.push(root);
  const adapterPath = join(root, 'adapter.mjs');
  writeFileSync(
    adapterPath,
    `export default () => ({
    version: 1, visibility: 'private', uploadOrigins: ['https://upload.example.com'],
    putFile: async () => 'created', downloadUrl: async () => 'https://media.example.com/file?grant=fixture',
    createUpload: async () => ({}), ${overrides}
  });`,
  );
  return { adapterPath };
}
it('does not enable storage without an explicitly configured local adapter', () => {
  vi.stubEnv('POCKET_MEDIA_ADAPTER', '');
  vi.stubEnv('POCKET_ASSET_ADAPTER', '');
  expect(readStorageSettings('media')).toBeUndefined();
  expect(readStorageSettings('assets')).toBeUndefined();
  vi.stubEnv('POCKET_MEDIA_ADAPTER', 'https://example.com/adapter.mjs');
  expect(() => readStorageSettings('media')).toThrow('local');
});
it('isolates public assets from private media and caches only successful initialization', async () => {
  const settings = fixture();
  const adapter = await loadStorage(settings, 'media', 'https://app.example.com');
  expect(await loadStorage(settings, 'media', 'https://app.example.com')).toBe(adapter);
  await expect(loadStorage(settings, 'assets', 'https://app.example.com')).rejects.toThrow('initialization');
  const invalid = fixture("visibility: 'public'");
  await expect(loadStorage(invalid, 'media', 'https://app.example.com')).rejects.toThrow('initialization');
});
it('sanitizes adapter errors and retries failed initialization', async () => {
  const settings = fixture();
  writeFileSync(
    settings.adapterPath,
    `let attempts = 0; export default () => {
    if (++attempts === 1) throw Error('sensitive-fixture');
    return { version: 1, visibility: 'private', uploadOrigins: [], putFile() {}, downloadUrl() {}, createUpload() {} };
  };`,
  );
  await expect(loadStorage(settings, 'media', 'https://app.example.com')).rejects.toThrow(
    /^Storage adapter initialization failed;/,
  );
  expect((await loadStorage(settings, 'media', 'https://app.example.com')).visibility).toBe('private');
});
it.each([
  'https://*.example.com',
  'https://upload.example.com/;script-src *',
  'http://upload.example.com',
  'https://name:secret@example.com',
])('rejects unsafe CSP origin %s', async (origin) => {
  await expect(
    loadStorage(fixture(`uploadOrigins: [${JSON.stringify(origin)}]`), 'media', 'https://app.example.com'),
  ).rejects.toThrow('initialization');
});
it('only accepts grants targeting declared upload origins and scoped grant fields', async () => {
  const adapter = await loadStorage(fixture(), 'media', 'https://app.example.com');
  const plan = {
    url: 'https://upload.example.com',
    method: 'POST',
    encoding: 'multipart',
    fields: { policy: 'temporary-grant' },
    fileField: 'file',
  };
  expect(validateUpload(plan, adapter)).toEqual(plan);
  expect(() => validateUpload({ ...plan, url: 'https://other.example.com' }, adapter)).toThrow('origin');
  expect(() => validateUpload({ ...plan, fields: { file: 'overlap' } }, adapter)).toThrow('overlaps');
  expect(() => validateUpload({ ...plan, secretKey: 'permanent' }, adapter)).toThrow();
});
it('sends multipart policy fields or raw PUT bytes without browser credentials or redirects', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetcher);
  const file = new File(['中文 ✅'], 'sample.txt');
  await uploadToStorage(
    {
      url: 'https://upload.example.com',
      method: 'POST',
      encoding: 'multipart',
      fields: { policy: 'short-grant', object: 'sample' },
      fileField: 'payload',
    },
    file,
  );
  const multipart = fetcher.mock.calls[0][1];
  expect(multipart.body.get('policy')).toBe('short-grant');
  expect(await multipart.body.get('payload').text()).toBe('中文 ✅');
  expect(multipart).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  await uploadToStorage(
    {
      url: 'https://upload.example.com/signed',
      method: 'PUT',
      encoding: 'raw',
      headers: { 'Content-Type': 'text/plain' },
    },
    file,
  );
  expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: file });
  fetcher.mockResolvedValue({ ok: false });
  await expect(
    uploadToStorage({ url: 'https://upload.example.com/signed', method: 'PUT', encoding: 'raw' }, file),
  ).rejects.toThrow();
});
