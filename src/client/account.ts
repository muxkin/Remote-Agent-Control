import {
  protectAccount,
  passwordKeys,
  recoveryKeys,
  unlockAccount,
  fingerprint,
  canonical,
  openPrivate,
  sealPrivate,
  privateId,
  type AccountSecrets,
  type AccountVault,
  type PublicAccountKeys,
  type Ciphertext,
} from '../shared/account-crypto.js';
import type { ChatUser } from '../shared/messaging.js';

export type Request = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export interface VaultItem {
  id: string;
  revision: number;
  ciphertext: Ciphertext | null;
}
export class AccountClient {
  user?: ChatUser;
  secrets?: AccountSecrets;
  vault?: AccountVault;
  revision = 0;
  recoveryCode = '';
  recoveryLogin = '';
  private pins = new Map<string, PublicAccountKeys>();
  private items = new Map<string, VaultItem>();
  private listeners = new Set<() => void>();
  constructor(readonly request: Request) {}
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changed() {
    for (const fn of this.listeners) fn();
  }
  async register(username: string, displayName: string, password: string, registrationCode?: string) {
    const protectedAccount = await protectAccount(password);
    const result = await this.request<{ user: ChatUser; vault: AccountVault }>('/crypto/register', 'POST', {
      username,
      displayName,
      registrationCode,
      vault: protectedAccount.vault,
      auth: protectedAccount.auth,
      recoveryAuth: protectedAccount.recoveryAuth,
    });
    this.activate(result.user, protectedAccount.secrets, result.vault, 1);
    this.recoveryCode = protectedAccount.recoveryCode;
    return result;
  }
  async login(identifier: string, password: string, recovery = false) {
    const parameters = await this.request<{ salt: string }>('/crypto/parameters', 'POST', { identifier });
    const keys = recovery ? await recoveryKeys(password) : await passwordKeys(password, parameters.salt!);
    const result = await this.request<{ user: ChatUser; vault: AccountVault; revision: number }>(
      '/crypto/login',
      'POST',
      { identifier, auth: keys.auth, recovery },
    );
    try {
      const { secrets } = await unlockAccount(result.vault, password, recovery);
      this.activate(result.user, secrets, result.vault, result.revision);
      if (recovery) this.recoveryLogin = password;
      await this.refreshItems();
      return result;
    } catch (error) {
      await this.request('/logout', 'POST', {}).catch(() => {});
      this.lock();
      throw error;
    }
  }
  async changePassword(current: string, next: string, recovery = false) {
    if (!this.secrets || !this.vault) throw Error('请先解锁账号');
    const latest = await this.request<{ vault: AccountVault; revision: number }>('/crypto/account');
    const verified = await unlockAccount(latest.vault, current, recovery);
    if (verified.secrets.root !== this.secrets.root) throw Error('账号密钥已变化');
    const protectedAccount = await protectAccount(next, this.secrets);
    const result = await this.request<{ revision: number }>('/crypto/password', 'POST', {
      currentAuth: verified.auth,
      recovery,
      revision: latest.revision,
      vault: protectedAccount.vault,
      auth: protectedAccount.auth,
      recoveryAuth: protectedAccount.recoveryAuth,
    });
    this.vault = protectedAccount.vault;
    this.revision = result.revision;
    this.recoveryCode = protectedAccount.recoveryCode;
    this.changed();
  }
  activate(user: ChatUser, secrets: AccountSecrets, vault?: AccountVault, revision = 0) {
    this.lock();
    this.user = user;
    this.secrets = secrets;
    this.vault = vault;
    this.revision = revision;
    this.pins.set(user.id, secrets.publicKeys);
    this.changed();
  }
  lock() {
    this.user = undefined;
    this.secrets = undefined;
    this.vault = undefined;
    this.recoveryCode = '';
    this.recoveryLogin = '';
    this.pins.clear();
    this.items.clear();
    this.changed();
  }
  async refreshItems() {
    if (!this.secrets) return [];
    const user = this.user!,
      secrets = this.secrets;
    const { items } = await this.request<{ items: VaultItem[] }>(`/crypto/items?accountId=${user.id}`);
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    this.items = new Map(items.map((item) => [item.id, item]));
    return items;
  }
  async readItem<T>(name: string): Promise<T | undefined> {
    if (!this.secrets) throw Error('请先解锁账号');
    const user = this.user!,
      secrets = this.secrets;
    const id = await privateId(secrets, name),
      item = this.items.get(id);
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    return item?.ciphertext ? openPrivate<T>(secrets, `vault:${user.id}:${id}`, item.ciphertext) : undefined;
  }
  async writeItem(name: string, value: unknown | null) {
    if (!this.secrets) throw Error('请先解锁账号');
    const user = this.user!,
      secrets = this.secrets;
    const id = await privateId(secrets, name);
    const ciphertext = value === null ? null : await sealPrivate(secrets, `vault:${user.id}:${id}`, value);
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    const previous = this.items.get(id);
    await this.writeCiphertext(id, ciphertext, previous?.revision ?? 0);
  }
  async writeCiphertext(id: string, ciphertext: Ciphertext | null, revision: number) {
    if (!this.secrets || !this.user) throw Error('请先解锁账号');
    const user = this.user,
      secrets = this.secrets;
    const result = await this.request<{ revision: number }>(`/crypto/items/${id}`, 'PUT', {
      accountId: user.id,
      revision,
      ciphertext,
    });
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    this.items.set(id, { id, ciphertext, revision: result.revision });
  }
  async publicKeys(id: string) {
    if (!this.secrets) throw Error('请先解锁账号');
    const user = this.user,
      secrets = this.secrets;
    if (id === this.user?.id) return this.secrets.publicKeys;
    const cached = this.pins.get(id);
    if (cached) return cached;
    const { publicKeys } = await this.request<{ publicKeys: PublicAccountKeys }>(
      `/crypto/keys/${encodeURIComponent(id)}`,
    );
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    const pinned = this.pins.get(id) ?? (await this.readItem<PublicAccountKeys>(`contact-key:${id}`));
    if (pinned && (await fingerprint(pinned)) !== (await fingerprint(publicKeys)))
      throw Error('联系人加密身份已变化，请核对安全码后再继续');
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    if (!pinned) {
      try {
        await this.writeItem(`contact-key:${id}`, publicKeys);
      } catch {
        await this.refreshItems();
        const raced = await this.readItem<PublicAccountKeys>(`contact-key:${id}`);
        if (!raced || canonical(raced) !== canonical(publicKeys))
          throw Error('无法保存联系人加密身份，请重试');
      }
    }
    if (this.user !== user || this.secrets !== secrets) throw Error('账号已切换');
    this.pins.set(id, publicKeys);
    return publicKeys;
  }
}
