import { createHash, randomBytes } from 'node:crypto';
import type {
  ResourcePolicy,
  ResourcePolicyProvider,
  ResourceStatus,
  RelayAccount,
} from '../../shared/resources.js';
import type { MessagingStore } from '../messaging/store-core.js';

export class ResourceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Calendar boundaries follow the policy's IANA timezone, including DST. */
export function resourceMonth(now: number, timeZone: string) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  const parts = (date: number) =>
    Object.fromEntries(
      format
        .formatToParts(date)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, Number(p.value)]),
    );
  const p = parts(now);
  const midnight = (year: number, month: number) => {
    const target = Date.UTC(year, month, 1);
    let guess = target;
    for (let n = 0; n < 3; n++) {
      const v = parts(guess);
      guess += target - Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
    }
    return guess;
  };
  return {
    key: `${timeZone}:${p.year}-${String(p.month).padStart(2, '0')}`,
    startsAt: midnight(p.year, p.month - 1),
    resetsAt: midnight(p.year, p.month),
  };
}

export class ResourceService {
  private pending = new Map<string, Promise<ResourcePolicy>>();
  constructor(
    readonly store: MessagingStore,
    private provider: ResourcePolicyProvider,
    private now = Date.now,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS resource_policies(owner_id TEXT PRIMARY KEY, payload TEXT NOT NULL, checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_usage(owner_id TEXT NOT NULL, resource TEXT NOT NULL, period TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(owner_id,resource,period));
      CREATE TABLE IF NOT EXISTS resource_relay_tickets(hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_hash TEXT NOT NULL, host TEXT NOT NULL, route TEXT NOT NULL, lane TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  }
  owner(id: string) {
    const user = this.store.db.prepare('SELECT id,owner_id FROM im_users WHERE id=?').get(id);
    if (!user) throw new ResourceError(401, '请先登录');
    return String(user.owner_id ?? user.id);
  }
  private cached(owner: string): ResourcePolicy | undefined {
    const row = this.store.db.prepare('SELECT * FROM resource_policies WHERE owner_id=?').get(owner);
    if (row && Number(row.checked_at) + 60000 > this.now()) return JSON.parse(String(row.payload));
  }
  async prepare(id: string): Promise<ResourcePolicy> {
    const owner = this.owner(id),
      cached = this.cached(owner);
    if (cached) return cached;
    const old = this.pending.get(owner);
    if (old) return old;
    const work = this.provider
      .resolve(owner)
      .then((policy) => {
        if (![policy.storageBytes, policy.relayBytes].every((n) => Number.isSafeInteger(n) && n >= 0))
          throw Error('Invalid policy');
        resourceMonth(this.now(), policy.timeZone);
        this.store.db
          .prepare(
            'INSERT INTO resource_policies VALUES (?,?,?) ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload,checked_at=excluded.checked_at',
          )
          .run(owner, JSON.stringify(policy), this.now());
        return policy;
      })
      .catch(() => {
        throw new ResourceError(503, '暂时无法读取资源额度，请稍后重试');
      })
      .finally(() => this.pending.delete(owner));
    this.pending.set(owner, work);
    return work;
  }
  storageUsed(id: string) {
    return this.store.mediaUsage(this.owner(id));
  }
  checkStorage(id: string, additional: number) {
    const policy = this.cached(this.owner(id));
    if (!policy) throw new ResourceError(503, '资源额度正在刷新，请重试');
    if (this.storageUsed(id) + additional > policy.storageBytes)
      throw new ResourceError(413, '附件空间不足，请到账户设置下载或清理文件');
  }
  async status(id: string): Promise<ResourceStatus> {
    const policy = await this.prepare(id),
      owner = this.owner(id),
      month = resourceMonth(this.now(), policy.timeZone);
    const used = Number(
      this.store.db
        .prepare("SELECT used FROM resource_usage WHERE owner_id=? AND resource='relay_bytes' AND period=?")
        .get(owner, month.key)?.used ?? 0,
    );
    return {
      managed: true,
      label: policy.label,
      storage: { used: this.storageUsed(id), limit: policy.storageBytes },
      relay: { used, limit: policy.relayBytes, resetsAt: month.resetsAt, timeZone: policy.timeZone },
    };
  }
  async issueRelay(id: string, session: string, host: string, route: string, lane: string) {
    const status = await this.status(id);
    if (status.relay.used >= status.relay.limit!)
      throw new ResourceError(429, '本月中转流量已用完，将于下月恢复');
    const token = randomBytes(32).toString('base64url');
    this.store.db.prepare('DELETE FROM resource_relay_tickets WHERE expires<=?').run(this.now());
    this.store.db
      .prepare('INSERT INTO resource_relay_tickets VALUES (?,?,?,?,?,?,?)')
      .run(hash(token), this.owner(id), hash(session), host, route, lane, this.now() + 120000);
    return { token };
  }
  async redeemRelay(token: string, host: string, route: string, lane: string): Promise<RelayAccount> {
    const row = this.store.transaction(() => {
      const value = this.store.db
        .prepare(
          'SELECT * FROM resource_relay_tickets WHERE hash=? AND host=? AND route=? AND lane=? AND expires>?',
        )
        .get(hash(token), host, route, lane, this.now());
      if (!value) throw new ResourceError(401, '请登录账户后使用中转');
      this.store.db.prepare('DELETE FROM resource_relay_tickets WHERE hash=?').run(hash(token));
      return value;
    });
    const account = { ownerId: String(row.owner_id), sessionHash: String(row.session_hash) };
    await this.consumeRelay(account, 0);
    return account;
  }
  async consumeRelay(account: RelayAccount, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 65536)
      throw new ResourceError(400, '无效流量大小');
    const session = this.store.db
      .prepare('SELECT user_id FROM im_sessions WHERE hash=? AND expires_at>?')
      .get(account.sessionHash, this.now());
    if (!session || this.owner(String(session.user_id)) !== account.ownerId)
      throw new ResourceError(401, '账户会话已失效');
    const policy = await this.prepare(account.ownerId),
      period = resourceMonth(this.now(), policy.timeZone).key;
    this.store.transaction(() => {
      // A policy refresh can yield; logout must still revoke the waiting frame.
      const current = this.store.db
        .prepare('SELECT user_id FROM im_sessions WHERE hash=? AND expires_at>?')
        .get(account.sessionHash, this.now());
      if (!current || this.owner(String(current.user_id)) !== account.ownerId)
        throw new ResourceError(401, '账户会话已失效');
      const row = this.store.db
        .prepare("SELECT used FROM resource_usage WHERE owner_id=? AND resource='relay_bytes' AND period=?")
        .get(account.ownerId, period);
      const used = Number(row?.used ?? 0);
      if (used + bytes > policy.relayBytes || (!bytes && used >= policy.relayBytes))
        throw new ResourceError(429, '本月中转流量已用完，将于下月恢复');
      this.store.db
        .prepare(
          "INSERT INTO resource_usage VALUES (?,'relay_bytes',?,?) ON CONFLICT(owner_id,resource,period) DO UPDATE SET used=excluded.used",
        )
        .run(account.ownerId, period, used + bytes);
    });
  }
}
