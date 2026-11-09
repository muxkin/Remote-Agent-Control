import { uploadRequest } from './upload-request.js';
import type { UploadProgress } from '../shared/upload-progress.js';
import { HttpMessagingClient } from './messaging.js';
import { AccountClient } from './account.js';
import { attachmentMime } from '../shared/attachment-mime.js';
import { interactionInput, interactionResponse } from '../shared/messaging-validation.js';
import {
  SEALED_PREFIX,
  encryptFor,
  decryptFor,
  parseEnvelope,
  encode64,
  decode64,
  seal,
  unseal,
  canonical,
  type PublicAccountKeys,
} from '../shared/account-crypto.js';
import type {
  ChatAttachment,
  ChatConversation,
  ChatMessage,
  ChatHistory,
  SendMessageOptions,
  MessageState,
  InteractionResponse,
  InteractionInput,
} from '../shared/messaging.js';

interface Content {
  text: string;
  options: SendMessageOptions;
  state: MessageState;
  request?: { text: string; options: SendMessageOptions };
}
interface FileSecret {
  key: string;
  name: string;
  mime: string;
  size: number;
  context: string;
}
/** Only authenticated ciphertext may persist; keys and plaintext stay in the unlocked client. */
export interface EncryptedFileCache {
  get(key: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  remove(key: string): Promise<void>;
}
export class EncryptedMessagingClient extends HttpMessagingClient {
  readonly account = new AccountClient(
    <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) =>
      super.request<T>(path, method, body, signal),
  );
  private decoded = new Map<string, Promise<ChatMessage>>();
  constructor(
    baseURL = '',
    private readonly credential?: string,
  ) {
    super(baseURL, credential);
    this.account.onChange(() => {
      this.decoded.clear();
    });
  }
  raw<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    return super.request<T>(path, method, body, signal);
  }
  override async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const result = await super.request<T>(path, method, body, signal);
    return this.decode(result) as Promise<T>;
  }
  private async decode(value: any): Promise<any> {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Promise.all(value.map((v) => this.decode(v)));
    if (
      typeof value.text === 'string' &&
      typeof value.conversationId === 'string' &&
      typeof value.senderId === 'string'
    )
      return this.decodeMessage(value);
    if (typeof value.encrypted === 'string' && typeof value.url === 'string') return this.decodeFile(value);
    return Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await this.decode(v)])),
    );
  }
  private async recipients(cid: string) {
    if (!this.account.secrets || !this.account.user) throw Error('请先解锁账号');
    const { conversation } = await this.raw<{ conversation: ChatConversation }>(
      `/conversations/${encodeURIComponent(cid)}`,
    );
    return Object.fromEntries(
      await Promise.all(
        conversation.members.map(async (member) => [member.id, await this.account.publicKeys(member.id)]),
      ),
    ) as Record<string, PublicAccountKeys>;
  }
  private async content(cid: string, clientId: string, revision: number, value: Content) {
    return encryptFor(
      this.account.secrets!,
      this.account.user!.id,
      await this.recipients(cid),
      `message:${cid}:${clientId}:${revision}`,
      value,
    );
  }
  override async send(id: string, text: string, clientId: string, options: SendMessageOptions = {}) {
    if (!this.account.secrets) throw Error('请先启用并解锁账号加密');
    if (text.length > 64000) throw Error('消息太长');
    if (
      !text.trim() &&
      !options.attachmentIds?.length &&
      !options.interaction &&
      !options.stickerId &&
      options.state !== 'streaming'
    )
      throw Error('请输入消息或添加附件');
    if (options.interaction)
      options = { ...options, interaction: interactionInput.parse(options.interaction) };
    const initialRequest = { text, options };
    const existing = await this.raw<{ message: ChatMessage | null }>(
      `/conversations/${encodeURIComponent(id)}/by-client/${encodeURIComponent(clientId)}`,
    );
    if (existing.message) {
      const message = await this.decodeMessage(existing.message);
      if (canonical(message.initialRequest) !== canonical(initialRequest))
        throw Error('消息请求标识已用于其他内容');
      return { message };
    }
    let sticker = false;
    if (options.stickerId) {
      const list = await this.stickers(),
        source = list.stickers.find((s) => s.id === options.stickerId);
      if (!source) throw Error('表情包不存在');
      const file = await this.download(source.url);
      const uploaded = await this.upload(id, file.name, new Blob([file.data], { type: file.mime }));
      options = { ...options, stickerId: undefined, attachmentIds: [uploaded.file.id] };
      sticker = true;
    }
    const original = { ...options, ...(sticker ? { encryptedSticker: true } : {}) };
    const encrypted = await this.content(id, clientId, 0, {
      text,
      options: original,
      state: options.state ?? 'complete',
      request: initialRequest,
    });
    const interaction: InteractionInput | undefined = options.interaction && {
      kind: options.interaction.kind,
      recipientId: options.interaction.recipientId,
      title: '加密请求',
      description: '请使用支持加密的客户端读取',
      expiresAt: options.interaction.expiresAt,
      ...(options.interaction.kind === 'question'
        ? { questions: [{ id: 'encrypted', header: '', question: '加密问题', options: [] }] }
        : {}),
    };
    return this.request<{ message: ChatMessage }>(
      `/conversations/${encodeURIComponent(id)}/messages`,
      'POST',
      { ...options, interaction, text: encrypted, clientId },
    );
  }
  override async updateMessage(
    id: string,
    messageId: string,
    revision: number,
    text: string,
    state: MessageState = 'streaming',
  ) {
    const { message } = await this.request<{ message: ChatMessage }>(
      `/conversations/${id}/messages/${messageId}`,
    );
    const encrypted = await this.content(id, message.clientId, revision, {
      text,
      options: {
        replyTo: message.replyTo ?? undefined,
        mentions: message.mentions,
        attachmentIds: message.attachments.map((f) => f.id),
      },
      state,
      request: message.initialRequest,
    });
    return this.request<{ message: ChatMessage }>(`/conversations/${id}/messages/${messageId}`, 'PATCH', {
      revision,
      text: encrypted,
      state,
    });
  }
  private decodeMessage(message: ChatMessage): Promise<ChatMessage> {
    if (!message.text.startsWith(SEALED_PREFIX))
      return Promise.resolve({ ...message, text: '消息格式无效', attachments: [], interaction: undefined });
    const cacheKey = `${message.id}:${message.revision}:${message.text}:${canonical(message.interaction)}`;
    const old = this.decoded.get(cacheKey);
    if (old) return old;
    const work = (async () => {
      if (!this.account.secrets)
        return { ...message, text: '请解锁账号后查看加密消息', attachments: [], interaction: undefined };
      try {
        const envelope = parseEnvelope(message.text);
        const prefix = `message:${message.conversationId}:${message.clientId}:`;
        const revision = Number(envelope.context.slice(prefix.length));
        if (
          !envelope.context.startsWith(prefix) ||
          !Number.isSafeInteger(revision) ||
          revision < 0 ||
          revision > message.revision
        )
          throw Error('消息版本不匹配');
        const content = await decryptFor<Content>(
          this.account.secrets,
          this.account.user!.id,
          message.senderId,
          await this.account.publicKeys(message.senderId),
          `${prefix}${revision}`,
          message.text,
        );
        if (
          (content.options.replyTo ?? null) !== message.replyTo ||
          canonical([...(content.options.attachmentIds ?? [])].sort()) !==
            canonical(message.attachments.map((f) => f.id).sort())
        )
          throw Error('消息引用不匹配');
        let interaction = message.interaction;
        if (content.options.interaction) {
          if (
            !interaction ||
            interaction.kind !== content.options.interaction.kind ||
            interaction.recipientId !== content.options.interaction.recipientId
          )
            throw Error('交互请求不匹配');
          interaction = { ...interaction, ...content.options.interaction };
          if (['approved', 'rejected', 'answered'].includes(interaction.status)) {
            const response = interaction.response;
            const encrypted =
              response && ('decision' in response ? response.comment : response.answers.encrypted?.[0]);
            if (!encrypted || interaction.respondedBy !== interaction.recipientId)
              throw Error('授权回复缺少有效签名');
            const original = await decryptFor<InteractionResponse>(
              this.account.secrets,
              this.account.user!.id,
              interaction.recipientId,
              await this.account.publicKeys(interaction.recipientId),
              `response:${message.conversationId}:${message.id}:${interaction.id}`,
              encrypted,
            );
            const status =
              'decision' in original
                ? original.decision === 'approve'
                  ? 'approved'
                  : 'rejected'
                : 'answered';
            if (status !== interaction.status) throw Error('授权状态不匹配');
            interaction.response = original;
          }
        } else if (interaction) throw Error('消息附带了未经签名的交互请求');
        return {
          ...message,
          text: content.text,
          initialRequest: content.request,
          interaction,
          sticker: !!(content.options as any).encryptedSticker,
          attachments: await Promise.all(message.attachments.map((f) => this.decodeFile(f))),
        };
      } catch {
        return {
          ...message,
          text: '此消息无法解密或验证；请检查账号及联系人安全码',
          attachments: [],
          interaction: undefined,
        };
      }
    })();
    this.decoded.set(cacheKey, work);
    if (this.decoded.size > 300) this.decoded.delete(this.decoded.keys().next().value!);
    return work;
  }
  override async respond(id: string, messageId: string, response: InteractionResponse) {
    const { message } = await this.request<{ message: ChatMessage }>(
      `/conversations/${id}/messages/${messageId}`,
    );
    if (!message.interaction) throw Error('此请求无法验证');
    response = interactionResponse.parse(response);
    const request = message.interaction;
    if (request.kind === 'question') {
      if (!('answers' in response)) throw Error('请提交问题答案');
      const answers = response.answers,
        questions = request.questions!;
      if (
        Object.keys(answers).length !== questions.length ||
        questions.some((q) => !Object.hasOwn(answers, q.id) || (!q.multiSelect && answers[q.id].length !== 1))
      )
        throw Error('请完整回答所有问题');
    } else if (!('decision' in response)) throw Error('请选择允许或拒绝');
    const sealed = await encryptFor(
      this.account.secrets!,
      this.account.user!.id,
      await this.recipients(id),
      `response:${id}:${messageId}:${message.interaction.id}`,
      response,
    );
    return super.respond(
      id,
      messageId,
      'decision' in response
        ? { decision: response.decision, comment: sealed }
        : { answers: { encrypted: [sealed] } },
    );
  }
  override async search(id: string, q: string, before?: number, signal?: AbortSignal): Promise<ChatHistory> {
    const found: ChatMessage[] = [];
    let cursor = before;
    // Never send plaintext queries to the relay. Scan authenticated history in bounded pages.
    for (let page = 0; page < 20; page++) {
      const result = await this.history(id, cursor, signal);
      found.push(
        ...result.messages
          .filter((m) => m.text.toLocaleLowerCase().includes(q.toLocaleLowerCase()))
          .reverse(),
      );
      cursor = result.before;
      if (!cursor || found.length >= 50) break;
    }
    return {
      messages: found.slice(0, 50),
      ...(found.length > 50 ? { before: found[49].sequence } : cursor ? { before: cursor } : {}),
    };
  }
  private async fileSecret(encrypted: string, expectedContext?: string) {
    if (!this.account.secrets) throw Error('请先解锁账号');
    const envelope = parseEnvelope(encrypted);
    if (
      !envelope.context.startsWith('attachment:') ||
      (expectedContext && envelope.context !== expectedContext)
    )
      throw Error('附件身份校验失败');
    return decryptFor<FileSecret>(
      this.account.secrets,
      this.account.user!.id,
      envelope.sender,
      await this.account.publicKeys(envelope.sender),
      envelope.context,
      encrypted,
    );
  }
  async decodeFile<T extends { encrypted?: string; name: string; mime: string; size: number; url?: string }>(
    file: T,
  ): Promise<T> {
    if (!file.encrypted) return file;
    const fileLocation = /\/conversations\/([^/]+)\/files\/([^/]+)\//.exec(file.url ?? '');
    const secret = await this.fileSecret(
      file.encrypted,
      fileLocation ? `attachment:${fileLocation[1]}:${fileLocation[2]}` : undefined,
    );
    return { ...file, name: secret.name, mime: secret.mime, size: secret.size };
  }
  override async saveSticker(conversationId: string, fileId: string) {
    const file = await this.request<{ mime: string }>(
      `/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/encrypted.pocket?meta=1`,
    );
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.mime)) throw Error('表情包需要图片');
    return super.saveSticker(conversationId, fileId);
  }
  override async upload(
    id: string,
    name: string,
    data: Blob | Uint8Array,
    signal?: AbortSignal,
    progress?: (value: UploadProgress) => void,
  ) {
    if (!this.account.secrets) throw Error('请先启用并解锁账号加密');
    signal?.throwIfAborted();
    progress?.({ phase: 'preparing', loaded: 0, total: data instanceof Blob ? data.size : data.length });
    const original = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    if (!original.length || original.length > 10 * 1024 * 1024) throw Error('附件需要为 1 字节至 10 MB');
    const key = crypto.getRandomValues(new Uint8Array(32)),
      context = `attachment:${id}:${crypto.randomUUID()}`;
    const mime = attachmentMime(name, original);
    const sealed = await seal(key, original, context);
    const encrypted = await encryptFor(
      this.account.secrets,
      this.account.user!.id,
      await this.recipients(id),
      context,
      { key: encode64(key), name, mime, size: original.length, context, iv: sealed.iv },
    );
    signal?.throwIfAborted();
    progress?.({ phase: 'uploading', loaded: 0, total: original.length });
    const response = await uploadRequest(
      `${this.baseURL}/api/im/conversations/${encodeURIComponent(id)}/files`,
      {
        method: 'POST',
        credentials: 'same-origin',
        signal,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': 'encrypted.pocket',
          'X-Encrypted-Header': encrypted,
          ...(this.credential ? { Authorization: `Bearer ${this.credential}` } : {}),
        },
        body: decode64(sealed.data),
      },
      progress
        ? (loaded, total) =>
            progress({
              phase: loaded === total ? 'finalizing' : 'uploading',
              loaded: Math.round((loaded / total) * original.length),
              total: original.length,
            })
        : undefined,
    );
    progress?.({ phase: 'finalizing', loaded: original.length, total: original.length });
    const body = await response.json();
    if (!response.ok) throw Error(body.error ?? '上传失败');
    const file = await this.decodeFile(body.file as ChatAttachment);
    return { file };
  }
  async download(
    path: string,
    signal?: AbortSignal,
    cache?: EncryptedFileCache,
  ): Promise<{ data: Uint8Array<ArrayBuffer>; name: string; mime: string; size: number }> {
    const url = new URL(path, this.baseURL || location.origin),
      origin = new URL(this.baseURL || location.origin).origin;
    if (url.origin !== origin || !url.pathname.startsWith('/api/im/')) throw Error('附件地址无效');
    const headers = this.credential ? { Authorization: `Bearer ${this.credential}` } : undefined;
    const meta = await fetch(`${url.origin}${url.pathname}?meta=1&full=1`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      signal,
    }).then(async (r) => {
      if (!r.ok) throw Error('附件不可用');
      return r.json();
    });
    const fetchBytes = async () => {
      const response = await fetch(meta.url.startsWith('/') ? `${origin}${meta.url}` : meta.url, {
        credentials: meta.url.startsWith('/') ? 'same-origin' : 'omit',
        headers: meta.url.startsWith('/') ? headers : undefined,
        signal,
        cache: 'no-store',
      });
      if (!response.ok) throw Error('附件下载失败');
      return new Uint8Array(await response.arrayBuffer());
    };
    if (!meta.encrypted) {
      if (!url.pathname.includes('/avatar/')) throw Error('附件未经加密');
      const data = await fetchBytes();
      return { data, name: meta.name, mime: meta.mime, size: data.length };
    }
    const fileLocation = /\/conversations\/([^/]+)\/files\/([^/]+)\//.exec(url.pathname);
    const resourceFile = /\/resources\/files\/file\/([^/]+)$/.exec(url.pathname);
    if (resourceFile && (typeof meta.context !== 'string' || !meta.context.endsWith(`:${resourceFile[1]}`)))
      throw Error('附件身份校验失败');
    const secret = (await this.fileSecret(
      meta.encrypted,
      fileLocation
        ? `attachment:${fileLocation[1]}:${fileLocation[2]}`
        : resourceFile
          ? meta.context
          : undefined,
    )) as FileSecret & { iv: string };
    const key = typeof meta.cacheKey === 'string' ? meta.cacheKey : '';
    const decode = async (data: Uint8Array<ArrayBuffer>) => {
      const plain = await unseal(
        decode64(secret.key),
        { iv: secret.iv, data: encode64(data) },
        secret.context,
      );
      if (plain.length !== secret.size) throw Error('附件长度校验失败');
      signal?.throwIfAborted();
      return plain;
    };
    let plain: Uint8Array<ArrayBuffer> | undefined;
    const cached = key ? await cache?.get(key).catch(() => undefined) : undefined;
    if (cached) {
      try {
        plain = await decode(cached);
      } catch {
        await cache?.remove(key).catch(() => {});
        signal?.throwIfAborted();
      }
    }
    if (!plain) {
      const data = await fetchBytes();
      plain = await decode(data);
      if (key) await cache?.put(key, data).catch(() => {});
    }
    return { data: plain, name: secret.name, mime: safeMime(secret.mime), size: secret.size };
  }
}
function safeMime(mime: string) {
  return /^(image\/(png|jpeg|gif|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|text\/plain|application\/pdf)(;|$)/i.test(
    mime,
  )
    ? mime
    : 'application/octet-stream';
}
