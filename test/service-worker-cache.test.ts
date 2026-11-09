import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../src/web/public/sw.js', import.meta.url), 'utf8');
function fixture() {
  const handlers: Record<string, (e: any) => void> = {},
    entries = new Map<string, Response>();
  let denied = false;
  const cache = {
    put: vi.fn(async (key: any, value: Response) => {
      if (denied) throw Error('quota');
      entries.set(typeof key === 'string' ? key : key.url, value);
    }),
    match: async (key: any) => entries.get(typeof key === 'string' ? key : key.url)?.clone(),
  };
  const fetch = vi.fn(
    async () => new Response('<html>current</html>', { headers: { 'Content-Type': 'text/html' } }),
  );
  runInNewContext(source, {
    self: {
      location: { origin: 'https://chat.test' },
      addEventListener: (key: string, handler: any) => {
        handlers[key] = handler;
      },
    },
    caches: { open: async () => cache },
    fetch,
    Response,
    URL,
    setTimeout,
    clearTimeout,
    MessageChannel,
  });
  return {
    entries,
    cache,
    fetch,
    deny: () => {
      denied = true;
    },
    request(path: string, destination = 'document') {
      let response: Promise<Response> | undefined;
      handlers.fetch({
        request: {
          url: `https://chat.test${path}`,
          method: 'GET',
          mode: destination === 'document' ? 'navigate' : 'cors',
          destination,
        },
        respondWith: (value: Promise<Response>) => {
          response = value;
        },
      });
      return response;
    },
  };
}
it('does not intercept private API navigations or cache media documents as the application shell', async () => {
  const f = fixture();
  expect(f.request('/api/im/me')).toBeUndefined();
  f.fetch.mockImplementation(async () => new Response('image', { headers: { 'Content-Type': 'image/png' } }));
  expect(await (await f.request('/support/wechat-reward.png'))!.text()).toBe('image');
  expect(f.cache.put).not.toHaveBeenCalled();
});
it('keeps online navigation working when cache writes fail and uses only the saved HTML shell offline', async () => {
  const f = fixture();
  await f.request('/?page=messages');
  expect(await f.entries.get('/')!.clone().text()).toContain('current');
  f.deny();
  expect(await (await f.request('/?page=contacts'))!.text()).toContain('current');
  f.fetch.mockRejectedValue(Error('offline'));
  expect(await (await f.request('/?page=messages'))!.text()).toContain('current');
});
it('returns cached public scripts without a second network request', async () => {
  const f = fixture();
  // Real same-origin fetch responses have type basic; default Response is also non-opaque.
  await f.request('/assets/app-123456.js', 'script');
  await f.request('/assets/app-123456.js', 'script');
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.request('/api/im/conversations/a/files/b/private.png', 'image')).toBeUndefined();
});
