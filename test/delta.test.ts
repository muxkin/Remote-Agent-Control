import { it, expect } from 'vitest';
import { diffViews, applyViewDelta } from '../src/shared/delta.js';
import { normalizedView } from '../packages/adapter-codex/src/timeline.js';
import { state } from './helpers.js';
it('sends only appended text and changed metadata for streaming messages', () => {
  const before = normalizedView(state(), 1, true);
  const after = {
    ...before,
    revision: 2,
    messages: before.messages.map((m) => (m.role === 'assistant' ? { ...m, text: m.text + '！' } : m)),
  };
  const delta = diffViews(before, after);
  expect(delta.changes).toEqual([{ type: 'append', id: 'a1', text: '！' }]);
  expect(delta.order).toBeUndefined();
  expect(applyViewDelta(before, delta)).toEqual(after);
});
it('preserves insertion, replacement and deletion ordering', () => {
  const before = normalizedView(state(), 1, true);
  const after = { ...before, revision: 3, messages: [{ ...before.messages[1], text: 'changed' }] };
  expect(applyViewDelta(before, diffViews(before, after))).toEqual(after);
});
it('rejects a delta belonging to an old connection revision', () => {
  const before = normalizedView(state(), 1, true);
  const delta = diffViews(before, { ...before, revision: 2 });
  expect(applyViewDelta({ ...before, revision: 3 }, delta)).toBeNull();
});
it('does not resend stable thread metadata on each text fragment', () => {
  const before = normalizedView(state(), 1, true);
  expect(diffViews(before, { ...before, revision: 2 }).thread).toEqual({ id: before.id, revision: 2 });
});
