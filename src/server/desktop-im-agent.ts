import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  loadCallAccount,
  runAgentCallListener,
  type AgentCallHandler,
} from '../client/agent-call-listener.js';
import type { EncryptedMessagingClient } from '../client/encrypted-messaging.js';
import type { ChatEvent } from '../shared/messaging.js';

type MessageHandler = (
  event: ChatEvent,
  context: {
    messaging: EncryptedMessagingClient;
    signal: AbortSignal;
  },
) => unknown | Promise<unknown>;

const [state, cursorFile, messageFile, callFile, initialCursor] = process.argv.slice(2);
const stop = new AbortController();
const publish = (value: object) => {
  if (process.connected) process.send?.(value, () => {});
};
let draining = false;
let initialized = false;
let messageActive = false;
let callActive = false;
let messagesOnline = false;
let callsOnline = false;
const status = () =>
  publish({
    type: 'status',
    messages: messagesOnline,
    calls: callsOnline,
    initialized,
    busy: messageActive || callActive,
  });
process.on('disconnect', () => stop.abort());
process.on('SIGINT', () => stop.abort());
process.on('SIGTERM', () => stop.abort());
process.on('message', (value: any) => {
  if (value?.type === 'stop') stop.abort();
  if (value?.type === 'resume') draining = false;
  if (value?.type === 'prepare') {
    const ok = !messageActive && !callActive;
    if (ok) draining = true;
    publish({ id: value.id, ok });
  }
});

async function messages(messaging: EncryptedMessagingClient, handler: MessageHandler) {
  const user = messaging.account.user!;
  const saved = await readFile(cursorFile, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
  const persist = async (cursor: number) => {
    const temp = `${cursorFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ user: user.id, origin: messaging.baseURL, cursor }), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temp, cursorFile);
  };
  let cursor: number;
  if (saved) {
    if (saved.user !== user.id || saved.origin !== messaging.baseURL) throw Error('Cursor identity mismatch');
    cursor = saved.cursor;
  } else {
    cursor = initialCursor
      ? Number(initialCursor)
      : (await messaging.request<{ cursor: number }>('/bootstrap', 'GET', undefined, stop.signal)).cursor;
    await persist(cursor);
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('Invalid message cursor');
  let wait = 1000;
  while (!stop.signal.aborted) {
    try {
      if (draining) {
        await delay(200, undefined, { signal: stop.signal });
        continue;
      }
      const batch = await messaging.sync(cursor, 25000, stop.signal);
      if (!messagesOnline) {
        messagesOnline = true;
        status();
      }
      for (const event of batch.events) {
        if (draining || stop.signal.aborted) break;
        if (event.sequence <= cursor) continue;
        const message = event.message;
        if (message && (message.senderId !== user.id || message.state === 'cancelled')) {
          messageActive = true;
          status();
          try {
            await handler(event, { messaging, signal: stop.signal });
            await persist(event.sequence);
            cursor = event.sequence;
          } finally {
            messageActive = false;
            status();
          }
        }
      }
      if (!draining && !stop.signal.aborted && batch.cursor > cursor) {
        await persist(batch.cursor);
        cursor = batch.cursor;
      }
      wait = 1000;
    } catch {
      if (stop.signal.aborted) break;
      messagesOnline = false;
      status();
      await delay(wait, undefined, { signal: stop.signal }).catch(() => {});
      wait = Math.min(15000, wait * 2);
    }
  }
}

async function start() {
  if (
    !process.send ||
    ![state, cursorFile].every(isAbsolute) ||
    (!messageFile && !callFile) ||
    [messageFile, callFile].some((path) => path && !isAbsolute(path))
  )
    throw Error('Invalid independent Agent configuration');
  const calls = await loadCallAccount(state);
  const [{ user }, messageHandler, callHandler] = await Promise.all([
    calls.messaging.me(stop.signal),
    messageFile ? import(pathToFileURL(messageFile).href) : undefined,
    callFile ? import(pathToFileURL(callFile).href) : undefined,
  ]);
  if (user?.id !== calls.messaging.account.user?.id) throw Error('Agent identity mismatch');
  if (
    (messageFile && typeof messageHandler?.onMessage !== 'function') ||
    (callFile && (callHandler?.capabilities?.audio !== true || typeof callHandler?.onCall !== 'function'))
  )
    throw Error('Invalid Agent handler');
  initialized = true;
  status();
  const run = (task: Promise<unknown>) =>
    task.catch(() => {
      if (!stop.signal.aborted) process.exitCode = 1;
      stop.abort();
    });
  await Promise.all([
    messageHandler && run(messages(calls.messaging, messageHandler.onMessage as MessageHandler)),
    callHandler &&
      run(
        runAgentCallListener(
          calls,
          callHandler as AgentCallHandler,
          stop.signal,
          (state) => {
            if (state !== 'call-failed') callsOnline = state === 'ready';
            status();
          },
          {
            canAnswer: () => !draining,
            active(value) {
              callActive = value;
              status();
            },
          },
        ),
      ),
  ]);
}

try {
  await start();
} catch {
  if (!stop.signal.aborted) process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}
