import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { buildRelay } from '../src/server/relay.js';
import { AccountClient } from '../src/client/account.js';
import { EncryptedMessagingClient } from '../src/client/encrypted-messaging.js';
import { agentCallsContract } from './contracts/agent-calls.js';
import { MessagingStore } from './messaging-fixtures.js';
import { CallStore, callIceConfig } from '../src/server/messaging/calls.js';
let relay: Awaited<ReturnType<typeof buildRelay>>, origin: string;
beforeAll(async () => {
  relay = await buildRelay({
    origin: 'http://localhost',
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'isolated-agent-call-test-enrollment',
  });
  // inject keeps the contract transport realistic without binding a public test port.
  origin = 'http://localhost';
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input),
      headers = new Headers(init.headers);
    const result = await relay.app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: { host: 'localhost', origin, ...Object.fromEntries(headers) },
      payload: init.body as string,
    });
    return new Response(new Uint8Array(result.rawPayload), {
      status: result.statusCode,
      headers: result.headers as Record<string, string>,
    });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await relay.app.close();
});
agentCallsContract(() => ({
  origin,
  session() {
    let token = '';
    const account = new AccountClient(async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const r = await fetch(`${origin}/api/im${path}`, {
        method,
        headers: {
          Origin: origin,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const cookie = r.headers.get('set-cookie');
      if (cookie) token = cookie.split(';')[0].split('=')[1];
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      return data;
    });
    return {
      account,
      client() {
        const c = new EncryptedMessagingClient(origin, token);
        c.account.activate(account.user!, account.secrets!, account.vault, account.revision);
        return c;
      },
    };
  },
}));
it('makes old human conversations read-only, rejects group bypasses and keeps their history', () => {
  const store = new MessagingStore(':memory:');
  try {
    const a = store.createUser('human', 'owner', 'Owner', 'hash'),
      b = store.createUser('human', 'other', 'Other', 'hash');
    store.addContact(a.id, b.id);
    const direct = store.direct(a.id, b.id),
      group = store.createGroup(a.id, 'Old group', [b.id]);
    store.send(a.id, direct.id, 'old-message', 'history');
    store.humanContacts = false;
    expect(store.contacts(a.id)).toEqual([]);
    expect(store.conversation(a.id, direct.id).readOnlyReason).toContain('历史');
    expect(store.history(a.id, direct.id).messages[0].text).toBe('history');
    expect(() => store.send(a.id, direct.id, 'new', 'blocked')).toThrow('自己的 Agent');
    expect(() => store.send(a.id, group.id, 'new', 'blocked')).toThrow('自己的 Agent');
    expect(() => store.createGroup(a.id, 'Bypass', [b.id])).toThrow('自己的 Agent');
  } finally {
    store.close();
  }
});
it('expires abandoned calls and issues portable short-lived TURN credentials', () => {
  const store = new MessagingStore(':memory:');
  try {
    const a = store.createUser('human', 'owner', 'Owner', 'hash');
    const agent = store.registerAgent(store.invite(a.id).invitation, 'agent', 'Agent');
    const cid = store.direct(a.id, agent.user.id).id;
    const calls = new CallStore(
      store,
      callIceConfig({
        POCKET_IM_CALL_TURN_URLS: 'turn:turn.example.test:3478',
        POCKET_IM_CALL_TURN_SECRET: 'private-shared-secret',
      }),
    );
    calls.ready(agent.user.id, true, true);
    const call = calls.create(a.id, cid, crypto.randomUUID(), 'audio');
    store.db.prepare('UPDATE im_calls SET created=? WHERE id=?').run(Date.now() - 46_000, call.id);
    expect(calls.poll(a.id, call.id, 0).call).toMatchObject({ state: 'ended', reason: 'unanswered' });
    expect(calls.iceServers(a.id)[0].username).toMatch(new RegExp(`:${a.id}$`));
    expect(JSON.stringify(calls.iceServers(a.id))).not.toContain('private-shared-secret');
  } finally {
    store.close();
  }
});
