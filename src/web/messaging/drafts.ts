import type { ChatAttachment, ChatMessage } from '../../shared/messaging';
export interface MessagingDraft {
  text: string;
  files: ChatAttachment[];
  reply?: ChatMessage;
  pending?: { key: string; id: string };
}
const drafts = new Map<string, MessagingDraft>();
export const readDraft = (id: string): MessagingDraft => drafts.get(id) ?? { text: '', files: [] };
export function writeDraft(id: string, draft: MessagingDraft) {
  drafts.set(id, draft);
}
export function clearDrafts() {
  drafts.clear();
}
