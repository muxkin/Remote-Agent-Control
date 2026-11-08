/** Synthetic browser fixtures use the same encrypted client as the application. */
import { expect, type Page } from '@playwright/test';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import { protectAccount, unlockAccount } from '../../src/shared/account-crypto.js';
import type { ChatUser, SendMessageOptions, MessageState } from '../../src/shared/messaging.js';

export async function saveRecoveryCode(page: Page) {
  await expect(page.getByRole('heading', { name: '保存恢复码' })).toBeVisible();
  await page.getByLabel('我已安全保存恢复码').check();
  await page.getByRole('button', { name: '保存后继续', exact: true }).click();
}

export async function registerAgentFixture(
  origin: string,
  registration: { invitation: string; username: string; displayName: string },
) {
  const protectedAccount = await protectAccount('synthetic-agent-fixture-password');
  const result = await new EncryptedMessagingClient(origin).raw<{
    user: ChatUser;
    owner: ChatUser;
    token: string;
  }>('/agents/register', 'POST', { ...registration, vault: protectedAccount.vault });
  const client = new EncryptedMessagingClient(origin, result.token);
  client.account.activate(result.user, protectedAccount.secrets, protectedAccount.vault);
  return { ...result, client, secrets: protectedAccount.secrets };
}

export async function browserAccountFixture(page: Page, origin: string, password: string) {
  const cookie = (await page.context().cookies(`${origin}/api/im`)).find(
    (c) => c.name === 'pocket_im_session',
  );
  if (!cookie) throw Error('Synthetic browser account is not signed in');
  const client = new EncryptedMessagingClient(origin, cookie.value);
  const { user } = await client.raw<{ user: ChatUser }>('/me');
  const { vault, revision } = await client.raw<{
    vault: Parameters<typeof unlockAccount>[0];
    revision: number;
  }>('/crypto/account');
  const { secrets } = await unlockAccount(vault, password);
  client.account.activate(user, secrets, vault, revision);
  await client.account.refreshItems();
  return client;
}

export function messagingFixtureRequest(
  client: EncryptedMessagingClient,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
) {
  const message = /^\/conversations\/([^/]+)\/messages(?:\/([^/]+))?$/.exec(path);
  if (message && method === 'POST' && !message[2]) {
    const { text = '', clientId, ...options } = body!;
    return client.send(message[1], String(text), String(clientId), options as SendMessageOptions);
  }
  if (message && method === 'PATCH' && message[2]) {
    const { revision, text, state } = body!;
    return client.updateMessage(
      message[1],
      message[2],
      Number(revision),
      String(text),
      state as MessageState,
    );
  }
  return client.request(path, method, body);
}
