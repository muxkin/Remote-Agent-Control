import type { Operation } from '../shared/types';

const terminal = new Set(['completed', 'interrupted', 'failed', 'rejected']);
const unresolved = new Set(['received', 'dispatching', 'uncertain']);

export function mergeOperation(previous: Operation[], incoming: Operation): Operation[] {
  const current = previous.find((item) => item.id === incoming.id);
  if (current?.state === 'accepted' && unresolved.has(incoming.state)) return previous;
  // A slower HTTP acknowledgement must not regress a completed WebSocket result.
  if (
    current &&
    terminal.has(current.state) &&
    (!terminal.has(incoming.state) || current.updatedAt > incoming.updatedAt)
  )
    return previous;
  return [incoming, ...previous.filter((item) => item.id !== incoming.id)].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}

export function readPending(deviceId: string, threadId: string): Operation[] {
  try {
    const saved = JSON.parse(localStorage.getItem(`pocket-pending:${deviceId}`) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((item) => item.threadId === threadId && unresolved.has(item.state))
      .map((item) => ({ ...item, state: 'uncertain', error: '上次请求尚未确认，正在与原实例核对' }));
  } catch {
    return [];
  }
}

export function rememberOperation(deviceId: string, operation: Operation): void {
  // Only request identifiers and status are persisted; no prompts or credentials.
  const key = `pocket-pending:${deviceId}`;
  let saved: Operation[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(key) ?? '[]');
  } catch {
    /* empty journal */
  }
  if (!Array.isArray(saved)) saved = [];
  saved = saved.filter((item) => item.id !== operation.id);
  if (unresolved.has(operation.state)) saved.push(operation);
  localStorage.setItem(key, JSON.stringify(saved));
}
