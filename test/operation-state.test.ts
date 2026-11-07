import { afterEach, expect, it, vi } from 'vitest';
import { mergeOperation, readPending, rememberOperation } from '../src/web/operation-state';
import type { Operation } from '../src/shared/types';

const operation: Operation = {
  id: 'request',
  threadId: 'thread',
  kind: 'send',
  state: 'received',
  turnId: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
};
afterEach(() => vi.unstubAllGlobals());
it('does not regress a final event when an earlier HTTP response arrives late', () => {
  const completed = { ...operation, state: 'completed' as const };
  expect(mergeOperation([completed], { ...operation, state: 'accepted' })).toEqual([completed]);
});
it('keeps a confirmed delivery when a delayed acknowledgement or timeout arrives', () => {
  const accepted = { ...operation, state: 'accepted' as const, updatedAt: 20 };
  for (const state of ['received', 'dispatching', 'uncertain'] as const)
    expect(mergeOperation([accepted], { ...operation, state, updatedAt: 30 })).toEqual([accepted]);
  const failed = { ...operation, state: 'failed' as const, updatedAt: 40 };
  expect(mergeOperation([accepted], failed)).toEqual([failed]);
  expect(mergeOperation([failed], { ...operation, state: 'completed', updatedAt: 10 })).toEqual([failed]);
});
it('accepts host confirmation even if the phone clock is ahead', () => {
  const local = { ...operation, updatedAt: 5000 };
  const confirmed = { ...operation, state: 'accepted' as const, updatedAt: 20 };
  expect(mergeOperation([local], confirmed)).toEqual([confirmed]);
});
it('keeps an unconfirmed request across reload and clears it only when acknowledged', () => {
  const values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k),
    setItem: (k: string, v: string) => values.set(k, v),
  });
  rememberOperation('device', operation);
  expect(readPending('device', 'thread')[0].state).toBe('uncertain');
  expect(readPending('other', 'thread')).toEqual([]);
  rememberOperation('device', { ...operation, state: 'accepted' });
  expect(readPending('device', 'thread')).toEqual([]);
});
