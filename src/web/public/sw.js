/* Cache local public assets only. CDN assets use their immutable HTTP cache directly. */
const CACHE = 'pocket-static-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('pocket-static-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !['script', 'style', 'font'].includes(request.destination) ||
    !url.pathname.includes('/assets/')
  )
    return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok && response.type !== 'opaque')
        await cache.put(request, response.clone()).catch(() => {});
      return response;
    }),
  );
});
