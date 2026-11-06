import { expect, it, vi } from 'vitest';
vi.mock('../src/web/sync-store', () => ({ SyncStore: class {} }));
import { DeviceSession } from '../src/web/device-session';

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
