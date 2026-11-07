import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from '../src/server/store.js';
import { appearanceImage, normalizeAppearancePatch } from '../src/server/backends/appearance.js';
import { temporaryRuntime } from './temporary-runtime.js';
const paths: string[] = [];
afterEach(() => paths.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
it('persists across database reopen, merges partial tool updates, and detects stale edits even after reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instance-appearance-'));
  paths.push(dir);
  let store = new Store(dir, temporaryRuntime);
  store.updateBackendAppearance(
    'codex-local',
    { name: '编程助手', icon: { kind: 'builtin', value: 'code' } },
    0,
  );
  store.close();
  store = new Store(dir, temporaryRuntime);
  try {
    expect(store.backendAppearance('codex-local').overrides.name).toBe('编程助手');
    store.updateBackendAppearance('codex-local', { description: '' });
    expect(store.backendAppearance('codex-local')).toMatchObject({
      revision: 2,
      overrides: { name: '编程助手', description: '', icon: { value: 'code' } },
    });
    store.updateBackendAppearance('codex-local', { name: null, description: null, icon: null }, 2);
    expect(() => store.updateBackendAppearance('codex-local', { name: 'stale' }, 0)).toThrow(
      '设置已在其他设备',
    );
    expect(store.backendAppearance('codex-local')).toEqual({ revision: 3, overrides: {} });
    expect(store.backendAppearance('dsh-two')).toEqual({ revision: 0, overrides: {} });
  } finally {
    store.close();
  }
});
it('re-encodes images to small raster icons and rejects remote URLs, SVG, malformed data and invalid settings', async () => {
  const png = await sharp({ create: { width: 800, height: 600, channels: 4, background: '#55aaff' } })
    .png()
    .toBuffer();
  const value = await appearanceImage(png);
  const metadata = await sharp(Buffer.from(value.split(',')[1], 'base64')).metadata();
  expect(metadata).toMatchObject({ format: 'webp', width: 192, height: 192 });
  expect(value.length).toBeLessThan(65536);
  expect(
    await normalizeAppearancePatch({ name: '  我的助手  ', icon: { kind: 'emoji', value: '👩🏽‍💻' } }),
  ).toMatchObject({ name: '我的助手' });
  for (const patch of [
    {},
    { name: ' ' },
    { name: 'x'.repeat(81) },
    { product: 'codex' },
    { icon: { kind: 'builtin', value: 'arbitrary' } },
    { icon: { kind: 'emoji', value: 'hello' } },
    { icon: { kind: 'emoji', value: '😀😀' } },
    { icon: { kind: 'image', value: 'https://example.com/icon.png' } },
    { icon: { kind: 'image', value: 'data:image/svg+xml;base64,PHN2Zz4=' } },
    { icon: { kind: 'image', value: 'data:image/png;base64,YmFk' } },
  ])
    await expect(normalizeAppearancePatch(patch)).rejects.toThrow();
  await expect(appearanceImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).rejects.toThrow();
});
