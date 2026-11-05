import { expect, it } from 'vitest';
import { assetSettings } from '../src/shared/assets';
it('keeps assets same-origin by default and accepts an optional HTTPS CDN prefix', () => {
  expect(assetSettings()).toEqual({ base: '/', origin: null });
  expect(assetSettings('https://static.example.com/pocket/v1')).toEqual({
    base: 'https://static.example.com/pocket/v1/',
    origin: 'https://static.example.com',
  });
});
it('rejects plaintext, credentials and signed asset URLs in public build config', () => {
  for (const value of [
    'http://cdn.example.com',
    'https://key:secret@cdn.example.com',
    'https://cdn.example.com/?token=secret',
    'https://cdn.example.com/#secret',
  ])
    expect(() => assetSettings(value)).toThrow();
});
