/** Messaging identities never authorize desktop control or device pairing. */
export interface ChatUser {
  /** Permanent, arbitrary-length decimal UID. Never convert to a number. */
  id: string;
  /** Qualified UID scoped to the account service, e.g. 10000000@chat.example.com. */
  address: string;
  kind: 'human' | 'agent';
  encrypted?: boolean;
  avatarUrl?: string;
  username: string;
  displayName: string;
  createdAt: number;
}
export interface ChatContact extends ChatUser {
  remark: string;
  blocked: boolean;
}
export interface ChatAttachment {
  encrypted?: string;
  id: string;
  name: string;
  size: number;
  mime: string;
  url: string;
}
export type MessageState = 'complete' | 'streaming' | 'cancelled' | 'failed';
export interface ChatQuestion {
  id: string;
  header: string;
  question: string;
  detail?: string;
  multiSelect?: boolean;
  options: { label: string; description: string }[];
}
export type InteractionInput = {
  kind: 'question' | 'approval';
  recipientId: string;
  title: string;
  description: string;
  questions?: ChatQuestion[];
  /** Absolute expiry, at most seven days ahead; defaults to 24 hours. */
  expiresAt?: number;
};
export type InteractionResponse =
  { decision: 'approve' | 'reject'; comment?: string } | { answers: Record<string, string[]> };
export interface ChatInteraction extends InteractionInput {
  id: string;
  expiresAt: number;
  status: 'pending' | 'answered' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  response?: InteractionResponse;
  respondedBy?: string;
  respondedAt?: number;
}
export interface ChatSticker {
  encrypted?: string;
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}
export interface ChatMessage {
  /** Decrypted client-only retry contract, never a plaintext server field. */
  initialRequest?: { text: string; options: SendMessageOptions };
  id: string;
  sequence: number;
  conversationId: string;
  senderId: string;
  sender: ChatUser;
  clientId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  state: MessageState;
  attachments: ChatAttachment[];
  mentions: string[];
  replyTo: string | null;
  interaction?: ChatInteraction;
  sticker?: boolean;
}
export interface ChatMember extends ChatUser {
  role: 'owner' | 'member';
  readSequence: number;
}
export interface ChatConversation {
  id: string;
  kind: 'direct' | 'group';
  name: string;
  ownerId: string | null;
  closed: boolean;
  peer: ChatUser | null;
  members: ChatMember[];
  lastMessage: ChatMessage | null;
  unread: number;
  readSequence: number;
  peerReadSequence: number;
}
export interface ChatEvent {
  sequence: number;
  type: 'message' | 'message.updated' | 'read' | 'contacts' | 'profile' | 'conversation';
  conversationId: string | null;
  message?: ChatMessage;
}
export interface ChatSync {
  events: ChatEvent[];
  cursor: number;
}
export interface ChatHistory {
  messages: ChatMessage[];
  before?: number;
}
export interface SendMessageOptions {
  state?: 'complete' | 'streaming';
  attachmentIds?: string[];
  mentions?: string[];
  replyTo?: string;
  interaction?: InteractionInput;
  stickerId?: string;
}
/** Shared by browsers, command-line tools and Agent integrations. */
export interface MessagingClient {
  me(signal?: AbortSignal): Promise<{ user: ChatUser | null }>;
  contacts(signal?: AbortSignal): Promise<{ users: ChatContact[] }>;
  addContact(identifier: string): Promise<{ user: ChatUser }>;
  conversations(signal?: AbortSignal): Promise<{ conversations: ChatConversation[] }>;
  direct(userId: string): Promise<{ conversation: ChatConversation }>;
  history(id: string, before?: number, signal?: AbortSignal): Promise<ChatHistory>;
  send(
    id: string,
    text: string,
    clientId: string,
    options?: SendMessageOptions,
  ): Promise<{ message: ChatMessage }>;
  updateMessage(
    id: string,
    messageId: string,
    revision: number,
    text: string,
    state: MessageState,
  ): Promise<{ message: ChatMessage }>;
  read(id: string, sequence: number): Promise<{ ok: boolean }>;
  sync(cursor: number, wait?: number, signal?: AbortSignal): Promise<ChatSync>;
}
