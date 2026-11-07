/** Client-side account encryption. This module never runs in the relay request path. */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const PASSWORD_ITERATIONS = 600_000;
export const SEALED_PREFIX = 'pocket-e2ee:1:';
export interface Ciphertext {
  iv: string;
  data: string;
}
export interface PublicAccountKeys {
  encryption: JsonWebKey;
  signing: JsonWebKey;
}
export interface AccountSecrets {
  root: string;
  encryption: JsonWebKey;
  signing: JsonWebKey;
  publicKeys: PublicAccountKeys;
}
export interface AccountVault {
  version: 1;
  salt: string;
  password: Ciphertext;
  recovery: Ciphertext;
  secrets: Ciphertext;
  publicKeys: PublicAccountKeys;
}
export interface SealedEnvelope {
  version: 1;
  sender: string;
  context: string;
  operation: string;
  ephemeral: JsonWebKey;
  recipients: Record<string, Ciphertext>;
  body: Ciphertext;
  signature: string;
}
export function encode64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function decode64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
const random = (length = 32) => crypto.getRandomValues(new Uint8Array(length));
const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function derive(raw: Uint8Array, purpose: string, salt = new Uint8Array(32)) {
  const key = await crypto.subtle.importKey('raw', bytes(raw), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: bytes(salt),
        info: encoder.encode(`pocket-account-v1:${purpose}`),
      },
      key,
      256,
    ),
  );
}
export async function seal(keyBytes: Uint8Array, value: Uint8Array, context: string): Promise<Ciphertext> {
  const iv = random(12);
  const key = await crypto.subtle.importKey('raw', bytes(keyBytes), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context), tagLength: 128 },
    key,
    bytes(value),
  );
  return { iv: encode64(iv), data: encode64(new Uint8Array(encrypted)) };
}
export async function unseal(keyBytes: Uint8Array, value: Ciphertext, context: string) {
  if (decode64(value.iv).length !== 12) throw Error('加密数据格式无效');
  const key = await crypto.subtle.importKey('raw', bytes(keyBytes), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode64(value.iv), additionalData: encoder.encode(context), tagLength: 128 },
      key,
      decode64(value.data),
    ),
  );
}
export async function passwordKeys(password: string, salt: string) {
  if (password.length < 10 || password.length > 128 || decode64(salt).length !== 32)
    throw Error('密码或加密参数无效');
  const source = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const base = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: decode64(salt), iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' },
      source,
      256,
    ),
  );
  const [auth, wrapping] = await Promise.all([
    derive(base, 'authentication'),
    derive(base, 'password-wrapping'),
  ]);
  base.fill(0);
  return { auth: encode64(auth), wrapping };
}
export async function createSecrets(): Promise<AccountSecrets> {
  const [encryption, signing] = await Promise.all([
    crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
  ]);
  return {
    root: encode64(random()),
    encryption: await crypto.subtle.exportKey('jwk', encryption.privateKey),
    signing: await crypto.subtle.exportKey('jwk', signing.privateKey),
    publicKeys: {
      encryption: await crypto.subtle.exportKey('jwk', encryption.publicKey),
      signing: await crypto.subtle.exportKey('jwk', signing.publicKey),
    },
  };
}
export async function recoveryKeys(code: string) {
  const raw = decode64(code.replace(/\s/g, ''));
  if (raw.length !== 32) throw Error('恢复码无效');
  return {
    auth: encode64(await derive(raw, 'recovery-authentication')),
    wrapping: await derive(raw, 'recovery-wrapping'),
  };
}
export async function protectAccount(password: string, existing?: AccountSecrets) {
  const secrets = existing ?? (await createSecrets());
  const salt = encode64(random()),
    recoveryCode = encode64(random());
  const [pw, recovery] = await Promise.all([passwordKeys(password, salt), recoveryKeys(recoveryCode)]);
  const root = decode64(secrets.root);
  const vault: AccountVault = {
    version: 1,
    salt,
    publicKeys: secrets.publicKeys,
    password: await seal(pw.wrapping, root, 'account-root:password:v1'),
    recovery: await seal(recovery.wrapping, root, 'account-root:recovery:v1'),
    secrets: await seal(root, encoder.encode(canonical(secrets)), 'account-secrets:v1'),
  };
  return { vault, auth: pw.auth, recoveryAuth: recovery.auth, recoveryCode, secrets };
}
export async function unlockAccount(vault: AccountVault, password: string, recovery = false) {
  const keys = recovery ? await recoveryKeys(password) : await passwordKeys(password, vault.salt);
  const root = await unseal(
    keys.wrapping,
    recovery ? vault.recovery : vault.password,
    `account-root:${recovery ? 'recovery' : 'password'}:v1`,
  );
  const secrets: AccountSecrets = JSON.parse(
    decoder.decode(await unseal(root, vault.secrets, 'account-secrets:v1')),
  );
  if (secrets.root !== encode64(root) || canonical(secrets.publicKeys) !== canonical(vault.publicKeys))
    throw Error('账号密钥不匹配');
  return { secrets, auth: keys.auth };
}
export async function sealPrivate(secrets: AccountSecrets, context: string, value: unknown) {
  return seal(
    await derive(decode64(secrets.root), 'private-records'),
    encoder.encode(canonical(value)),
    context,
  );
}
export async function openPrivate<T>(
  secrets: AccountSecrets,
  context: string,
  value: Ciphertext,
): Promise<T> {
  return JSON.parse(
    decoder.decode(await unseal(await derive(decode64(secrets.root), 'private-records'), value, context)),
  );
}
export async function privateId(secrets: AccountSecrets, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    await derive(decode64(secrets.root), 'identifiers'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return encode64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))).replace(
    /[+/=]/g,
    (c) => ({ '+': '-', '/': '_', '=': '' })[c]!,
  );
}
export async function fingerprint(keys: PublicAccountKeys) {
  const publicOnly = (k: JsonWebKey) => ({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(
          canonical({ encryption: publicOnly(keys.encryption), signing: publicOnly(keys.signing) }),
        ),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
async function sharedKey(privateKey: CryptoKey, publicKey: JsonWebKey, context: string) {
  if (publicKey.d) throw Error('公钥格式无效');
  const pub = await crypto.subtle.importKey(
    'jwk',
    publicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const raw = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256));
  return derive(raw, `message-wrapping:${context}`);
}
export async function encryptFor(
  secrets: AccountSecrets,
  sender: string,
  recipients: Record<string, PublicAccountKeys>,
  context: string,
  value: unknown,
): Promise<string> {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const contentKey = random();
  const body = encoder.encode(canonical(value));
  const envelope: SealedEnvelope = {
    version: 1,
    sender,
    context,
    operation: await privateId(secrets, `${context}:${canonical(value)}`),
    ephemeral: await crypto.subtle.exportKey('jwk', ephemeral.publicKey),
    recipients: Object.fromEntries(
      await Promise.all(
        Object.entries(recipients).map(async ([id, keys]) => [
          id,
          await seal(
            await sharedKey(ephemeral.privateKey, keys.encryption, `${context}:${id}`),
            contentKey,
            `${context}:${sender}:${id}`,
          ),
        ]),
      ),
    ),
    body: await seal(contentKey, body, `${context}:${sender}`),
    signature: '',
  };
  const key = await crypto.subtle.importKey(
    'jwk',
    secrets.signing,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  envelope.signature = encode64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        encoder.encode(canonical({ ...envelope, signature: '' })),
      ),
    ),
  );
  return SEALED_PREFIX + encode64(encoder.encode(canonical(envelope)));
}
export function parseEnvelope(text: string): SealedEnvelope {
  if (!text.startsWith(SEALED_PREFIX)) throw Error('消息未经加密');
  const value = JSON.parse(decoder.decode(decode64(text.slice(SEALED_PREFIX.length)))) as SealedEnvelope;
  if (
    value.version !== 1 ||
    typeof value.context !== 'string' ||
    typeof value.sender !== 'string' ||
    !value.recipients ||
    !value.body ||
    !value.signature ||
    !value.operation
  )
    throw Error('加密消息格式无效');
  return value;
}
export async function decryptFor<T>(
  secrets: AccountSecrets,
  recipient: string,
  sender: string,
  senderKeys: PublicAccountKeys,
  context: string,
  text: string,
): Promise<T> {
  const envelope = parseEnvelope(text);
  if (envelope.sender !== sender || envelope.context !== context) throw Error('消息身份或上下文不匹配');
  const key = await crypto.subtle.importKey(
    'jwk',
    senderKeys.signing,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  if (
    !(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      decode64(envelope.signature),
      encoder.encode(canonical({ ...envelope, signature: '' })),
    ))
  )
    throw Error('消息签名无效');
  if (!Object.hasOwn(envelope.recipients, recipient)) throw Error('此设备无权解密该历史消息');
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    secrets.encryption,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const contentKey = await unseal(
    await sharedKey(privateKey, envelope.ephemeral, `${context}:${recipient}`),
    envelope.recipients[recipient],
    `${context}:${sender}:${recipient}`,
  );
  return JSON.parse(decoder.decode(await unseal(contentKey, envelope.body, `${context}:${sender}`)));
}
