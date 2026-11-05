import type { ThreadDelta, ThreadView } from './types.js';
export function diffViews(previous: ThreadView, next: ThreadView): ThreadDelta {
  const { messages, ...metadata } = next;
  const before = new Map(previous.messages.map((m) => [m.id, m]));
  const thread = { id: next.id, revision: next.revision } as ThreadDelta['thread'];
  for (const key of Object.keys(metadata) as (keyof typeof metadata)[])
    if (metadata[key] !== previous[key] && JSON.stringify(metadata[key]) !== JSON.stringify(previous[key]))
      Object.assign(thread, { [key]: metadata[key] });
  const changes: ThreadDelta['changes'] = [];
  for (const message of messages) {
    const old = before.get(message.id);
    if (old && JSON.stringify(old) === JSON.stringify(message)) continue;
    const { text: oldText, ...oldMeta } = old ?? { text: '' };
    const { text, ...meta } = message;
    if (old && text.startsWith(oldText) && JSON.stringify(oldMeta) === JSON.stringify(meta))
      changes.push({ type: 'append', id: message.id, text: text.slice(oldText.length) });
    else changes.push({ type: 'put', message });
  }
  const ids = messages.map((m) => m.id);
  const order = JSON.stringify(ids) === JSON.stringify(previous.messages.map((m) => m.id)) ? undefined : ids;
  return { thread, baseRevision: previous.revision, changes, order };
}
export function applyViewDelta(previous: ThreadView | null, delta: ThreadDelta): ThreadView | null {
  if (!previous || previous.id !== delta.thread.id || previous.revision !== delta.baseRevision) return null;
  const messages = new Map(previous.messages.map((m) => [m.id, m]));
  for (const change of delta.changes) {
    if (change.type === 'put') messages.set(change.message.id, change.message);
    else {
      const old = messages.get(change.id);
      if (!old) return null;
      messages.set(change.id, { ...old, text: old.text + change.text });
    }
  }
  const order = delta.order ?? previous.messages.map((m) => m.id);
  if (order.some((id) => !messages.has(id))) return null;
  return { ...previous, ...delta.thread, messages: order.map((id) => messages.get(id)!) };
}
