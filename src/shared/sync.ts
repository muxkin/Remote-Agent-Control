import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { applyViewDelta } from './delta.js';
import type { Message, ThreadView, ThreadDelta } from './types.js';

function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',') +
    '}'
  );
}
export const contentVersion = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(canonical(value))));
export interface SyncCheckpoint {
  epoch: string;
  revision: number;
  versions: Record<string, string>;
}
export interface CachedThread {
  epoch: string;
  view: ThreadView;
}
export type SyncUpdate =
  | { kind: 'delta'; epoch: string; delta: ThreadDelta }
  | {
      kind: 'manifest';
      epoch: string;
      thread: Omit<ThreadView, 'messages'>;
      order: string[];
      changed: Message[];
    };
export function checkpoint(cached: CachedThread | null): SyncCheckpoint | undefined {
  if (!cached) return undefined;
  return {
    epoch: cached.epoch,
    revision: cached.view.revision,
    versions: Object.fromEntries(
      cached.view.messages.map((message) => [message.id, contentVersion(message)]),
    ),
  };
}
export function applySync(cached: CachedThread | null, update: SyncUpdate): CachedThread | null {
  if (update.kind === 'delta') {
    if (!cached || cached.epoch !== update.epoch) return null;
    if (update.delta.thread.revision <= cached.view.revision) return cached;
    const view = applyViewDelta(cached.view, update.delta);
    return view ? { epoch: update.epoch, view } : null;
  }
  if (cached?.epoch === update.epoch && cached.view.revision > update.thread.revision) return cached;
  const messages = new Map((cached?.view.messages ?? []).map((message) => [message.id, message]));
  for (const message of update.changed) messages.set(message.id, message);
  if (update.order.some((id) => !messages.has(id))) return null;
  return {
    epoch: update.epoch,
    view: { ...update.thread, messages: update.order.map((id) => messages.get(id)!) },
  };
}
