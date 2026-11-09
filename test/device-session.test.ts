import { expect, it, vi } from 'vitest';
vi.mock('../src/web/sync-store', () => ({
  SyncStore: class {
    get = vi.fn().mockResolvedValue(undefined);
    put = vi.fn();
  },
}));
import { DeviceSession } from '../src/web/device-session';
import { DEFAULT_BACKEND, conversationKey } from '../src/shared/backends';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(id: string) {
  return {
    type: 'sync',
    threadId: id,
    updates: [
      {
        kind: 'manifest',
        epoch: 'epoch',
        thread: { id, revision: 1 },
        order: ['message'],
        changed: [{ id: 'message', role: 'assistant', text: 'History for ' + id }],
      },
    ],
  };
}

it('releases inactive chat snapshots while keeping their persistent cache', async () => {
  const session = new DeviceSession();
  for (let index = 0; index < 40; index++) {
    const id = `chat-${index}`;
    const unsubscribe = session.subscribe(id, vi.fn());
    await (session as any).receive(snapshot(id));
    unsubscribe();
  }
  expect((session as any).views.size).toBe(0);
  expect(session.cache.put).toHaveBeenCalledTimes(40);
});

it('ignores late snapshots for chats that are no longer watched', async () => {
  const session = new DeviceSession();
  await (session as any).receive(snapshot('old-chat'));
  expect(session.cache.get).not.toHaveBeenCalled();
  expect(session.cache.put).not.toHaveBeenCalled();
  expect((session as any).views.size).toBe(0);
});

it('discards a snapshot if the subscription changes while its cache read is pending', async () => {
  const session = new DeviceSession();
  const read = deferred<undefined>();
  vi.mocked(session.cache.get).mockReturnValueOnce(read.promise);
  const key = conversationKey(DEFAULT_BACKEND, 'chat');
  const previous = vi.fn(),
    current = vi.fn();
  (session as any).watchers.set(key, new Set([previous]));
  const receiving = (session as any).receive(snapshot('chat'));
  (session as any).watchers.set(key, new Set([current]));
  read.resolve(undefined);
  await receiving;
  expect(previous).not.toHaveBeenCalled();
  expect(current).not.toHaveBeenCalled();
  expect(session.cache.put).not.toHaveBeenCalled();
  expect((session as any).views.size).toBe(0);
});

it('does not restore an old host snapshot after disconnecting during a cache read', async () => {
  const session = new DeviceSession();
  const read = deferred<any>();
  vi.mocked(session.cache.get).mockReturnValueOnce(read.promise);
  const listener = vi.fn();
  session.subscribe('chat', listener);
  session.disconnect();
  read.resolve({ epoch: 'old-host', view: { id: 'chat', messages: [], revision: 1 } });
  await read.promise;
  expect(listener).not.toHaveBeenCalled();
  expect((session as any).views.size).toBe(0);
});

it('keeps the new subscription when an old host subscription is cleaned up late', async () => {
  const session = new DeviceSession();
  const oldUnsubscribe = session.subscribe('chat', vi.fn());
  session.disconnect();
  const current = vi.fn();
  const unsubscribe = session.subscribe('chat', current);
  oldUnsubscribe();
  await (session as any).receive(snapshot('chat'));
  expect(current).toHaveBeenCalledWith({ type: 'thread', thread: expect.objectContaining({ id: 'chat' }) });
  unsubscribe();
});

it('uses the live relay when a closed direct link is awaiting cleanup', async () => {
  const session = new DeviceSession();
  const request = vi.fn().mockResolvedValue({ value: { ok: true } });
  (session as any).links.set('direct:control', { closed: true });
  (session as any).links.set('relay:control', { closed: false, request });
  expect(session.online).toBe(true);
  await expect(session.request('ping', {})).resolves.toEqual({ value: { ok: true } });
  expect(request).toHaveBeenCalledOnce();
});

it('notifies connection subscribers when the session is explicitly disconnected', () => {
  const session = new DeviceSession();
  (session as any).links.set('relay:control', { closed: false, close: vi.fn() });
  const online: boolean[] = [];
  session.onChange(() => online.push(session.online));
  expect(session.online).toBe(true);
  session.disconnect();
  expect(online).toEqual([false]);
});

it('scopes history errors to the requested chat instead of every chat on the backend', async () => {
  const session = new DeviceSession();
  const current = vi.fn(),
    other = vi.fn();
  (session as any).watchers.set(JSON.stringify(['codex', 'current']), new Set([current]));
  (session as any).watchers.set(JSON.stringify(['codex', 'other']), new Set([other]));
  await (session as any).receive({
    type: 'event',
    backendId: 'codex',
    threadId: 'other',
    event: { type: 'error', message: 'Unavailable' },
  });
  expect(current).not.toHaveBeenCalled();
  expect(other).toHaveBeenCalledWith({ type: 'error', message: 'Unavailable' });
});
