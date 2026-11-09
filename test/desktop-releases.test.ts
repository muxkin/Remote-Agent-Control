import { it, expect } from 'vitest';
import { desktopRelease, releaseKey } from '../src/shared/desktop-releases.js';
const bytes = new TextEncoder().encode('0123456789');
const store = {
  head: async () => ({ size: 10, etag: '"test"' }),
  read: async (_key: string, range?: { offset: number; length: number }) =>
    new Response(range ? bytes.slice(range.offset, range.offset + range.length) : bytes).body,
};
it('serves full and range downloads, HEAD and cache validation with the shared release contract', async () => {
  const url = 'https://example.com/downloads/desktop/linux/x64/AgentSpace-0.4.0-linux-x64.AppImage';
  const full = await desktopRelease(new Request(url), store);
  expect(await full.text()).toBe('0123456789');
  const part = await desktopRelease(new Request(url, { headers: { Range: 'bytes=2-5' } }), store);
  expect(part.status).toBe(206);
  expect(part.headers.get('Content-Range')).toBe('bytes 2-5/10');
  expect(await part.text()).toBe('2345');
  const head = await desktopRelease(new Request(url, { method: 'HEAD' }), store);
  expect(head.headers.get('Content-Length')).toBe('10');
  expect(await head.text()).toBe('');
  expect((await desktopRelease(new Request(url, { headers: { Range: 'bytes=20-30' } }), store)).status).toBe(
    416,
  );
  expect(
    (await desktopRelease(new Request(url, { headers: { 'If-None-Match': '"test"' } }), store)).status,
  ).toBe(304);
  const manifest = await desktopRelease(
    new Request('https://example.com/downloads/desktop/releases.json'),
    store,
  );
  expect(manifest.headers.get('Cache-Control')).toBe('no-cache');
});
it('does not expose private media keys or arbitrary paths', async () => {
  for (const path of [
    '/downloads/desktop/private/image.png',
    '/downloads/desktop/linux/x64/../../../identity.json',
    '/downloads/desktop/linux/x64/secret.env',
    '/downloads/desktop/linux/x64/latest.yml/extra',
  ])
    expect(releaseKey(path)).toBeNull();
  expect(
    (
      await desktopRelease(
        new Request('https://example.com/downloads/desktop/releases.json', { method: 'POST' }),
        store,
      )
    ).status,
  ).toBe(405);
});
it('publishes the same artifacts to a persistent VPS directory, preserves other platforms, and rejects corruption', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const { fileReleaseStore } = await import('../src/server/desktop-releases.js');
  const root = await mkdtemp(join(tmpdir(), 'desktop-publish-'));
  const input = join(root, 'input'),
    output = join(root, 'persistent');
  try {
    await mkdir(input);
    const file = 'AgentSpace-0.4.0-linux-x86_64.AppImage';
    await writeFile(join(input, file), bytes);
    const manifest = {
      version: '0.4.0',
      files: [{ url: file, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }],
    };
    await writeFile(join(input, 'latest-linux.yml'), JSON.stringify(manifest));
    await mkdir(join(output, 'desktop-releases'), { recursive: true });
    const previous = { platform: 'darwin', arch: 'arm64', file: 'AgentSpace-0.4.0-mac-arm64.dmg' };
    await writeFile(join(output, 'desktop-releases/releases.json'), JSON.stringify({ files: [previous] }));
    const publish = () =>
      spawnSync(
        process.execPath,
        [
          'scripts/desktop/publish.mjs',
          '--directory',
          input,
          '--output',
          output,
          '--platform',
          'linux',
          '--arch',
          'x64',
        ],
        { encoding: 'utf8' },
      );
    const first = publish();
    expect(first.status, first.stderr).toBe(0);
    const index = JSON.parse(await readFile(join(output, 'desktop-releases/releases.json'), 'utf8'));
    expect(index.files).toContainEqual(previous);
    expect(index.files).toContainEqual(expect.objectContaining({ platform: 'linux', arch: 'x64', file }));
    const response = await desktopRelease(
      new Request(`https://vps.example/downloads/desktop/linux/x64/${file}`, {
        headers: { Range: 'bytes=1-3' },
      }),
      fileReleaseStore(output),
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('123');
    expect(publish().stderr).toContain('Immutable release already exists');
    await writeFile(join(input, file), 'corrupted');
    expect(publish().stderr).toContain('Release integrity mismatch');
    expect(JSON.parse(await readFile(join(output, 'desktop-releases/releases.json'), 'utf8'))).toEqual(index);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
