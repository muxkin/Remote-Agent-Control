import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeFile, MediaService } from '../src/server/media.js';
import { fixtureConfig } from './helpers.js';
import { loadStorage } from '../src/server/object-storage.js';
vi.mock('../src/server/object-storage.js', async (original) => ({
  ...(await original<typeof import('../src/server/object-storage.js')>()),
  loadStorage: vi.fn(),
}));
function cloud(config: ReturnType<typeof fixtureConfig>) {
  config.media = { adapterPath: '/test/adapter.mjs' };
  const put = vi.fn().mockResolvedValue('created');
  vi.mocked(loadStorage).mockResolvedValue({
    version: 1,
    visibility: 'private',
    uploadOrigins: [],
    putFile: put,
    downloadUrl: async (key, expiresAt) =>
      `https://private.example.com/${key}?token=fixture&expires=${expiresAt}`,
    createUpload: vi.fn(),
  });
  return put;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanups.splice(0).forEach((fn) => fn());
});
function fixture() {
  const config = fixtureConfig();
  const file = join(config.desktopRoot, 'video.mp4');
  writeFileSync(file, '0123456789');
  cleanups.push(() => rmSync(config.desktopRoot, { recursive: true, force: true }));
  return { config, file, messages: [{ id: 'm', role: 'assistant' as const, text: `[video](${file})` }] };
}
it('authorizes exact emitted file links, including files outside the project', async () => {
  const { config, file, messages } = fixture();
  expect(await authorizeFile(file, config.desktopRoot, messages)).toBe(file);
  await expect(
    authorizeFile(file, config.desktopRoot, [{ ...messages[0], text: `[wrong](${file}-different)` }]),
  ).rejects.toThrow();
  const outside = mkdtempSync(join(tmpdir(), 'pocket-outside-'));
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.txt'), 'private');
  const link = join(config.desktopRoot, 'link.txt');
  symlinkSync(join(outside, 'secret.txt'), link);
  expect(await authorizeFile(link, config.desktopRoot, [{ ...messages[0], text: `[file](${link})` }])).toBe(
    join(outside, 'secret.txt'),
  );
  await expect(authorizeFile(join(outside, 'secret.txt'), config.desktopRoot, messages)).rejects.toThrow();
});
it('binds local attachment grants to one device, file version and short lifetime', async () => {
  const { config, file } = fixture();
  const service = new MediaService(config);
  const result = await service.resolve(file, 'phone');
  const token = result.url.split('/').at(-1)!;
  expect(await service.grant(token, 'phone')).not.toBeNull();
  expect(await service.grant(token, 'other')).toBeNull();
  writeFileSync(file, 'changed');
  expect(await service.grant(token, 'phone')).toBeNull();
});
it('uploads private media once and returns only a short signed URL', async () => {
  const { config, file } = fixture();
  const put = cloud(config);
  const service = new MediaService(config);
  const first = await service.resolve(file, 'phone');
  await service.resolve(file, 'phone');
  expect(put).toHaveBeenCalledTimes(1);
  expect(first.source).toBe('object-storage');
  expect(first.url).toContain('https://private.example.com/codex-pocket/private-media/');
  expect(first.url).toContain('token=');
  expect(first.url).not.toContain('test-secret');
  expect(first.expiresAt - Date.now()).toBeLessThanOrEqual(300000);
});
it('starts the download lifetime after a slow upload completes', async () => {
  const { config, file } = fixture();
  const put = cloud(config);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  put.mockImplementation(async () => {
    vi.setSystemTime(600000);
    return 'created';
  });
  const result = await new MediaService(config).resolve(file, 'phone');
  expect(result.expiresAt).toBe(900000);
});

it.each([
  ['中文.TXT', Buffer.from('中文附件 ✅ 📱\n'), 'text/plain; charset=utf-8'],
  ['state.json', Buffer.from('{"内容":"中文"}'), 'application/json; charset=utf-8'],
  ['split.md', Buffer.from('a'.repeat(65535) + '中文'), 'text/plain; charset=utf-8'],
  ['legacy.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'application/octet-stream'],
  ['truncated.txt', Buffer.from([0xe4, 0xb8]), 'application/octet-stream'],
  ['binary.txt', Buffer.from([0, 1, 2]), 'application/octet-stream'],
])('serves %s with a byte-validated charset through both transports', async (name, bytes, mime) => {
  const { config } = fixture();
  const file = join(config.desktopRoot, name);
  writeFileSync(file, bytes);
  const local = new MediaService(config);
  const grant = await local.resolve(file, 'phone');
  expect((await local.grant(grant.url.split('/').at(-1)!, 'phone'))?.mimeType).toBe(mime);
  const put = cloud(config);
  const remote = await new MediaService(config).resolve(file, 'phone');
  expect(put.mock.calls[0][0]?.contentType).toBe(mime);
  // Old objects with identical bytes had no charset. Do not reuse their cached headers.
  expect(new URL(remote.url).pathname).toContain('/private-media/text-v1/');
  expect(put.mock.calls[0][0]?.file).toBe(file);
});

it('supports generated, downloaded, spaced and file-URL image references only when attached to this conversation', async () => {
  const { config } = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'pocket-shared-images-'));
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
  const file = join(outside, 'external photo.png');
  writeFileSync(file, 'image');
  const messages = [{ id: 'generated:media:0', role: 'assistant' as const, text: `![图片](<${file}>)` }];
  expect(await authorizeFile(encodeURI(file), config.desktopRoot, messages)).toBe(file);
  expect(await authorizeFile(`file://${encodeURI(file)}`, config.desktopRoot, messages)).toBe(file);
  expect(
    await authorizeFile(file, config.desktopRoot, [
      { ...messages[0], text: `![图片][photo]\n\n[photo]: <${file}>` },
    ]),
  ).toBe(file);
  await expect(
    authorizeFile(file, config.desktopRoot, [
      { ...messages[0], text: `\`\`\`md\n![图片](<${file}>)\n\`\`\`` },
    ]),
  ).rejects.toThrow();
  await expect(authorizeFile(file, config.desktopRoot, [])).rejects.toThrow();
  await expect(
    authorizeFile(file, config.desktopRoot, [{ ...messages[0], id: 'user', role: 'user' }]),
  ).rejects.toThrow();
  await expect(
    authorizeFile('https://example.com/picture.png', config.desktopRoot, messages),
  ).rejects.toThrow();
});
