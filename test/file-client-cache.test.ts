import { it, expect, vi, afterEach } from 'vitest';
const session = vi.hoisted(() => ({
  backendId: 'codex',
  online: true,
  cache: { scope: 'account-a', get: vi.fn(), put: vi.fn(), block: vi.fn() },
  api: vi.fn(),
  contentKey: (suffix: string) => `host:${suffix}`,
}));
vi.mock('../src/web/device-session', () => ({ deviceSession: session }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  session.cache.scope = 'account-a';
});
it('does not restore a pending attachment provider or cache manifest after account switching', async () => {
  vi.stubGlobal('navigator', {});
  const { mediaContent, clearFileProviders } = await import('../src/web/file-client');
  let finish!: (value: unknown) => void;
  session.api.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = mediaContent('thread', '/file.png');
  await vi.waitFor(() => expect(session.api).toHaveBeenCalled());
  session.cache.scope = 'account-b';
  clearFileProviders();
  finish({ id: 'old-file', hashes: [], sha256: '', name: 'old', mime: 'image/png', size: 0 });
  await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  expect(session.cache.put).not.toHaveBeenCalled();
  expect(session.cache.block).not.toHaveBeenCalled();
});
