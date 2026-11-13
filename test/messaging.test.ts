import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelay } from '../src/server/relay.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { nextUserId } from '../src/shared/account-identity.js';
import { MessagingStore } from './messaging-fixtures.js';
import { EncryptedMessagingClient } from '../src/client/encrypted-messaging.js';
import { AccountClient } from '../src/client/account.js';
import { protectAccount } from '../src/shared/account-crypto.js';
import { translationProvider } from '../src/server/messaging/translation.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});
async function fixture(registrationCode?: string, translation?: { fetch: typeof fetch; apiKey?: string }) {
  const origin = 'https://chat.test';
  const relay = await buildRelay({
    origin,
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'test-messaging-relay-enrollment-secret',
    messaging: {
      humanContacts: true,
      registrationCode,
      translate:
        translation &&
        translationProvider({
          POCKET_TRANSLATION_URL: 'https://translate.test/translate',
          POCKET_TRANSLATION_API_KEY: translation.apiKey,
        }),
    },
  });
  cleanups.push(() => relay.app.close());
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.origin === 'https://translate.test') {
      if (!translation) throw Error('Translation was disabled in this test');
      return translation.fetch(input, init);
    }
    const headers = new Headers(init.headers);
    const result = await relay.app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: { host: 'chat.test', origin, ...Object.fromEntries(headers) },
      payload:
        typeof init.body === 'string'
          ? init.body
          : init.body
            ? Buffer.from(init.body as Uint8Array)
            : undefined,
    });
    return new Response(new Uint8Array(result.rawPayload), {
      status: result.statusCode,
      headers: result.headers as Record<string, string>,
    });
  });
  const clients = new Map<string, InjectClient>();
  type Result = { status: number; body: any; cookie: string; headers: any };
  class InjectClient extends EncryptedMessagingClient {
    override readonly account = new AccountClient(<T>(path: string, method?: string, body?: unknown) =>
      this.raw<T>(path, method, body),
    );
    extra: Record<string, string> = {};
    last: Result = { status: 200, body: {}, cookie: '', headers: {} };
    authResponse?: Result;
    constructor(public auth = '') {
      super();
    }
    override async raw<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
      const response = await relay.app.inject({
        method: method as 'GET',
        url: `/api/im${path}`,
        headers: {
          host: 'chat.test',
          origin,
          ...(this.auth.startsWith('Bearer ') ? { authorization: this.auth } : { cookie: this.auth }),
          ...this.extra,
        },
        payload: payload as object,
      });
      this.last = {
        status: response.statusCode,
        body: response.json(),
        cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        headers: response.headers,
      };
      if (this.last.cookie) {
        this.auth = this.last.cookie;
        clients.set(this.auth, this);
        this.authResponse = this.last;
      }
      if (response.statusCode >= 400)
        throw Object.assign(Error(this.last.body.error), { status: response.statusCode });
      return this.last.body as T;
    }
    media() {
      const client = new EncryptedMessagingClient(
        origin,
        this.auth.startsWith('Bearer ') ? this.auth.slice(7) : this.auth.split('=')[1],
      );
      client.account.activate(
        this.account.user!,
        this.account.secrets!,
        this.account.vault,
        this.account.revision,
      );
      return client;
    }
    override upload(id: string, name: string, data: Blob | Uint8Array, signal?: AbortSignal) {
      return this.media().upload(id, name, data, signal);
    }
    override download(path: string, signal?: AbortSignal) {
      return this.media().download(path, signal);
    }
    override async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      return (this as any).decode(await this.raw(path, method, body));
    }
  }
  // This test adapter translates human-readable test inputs through the production encrypted client.
  const request = async (
    path: string,
    method = 'GET',
    payload?: any,
    credential = '',
    extra: Record<string, string> = {},
  ): Promise<Result> => {
    const client = clients.get(credential) ?? new InjectClient(credential);
    client.extra = extra;
    client.last = { status: 200, body: {}, cookie: '', headers: {} };
    client.authResponse = undefined;
    try {
      let body: any;
      if (path === '/crypto/register' && payload?.password)
        body = await client.account.register(
          payload.username,
          payload.displayName,
          payload.password,
          payload.registrationCode,
        );
      else if (path === '/crypto/login' && payload?.password && typeof payload.identifier === 'string')
        body = await client.account.login(payload.identifier, payload.password);
      else if (path === '/crypto/password') {
        try {
          await client.account.changePassword(payload.currentPassword, payload.newPassword);
          body = { ok: true };
        } catch (error) {
          throw Object.assign(error as object, { status: (error as any).status ?? 403 });
        }
      } else if (path === '/agents/register') {
        const protectedAccount = await protectAccount('test-agent-password-123');
        body = await client.raw(path, method, { ...payload, vault: protectedAccount.vault });
        const agent = new InjectClient(`Bearer ${body.token}`);
        agent.account.activate(body.user, protectedAccount.secrets);
        clients.set(agent.auth, agent);
      } else {
        const message = /^\/conversations\/([^/]+)\/messages(?:\/([^/]+))?(\/respond)?$/.exec(path);
        if (message && method === 'POST' && message[3])
          body = await client.respond(message[1], message[2], payload);
        else if (message && method === 'POST' && !message[2]) {
          const { text = '', clientId, ...options } = payload;
          body = await client.send(message[1], text, clientId, options);
        } else if (message && method === 'PATCH')
          body = await client.updateMessage(
            message[1],
            message[2],
            payload.revision,
            payload.text,
            payload.state,
          );
        else if (path === '/stickers' && method === 'POST')
          body = await client.saveSticker(payload.conversationId, payload.fileId);
        else body = await client.request(path, method, payload);
      }
      return { ...(client.authResponse ?? client.last), body };
    } catch (error) {
      const detail = error as { status?: number; message: string };
      return {
        ...client.last,
        status:
          detail.status ??
          (/请求标识/.test(detail.message) ? 409 : /表情包不存在/.test(detail.message) ? 404 : 400),
        body: { error: detail.message },
      };
    }
  };
  async function human(username: string) {
    const result = await request('/crypto/register', 'POST', {
      username,
      displayName: username,
      password: 'test-password-123',
      registrationCode,
    });
    expect(result.status).toBe(201);
    return { ...result.body.user, cookie: result.cookie };
  }
  return { request, human, app: relay.app, client: (cookie: string) => clients.get(cookie)! };
}

