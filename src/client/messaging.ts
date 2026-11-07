import type {
  ChatConversation,
  ChatHistory,
  ChatMessage,
  ChatSync,
  ChatUser,
  ChatContact,
  ChatAttachment,
  SendMessageOptions,
  MessageState,
  MessagingClient,
  InteractionResponse,
  ChatSticker,
} from '../shared/messaging.js';
export class MessagingError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Works in browsers (HttpOnly cookie) and Node/Agent tools (Bearer credential). */
export class HttpMessagingClient implements MessagingClient {
  constructor(
    readonly baseURL = '',
    private readonly token?: string,
  ) {}
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseURL}/api/im${path}`, {
      method,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(path.startsWith('/sync?') ? 35000 : 15000)])
        : AbortSignal.timeout(path.startsWith('/sync?') ? 35000 : 15000),
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new MessagingError(response.status, data.error ?? '消息服务暂不可用');
    return data as T;
  }
  me(signal?: AbortSignal) {
    return this.request<{ user: ChatUser | null }>('/me', 'GET', undefined, signal);
  }
  contacts(signal?: AbortSignal) {
    return this.request<{ users: ChatContact[] }>('/contacts', 'GET', undefined, signal);
  }
  addContact(identifier: string) {
    return this.request<{ user: ChatUser }>('/contacts', 'POST', { identifier });
  }
  conversations(signal?: AbortSignal) {
    return this.request<{ conversations: ChatConversation[] }>('/conversations', 'GET', undefined, signal);
  }
  direct(userId: string) {
    return this.request<{ conversation: ChatConversation }>('/conversations', 'POST', { userId });
  }
  history(id: string, before?: number, signal?: AbortSignal) {
    return this.request<ChatHistory>(
      `/conversations/${encodeURIComponent(id)}/messages${before === undefined ? '' : `?before=${before}`}`,
      'GET',
      undefined,
      signal,
    );
  }
  send(id: string, text: string, clientId: string, options: SendMessageOptions = {}) {
    return this.request<{ message: ChatMessage }>(
      `/conversations/${encodeURIComponent(id)}/messages`,
      'POST',
      { ...options, text, clientId },
    );
  }
  updateMessage(
    id: string,
    messageId: string,
    revision: number,
    text: string,
    state: MessageState = 'streaming',
  ) {
    return this.request<{ message: ChatMessage }>(
      `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
      'PATCH',
      { revision, text, state },
    );
  }
  cancel(id: string, messageId: string) {
    return this.request<{ message: ChatMessage }>(
      `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/cancel`,
      'POST',
    );
  }
  respond(id: string, messageId: string, response: InteractionResponse) {
    return this.request<{ message: ChatMessage }>(
      `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/respond`,
      'POST',
      response,
    );
  }
  cancelInteraction(id: string, messageId: string) {
    return this.request<{ message: ChatMessage }>(
      `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/interaction/cancel`,
      'POST',
    );
  }
  stickers() {
    return this.request<{ stickers: ChatSticker[] }>('/stickers');
  }
  saveSticker(conversationId: string, fileId: string) {
    return this.request<{ stickers: ChatSticker[] }>('/stickers', 'POST', { conversationId, fileId });
  }
  removeSticker(id: string) {
    return this.request<{ ok: true }>(`/stickers/${encodeURIComponent(id)}`, 'DELETE');
  }
  group(name: string, userIds: string[]) {
    return this.request<{ conversation: ChatConversation }>('/groups', 'POST', { name, userIds });
  }
  search(id: string, q: string, before?: number, signal?: AbortSignal) {
    return this.request<ChatHistory>(
      `/conversations/${encodeURIComponent(id)}/search?${new URLSearchParams({ q, ...(before ? { before: String(before) } : {}) })}`,
      'GET',
      undefined,
      signal,
    );
  }
  async upload(id: string, name: string, data: Blob | Uint8Array, signal?: AbortSignal) {
    const response = await fetch(`${this.baseURL}/api/im/conversations/${encodeURIComponent(id)}/files`, {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: data as BodyInit,
    });
    const body = await response.json();
    if (!response.ok) throw new MessagingError(response.status, body.error ?? '上传失败');
    return body as { file: ChatAttachment };
  }
  /** Snapshot revisions make retries safe; cancellation is a persisted terminal state. */
  async *events(cursor = 0, signal?: AbortSignal) {
    while (!signal?.aborted) {
      const batch = await this.sync(cursor, 25000, signal);
      for (const event of batch.events) yield event;
      cursor = batch.cursor;
    }
  }
  read(id: string, sequence: number) {
    return this.request<{ ok: boolean }>(`/conversations/${encodeURIComponent(id)}/read`, 'POST', {
      sequence,
    });
  }
  sync(cursor: number, wait = 25_000, signal?: AbortSignal) {
    return this.request<ChatSync>(`/sync?cursor=${cursor}&wait=${wait}`, 'GET', undefined, signal);
  }
  registerAgent(invitation: string, username: string, displayName: string) {
    return this.request<{ user: ChatUser; owner: ChatUser; token: string; expiresAt: number }>(
      '/agents/register',
      'POST',
      { invitation, username, displayName },
    );
  }
}
