export interface ReleaseStore {
  head(key: string): Promise<{ size: number; etag: string } | null>;
  read(key: string, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array> | null>;
}
export function releaseKey(path: string) {
  const name = path.replace(/^\/downloads\/desktop\//, '');
  if (name === 'releases.json') return `desktop-releases/${name}`;
  if (
    !/^(linux|darwin|win32)\/(x64|arm64)\/(?:latest(?:-mac|-linux)?\.yml|AgentSpace-[0-9][A-Za-z0-9._-]*\.(?:exe|dmg|zip|AppImage)(?:\.blockmap)?|SHA256SUMS)$/.test(
      name,
    )
  )
    return null;
  return `desktop-releases/${name}`;
}
/** Same public download contract for Node and Workers; storage is the only adapter. */
export async function desktopRelease(request: Request, store: ReleaseStore): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const key = releaseKey(new URL(request.url).pathname);
  if (!key) return new Response(null, { status: 404 });
  const info = await store.head(key);
  if (!info) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const manifest = /\.(json|yml)$/.test(key);
  const headers: Record<string, string> = {
    'Content-Type': key.endsWith('.json')
      ? 'application/json'
      : key.endsWith('.yml')
        ? 'text/yaml'
        : 'application/octet-stream',
    'Cache-Control': manifest ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    ETag: info.etag,
  };
  if (request.headers.get('If-None-Match') === info.etag) return new Response(null, { status: 304, headers });
  let range: { offset: number; length: number } | undefined;
  const raw = request.headers.get('Range');
  if (raw && (!request.headers.get('If-Range') || request.headers.get('If-Range') === info.etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${info.size}` },
      });
    const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= info.size
    )
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${info.size}` },
      });
    range = { offset: start, length: end - start + 1 };
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = String(range?.length ?? info.size);
  const body = request.method === 'HEAD' ? null : await store.read(key, range);
  if (request.method !== 'HEAD' && !body) return new Response(null, { status: 404 });
  return new Response(body, { status: range ? 206 : 200, headers });
}