it('reports disabled selection translation to signed-in users', async () => {
  const { request, human } = await fixture();
  const selected = { text: 'Selected text', targetLanguage: 'zh' };
  expect((await request('/translation')).status).toBe(401);
  expect((await request('/translation', 'POST', selected)).status).toBe(401);
  const alice = await human('alice');
  const capability = await request('/translation', 'GET', undefined, alice.cookie);
  expect(capability.body).toEqual({ available: false });
  expect(capability.headers['cache-control']).toBe('no-store');
  expect((await request('/translation', 'POST', selected, alice.cookie)).status).toBe(503);
});

it('translates a bounded selection for a signed-in user and hides upstream failures', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ translatedText: 'Translated text' }))
    .mockResolvedValueOnce(Response.json({ error: 'upstream sensitive detail' }, { status: 500 }));
  const { request, human } = await fixture(undefined, { fetch, apiKey: 'fixture-api-key' });
  const alice = await human('alice');
  const capability = await request('/translation', 'GET', undefined, alice.cookie);
  expect(capability.body).toEqual({ available: true });
  const selected = '字'.repeat(2000);
  for (const body of [
    { text: ' ', targetLanguage: 'en' },
    { text: selected + '字', targetLanguage: 'en' },
    { text: selected, targetLanguage: 'fr' },
  ]) {
    expect((await request('/translation', 'POST', body, alice.cookie)).status).toBe(400);
  }
  expect(
    (await request('/translation', 'POST', { text: '字'.repeat(6000), targetLanguage: 'en' }, alice.cookie))
      .status,
  ).toBe(413);
  const input = { text: selected, targetLanguage: 'en' };
  expect(
    (await request('/translation', 'POST', input, alice.cookie, { origin: 'https://other.test' })).status,
  ).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  const result = await request('/translation', 'POST', input, alice.cookie);
  expect(result.body).toEqual({ translatedText: 'Translated text' });
  expect(result.headers['cache-control']).toBe('no-store');
  expect(fetch).toHaveBeenCalledOnce();
  const [endpoint, init] = fetch.mock.calls[0];
  expect(String(endpoint)).toBe('https://translate.test/translate');
  expect(init?.method).toBe('POST');
  expect(init?.redirect).toBe('manual');
  expect(JSON.parse(String(init?.body))).toEqual({
    q: selected,
    source: 'auto',
    target: 'en',
    format: 'text',
    api_key: 'fixture-api-key',
  });
  const failure = await request('/translation', 'POST', input, alice.cookie);
  expect(failure.status).toBe(502);
  expect(failure.body.error).not.toContain('upstream sensitive detail');
});

it('registers real human accounts, restores sessions, persists profile and enforces login/logout', async () => {
  const { request, human } = await fixture();
  const alice = await human('alice');
  expect((await request('/me', 'GET', undefined, alice.cookie)).body.user.id).toBe(alice.id);
  const profile = await request('/me', 'PATCH', { displayName: 'Alice 新名字' }, alice.cookie);
  expect(profile.body.user.displayName).toBe('Alice 新名字');
  expect(
    (await request('/crypto/login', 'POST', { identifier: 'alice', password: 'wrong-password' })).status,
  ).toBe(401);
  const login = await request('/crypto/login', 'POST', {
    identifier: 'ALICE',
    password: 'test-password-123',
  });
  expect(login.status).toBe(200);
  expect(login.headers['set-cookie']).toContain('HttpOnly');
  expect(login.headers['set-cookie']).toContain('Secure');
  expect(login.headers['set-cookie']).toContain('SameSite=Strict');
  await request('/logout', 'POST', {}, login.cookie);
  expect((await request('/contacts', 'GET', undefined, login.cookie)).status).toBe(401);
  expect((await request('/me')).body).toEqual({ user: null });
});

it('uses one-use Agent invitations, scopes credentials and immediately revokes long polls', async () => {
  const { request, human } = await fixture();
  const alice = await human('alice'),
    bob = await human('bob');
  const invite = await request('/agent-invitations', 'POST', {}, alice.cookie);
  const agent = await request('/agents/register', 'POST', {
    invitation: invite.body.invitation,
    username: 'assistant',
    displayName: '研究助手',
  });
  expect(agent.status).toBe(201);
  expect(agent.body.owner.id).toBe(alice.id);
  const auth = `Bearer ${agent.body.token}`;
  expect(
    (
      await request('/agents/register', 'POST', {
        invitation: invite.body.invitation,
        username: 'other',
        displayName: 'other',
      })
    ).status,
  ).toBe(400);
  expect(
    (await request('/contacts', 'GET', undefined, alice.cookie)).body.users.map((u: any) => u.id),
  ).toEqual([agent.body.user.id]);
  expect((await request('/contacts', 'GET', undefined, auth)).body.users.map((u: any) => u.id)).toEqual([
    alice.id,
  ]);
  expect((await request('/agent-invitations', 'POST', {}, auth)).status).toBe(403);
  expect(
    (await request(`/agents/${agent.body.user.id}/credentials`, 'DELETE', undefined, bob.cookie)).status,
  ).toBe(404);
  const current = await request('/sync?cursor=0&wait=0', 'GET', undefined, auth);
  const pending = request(`/sync?cursor=${current.body.cursor}&wait=25000`, 'GET', undefined, auth);
  await new Promise((r) => setTimeout(r, 20));
  await request(`/agents/${agent.body.user.id}/credentials`, 'DELETE', undefined, alice.cookie);
  expect((await pending).status).toBe(401);
  expect((await request('/contacts', 'GET', undefined, auth)).status).toBe(401);
  const rotated = await request(`/agents/${agent.body.user.id}/credentials`, 'POST', {}, alice.cookie);
  expect((await request('/contacts', 'GET', undefined, `Bearer ${rotated.body.token}`)).status).toBe(200);
});

