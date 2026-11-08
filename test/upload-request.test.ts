import { afterEach, expect, it, vi } from 'vitest';
import { uploadRequest } from '../src/client/upload-request';

class UploadXHR extends EventTarget {
  static current: UploadXHR;
  upload: { onprogress?: (event: ProgressEvent) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  responseText = '{"file":{"id":"fixture"}}';
  status = 200;
  withCredentials = false;
  headers = new Headers();
  open = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  setRequestHeader = (name: string, value: string) => this.headers.set(name, value);
  constructor() {
    super();
    UploadXHR.current = this;
  }
}
function setup() {
  vi.stubGlobal('XMLHttpRequest', UploadXHR);
  vi.stubGlobal('location', { href: 'https://fixture.test/', origin: 'https://fixture.test' });
}
afterEach(() => vi.unstubAllGlobals());

it('reports transmitted bytes, keeps same-origin credentials and returns server failures for the caller', async () => {
  setup();
  const progress = vi.fn();
  const request = uploadRequest('/api/upload', { method: 'POST', body: new Uint8Array(20) }, progress);
  const xhr = UploadXHR.current;
  expect(xhr.withCredentials).toBe(true);
  xhr.upload.onprogress!({ lengthComputable: true, loaded: 5, total: 20 } as ProgressEvent);
  expect(progress).toHaveBeenLastCalledWith(5, 20);
  xhr.status = 413;
  xhr.responseText = '{"error":"Too large"}';
  xhr.onload!();
  const response = await request;
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'Too large' });
});

it('rejects a network failure so a batch can report that file and continue', async () => {
  setup();
  const request = uploadRequest('/api/upload', { method: 'POST' }, vi.fn());
  const assertion = expect(request).rejects.toThrow('上传连接中断');
  UploadXHR.current.onerror!();
  await assertion;
});

it('aborts an active upload and detaches the signal after completion', async () => {
  setup();
  const controller = new AbortController();
  const request = uploadRequest('/api/upload', { signal: controller.signal }, vi.fn());
  const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await assertion;
  expect(UploadXHR.current.abort).toHaveBeenCalledOnce();

  const next = new AbortController();
  const completed = uploadRequest('/api/upload', { signal: next.signal }, vi.fn());
  const xhr = UploadXHR.current;
  xhr.onload!();
  await completed;
  next.abort();
  expect(xhr.abort).not.toHaveBeenCalled();
});

it('keeps the fetch path for Node clients without XMLHttpRequest', async () => {
  vi.stubGlobal('XMLHttpRequest', undefined);
  const response = new Response('{}');
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  const init = { method: 'POST', body: new Uint8Array(8) };
  await expect(uploadRequest('https://fixture.test/api/upload', init, vi.fn())).resolves.toBe(response);
  expect(fetch).toHaveBeenCalledWith('https://fixture.test/api/upload', init);
});
