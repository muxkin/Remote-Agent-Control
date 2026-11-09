/* Cache local public assets only. CDN assets use their immutable HTTP cache directly. */
const CACHE = 'pocket-static-v4';
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
  if (url.origin === self.location.origin && /^\/local-files\/[a-f0-9-]{36}$/.test(url.pathname)) {
    event.respondWith(localFile(event, url.pathname.split('/').at(-1)));
    return;
  }
  if (
    url.origin === self.location.origin &&
    request.mode === 'navigate' &&
    !url.pathname.startsWith('/api/')
  ) {
    event.respondWith(
      caches
        .open(CACHE)
        .catch(() => undefined)
        .then(async (cache) => {
          try {
            const response = await fetch(request);
            if (response.ok && response.headers.get('Content-Type')?.includes('text/html'))
              await cache?.put('/', response.clone()).catch(() => {});
            return response;
          } catch {
            return (
              (await cache?.match('/').catch(() => undefined)) ??
              new Response('请联网打开一次页面', { status: 503 })
            );
          }
        }),
    );
    return;
  }
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !['script', 'style', 'font'].includes(request.destination) ||
    !url.pathname.includes('/assets/')
  )
    return;
  event.respondWith(
    caches
      .open(CACHE)
      .catch(() => undefined)
      .then(async (cache) => {
        const hit = await cache?.match(request).catch(() => undefined);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok && response.type !== 'opaque')
          await cache?.put(request, response.clone()).catch(() => {});
        return response;
      }),
  );
});

// Private media never enters CacheStorage or the cloud HTTP route. The owning
// page authorizes each local capability and supplies one decrypted block at a time.
async function localFile(event, id) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const ask = (client, body) =>
    new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(Error('File unavailable'));
      }, 30000);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timer);
        channel.port1.close();
        data.error ? reject(Error('File unavailable')) : resolve(data);
      };
      client.postMessage({ type: 'local-file', id, ...body }, [channel.port2]);
    });
  let owner, meta;
  for (const client of clients) {
    try {
      meta = await ask(client, { metadata: true });
      owner = client;
      break;
    } catch {}
  }
  if (!owner) return new Response('附件页面已关闭，请在会话中重新打开', { status: 410 });
  const range = event.request.headers.get('Range');
  let start = 0,
    end = meta.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
    start = match[1] ? Number(match[1]) : Math.max(0, meta.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= meta.size)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
  }
  const headers = {
    'Content-Type': meta.mime,
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  const inline = /^(image\/|audio\/|video\/|text\/plain(?:;|$)|application\/(?:pdf|json)(?:;|$))/.test(
    meta.mime,
  );
  const disposition =
    !inline || new URL(event.request.url).searchParams.has('download') ? 'attachment' : 'inline';
  headers['Content-Disposition'] =
    `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${meta.size}`;
  const stream = new ReadableStream({
    async pull(controller) {
      if (start > end) {
        controller.close();
        return;
      }
      const stop = Math.min(end, (Math.floor(start / 1048576) + 1) * 1048576 - 1);
      try {
        const { data } = await ask(owner, { start, end: stop });
        controller.enqueue(data);
        start = stop + 1;
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(event.request.method === 'HEAD' ? null : stream, {
    status: range ? 206 : 200,
    headers,
  });
}
