import { beforeEach, expect, it, vi } from 'vitest';
import { AccountClient } from '../src/client/account.js';
import { createSecrets } from '../src/shared/account-crypto.js';
import type { ChatUser } from '../src/shared/messaging.js';
const fixture = vi.hoisted(() => {
  const records = new Map<string, any>(),
    hosts = new Map<string, any[]>();
  const cache = {
    scope: '',
    onHostChange: undefined as ((id: string, host?: any) => Promise<void>) | undefined,
    hosts: async (scope?: string) => hosts.get(scope ?? cache.scope) ?? [],
    replaceHosts: async (value: any[], scope?: string) => {
      hosts.set(scope ?? cache.scope, value);
    },
    identity: async () => ({ peerId: 'test-phone', privateKey: new Uint8Array([1, 2]) }),
  };
  const get = async (key: string) => structuredClone(records.get(key));
  const remove = async (key: string) => {
    records.delete(key);
  };
  const database = {
    get: async (_store: string, key: string) => get(key),
    put: async (_store: string, value: any, key: string) => {
      records.set(key, structuredClone(value));
    },
    delete: async (_store: string, key: string) => remove(key),
    getAllKeys: async () => [...records.keys()],
    transaction: () => ({ store: { get, delete: remove }, done: Promise.resolve() }),
  };
  const session = {
    cache,
    host: undefined,
    resetAccount: (scope: string) => {
      cache.scope = scope;
    },
    init: async () => {},
    select: async () => {},
  };
  return { records, hosts, database, session };
});
vi.mock('idb', () => ({ openDB: async () => fixture.database }));
vi.mock('../src/web/device-session', () => ({ deviceSession: fixture.session }));
import { activateAccount, syncAccountHosts, accountSyncError } from '../src/web/account-session.js';
const user = (id: string): ChatUser => ({
  id,
  username: `user${id}`,
  address: `${id}@test`,
  displayName: 'Test',
  kind: 'human',
  encrypted: true,
  createdAt: 0,
});
const host = {
  hostId: 'test-host',
  name: 'My Codex',
  deviceId: 'device',
  ticket: 'private-ticket-marker',
  phoneId: 'test-phone',
  identity: { peerId: 'test-phone', privateKey: new Uint8Array([1, 2]) },
};
beforeEach(() => {
  fixture.records.clear();
  fixture.hosts.clear();
});
function server() {
  let uid = '10000000',
    offline = false;
  const rows = new Map<string, Map<string, any>>();
  const account = new AccountClient(async <T>(path: string, _method?: string, body?: any): Promise<T> => {
    if (offline) throw Error('Offline');
    const items = rows.get(uid) ?? new Map<string, any>();
    rows.set(uid, items);
    if (path.startsWith('/crypto/items?')) return { items: [...items.values()] } as T;
    if (body.accountId !== uid) throw Error('Wrong account');
    const id = path.split('/').at(-1)!;
    items.set(id, { id, revision: body.revision + 1, ciphertext: body.ciphertext });
    return { revision: body.revision + 1 } as T;
  });
  return {
    account,
    rows,
    setUser: (id: string) => {
      uid = id;
    },
    offline: (value: boolean) => {
      offline = value;
    },
  };
}
it('retains encrypted pending pairings when initial sync is offline, then restores them on reconnect', async () => {
  const cloud = server(),
    secrets = await createSecrets(),
    owner = user('10000000');
  await activateAccount(cloud.account, null);
  cloud.account.activate(owner, secrets);
  cloud.offline(true);
  await activateAccount(cloud.account, owner);
  expect(fixture.session.cache.onHostChange).toBeDefined();
  await fixture.session.cache.onHostChange!('test-host', host);
  expect(accountSyncError).toContain('联网');
  const pending = [...fixture.records.entries()].filter(([key]) => key.startsWith('pending:'));
  expect(pending).toHaveLength(1);
  expect(JSON.stringify(pending)).not.toContain(host.ticket);
  cloud.offline(false);
  await syncAccountHosts(cloud.account);
  expect(await cloud.account.readItem('host:test-host')).toMatchObject({
    kind: 'host',
    host: { ticket: host.ticket },
  });
  expect([...fixture.records.keys()].filter((key) => key.startsWith('pending:'))).toHaveLength(0);
});
it('a pairing finishing after account switch stays encrypted for its original owner', async () => {
  const cloud = server(),
    a = user('10000000'),
    b = user('10000001'),
    aKeys = await createSecrets(),
    bKeys = await createSecrets();
  await activateAccount(cloud.account, null);
  cloud.account.activate(a, aKeys);
  await activateAccount(cloud.account, a);
  const finishing = fixture.session.cache.onHostChange!;
  cloud.setUser(b.id);
  cloud.account.activate(b, bKeys);
  await activateAccount(cloud.account, b);
  await finishing(host.hostId, host);
  expect(cloud.rows.get(b.id)?.size ?? 0).toBe(0);
  cloud.setUser(a.id);
  cloud.account.activate(a, aKeys);
  await activateAccount(cloud.account, a);
  expect(await cloud.account.readItem('host:test-host')).toMatchObject({ host: { ticket: host.ticket } });
});
