import { describe, it, expect } from 'vitest';
import { SyncJournal } from '../src/server/sync-journal.js';
import { applySync, checkpoint } from '../src/shared/sync.js';
import { normalizedView } from '../packages/adapter-codex/src/timeline.js';
import { state } from './helpers.js';

const view = (revision: number, text = '世界') => ({
  id: 'thread',
  title: 'title',
  cwd: '/test',
  updatedAt: 0,
  messages: [{ id: 'a', role: 'assistant' as const, text }],
  revision,
  owner: true,
  synchronized: true,
  activeTurnId: null,
  runtimeStatus: 'idle',
  model: null,
  pendingRequests: 0,
  canSend: true,
  canInterrupt: false,
  reason: null,
});
describe('cross-connection sync', () => {
  it('does not resend unchanged messages and resumes missing deltas', () => {
    const journal = new SyncJournal();
    let cache = applySync(null, journal.resume(view(1))[0])!;
    const known = checkpoint(cache);
    const unchanged = journal.resume(view(1), known)[0];
    expect(unchanged.kind === 'manifest' && unchanged.changed).toEqual([]);
    const updates = journal.resume(view(2, '世界新增'), known);
    expect(updates[0].kind).toBe('delta');
    for (const update of updates) cache = applySync(cache, update)!;
    expect(cache.view.messages[0].text).toBe('世界新增');
  });
  it('uses content identities across epoch changes and handles removals', () => {
    const journal = new SyncJournal();
    const cache = applySync(null, journal.resume(view(10))[0])!;
    const fresh = journal.resume(view(0), checkpoint(cache))[0];
    expect(fresh.epoch).not.toBe(cache.epoch);
    expect(fresh.kind === 'manifest' && fresh.changed).toEqual([]);
    const resumed = applySync(cache, fresh)!;
    const removed = journal.resume({ ...view(1), messages: [] }, checkpoint(resumed));
    expect(applySync(resumed, removed[0])!.view.messages).toEqual([]);
  });
  it('falls back to a selective manifest when bounded logs expire', () => {
    let now = 1;
    const journal = new SyncJournal(() => now, { entries: 1, bytes: 10000, total: 10000, age: 10 });
    const cached = applySync(null, journal.resume(view(1))[0])!;
    journal.update(view(2, 'two'));
    journal.update(view(3, 'three'));
    now = 30;
    const updates = journal.resume(view(3, 'three'), checkpoint(cached));
    expect(updates[0].kind).toBe('manifest');
    expect(journal.bytes).toBe(0);
  });
});
