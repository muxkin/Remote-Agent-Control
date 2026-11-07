/** Agent-friendly JSON CLI. Credentials are written privately, never printed by registration. */
import { parseArgs } from 'node:util';
import { mkdir, readFile, open, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EncryptedMessagingClient } from '../src/client/encrypted-messaging.js';
import { protectAccount, type AccountSecrets } from '../src/shared/account-crypto.js';
import type { ChatUser } from '../src/shared/messaging.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    origin: { type: 'string' },
    state: { type: 'string' },
    username: { type: 'string' },
    account: { type: 'string' },
    name: { type: 'string' },
    user: { type: 'string' },
    conversation: { type: 'string' },
    text: { type: 'string' },
    'request-id': { type: 'string' },
    cursor: { type: 'string' },
    before: { type: 'string' },
    wait: { type: 'string' },
    sequence: { type: 'string' },
    message: { type: 'string' },
    revision: { type: 'string' },
    status: { type: 'string' },
    members: { type: 'string' },
    add: { type: 'string' },
    remove: { type: 'string' },
    owner: { type: 'string' },
    close: { type: 'boolean' },
    file: { type: 'string' },
    attachments: { type: 'string' },
    mentions: { type: 'string' },
    reply: { type: 'string' },
    query: { type: 'string' },
    sticker: { type: 'string' },
  },
});
const state =
  values.state ??
  process.env.POCKET_IM_AGENT_STATE ??
  join(homedir(), '.local/state/codex-pocket-remote/im-agent.json');
