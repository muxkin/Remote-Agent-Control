import { openDB } from 'idb';
import type { Identity } from '../shared/secure-channel';
import { createIdentity } from '../shared/secure-channel';

export interface PairedHost {
  hostId: string;
  name: string;
  deviceId: string;
  ticket: string;
  phoneId: string;
  identity?: Identity;
}
interface Entry {
  key: string;
  value: any;
  size: number;
  touched: number;
  kind: 'text' | 'attachment';
  opfs?: boolean;
}
/** Persistent content has no application budget or automatic eviction. */
export class SyncStore {
  scope = '';
  onHostChange?: (hostId: string, host?: PairedHost) => Promise<void>;
  private privateKey(key: string, scope = this.scope) {
    return scope ? `account:${scope}:${key}` : key;
  }
  private db = openDB('pocket-device-v2', 1, {
    upgrade(db) {
      db.createObjectStore('private');
      db.createObjectStore('content', { keyPath: 'key' });
    },
  });
  private memory = new Map<string, Entry>();
  private pending = new Map<string, Entry>();
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<unknown> = Promise.resolve();
  private generation = 0;
  writeFailed = false;
  metrics = { hitBytes: 0 };
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work);
    this.writes = result.catch(() => {});
    return result;
  }
  private remember(entry: Entry) {
    this.memory.delete(entry.key);
    this.memory.set(entry.key, entry);
    if (this.memory.size > 32) this.memory.delete(this.memory.keys().next().value!);
  }
  async identity(scope = this.scope): Promise<Identity> {
    const key = this.privateKey('identity', scope);
    const db = await this.db;
    const old = await db.get('private', key);
    if (old) return old;
    const identity = await createIdentity();
    const tx = db.transaction('private', 'readwrite');
    const raced = await tx.store.get(key);
    if (!raced) await tx.store.put(identity, key);
    await tx.done;
    return raced ?? identity;
  }
  async hosts(scope = this.scope): Promise<PairedHost[]> {
    return (await (await this.db).get('private', this.privateKey('hosts', scope))) ?? [];
  }
  async saveHost(host: PairedHost, sync = true) {
    const scope = this.scope,
      changed = this.onHostChange;
    const hosts = await this.hosts(scope);
    host.identity ??= await this.identity(scope);
    await (
      await this.db
    ).put(
      'private',
      [...hosts.filter((h) => h.hostId !== host.hostId), host],
      this.privateKey('hosts', scope),
    );
    await (await this.db).put('private', host.hostId, this.privateKey('active', scope));
    if (sync) await changed?.(host.hostId, host);
  }
  async active() {
    const scope = this.scope;
    const hosts = await this.hosts(scope),
      id = await (await this.db).get('private', this.privateKey('active', scope));
    return hosts.find((h) => h.hostId === id) ?? hosts[0];
  }
  async renameHost(hostId: string, name: string) {
    const scope = this.scope;
    const changed = this.onHostChange;
    const key = this.privateKey('hosts', scope);
    const tx = (await this.db).transaction('private', 'readwrite');
    const hosts: PairedHost[] = (await tx.store.get(key)) ?? [];
    const host = hosts.find((entry) => entry.hostId === hostId);
    if (host) {
      host.name = name;
      await tx.store.put(hosts, key);
    }
    await tx.done;
    if (host && scope === this.scope) await changed?.(hostId, host);
    return host;
  }
  async forget(hostId: string, sync = true) {
    const scope = this.scope;
    if (sync) await this.onHostChange?.(hostId);
    await (
      await this.db
    ).put(
      'private',
      (await this.hosts(scope)).filter((h) => h.hostId !== hostId),
      this.privateKey('hosts', scope),
    );
    await this.clear(`:${hostId}:`);
  }
  async replaceHosts(hosts: PairedHost[], scope = this.scope) {
    await (await this.db).put('private', hosts, this.privateKey('hosts', scope));
  }
  async get<T>(key: string): Promise<T | undefined> {
    const generation = this.generation;
    const entry: Entry | undefined =
      this.pending.get(key) ??
      this.memory.get(key) ??
      (await (await this.db).get('content', key).catch(() => undefined));
    if (!entry || generation !== this.generation) return;
    if (entry.opfs) {
      try {
        const root = await navigator.storage.getDirectory();
        const bytes = new Uint8Array(await (await (await root.getFileHandle(key)).getFile()).arrayBuffer());
        if (generation !== this.generation) return;
        this.metrics.hitBytes += bytes.byteLength;
        return bytes as T;
      } catch {
        if (generation === this.generation) await this.remove(entry);
        return;
      }
    }
    this.metrics.hitBytes += entry.size;
    this.remember(entry);
    return entry.value;
  }
  put(key: string, value: any, kind: Entry['kind'] = 'text') {
    const size =
      value instanceof Uint8Array ? value.byteLength : new TextEncoder().encode(JSON.stringify(value)).length;
    this.pending.set(key, { key, value, size, touched: Date.now(), kind });
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 500);
  }
  async block(key: string, bytes: Uint8Array) {
    return this.serialize(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle(key, { create: true });
        const writable = await file.createWritable();
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
        await (
          await this.db
        ).put('content', {
          key,
          size: bytes.length,
          touched: Date.now(),
          kind: 'attachment',
          opfs: true,
        });
        this.writeFailed = false;
      } catch {
        // A failed persistent write must not stop the live download or remove older content.
        const entry: Entry = {
          key,
          value: bytes,
          size: bytes.length,
          touched: Date.now(),
          kind: 'attachment',
        };
        this.remember(entry);
        try {
          await (await this.db).put('content', entry);
          this.writeFailed = false;
        } catch {
          this.writeFailed = true;
        }
      }
    });
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) this.remember(entry);
    return this.serialize(async () => {
      if (!entries.length) return;
      try {
        const tx = (await this.db).transaction('content', 'readwrite');
        const done = tx.done.catch(() => {});
        try {
          for (const entry of entries) await tx.store.put(entry);
          await tx.done;
          this.writeFailed = false;
        } finally {
          await done;
        }
      } catch {
        this.writeFailed = true;
      }
    });
  }
  async usage() {
    await this.flush();
    let bytes = 0;
    let cursor = await (await this.db).transaction('content').store.openCursor();
    while (cursor) {
      bytes += cursor.value.size;
      cursor = await cursor.continue();
    }
    return { bytes };
  }
  private async remove(entry: Entry) {
    this.memory.delete(entry.key);
    this.pending.delete(entry.key);
    await (await this.db).delete('content', entry.key);
    if (entry.opfs)
      await navigator.storage
        .getDirectory()
        .then((d) => d.removeEntry(entry.key))
        .catch(() => {});
  }
  async clear(fragment = '') {
    // Retain upload resume journals while clearing ordinary cache. Unpair removes them too.
    const matches = (key: string) => key.includes(fragment) && (!!fragment || !key.includes(':upload:'));
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const key of this.pending.keys()) if (matches(key)) this.pending.delete(key);
    for (const key of this.memory.keys()) if (matches(key)) this.memory.delete(key);
    return this.serialize(async () => {
      const db = await this.db;
      const tx = db.transaction('content', 'readwrite');
      const files: string[] = [];
      let cursor = await tx.store.openCursor();
      while (cursor) {
        if (matches(cursor.key as string)) {
          if (cursor.value.opfs) files.push(cursor.key as string);
          await cursor.delete();
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      try {
        const root = await navigator.storage.getDirectory();
        for (const name of files) await root.removeEntry(name).catch(() => {});
      } catch {
        /* OPFS is optional. IndexedDB content is already cleared. */
      }
      this.writeFailed = false;
    });
  }
}
