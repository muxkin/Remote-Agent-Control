import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function superviseIndependentAgents(root, directory, notify) {
  const manifest = process.env.POCKET_NATIVE_IM_AGENTS ?? join(directory, 'im-agents.json');
  const profiles = [];
  let invalid = false;
  let draining = false;
  let stopped = false;
  try {
    if (existsSync(manifest)) {
      const list = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!Array.isArray(list) || list.length > 16) throw Error();
      const ids = new Set();
      const accounts = new Set();
      for (const profile of list) {
        try {
          const { id, state, messageHandler, callHandler, environmentFile, cursor } = profile;
          if (
            typeof id !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
            typeof state !== 'string' ||
            !isAbsolute(state) ||
            (!messageHandler && !callHandler) ||
            [messageHandler, callHandler, environmentFile].some(
              (p) => p !== undefined && (typeof p !== 'string' || !isAbsolute(p)),
            ) ||
            (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
          )
            throw Error();
          const account = realpathSync(state);
          if (ids.has(id) || accounts.has(account)) throw Error();
          ids.add(id);
          accounts.add(account);
          profiles.push({ id, state: account, messageHandler, callHandler, environmentFile, cursor });
        } catch {
          invalid = true;
        }
      }
    }
  } catch {
    invalid = true;
  }

  const progress = join(directory, 'im-agent-progress');
  if (profiles.length) mkdirSync(progress, { recursive: true, mode: 0o700 });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_[A-Z_]+|TZ)$/i.test(
        key,
      ),
    ),
  );

  function start(profile) {
    if (stopped || draining || profile.child) return;
    const args = [
      profile.state,
      join(progress, profile.id + '.json'),
      profile.messageHandler ?? '',
      profile.callHandler ?? '',
      String(profile.cursor ?? ''),
    ];
    const child = fork(join(root, 'dist/server/desktop-im-agent.js'), args, {
      cwd: root,
      execArgv: profile.environmentFile ? ['--env-file', profile.environmentFile] : [],
      env: environment,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    profile.child = child;
    profile.status = undefined;
    child.on('message', (value) => {
      if (value?.type === 'status') {
        profile.status = value;
        notify();
      }
    });
    child.on('error', () => {});
    child.on('close', () => {
      profile.child = undefined;
      profile.status = undefined;
      notify();
      if (!stopped && !draining) profile.retry = setTimeout(() => start(profile), 5000);
    });
  }

  function prepare(child) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (ok) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('close', onClose);
        resolve(ok);
      };
      const onMessage = (message) => {
        if (message?.id === id) finish(message.ok === true);
      };
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), 5000);
      child.on('message', onMessage);
      child.on('close', onClose);
      child.send({ type: 'prepare', id }, (error) => {
        if (error) finish(!child.connected);
      });
    });
  }

  function resume() {
    if (stopped) return;
    draining = false;
    for (const profile of profiles) {
      if (profile.child?.connected) profile.child.send({ type: 'resume' }, () => {});
      else {
        clearTimeout(profile.retry);
        profile.retry = setTimeout(() => start(profile), 1000);
      }
    }
  }
  for (const profile of profiles) start(profile);
  return {
    status() {
      const rows = profiles.map(({ id, status, messageHandler, callHandler }) => ({
        name: [
          `独立 Agent ${id}`,
          messageHandler && (status?.messages ? '消息在线' : '消息待接入'),
          callHandler && (status?.calls ? '通话可接听' : '通话待接入'),
        ]
          .filter(Boolean)
          .join(' · '),
        connected: !!(status?.messages || status?.calls),
      }));
      if (invalid) rows.push({ name: '独立 Agent 配置有误', connected: false });
      return rows;
    },
    idle: () => profiles.every((profile) => !profile.status?.busy),
    async prepare() {
      draining = true;
      const checks = await Promise.all(profiles.map(({ child }) => !child?.connected || prepare(child)));
      if (checks.some((ok) => !ok)) {
        resume();
        throw Error('独立 Agent 正在处理消息或通话');
      }
    },
    resume,
    stop() {
      stopped = true;
      for (const { child, retry } of profiles) {
        clearTimeout(retry);
        if (!child?.connected) continue;
        child.send({ type: 'stop' }, () => {});
        const timeout = setTimeout(() => child.kill(), 12000);
        child.once('close', () => clearTimeout(timeout));
      }
    },
  };
}