function required(value: string | undefined, name: string) {
  if (!value) throw Error(`Missing ${name}`);
  return value;
}
function number(value: string | undefined, fallback: number) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw Error('Expected a non-negative integer');
  return result;
}
async function main() {
  const command = positionals[0];
  if (!command || command === 'help')
    return {
      usage:
        'npm run im -- <register|me|contacts|add-contact|chats|chat|group|group-update|history|search|send|stream-start|stream-update|cancel|request|request-cancel|stickers|sticker-save|sticker-remove|upload|sync|read> [options]',
      registration:
        'register --origin https://your-server --username my-agent --name 我的助手; set POCKET_IM_INVITATION first',
      options:
        '--state private.json; --user USER_ID (chat); --account UID_OR_USERNAME (add-contact); --conversation ID (history/send/read); --text TEXT --request-id ID (send); --cursor N --wait MS (sync); --before N (history); --sequence N (read)',
      group:
        'group --name NAME --members USER_ID,USER_ID; group-update --conversation ID [--name NAME] [--add IDS] [--remove ID] [--owner ID] [--close]',
      stream:
        'stream-start --conversation ID --request-id ID [--text TEXT]; stream-update --conversation ID --message ID --revision N --text FULL_TEXT [--status streaming|complete|failed]; cancel --conversation ID --message ID',
      interactions:
        'request --conversation ID --file request.json --request-id STABLE_ID; request-cancel --conversation ID --message ID; responses arrive in message.interaction via sync',
      stickers:
        'stickers; sticker-save --conversation ID --attachments FILE_ID; sticker-remove --sticker ID; send --conversation ID --sticker ID',
      files:
        'upload --conversation ID --file PATH; send --conversation ID [--text TEXT] [--attachments FILE_ID,FILE_ID] [--mentions USER_ID,USER_ID] [--reply MESSAGE_ID]; search --conversation ID --query TEXT',
    };
  let saved: { origin?: string; token?: string; secrets?: AccountSecrets; user?: ChatUser } = {};
  let stateExists = false;
  try {
    saved = JSON.parse(await readFile(state, 'utf8'));
    stateExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Cannot read credential file');
  }
  const origin = new URL(
    required(values.origin ?? process.env.POCKET_IM_ORIGIN ?? saved.origin, '--origin or POCKET_IM_ORIGIN'),
  ).origin;
  if (saved.token && saved.origin !== origin && !process.env.POCKET_IM_TOKEN && command !== 'register')
    throw Error('Origin differs from saved credentials; use a separate --state file');
  const client = new EncryptedMessagingClient(origin, process.env.POCKET_IM_TOKEN ?? saved.token);
  if (saved.secrets && saved.user) {
    client.account.activate(saved.user, saved.secrets);
    await client.account.refreshItems();
  }
  switch (command) {
    case 'register': {
      if (stateExists)
        throw Error('Credential file already exists; choose a new --state file to register another Agent');
      const invitation = required(process.env.POCKET_IM_INVITATION, 'POCKET_IM_INVITATION');
      const username = required(values.username, '--username'),
        displayName = required(values.name, '--name');
      await mkdir(dirname(state), { recursive: true, mode: 0o700 });
      // Reserve a writable destination before consuming the one-use invitation.
      const file = await open(state, 'wx', 0o600);
      try {
        const protectedAccount = await protectAccount(randomUUID() + randomUUID());
        await file.writeFile(
          JSON.stringify({ origin, secrets: protectedAccount.secrets, pendingRegistration: true, username }) +
            '\n',
        );
        await file.sync();
        const result = await client.registerAgent(invitation, username, displayName, protectedAccount.vault);
        const next = `${state}.${randomUUID()}.tmp`;
        const completed = await open(next, 'wx', 0o600);
        try {
          await completed.writeFile(
            JSON.stringify(
              {
                origin,
                token: result.token,
                user: result.user,
                owner: result.owner,
                expiresAt: result.expiresAt,
                secrets: protectedAccount.secrets,
              },
              null,
              2,
            ) + '\n',
          );
          await completed.sync();
        } finally {
          await completed.close();
        }
        await file.close();
        await rename(next, state);
        return { user: result.user, owner: result.owner, expiresAt: result.expiresAt, credentialFile: state };
      } catch (error) {
        // Preserve any issued credential/key material; a failed second request must be recoverable.
        if ((await file.stat().catch(() => ({ size: 1 }))).size === 0) await unlink(state).catch(() => {});
        throw error;
      } finally {
        await file.close();
      }
    }
    case 'me':
      return client.me();
    case 'contacts':
      return client.contacts();
    case 'add-contact':
      return client.addContact(required(values.account, '--account'));
    case 'chats':
      return client.conversations();
    case 'chat':
      return client.direct(required(values.user, '--user'));
    case 'history':
      return client.history(
        required(values.conversation, '--conversation'),
        values.before === undefined ? undefined : number(values.before, 0),
      );
    case 'send':
    case 'stream-start':
      return client.send(
        required(values.conversation, '--conversation'),
        values.text ?? '',
        values['request-id'] ?? randomUUID(),
        {
          state: command === 'stream-start' ? 'streaming' : 'complete',
          attachmentIds: values.attachments?.split(','),
          mentions: values.mentions?.split(','),
          replyTo: values.reply,
          stickerId: values.sticker,
        },
      );
    case 'group':
      return client.group(required(values.name, '--name'), required(values.members, '--members').split(','));
    case 'group-update':
      return client.request(
        `/groups/${encodeURIComponent(required(values.conversation, '--conversation'))}`,
        'PATCH',
        {
          name: values.name,
          add: values.add?.split(','),
          remove: values.remove,
          ownerId: values.owner,
          closed: values.close,
        },
      );
    case 'search':
      return client.search(
        required(values.conversation, '--conversation'),
        required(values.query, '--query'),
        values.before === undefined ? undefined : number(values.before, 0),
      );
    case 'stream-update': {
      const status = values.status ?? 'streaming';
      if (!['streaming', 'complete', 'failed'].includes(status)) throw Error('Invalid --status');
      return client.updateMessage(
        required(values.conversation, '--conversation'),
        required(values.message, '--message'),
        number(required(values.revision, '--revision'), 0),
        values.text ?? '',
        status as 'streaming' | 'complete' | 'failed',
      );
    }
    case 'cancel':
      return client.cancel(
        required(values.conversation, '--conversation'),
        required(values.message, '--message'),
      );
    case 'request': {
      const interaction = JSON.parse(await readFile(required(values.file, '--file'), 'utf8'));
      return client.send(
        required(values.conversation, '--conversation'),
        values.text ?? interaction.title ?? '',
        values['request-id'] ?? randomUUID(),
        { interaction },
      );
    }
    case 'request-cancel':
      return client.cancelInteraction(
        required(values.conversation, '--conversation'),
        required(values.message, '--message'),
      );
    case 'stickers':
      return client.stickers();
    case 'sticker-save':
      return client.saveSticker(
        required(values.conversation, '--conversation'),
        required(values.attachments, '--attachments'),
      );
    case 'sticker-remove':
      return client.removeSticker(required(values.sticker, '--sticker'));
    case 'upload': {
      const path = required(values.file, '--file');
      return client.upload(
        required(values.conversation, '--conversation'),
        basename(path),
        await readFile(path),
      );
    }
    case 'sync':
      return client.sync(number(values.cursor, 0), number(values.wait, 25000));
    case 'read':
      return client.read(
        required(values.conversation, '--conversation'),
        number(required(values.sequence, '--sequence'), 0),
      );
    default:
      throw Error('Unknown command; run npm run im -- help');
  }
}
main()
  .then((value) => console.log(JSON.stringify(value, null, 2)))
  .catch((error) => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' }));
    process.exitCode = 1;
  });
