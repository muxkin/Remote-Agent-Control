import { openDB } from 'idb';
import type { AccountClient } from '../client/account';
import {
  openPrivate,
  sealPrivate,
  privateId,
  type Ciphertext,
  type AccountSecrets,
  type AccountVault,
} from '../shared/account-crypto';
import type { ChatUser } from '../shared/messaging';
import { deviceSession } from './device-session';
import type { PairedHost } from './sync-store';

const db = openDB('pocket-account-v1', 1, {
  upgrade(db) {
    db.createObjectStore('unlocked');
  },
});
let current = '',
  generation = 0;
let syncing: { epoch: number; promise: Promise<void> } | undefined;
let changed: (() => void) | undefined;
export let accountSyncError = '';
async function flushPending(account: AccountClient, epoch = generation) {
  const user = account.user,
    secrets = account.secrets;
  if (!user || !secrets) return;
  const active = () => epoch === generation && account.user === user && account.secrets === secrets;
  const database = await db,
    prefix = `pending:${user.id}:`;
  for (const key of await database.getAllKeys('unlocked')) {
    if (!active()) return;
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
    const pending = (await database.get('unlocked', key)) as
      { id: string; ciphertext: Ciphertext | null } | undefined;
    if (!pending || !active()) continue;
    const currentItems = await account.refreshItems();
    if (!active()) return;
    await account.writeCiphertext(
      pending.id,
      pending.ciphertext,
      currentItems.find((i) => i.id === pending.id)?.revision ?? 0,
    );
    if (!active()) return;
    // Do not clear a newer change queued while this upload was in flight.
    const tx = database.transaction('unlocked', 'readwrite');
    if (JSON.stringify(await tx.store.get(key)) === JSON.stringify(pending)) await tx.store.delete(key);
    await tx.done;
  }
  if (active()) accountSyncError = '';
}
export function onAccountSessionChange(fn: () => void) {
  changed = fn;
}
export async function rememberAccount(account: AccountClient) {
  const user = account.user,
    secrets = account.secrets,
    vault = account.vault,
    revision = account.revision;
  if (user && secrets) await (await db).put('unlocked', { secrets, vault, revision }, user.id);
}
export async function activateAccount(account: AccountClient, user: ChatUser | null) {
  const epoch = ++generation;
  deviceSession.cache.onHostChange = undefined;
  accountSyncError = '';
  if (!user) {
    const previous = current;
    current = '';
    account.lock();
    deviceSession.resetAccount('');
    if (previous) await (await db).delete('unlocked', previous);
    return;
  }
  if (account.user?.id !== user.id || !account.secrets) {
    const saved = (await (await db).get('unlocked', user.id)) as
      { secrets: AccountSecrets; vault: AccountVault; revision: number } | undefined;
    if (epoch !== generation) return;
    if (saved) account.activate(user, saved.secrets, saved.vault, saved.revision);
    else {
      account.lock();
      account.user = user;
    }
  }
  const switching = current !== user.id;
  current = user.id;
  if (switching) deviceSession.resetAccount(user.id);
  if (!account.secrets) return;
  const owner = account.user!,
    secrets = account.secrets;
  deviceSession.cache.onHostChange = async (id, host) => {
    const itemId = await privateId(secrets, `host:${id}`);
    const value = host
      ? {
          kind: 'host',
          host: {
            ...host,
            identity: host.identity
              ? { ...host.identity, privateKey: Array.from(host.identity.privateKey) }
              : undefined,
          },
        }
      : null;
    const ciphertext = value ? await sealPrivate(secrets, `vault:${owner.id}:${itemId}`, value) : null;
    await (await db).put('unlocked', { id: itemId, ciphertext }, `pending:${owner.id}:${itemId}`);
    if (epoch !== generation) return;
    try {
      await flushPending(account, epoch);
    } catch {
      if (epoch === generation) accountSyncError = '电脑已保存在本机，账号同步将在联网后重试';
    }
    changed?.();
  };
  await rememberAccount(account);
  try {
    const unclaimed = await deviceSession.cache.hosts('');
    const localIdentity = unclaimed.length ? await deviceSession.cache.identity('') : undefined;
    if (epoch !== generation) return;
    if (unclaimed.length) {
      await account.refreshItems();
      for (const host of unclaimed) {
        if (epoch !== generation) return;
        const identity = host.identity ?? localIdentity!;
        if (!(await account.readItem(`host:${host.hostId}`)))
          await account.writeItem(`host:${host.hostId}`, {
            kind: 'host',
            host: { ...host, identity: { ...identity, privateKey: Array.from(identity.privateKey) } },
          });
      }
      if (epoch !== generation) return;
      // Claim anonymous pairings once; they must not leak into the next signed-in account.
      await deviceSession.cache.replaceHosts([], '');
    }
    await syncAccountHosts(account);
    if (epoch !== generation) return;
  } catch (error) {
    if ((error as { status?: number }).status === 401) throw error;
    if (epoch === generation) accountSyncError = '账号同步暂不可用，联网后会重试';
  }
  if (epoch !== generation) return;
  await deviceSession.init();
}
export async function syncAccountHosts(account: AccountClient) {
  if (!account.secrets || account.user?.id !== current) return;
  if (syncing?.epoch === generation) return syncing.promise;
  const epoch = generation,
    user = account.user.id,
    secrets = account.secrets;
  const promise = (async () => {
    await flushPending(account, epoch);
    if (epoch !== generation) return;
    const items = await account.refreshItems();
    const hosts: PairedHost[] = [];
    for (const item of items) {
      if (!item.ciphertext) continue;
      const value = await openPrivate<any>(secrets, `vault:${user}:${item.id}`, item.ciphertext);
      if (value?.kind === 'host' && value.host?.hostId && value.host.identity?.privateKey) {
        hosts.push({
          ...value.host,
          identity: { ...value.host.identity, privateKey: new Uint8Array(value.host.identity.privateKey) },
        });
      }
    }
    if (epoch !== generation) return;
    const active = deviceSession.host?.hostId;
    await deviceSession.cache.replaceHosts(hosts, user);
    if (epoch !== generation) return;
    if (active && !hosts.some((h) => h.hostId === active)) deviceSession.resetAccount(user);
    const updated = hosts.find((h) => h.hostId === active);
    if (
      updated &&
      deviceSession.host &&
      (updated.phoneId !== deviceSession.host.phoneId || updated.ticket !== deviceSession.host.ticket)
    )
      await deviceSession.select(updated);
    if (!deviceSession.host && hosts.length) await deviceSession.init();
    changed?.();
  })().finally(() => {
    if (syncing?.epoch === epoch) syncing = undefined;
  });
  syncing = { epoch, promise };
  return promise;
}
