/** Browser uploads expose real byte progress; Node clients keep the fetch path. */
export async function uploadRequest(
  url: string,
  init: RequestInit,
  progress?: (loaded: number, total: number) => void,
): Promise<Response> {
  if (!progress || typeof XMLHttpRequest === 'undefined') return fetch(url, init);
  init.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => init.signal?.removeEventListener('abort', abort);
    xhr.open(init.method ?? 'POST', url);
    xhr.withCredentials = new URL(url, location.href).origin === location.origin;
    new Headers(init.headers).forEach((value, key) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(event.loaded, event.total);
    };
    xhr.upload.onload = () => progress(1, 1);
    xhr.onload = () => {
      cleanup();
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('上传连接中断，请重试'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };
    init.signal?.addEventListener('abort', abort, { once: true });
    xhr.send(init.body as XMLHttpRequestBodyInit);
  });
}
