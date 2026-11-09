import type { ChatAttachment, ChatMessage, SendMessageOptions } from '../../shared/messaging';

type DraftContent = { text: string; files: ChatAttachment[]; reply?: ChatMessage };
export type PendingMessage = DraftContent & {
  id: string;
  options: SendMessageOptions;
  createdAt: number;
  error?: string;
  rejected?: boolean;
};
export type MessagingDraft = DraftContent & { pending?: PendingMessage };

const empty: MessagingDraft = { text: '', files: [] };
const drafts = new Map<string, MessagingDraft>();
const listeners = new Set<() => void>();

export const readDraft = (id: string): MessagingDraft => drafts.get(id) ?? empty;
export function subscribeDrafts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function updateDraft(id: string, update: (draft: MessagingDraft) => MessagingDraft) {
  const previous = readDraft(id);
  const next = update(previous);
  if (next === previous) return;
  drafts.set(id, next);
  for (const listener of listeners) listener();
}
export function clearDrafts() {
  drafts.clear();
  for (const listener of listeners) listener();
}