it('delivers human↔Agent messages in realtime, deduplicates retries and isolates third parties', async () => {
  const { request, human } = await fixture();
  const alice = await human('alice'),
    eve = await human('eve');
  const invite = (await request('/agent-invitations', 'POST', {}, alice.cookie)).body;
  const agent = (
    await request('/agents/register', 'POST', {
      invitation: invite.invitation,
      username: 'assistant',
      displayName: 'Agent',
    })
  ).body;
  const auth = `Bearer ${agent.token}`;
  const convo = (await request('/conversations', 'POST', { userId: agent.user.id }, alice.cookie)).body
    .conversation;
  expect((await request('/conversations', 'POST', { userId: alice.id }, auth)).body.conversation.id).toBe(
    convo.id,
  );
  const current = (await request('/sync?cursor=0&wait=0', 'GET', undefined, auth)).body;
  const pending = request(`/sync?cursor=${current.cursor}&wait=25000`, 'GET', undefined, auth);
  await new Promise((r) => setTimeout(r, 20));
  const sent = (
    await request(
      `/conversations/${convo.id}/messages`,
      'POST',
      { clientId: 'msg1', text: '你好' },
      alice.cookie,
    )
  ).body.message;
  expect((await pending).body.events[0]).toMatchObject({ type: 'message', conversationId: convo.id });
  const retry = await request(
    `/conversations/${convo.id}/messages`,
    'POST',
    { clientId: 'msg1', text: '你好' },
    alice.cookie,
  );
  expect(retry.body.message.id).toBe(sent.id);
  expect(
    (
      await request(
        `/conversations/${convo.id}/messages`,
        'POST',
        { clientId: 'msg1', text: '不同内容' },
        alice.cookie,
      )
    ).status,
  ).toBe(409);
  expect((await request('/conversations', 'GET', undefined, auth)).body.conversations[0].unread).toBe(1);
  await request(`/conversations/${convo.id}/read`, 'POST', { sequence: sent.sequence }, auth);
  expect(
    (await request('/conversations', 'GET', undefined, alice.cookie)).body.conversations[0].peerReadSequence,
  ).toBe(sent.sequence);
  await request(`/conversations/${convo.id}/messages`, 'POST', { clientId: 'reply1', text: '收到' }, auth);
  expect(
    (await request(`/conversations/${convo.id}/messages`, 'GET', undefined, alice.cookie)).body.messages.map(
      (m: any) => m.text,
    ),
  ).toEqual(['你好', '收到']);
  for (const [path, method, body] of [
    [`/conversations/${convo.id}/messages`, 'GET', undefined],
    [`/conversations/${convo.id}/messages`, 'POST', { clientId: 'steal', text: 'test' }],
    [`/conversations/${convo.id}/read`, 'POST', { sequence: sent.sequence }],
  ] as const)
    expect((await request(path, method, body, eve.cookie)).status).toBe(404);
  expect((await request('/sync?cursor=0&wait=0', 'GET', undefined, eve.cookie)).body.events).toEqual([]);
  expect((await request('/conversations', 'GET', undefined, eve.cookie)).body.conversations).toEqual([]);
});

it('supports human contacts, validates input, CSRF, private registration and rate limiting', async () => {
  const { request, human } = await fixture('private-registration-code');
  expect(
    (
      await request('/crypto/register', 'POST', {
        username: 'blocked',
        displayName: 'Blocked',
        password: 'valid-pass-123',
      })
    ).status,
  ).toBe(403);
  const alice = await human('alice'),
    bob = await human('bob');
  expect((await request('/conversations', 'POST', { userId: bob.id }, alice.cookie)).status).toBe(403);
  await request('/contacts', 'POST', { identifier: 'bob' }, alice.cookie);
  const convo = (await request('/conversations', 'POST', { userId: bob.id }, alice.cookie)).body.conversation;
  expect(convo.peer.kind).toBe('human');
  expect(
    (await request('/contacts', 'POST', { identifier: 'bob' }, alice.cookie, { origin: 'https://evil.test' }))
      .status,
  ).toBe(403);
  expect(
    (
      await request(
        `/conversations/${convo.id}/messages`,
        'POST',
        { clientId: 'empty', text: '  ' },
        alice.cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (await request(`/conversations/${convo.id}/read`, 'POST', { sequence: 5000 }, alice.cookie)).status,
  ).toBe(400);
  expect((await request('/contacts', 'POST', { identifier: 'alice' }, alice.cookie)).status).toBe(400);
  for (let i = 0; i < 15; i++) await request('/crypto/login', 'POST', {});
  expect((await request('/crypto/login', 'POST', {})).status).toBe(429);
});

it('persists history, pages without gaps and keeps unread cursors monotonic after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-messaging-'));
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, 'chat.sqlite');
  let store = new MessagingStore(path);
  const a = store.createUser('human', 'alice', 'Alice', 'hash'),
    b = store.createUser('human', 'bob', 'Bob', 'hash');
  store.addContact(a.id, 'bob');
  const conversation = store.direct(a.id, b.id);
  const token = store.issueSession(a.id).token;
  for (let i = 0; i < 125; i++) store.send(a.id, conversation.id, String(i), `message ${i}`);
  store.read(b.id, conversation.id, 100);
  store.read(b.id, conversation.id, 10);
  store.close();
  store = new MessagingStore(path);
  cleanups.push(() => store.close());
  expect(store.authenticate(token)?.id).toBe(a.id);
  expect(store.conversation(b.id, conversation.id).unread).toBe(25);
  let page = store.history(b.id, conversation.id),
    messages = [...page.messages];
  while (page.before) {
    page = store.history(b.id, conversation.id, page.before);
    messages.unshift(...page.messages);
  }
  expect(messages.map((m) => m.text)).toEqual(Array.from({ length: 125 }, (_, i) => `message ${i}`));
  const first = store.sync(b.id, 0),
    second = store.sync(b.id, first.cursor);
  expect(first.events).toHaveLength(100);
  expect(second.events.length).toBeGreaterThan(0);
  expect(second.events[0].sequence).toBeGreaterThan(first.cursor);
});

