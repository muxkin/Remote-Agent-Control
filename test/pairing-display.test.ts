import { afterEach, expect, it } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { createPairingDisplay } from '../src/server/pairing-display.js';
import { Store } from '../src/server/store.js';
import { fixtureConfig } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
});

it('decodes the generated PNG into a working, single-use pairing link', async () => {
  const config = fixtureConfig();
  config.origin = 'https://pocket.example.com';
  const store = new Store(config.stateDir);
  cleanup.push(async () => {
    store.close();
    await rm(config.desktopRoot, { recursive: true, force: true });
  });
  const pairing = store.mintPairing();
  const display = await createPairingDisplay(config, pairing);
  const png = PNG.sync.read(await readFile(display.imagePath));
  const scanned = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(scanned).not.toBeNull();
  const url = new URL(scanned!.data);
  expect(url.origin).toBe(config.origin);
  expect(url.search).toBe(''); // The credential is a fragment, never an HTTP query.
  const code = new URLSearchParams(url.hash.slice(1)).get('pair')!;
  expect(store.pair(code, 'QR test phone')).not.toBeNull();
  expect(store.pair(code, 'QR replay')).toBeNull();
});

it('keeps QR artifacts private and replaces the preview when a new code is generated', async () => {
  const config = fixtureConfig();
  const store = new Store(config.stateDir);
  cleanup.push(async () => {
    store.close();
    await rm(config.desktopRoot, { recursive: true, force: true });
  });
  const first = await createPairingDisplay(config, store.mintPairing());
  const second = await createPairingDisplay(config, store.mintPairing());
  expect(first.pagePath).toBe(second.pagePath);
  const html = await readFile(second.pagePath, 'utf8');
  expect(html).toContain(second.link);
  expect(html).not.toContain(first.link);
  expect(html).toContain('data:image/png;base64,');
  expect((await stat(dirname(second.pagePath))).mode & 0o777).toBe(0o700);
  for (const path of [second.pagePath, second.imagePath]) expect((await stat(path)).mode & 0o777).toBe(0o600);
});
