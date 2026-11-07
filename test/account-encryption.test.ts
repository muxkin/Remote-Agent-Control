import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildRelay } from '../src/server/relay.js';
import { AccountClient } from '../src/client/account.js';
import { EncryptedMessagingClient } from '../src/client/encrypted-messaging.js';
import {
  createSecrets,
  protectAccount,
  unlockAccount,
  encryptFor,
  decryptFor,
  parseEnvelope,
  canonical,
  SEALED_PREFIX,
  encode64,
} from '../src/shared/account-crypto.js';
import { parsePairingLink } from '../src/shared/pairing-link.js';
import { createIdentity } from '../src/shared/secure-channel.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllGlobals();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'account-encryption-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'im.sqlite');
  const relay = await buildRelay({
    origin: 'https://chat.test',
    webRoot: '/nonexistent',
    assetOrigin: null,
    uploadOrigins: [],
    enrollmentSecret: 'encryption-test-enrollment-secret-32',
    messaging: { database },
  });
  cleanup.push(() => relay.app.close());
  const db = new DatabaseSync(database);
  cleanup.push(() => db.close());
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'https://chat.test'),
      headers = new Headers(init.headers);
    const response = await relay.app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: { host: 'chat.test', origin: 'https://chat.test', ...Object.fromEntries(headers) },
      payload:
        typeof init.body === 'string'
          ? init.body
          : init.body
            ? Buffer.from(init.body as Uint8Array)
            : undefined,
    });
    return new Response(new Uint8Array(response.rawPayload), {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  });
  function session() {
    let cookie = '';
    const account = new AccountClient(async <T>(path: string, method = 'GET', body?: unknown) => {
      const response = await relay.app.inject({
        method: method as 'GET',
        url: `/api/im${path}`,
        headers: { host: 'chat.test', origin: 'https://chat.test', cookie },
        payload: body as object,
      });
      if (response.cookies.length) cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      if (response.statusCode >= 400)
        throw Object.assign(Error(response.json().error), { status: response.statusCode });
      return response.json() as T;
    });
    return {
      account,
      client: (baseURL = 'https://chat.test') => {
        const client = new EncryptedMessagingClient(baseURL, cookie.split('=')[1]);
        client.account.activate(account.user!, account.secrets!, account.vault, account.revision);
        return client;
      },
    };
  }
  return { session, db, relay };
}
it('keeps account keys opaque to the server, supports another device, recovery, password changes and isolated vault CAS', async () => {
  const { session, db } = await fixture();
  const first = session(),
    second = session(),
    other = session();
  await first.account.register('alice', 'Alice', 'strong-password-alice');
  const code = first.account.recoveryCode;
  await first.account.writeItem('host:test-host', {
    kind: 'host',
    host: { privateKey: 'private-pairing-marker', name: 'My Codex' },
  });
  await second.account.login('alice', 'strong-password-alice');
  expect(await second.account.readItem('host:test-host')).toEqual({
    kind: 'host',
    host: { privateKey: 'private-pairing-marker', name: 'My Codex' },
  });
  expect(second.account.secrets?.root).toBe(first.account.secrets?.root);
  await other.account.register('bob', 'Bob', 'strong-password-bob');
  expect(await other.account.readItem('host:test-host')).toBeUndefined();
  await first.account.writeItem('host:test-host', { new: true });
  await expect(second.account.writeItem('host:test-host', { stale: true })).rejects.toMatchObject({
    status: 409,
  });
  const recovered = session();
  await recovered.account.login('alice', code, true);
  await recovered.account.changePassword(code, 'new-strong-password-alice', true);
  await expect(session().account.login('alice', 'strong-password-alice')).rejects.toThrow();
  await expect(session().account.login('alice', code, true)).rejects.toThrow();
  const after = session();
  await after.account.login('alice', 'new-strong-password-alice');
  expect(after.account.secrets?.root).toBe(first.account.secrets?.root);
  const rows =
    JSON.stringify(db.prepare('SELECT * FROM im_account_crypto').all()) +
    JSON.stringify(db.prepare('SELECT * FROM im_vault_items').all());
  for (const marker of [
    'strong-password',
    'private-pairing-marker',
    first.account.secrets!.root,
    first.account.secrets!.encryption.d!,
  ])
    expect(rows).not.toContain(marker);
});
it('encrypts messages, attachments and signed approvals, preserves retries, rejects plaintext and synchronizes decryption', async () => {
  const { session, db } = await fixture();
  const a = session(),
    b = session();
  await a.account.register('alice', 'Alice', 'strong-password-alice');
  await b.account.register('bob', 'Bob', 'strong-password-bob');
  const alice = a.client(),
    bob = b.client();
  await alice.addContact(b.account.user!.id);
  const { conversation } = await alice.direct(b.account.user!.id);
  const cid = conversation.id;
  const sent = await alice.send(cid, 'private-text-marker', 'stable-id');
  expect(sent.message.text).toBe('private-text-marker');
  expect((await alice.send(cid, 'private-text-marker', 'stable-id')).message.id).toBe(sent.message.id);
  await expect(alice.send(cid, 'different', 'stable-id')).rejects.toThrow();
  expect((await bob.history(cid)).messages[0].text).toBe('private-text-marker');
  const upload = await alice.upload(
    cid,
    'private-filename.txt',
    new Blob(['private-attachment-bytes'], { type: 'text/plain' }),
  );
  expect(upload.file.name).toBe('private-filename.txt');
  await alice.send(cid, '', 'file-id', { attachmentIds: [upload.file.id] });
  const file = (await bob.history(cid)).messages[1].attachments[0];
  expect(new TextDecoder().decode((await bob.download(file.url)).data)).toBe('private-attachment-bytes');
  vi.stubGlobal('location', { origin: 'https://chat.test' });
  expect(new TextDecoder().decode((await b.client('').download(file.url)).data)).toBe(
    'private-attachment-bytes',
  );
  const another = await alice.upload(cid, 'second.txt', new Blob(['another-file'], { type: 'text/plain' }));
  const savedHeader = db.prepare('SELECT encrypted FROM im_files WHERE id=?').get(file.id)!.encrypted;
  db.prepare('UPDATE im_files SET encrypted=(SELECT encrypted FROM im_files WHERE id=?) WHERE id=?').run(
    another.file.id,
    file.id,
  );
  await expect(bob.download(file.url)).rejects.toThrow('附件身份');
  db.prepare('UPDATE im_files SET encrypted=? WHERE id=?').run(savedHeader!, file.id);
  const request = await alice.send(cid, 'Please approve', 'approval-id', {
    interaction: {
      kind: 'approval',
      recipientId: b.account.user!.id,
      title: 'private-title',
      description: 'private-action-details',
    },
  });
  const approved = await bob.respond(cid, request.message.id, {
    decision: 'approve',
    comment: 'private-response',
  });
  expect(approved.message.interaction?.status).toBe('approved');
  expect((await alice.history(cid)).messages.at(-1)?.interaction?.response).toEqual({
    decision: 'approve',
    comment: 'private-response',
  });
  expect(
    (await bob.respond(cid, request.message.id, { decision: 'approve', comment: 'private-response' })).message
      .id,
  ).toBe(request.message.id);
  await expect(
    alice.raw(`/conversations/${cid}/messages`, 'POST', { text: 'plaintext-bypass', clientId: 'bypass' }),
  ).rejects.toThrow('端到端加密');
  const rows =
    JSON.stringify(db.prepare('SELECT * FROM im_messages').all()) +
    JSON.stringify(db.prepare('SELECT * FROM im_files').all()) +
    JSON.stringify(db.prepare('SELECT * FROM im_message_features').all());
  for (const marker of [
    'private-text-marker',
    'private-filename',
    'private-attachment-bytes',
    'private-title',
    'private-action-details',
    'private-response',
  ])
    expect(rows).not.toContain(marker);
  const fresh = session();
  await fresh.account.login('alice', 'strong-password-alice');
  expect((await fresh.client().history(cid)).messages[0].text).toBe('private-text-marker');
});
it('authenticates ciphertext context, sender, recipients and rejects altered envelopes and wrong passwords', async () => {
  const a = await createSecrets(),
    b = await createSecrets(),
    outsider = await createSecrets();
  const text = await encryptFor(
    a,
    '10000000',
    { '10000000': a.publicKeys, '10000001': b.publicKeys },
    'test-context',
    { secret: 'value' },
  );
  expect(await decryptFor(b, '10000001', '10000000', a.publicKeys, 'test-context', text)).toEqual({
    secret: 'value',
  });
  await expect(
    decryptFor(outsider, '10000002', '10000000', a.publicKeys, 'test-context', text),
  ).rejects.toThrow();
  await expect(
    decryptFor(b, '10000001', '10000000', a.publicKeys, 'another-context', text),
  ).rejects.toThrow();
  const forged = parseEnvelope(text);
  forged.operation = 'forged';
  await expect(
    decryptFor(
      b,
      '10000001',
      '10000000',
      a.publicKeys,
      'test-context',
      SEALED_PREFIX + encode64(new TextEncoder().encode(canonical(forged))),
    ),
  ).rejects.toThrow('签名');
  const protectedAccount = await protectAccount('strong-test-password', a);
  await expect(unlockAccount(protectedAccount.vault, 'wrong-test-password')).rejects.toThrow();
});
it('encrypts Agent streams and group membership changes without granting new members historical keys', async () => {
  const { session } = await fixture();
  const a = session(),
    b = session(),
    c = session();
  await a.account.register('alice', 'Alice', 'strong-password-alice');
  await b.account.register('bob', 'Bob', 'strong-password-bob');
  await c.account.register('carol', 'Carol', 'strong-password-carol');
  const alice = a.client(),
    bob = b.client(),
    carol = c.client();
  await alice.addContact(b.account.user!.id);
  await alice.addContact(c.account.user!.id);
  const invite = await alice.raw<{ invitation: string }>('/agent-invitations', 'POST');
  const agentKeys = await protectAccount('agent-random-test-password');
  const registered = await alice.registerAgent(invite.invitation, 'testagent', 'Agent', agentKeys.vault);
  const agent = new EncryptedMessagingClient('https://chat.test', registered.token);
  agent.account.activate(registered.user, agentKeys.secrets);
  const { conversation } = await alice.group('Group', [b.account.user!.id, registered.user.id]);
  const cid = conversation.id;
  const original = await agent.send(cid, '', 'stream-stable', { state: 'streaming' });
  await agent.updateMessage(cid, original.message.id, 1, 'stream-private-content');
  const retried = await agent.send(cid, '', 'stream-stable', { state: 'streaming' });
  expect(retried.message.text).toBe('stream-private-content');
  await agent.updateMessage(cid, original.message.id, 1, 'stream-private-content');
  expect((await bob.history(cid)).messages[0].text).toBe('stream-private-content');
  await alice.request(`/groups/${cid}`, 'PATCH', { add: [c.account.user!.id] });
  expect((await carol.history(cid)).messages[0].text).toContain('无法解密');
  await alice.request(`/groups/${cid}`, 'PATCH', { remove: b.account.user!.id });
  await agent.updateMessage(cid, original.message.id, 2, 'after-membership-change', 'complete');
  const raw = await alice.raw<{ message: any }>(`/conversations/${cid}/messages/${original.message.id}`);
  expect(Object.keys(parseEnvelope(raw.message.text).recipients)).not.toContain(b.account.user!.id);
  expect((await carol.history(cid)).messages[0].text).toBe('after-membership-change');
  await expect(bob.history(cid)).rejects.toThrow();
});
it('accepts same-origin pairing QR codes and refuses foreign origins or malformed capabilities', async () => {
  const identity = await createIdentity(),
    link = `https://chat.test/#host=${identity.peerId}&pair=${'a'.repeat(32)}`;
  expect(parsePairingLink(link, 'https://chat.test').host).toBe(identity.peerId);
  expect(() => parsePairingLink(link, 'https://other.test')).toThrow();
  expect(() => parsePairingLink('javascript:alert(1)', 'https://chat.test')).toThrow();
});