it('does not consume invitations on username conflicts and rejects expired secrets', () => {
  const store = new MessagingStore(':memory:');
  cleanups.push(() => store.close());
  const owner = store.createUser('human', 'owner', 'Owner', 'hash');
  const invite = store.invite(owner.id);
  expect(() => store.registerAgent(invite.invitation, 'owner', 'Conflict')).toThrow('用户名已被使用');
  const agent = store.registerAgent(invite.invitation, 'assistant', 'Assistant');
  expect(agent.owner.id).toBe(owner.id);
  const expired = store.invite(owner.id);
  store.db.prepare('UPDATE im_invites SET expires_at=0').run();
  expect(() => store.registerAgent(expired.invitation, 'expired', 'Expired')).toThrow('邀请无效');
  store.db.prepare('UPDATE im_sessions SET expires_at=0').run();
  expect(store.authenticate(agent.token)).toBeNull();
  const stored = store.db.prepare('SELECT hash FROM im_sessions').get()!;
  expect(stored.hash).not.toBe(agent.token);
});

it('enforces auth limits even with query parameters and rejects untrusted cookies', async () => {
  const { request, human } = await fixture();
  const alice = await human('alice');
  expect((await request('/me', 'PATCH', { displayName: 'Fake' }, alice.cookie, { origin: '' })).status).toBe(
    403,
  );
  expect(
    (await request('/contacts', 'GET', undefined, alice.cookie, { 'sec-fetch-site': 'cross-site' })).status,
  ).toBe(403);
  for (let i = 0; i < 15; i++) await request(`/crypto/login?attempt=${i}`, 'POST', {});
  expect((await request('/crypto/login?attempt=16', 'POST', {})).status).toBe(429);
});

function groupFixture() {
  const store = new MessagingStore(':memory:');
  cleanups.push(() => store.close());
  const owner = store.createUser('human', 'owner', 'Owner', 'hash');
  const member = store.createUser('human', 'member', 'Member', 'hash');
  const outsider = store.createUser('human', 'outsider', 'Outsider', 'hash');
  const agent = store.registerAgent(store.invite(owner.id).invitation, 'assistant', 'Assistant').user;
  store.addContact(owner.id, member.username);
  const group = store.createGroup(owner.id, '研究讨论组', [member.id, agent.id]);
  return { store, owner, member, outsider, agent, group };
}

it('enforces group ownership, transfer, leaving, dissolution and membership visibility', () => {
  const { store, owner, member, outsider, agent, group } = groupFixture();
  expect(group.kind).toBe('group');
  expect(group.members).toHaveLength(3);
  expect(() => store.updateGroup(member.id, group.id, { name: 'hijack' })).toThrow('只有群主');
  expect(() => store.updateGroup(owner.id, group.id, { remove: owner.id })).toThrow('请先转让');
  expect(() => store.updateGroup(owner.id, group.id, { add: [outsider.id] })).toThrow('添加联系人');
  store.addContact(owner.id, outsider.username);
  store.updateGroup(owner.id, group.id, { add: [outsider.id], name: '新群名' });
  expect(store.conversation(outsider.id, group.id).name).toBe('新群名');
  store.updateGroup(owner.id, group.id, { ownerId: member.id });
  store.updateGroup(owner.id, group.id, { remove: owner.id });
  expect(() => store.history(owner.id, group.id)).toThrow('已离开');
  expect(() => store.updateGroup(owner.id, group.id, { closed: true })).toThrow('已离开');
  const stream = store.send(agent.id, group.id, 'stream', 'draft', { state: 'streaming' });
  const cursor = store.cursor(member.id);
  store.updateGroup(member.id, group.id, { closed: true });
  expect(store.message(member.id, group.id, stream.id).state).toBe('cancelled');
  expect(store.sync(member.id, cursor).events.some((e) => e.message?.state === 'cancelled')).toBe(true);
  expect(() => store.send(member.id, group.id, 'closed', 'test')).toThrow('已解散');
  expect(store.history(member.id, group.id).messages).toHaveLength(1);
});

it('streams immutable creation requests with ordered revisions, safe retries and persisted cancellation', () => {
  const { store, owner, agent, member, group } = groupFixture();
  expect(() => store.send(owner.id, group.id, 'human-stream', '', { state: 'streaming' })).toThrow(
    '仅适用于 Agent',
  );
  const first = store.send(agent.id, group.id, 'stream', '', { state: 'streaming' });
  const update = store.updateMessage(agent.id, group.id, first.id, 1, '**hello**', 'streaming');
  expect(update.sequence).toBe(first.sequence);
  expect(store.updateMessage(agent.id, group.id, first.id, 1, '**hello**', 'streaming')).toEqual(update);
  expect(() => store.updateMessage(agent.id, group.id, first.id, 1, 'altered', 'streaming')).toThrow(
    '版本冲突',
  );
  expect(() => store.updateMessage(member.id, group.id, first.id, 2, 'hijack', 'complete')).toThrow(
    '自己发出',
  );
  expect(store.send(agent.id, group.id, 'stream', '', { state: 'streaming' }).id).toBe(first.id);
  expect(() => store.send(agent.id, group.id, 'stream', 'different start', { state: 'streaming' })).toThrow(
    '其他内容',
  );
  expect(() => store.send(agent.id, group.id, 'stream', '**hello**')).toThrow('其他内容');
  const stopped = store.cancel(owner.id, group.id, first.id);
  expect(stopped).toMatchObject({ state: 'cancelled', text: '**hello**', revision: 2 });
  expect(() => store.updateMessage(agent.id, group.id, first.id, 3, 'late token', 'complete')).toThrow(
    '回复已结束',
  );
  expect(store.cancel(owner.id, group.id, first.id)).toEqual(stopped);
  expect(store.history(member.id, group.id).messages).toHaveLength(1);
});

it('expires abandoned streams and coalesces sync payloads without losing the event cursor', () => {
  const { store, owner, agent, group } = groupFixture();
  const cursor = store.cursor(owner.id);
  const stream = store.send(agent.id, group.id, 'stream', '', { state: 'streaming' });
  store.updateMessage(agent.id, group.id, stream.id, 1, 'part', 'streaming');
  store.db.prepare('UPDATE im_messages SET updated_at=0 WHERE id=?').run(stream.id);
  store.expireStreams();
  const batch = store.sync(owner.id, cursor);
  expect(batch.events).toHaveLength(3);
  expect(batch.events.filter((e) => e.message)).toHaveLength(1);
  expect(batch.events.at(-1)?.message).toMatchObject({ state: 'failed', text: 'part', revision: 2 });
  expect(batch.cursor).toBe(store.cursor(owner.id));
});

