import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildRelay } from '../src/server/relay.js';

it('serves the published web version from the public origin with revalidation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-release-'));
  const relay = await buildRelay({
    origin: 'http://localhost',
    webRoot: root,
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'fixture-enrollment-secret-32-characters',
  });
  try {
    writeFileSync(join(root, 'version.json'), JSON.stringify({ buildId: '0123456789abcdef' }));
    const first = await relay.app.inject({ url: '/version.json', headers: { host: 'localhost' } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ buildId: '0123456789abcdef' });
    expect(first.headers['cache-control']).toBe('no-cache');
    writeFileSync(join(root, 'next.json'), JSON.stringify({ buildId: 'fedcba9876543210' }));
    renameSync(join(root, 'next.json'), join(root, 'version.json'));
    expect((await relay.app.inject({ url: '/version.json', headers: { host: 'localhost' } })).json()).toEqual({ buildId: 'fedcba9876543210' });
  } finally {
    await relay.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
