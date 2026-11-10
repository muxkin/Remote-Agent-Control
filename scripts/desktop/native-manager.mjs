import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { runUpdates } from './native-update.mjs';

const executable = process.argv[2];
const root = process.cwd();
const directory = process.env.POCKET_STATE_DIR;
const defaultInstances = join(directory, 'instances.json');
if (existsSync(defaultInstances)) process.env.POCKET_NATIVE_DEFAULT_INSTANCES = defaultInstances;

const input = createInterface({ input: process.stdin, terminal: false });
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let closing = false;
let installing = false;
let gateway;
let restart;
let status;
let ready = false;
const pending = new Map();
const publish = () => emit({ type: 'status', ...status, update, manualUpdate });
let update = '';
let manualUpdate = false;

function start() {
  if (closing) return;
  const child = fork(join(root, 'dist/server/main.js'), {
    cwd: root,
    execArgv: [],
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, POCKET_DESKTOP_MANAGED: '1', POCKET_MANAGED_ADAPTERS: '1' },
  });
  gateway = child;
  child.on('message', (message) => {
    if (message?.type === 'desktop-status') {
      ready = true;
      status = { ...message };
      delete status.type;
      publish();
    }
    pending.get(message?.id)?.(message);
  });
  child.on('error', () => {});
  child.on('close', () => {
    gateway = undefined;
    ready = false;
    for (const resolve of pending.values()) resolve({ error: '插件网关已退出' });
    status = { relayConnected: false };
    if (!closing) {
      publish();
      restart = setTimeout(start, 5000);
    }
  });
}

async function request(type, extra = {}) {
  const child = gateway;
  if (!child?.connected) throw Error('插件网关尚未启动');
  const id = randomUUID();
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      pending.set(id, (message) => (message.error ? reject(Error(message.error)) : resolve(message.value)));
      timer = setTimeout(() => reject(Error('插件网关响应超时')), 15000);
      child.send({ type, id, ...extra }, (error) => {
        if (error) reject(error);
      });
    });
  } finally {
    clearTimeout(timer);
    pending.delete(id);
  }
}

const updates = runUpdates({
  root,
  directory,
  executable,
  idle: () => !closing && status?.safeToRestart === true,
  notify: (message, manual = false) => {
    update = message;
    manualUpdate = manual;
    publish();
  },
  prepare: async () => request('desktop-prepare-update'),
  handoff: () => {
    installing = true;
    emit({ type: 'exit-for-update' });
    stop();
  },
  recover: () => {
    if (gateway?.connected) gateway.send({ type: 'desktop-stop' }, () => {});
  },
});

input.on('line', (line) => {
  if (closing) return;
  if (line === 'pair') {
    void request('desktop-pair', { format: 'link' })
      .then((value) => {
        status = { ...status, pairing: { state: 'ready', expiresAt: value.expiresAt } };
        emit({ type: 'pair', ...value });
      })
      .catch(() => {});
  } else if (line === 'install-update') {
    updates.install();
  }
});

function stop() {
  if (closing) return;
  closing = true;
  updates.stop();
  clearTimeout(restart);
  input.close();
  process.stdin.pause();
  if (gateway?.connected) {
    if (ready) gateway.send({ type: 'desktop-stop' }, () => {});
    else gateway.disconnect();
  }
  // A healthy child exits after closing the relay, plugin hosts and SQLite.
  // Leave its IPC connected until exit so it can finish draining.
  if (installing) process.stdout.end();
}
input.on('close', stop);
process.on('SIGTERM', stop);
start();