it('checks attachment ownership, conversation boundaries, drafts, membership removal and byte integrity', () => {
  const { store, owner, member, outsider, agent, group } = groupFixture();
  const data = Buffer.from('材料测试\n0\u0000\u0001\u00ff', 'utf8');
  const file = store.upload(owner.id, group.id, '数据.txt', data);
  expect(() => store.file(member.id, group.id, file.id)).toThrow('附件不存在');
  expect(store.file(owner.id, group.id, file.id).data.equals(data)).toBe(true);
  expect(() => store.send(member.id, group.id, 'stolen', '', { attachmentIds: [file.id] })).toThrow(
    '附件不存在',
  );
  const direct = store.direct(owner.id, agent.id);
  expect(() => store.send(owner.id, direct.id, 'cross', '', { attachmentIds: [file.id] })).toThrow(
    '附件不存在',
  );
  store.send(owner.id, group.id, 'file', '', { attachmentIds: [file.id] });
  store.removeUpload(owner.id, group.id, file.id);
  expect(store.file(member.id, group.id, file.id).data.equals(data)).toBe(true);
  expect(() => store.file(outsider.id, group.id, file.id)).toThrow('已离开');
  const stream = store.send(agent.id, group.id, 'stream', 'partial', { state: 'streaming' });
  const cursor = store.cursor(member.id);
  store.updateGroup(owner.id, group.id, { remove: agent.id });
  expect(
    store
      .sync(member.id, cursor)
      .events.some((e) => e.message?.id === stream.id && e.message.state === 'cancelled'),
  ).toBe(true);
  store.updateGroup(owner.id, group.id, { remove: member.id });
  expect(() => store.file(member.id, group.id, file.id)).toThrow('已离开');
  expect(store.sync(member.id, 0).events.every((e) => !e.message)).toBe(true);
  expect(() => store.upload(owner.id, group.id, 'empty', Buffer.alloc(0))).toThrow('1 字节');
  expect(() => store.upload(owner.id, group.id, 'large', Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow(
    '10 MB',
  );
});

it('validates replies and mentions, searches and propagates profiles to group-only peers', () => {
  const { store, owner, member, outsider, agent, group } = groupFixture();
  const first = store.send(owner.id, group.id, 'first', 'DFT Calculation');
  const reply = store.send(member.id, group.id, 'reply', '@assistant 收到', {
    replyTo: first.id,
    mentions: [agent.id],
  });
  expect(reply.replyTo).toBe(first.id);
  expect(() => store.send(member.id, group.id, 'mention', 'unknown', { mentions: [outsider.id] })).toThrow(
    '当前会话成员',
  );
  const direct = store.direct(owner.id, agent.id);
  expect(() => store.send(owner.id, direct.id, 'reply-cross', 'test', { replyTo: first.id })).toThrow(
    '消息不存在',
  );
  expect(store.search(agent.id, group.id, 'dft').messages.map((m) => m.id)).toEqual([first.id]);
  expect(store.search(agent.id, group.id, '不存在').messages).toEqual([]);
  const cursor = store.cursor(agent.id);
  store.profile(member.id, '新昵称');
  expect(store.sync(agent.id, cursor).events.some((e) => e.type === 'profile')).toBe(true);
});

it('keeps a contact block effective until explicitly lifted, without deleting history', () => {
  const { store, owner, member } = groupFixture();
  const chat = store.direct(owner.id, member.id);
  store.send(owner.id, chat.id, 'first', 'history');
  store.editContact(owner.id, member.id, { remark: '同事', blocked: true });
  expect(store.contacts(owner.id).find((c) => c.id === member.id)).toMatchObject({
    remark: '同事',
    blocked: true,
  });
  expect(() => store.send(member.id, chat.id, 'blocked', 'test')).toThrow('已被屏蔽');
  expect(() => store.editContact(owner.id, member.id, {}, true)).toThrow('解除屏蔽');
  expect(() => store.createGroup(owner.id, 'new', [member.id])).toThrow('已屏蔽');
  store.editContact(owner.id, member.id, { blocked: false });
  store.editContact(owner.id, member.id, {}, true);
  expect(store.history(owner.id, chat.id).messages).toHaveLength(1);
  expect(store.contacts(owner.id).find((c) => c.id === member.id)).toBeUndefined();
});

it('changes passwords safely, revokes other sessions and rejects the previous password', async () => {
  const { request, human } = await fixture();
  const owner = await human('owner');
  const other = await request('/crypto/login', 'POST', {
    identifier: 'owner',
    password: 'test-password-123',
  });
  expect(
    (
      await request(
        '/crypto/password',
        'POST',
        { currentPassword: 'incorrect-pass', newPassword: 'new-password-123' },
        owner.cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        '/crypto/password',
        'POST',
        { currentPassword: 'test-password-123', newPassword: 'new-password-123' },
        owner.cookie,
      )
    ).status,
  ).toBe(200);
  expect((await request('/contacts', 'GET', undefined, other.cookie)).status).toBe(401);
  expect((await request('/contacts', 'GET', undefined, owner.cookie)).status).toBe(200);
  expect(
    (await request('/crypto/login', 'POST', { identifier: 'owner', password: 'test-password-123' })).status,
  ).toBe(401);
  expect(
    (await request('/crypto/login', 'POST', { identifier: 'owner', password: 'new-password-123' })).status,
  ).toBe(200);
});

it('serves authorized binary attachments with safe headers and rejects active content and oversized bodies', async () => {
  const { request, human, app, client } = await fixture();
  const owner = await human('owner'),
    member = await human('member');
  await request('/contacts', 'POST', { identifier: 'member' }, owner.cookie);
  const group = (await request('/groups', 'POST', { name: '测试群', userIds: [member.id] }, owner.cookie))
    .body.conversation;
  const headers = {
    origin: 'https://chat.test',
    host: 'chat.test',
    cookie: owner.cookie,
    'content-type': 'application/octet-stream',
    'x-file-name': encodeURIComponent('测试.html'),
  };
  const payload = Buffer.from('<script>alert(1)</script>\n\u0000');
  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/im/conversations/${group.id}/files`,
    headers,
    payload,
  });
  expect(uploaded.statusCode).toBe(409); // Plaintext uploads have no compatibility path.
  const { file } = await client(owner.cookie).upload(group.id, '测试.html', payload);
  expect(file.mime).toBe('application/octet-stream');
  await request(
    `/conversations/${group.id}/messages`,
    'POST',
    { clientId: 'file', attachmentIds: [file.id] },
    owner.cookie,
  );
  const downloaded = await app.inject({
    url: file.url,
    headers: { host: 'chat.test', cookie: member.cookie },
  });
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.rawPayload.equals(payload)).toBe(false);
  expect(Buffer.from((await client(member.cookie).download(file.url)).data)).toEqual(payload);
  expect(downloaded.headers['content-disposition']).toContain('attachment');
  expect(downloaded.headers['content-security-policy']).toContain("default-src 'none'");
  const invalid = await app.inject({
    method: 'POST',
    url: `/api/im/conversations/${group.id}/files`,
    headers: { ...headers, 'x-file-name': encodeURIComponent('../escape') },
    payload,
  });
  expect(invalid.statusCode).toBe(400);
  const large = await app.inject({
    method: 'POST',
    url: `/api/im/conversations/${group.id}/files`,
    headers,
    payload: Buffer.alloc(10 * 1024 * 1024 + 17),
  });
  expect(large.statusCode).toBe(413);
  await request(`/groups/${group.id}`, 'PATCH', { remove: member.id }, owner.cookie);
  expect(
    (await app.inject({ url: file.url, headers: { host: 'chat.test', cookie: member.cookie } })).statusCode,
  ).toBe(404);
});

it('allocates permanent decimal string UIDs without fixed width or numeric precision loss', () => {
  expect(nextUserId('9999999')).toBe('10000000');
  expect(nextUserId('99999999')).toBe('100000000');
  expect(nextUserId('9007199254740992')).toBe('9007199254740993');
  expect(nextUserId('9'.repeat(512))).toBe('1' + '0'.repeat(512));
  const store = new MessagingStore(':memory:', 'chat.test');
  cleanups.push(() => store.close());
  const first = store.createUser('human', 'first', 'First', 'hash');
  expect(first).toMatchObject({ id: '10000000', address: '10000000@chat.test' });
  expect(typeof first.id).toBe('string');
  store.db.prepare("UPDATE im_uid_allocator SET last_uid=? WHERE name='user'").run('9'.repeat(128));
  const huge = store.createUser('human', 'huge', 'Huge', 'hash');
  expect(huge.id).toBe('1' + '0'.repeat(128));
  expect(store.credentials(huge.id)?.id).toBe(huge.id);
  expect(store.db.prepare('SELECT typeof(id) AS type FROM im_users WHERE id=?').get(huge.id)?.type).toBe(
    'text',
  );
  expect(store.db.prepare('SELECT typeof(last_uid) AS type FROM im_uid_allocator').get()?.type).toBe('text');
  const agent = store.registerAgent(store.invite(first.id).invitation, 'agent', 'Agent').user;
  expect(agent.id).toBe(nextUserId(huge.id));
  expect(agent.address).toBe(agent.id + '@chat.test');
  expect(store.agents(first.id)[0].address).toBe(agent.address);
  const chat = store.direct(first.id, agent.id);
  const msg = store.send(first.id, chat.id, 'request', 'hello', { mentions: [agent.id] });
  expect(msg.senderId).toBe(first.id);
  expect(msg.mentions).toEqual([agent.id]);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('does not reuse committed UIDs after account removal and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-uid-persist-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'chat.sqlite');
  let store = new MessagingStore(path);
  const first = store.createUser('human', 'first', 'First', 'hash');
  store.db.prepare('DELETE FROM im_users WHERE id=?').run(first.id);
  store.close();
  store = new MessagingStore(path);
  cleanups.push(() => store.close());
  expect(store.createUser('human', 'second', 'Second', 'hash').id).toBe('10000001');
});

it('serializes UID allocation across concurrent processes sharing the account database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-uid-concurrent-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'chat.sqlite');
  const store = new MessagingStore(path);
  cleanups.push(() => store.close());
  const run = promisify(execFile);
  const code = `import {MessagingStore} from ${JSON.stringify(new URL('../src/server/messaging/store.ts', import.meta.url).href)};
    const store=new MessagingStore(process.argv[1]);for(let i=0;i<30;i++)store.createUser('human',process.argv[2]+'_'+i,'Worker','hash');store.close();`;
  await Promise.all(
    ['a', 'b', 'c', 'd'].map((prefix) =>
      run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, path, prefix], {
        cwd: resolve('.'),
      }),
    ),
  );
  const ids = store.db
    .prepare('SELECT id FROM im_users')
    .all()
    .map((row) => String(row.id));
  expect(ids).toHaveLength(120);
  expect(new Set(ids).size).toBe(120);
  expect(store.db.prepare('SELECT last_uid FROM im_uid_allocator').get()?.last_uid).toBe('10000119');
});

it('accepts UID, username and local qualified identity for login and contacts, while rejecting wrong scopes and numeric JSON IDs', async () => {
  const { request, human } = await fixture();
  const alice = await human('alice'),
    bob = await human('bob');
  expect(alice.id).toBe('10000000');
  expect(bob.id).toBe('10000001');
  for (const identifier of [alice.id, '@ALICE', alice.address]) {
    const login = await request('/crypto/login', 'POST', { identifier, password: 'test-password-123' });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(alice.id);
  }
  expect(
    (
      await request('/crypto/login', 'POST', {
        identifier: alice.id + '@elsewhere.test',
        password: 'test-password-123',
      })
    ).status,
  ).toBe(401);
  expect(
    (await request('/crypto/login', 'POST', { identifier: 10000000, password: 'test-password-123' })).status,
  ).toBe(400);
  for (const identifier of [bob.id, '@BOB', bob.address]) {
    const added = await request('/contacts', 'POST', { identifier }, alice.cookie);
    expect(added.status).toBe(200);
    expect(added.body.user.id).toBe(bob.id);
  }
  expect(
    (await request('/contacts', 'POST', { identifier: bob.id + '@elsewhere.test' }, alice.cookie)).status,
  ).toBe(404);
  expect((await request('/conversations', 'POST', { userId: bob.id }, alice.cookie)).status).toBe(200);
  expect((await request('/conversations', 'POST', { userId: 10000001 }, alice.cookie)).status).toBe(400);
  expect((await request('/conversations', 'POST', { userId: '010000001' }, alice.cookie)).status).toBe(400);
  expect(
    (
      await request('/crypto/register', 'POST', {
        username: '12345678',
        displayName: 'invalid',
        password: 'test-password-123',
      })
    ).status,
  ).toBe(400);
});

it('delivers question and approval snapshots with human-only, single-recipient decisions and safe retries', async () => {
  const { request, human } = await fixture();
  const alice = await human('alice'),
    bob = await human('bob');
  await request('/contacts', 'POST', { identifier: bob.id }, alice.cookie);
  const invite = await request('/agent-invitations', 'POST', {}, alice.cookie);
  const agent = (
    await request('/agents/register', 'POST', {
      invitation: invite.body.invitation,
      username: 'request-agent',
      displayName: 'Agent',
    })
  ).body;
  const token = `Bearer ${agent.token}`;
  const group = (
    await request('/groups', 'POST', { name: 'Requests', userIds: [bob.id, agent.user.id] }, alice.cookie)
  ).body.conversation;
  const path = `/conversations/${group.id}/messages`;
  const interaction = {
    kind: 'approval',
    recipientId: alice.id,
    title: 'Export report',
    description: 'Write the reviewed report to the specified file.',
  };
  const sent = await request(path, 'POST', { clientId: 'approval-1', text: 'Review', interaction }, token);
  expect(sent.status).toBe(200);
  expect(sent.body.message.interaction.status).toBe('pending');
  const endpoint = `${path}/${sent.body.message.id}/respond`;
  expect((await request(endpoint, 'POST', { decision: 'approve' }, bob.cookie)).status).toBe(403);
  expect((await request(endpoint, 'POST', { decision: 'approve' }, token)).status).toBe(403);
  expect(
    (await request(endpoint, 'POST', { decision: 'approve', permission: 'all' }, alice.cookie)).status,
  ).toBe(400);
  const approved = await request(endpoint, 'POST', { decision: 'approve' }, alice.cookie);
  expect(approved.body.message.interaction).toMatchObject({
    status: 'approved',
    respondedBy: alice.id,
    response: { decision: 'approve' },
  });
  expect(typeof approved.body.message.interaction.respondedBy).toBe('string');
  expect((await request(endpoint, 'POST', { decision: 'approve' }, alice.cookie)).body.message.revision).toBe(
    1,
  );
  expect((await request(endpoint, 'POST', { decision: 'reject' }, alice.cookie)).status).toBe(409);
  expect(
    (await request(path, 'POST', { clientId: 'approval-1', text: 'Review', interaction }, token)).body.message
      .id,
  ).toBe(sent.body.message.id);
  expect(
    (
      await request(
        path,
        'POST',
        {
          clientId: 'approval-1',
          text: 'Review',
          interaction: { ...interaction, description: 'Changed action' },
        },
        token,
      )
    ).status,
  ).toBe(409);
  const updates = (await request('/sync?cursor=0&wait=0', 'GET', undefined, token)).body.events;
  expect(updates.some((e: any) => e.message?.interaction?.status === 'approved')).toBe(true);
  const question = await request(
    path,
    'POST',
    {
      clientId: 'questions-1',
      interaction: {
        kind: 'question',
        recipientId: alice.id,
        title: 'Select',
        description: 'Two questions',
        questions: [
          { id: 'a', question: 'Which one?', options: [{ label: 'One' }] },
          { id: 'b', question: 'Details', multiSelect: true },
        ],
      },
    },
    token,
  );
  expect(question.status).toBe(200);
  const answerPath = `${path}/${question.body.message.id}/respond`;
  expect((await request(answerPath, 'POST', { decision: 'approve' }, alice.cookie)).status).toBe(400);
  expect((await request(answerPath, 'POST', { answers: { a: ['One'] } }, alice.cookie)).status).toBe(400);
  expect(
    (await request(answerPath, 'POST', { answers: { a: ['One', 'Two'], b: ['x'] } }, alice.cookie)).status,
  ).toBe(400);
  const answer = await request(
    answerPath,
    'POST',
    { answers: { a: ['Custom answer'], b: ['x', 'y'] } },
    alice.cookie,
  );
  expect(answer.body.message.interaction).toMatchObject({
    status: 'answered',
    response: { answers: { a: ['Custom answer'], b: ['x', 'y'] } },
  });
  expect(
    (
      await request(
        path,
        'POST',
        { clientId: 'bad-target', interaction: { ...interaction, recipientId: agent.user.id } },
        token,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        path,
        'POST',
        { clientId: 'number-target', interaction: { ...interaction, recipientId: 10000000 } },
        token,
      )
    ).status,
  ).toBe(400);
});

it('expires and withdraws requests, and invalidates requests when group membership changes', () => {
  const store = new MessagingStore(':memory:');
  cleanups.push(() => store.close());
  const owner = store.createUser('human', 'owner', 'Owner', 'hash'),
    other = store.createUser('human', 'other', 'Other', 'hash');
  store.addContact(owner.id, other.id);
  const agent = store.registerAgent(store.invite(owner.id).invitation, 'agent', 'Agent').user;
  const group = store.createGroup(owner.id, 'Group', [other.id, agent.id]);
  const make = (key: string, recipientId = owner.id) =>
    store.send(agent.id, group.id, key, '', {
      interaction: { kind: 'approval', recipientId, title: 'Run', description: 'Specific action' },
    });
  const expired = make('expire');
  const payload = { ...expired.interaction!, expiresAt: Date.now() - 1 };
  store.db
    .prepare('UPDATE im_message_features SET expires_at=?,interaction=? WHERE message_id=?')
    .run(payload.expiresAt, JSON.stringify(payload), expired.id);
  expect(() => store.respond(owner.id, group.id, expired.id, { decision: 'approve' })).toThrow('已失效');
  expect(store.message(owner.id, group.id, expired.id).interaction?.status).toBe('expired');
  const cancel = make('cancel');
  expect(() => store.cancelInteraction(other.id, group.id, cancel.id)).toThrow('只有');
  store.cancelInteraction(agent.id, group.id, cancel.id);
  expect(() => store.respond(owner.id, group.id, cancel.id, { decision: 'approve' })).toThrow('已失效');
  const leaving = make('leaving', other.id);
  store.updateGroup(owner.id, group.id, { remove: other.id });
  store.updateGroup(owner.id, group.id, { add: [other.id] });
  expect(store.message(other.id, group.id, leaving.id).interaction?.status).toBe('cancelled');
  expect(() => store.respond(other.id, group.id, leaving.id, { decision: 'approve' })).toThrow('已失效');
  const closed = make('closed');
  store.updateGroup(owner.id, group.id, { closed: true });
  expect(store.message(owner.id, group.id, closed.id).interaction?.status).toBe('cancelled');
  expect(() => store.respond(owner.id, group.id, closed.id, { decision: 'approve' })).toThrow('已解散');
});

it('keeps private sticker collections, copies sent bytes, and detects audio from content', async () => {
  const { request, human, app, client } = await fixture();
  const alice = await human('alice'),
    bob = await human('bob');
  await request('/contacts', 'POST', { identifier: bob.id }, alice.cookie);
  const cid = (await request('/conversations', 'POST', { userId: bob.id }, alice.cookie)).body.conversation
    .id;
  const path = `/conversations/${cid}`;
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  async function upload(name: string, data: Buffer) {
    return (await client(alice.cookie).upload(cid, name, data)).file;
  }
  const image = await upload('hello.gif', gif);
  expect(
    (await request('/stickers', 'POST', { conversationId: cid, fileId: image.id }, bob.cookie)).status,
  ).toBe(404);
  const saved = await request('/stickers', 'POST', { conversationId: cid, fileId: image.id }, alice.cookie);
  expect(saved.body.stickers).toHaveLength(1);
  const sticker = saved.body.stickers[0];
  expect(
    (await request('/stickers', 'POST', { conversationId: cid, fileId: image.id }, alice.cookie)).body
      .stickers,
  ).toHaveLength(1);
  expect((await request('/stickers', 'GET', undefined, bob.cookie)).body.stickers).toHaveLength(0);
  const bad = await app.inject({
    method: 'GET',
    url: sticker.url,
    headers: { host: 'chat.test', cookie: bob.cookie },
  });
  expect(bad.statusCode).toBe(404);
  expect(
    (
      await request(
        `${path}/messages`,
        'POST',
        { clientId: 'foreign-sticker', stickerId: sticker.id },
        bob.cookie,
      )
    ).status,
  ).toBe(404);
  const sent = await request(
    `${path}/messages`,
    'POST',
    { clientId: 'sticker-send', stickerId: sticker.id },
    alice.cookie,
  );
  expect(sent.body.message.sticker).toBe(true);
  const file = sent.body.message.attachments[0];
  expect(file.id).not.toBe(image.id);
  expect(
    (
      await request(
        `${path}/messages`,
        'POST',
        { clientId: 'sticker-send', stickerId: sticker.id },
        alice.cookie,
      )
    ).body.message.id,
  ).toBe(sent.body.message.id);
  await request(`/stickers/${sticker.id}`, 'DELETE', {}, alice.cookie);
  const bytes = await app.inject({
    method: 'GET',
    url: file.url,
    headers: { host: 'chat.test', cookie: bob.cookie },
  });
  expect(bytes.rawPayload).not.toEqual(gif);
  expect(Buffer.from((await client(bob.cookie).download(file.url)).data)).toEqual(gif);
  const wav = Buffer.alloc(48);
  wav.write('RIFF');
  wav.writeUInt32LE(40, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(4, 40);
  const voice = await upload('voice.wav', wav);
  expect(voice.mime).toBe('audio/wav');
  expect(
    (await request('/stickers', 'POST', { conversationId: cid, fileId: voice.id }, alice.cookie)).status,
  ).toBe(400);
  const disguised = await upload('voice.mp3', Buffer.from('<html>not audio</html>'));
  expect(disguised.mime).toBe('application/octet-stream');
  await request(`${path}/messages`, 'POST', { clientId: 'voice', attachmentIds: [voice.id] }, alice.cookie);
  const audio = await app.inject({
    method: 'GET',
    url: voice.url,
    headers: { host: 'chat.test', cookie: bob.cookie },
  });
  expect(audio.headers['content-type']).toBe('application/octet-stream');
  expect(audio.rawPayload).not.toEqual(wav);
  expect(Buffer.from((await client(bob.cookie).download(voice.url)).data)).toEqual(wav);
});

it('adds feature tables without changing existing accounts, IDs, messages or committed responses', () => {
  const folder = mkdtempSync(join(tmpdir(), 'im-features-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'im.sqlite');
  let store = new MessagingStore(path);
  const owner = store.createUser('human', 'owner', 'Owner', 'hash');
  const agent = store.registerAgent(store.invite(owner.id).invitation, 'agent', 'Agent').user;
  const cid = store.direct(owner.id, agent.id).id;
  const old = store.send(owner.id, cid, 'old', 'Existing history');
  store.db.exec('DROP TABLE im_message_features; DROP TABLE im_stickers');
  store.close();
  store = new MessagingStore(path);
  expect(store.user(owner.id).id).toBe(owner.id);
  expect(store.message(owner.id, cid, old.id).text).toBe('Existing history');
  const m = store.send(agent.id, cid, 'approve', '', {
    interaction: { kind: 'approval', recipientId: owner.id, title: 'Once', description: 'Exact action' },
  });
  store.respond(owner.id, cid, m.id, { decision: 'reject' });
  store.close();
  store = new MessagingStore(path);
  cleanups.push(() => store.close());
  expect(store.message(owner.id, cid, m.id).interaction).toMatchObject({
    status: 'rejected',
    respondedBy: owner.id,
  });
  expect(() => store.respond(owner.id, cid, m.id, { decision: 'approve' })).toThrow('已失效');
});
