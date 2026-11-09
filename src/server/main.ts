import { builtinBackends } from './backends/builtins.js';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { HostService } from './host-service.js';
import { createPairingDisplay } from './pairing-display.js';
import { readFile } from 'node:fs/promises';
import { queueBundledUpdates } from './adapters/managed-updates.js';

process.umask(0o077);
const config = readConfig();
const store = new Store(config.stateDir);
const registry = await builtinBackends(config);
const host = await HostService.create(config, { store, registry });
store.recover();
await registry.start(false);
host.start();
if (process.env.POCKET_MANAGED_ADAPTERS === '1')
  await queueBundledUpdates(config).catch(() => console.error('Cannot queue bundled adapter updates'));
console.log(`Codex Pocket Remote v2 connecting to ${config.origin}; no inbound business port`);
for (const backend of registry.all())
  console.log(
    `${backend.id}: connected=${backend.status().connected}; controls=${backend.status().writesEnabled}; version=${backend.status().desktopVersion ?? 'unknown'}; referenceBuild=${backend.status().supportedVersion}`,
  );
let shutdown: Promise<void> | undefined;
let desktopTimer: NodeJS.Timeout | undefined;
if (process.env.POCKET_DESKTOP_MANAGED === '1' && process.send) {
  const send = (value: unknown) => {
    if (process.connected) process.send?.(value);
  };
  const status = () =>
    send({
      type: 'desktop-status',
      safeToRestart: !shutdown && host.idleForUpdate,
      status: !host.relayConnected
        ? '正在连接服务，请检查服务地址、网络或接入密钥'
        : registry.all().some((b) => b.status().connected)
          ? '已连接，手机可随时接入'
          : '等待电脑端 Agent 启动',
    });
  status();
  desktopTimer = setInterval(status, 5000);
  desktopTimer.unref();
  process.on('message', (message: any) => {
    if (message?.type === 'desktop-stop') {
      void close().then(() => process.exit(0));
      return;
    }
    if (typeof message?.id !== 'string') return;
    void (async () => {
      if (message.type === 'desktop-prepare-update') {
        if (!host.idleForUpdate || shutdown) throw Error('仍有手机连接或操作正在确认');
        host.stop();
        return { ok: true };
      }
      if (message.type === 'desktop-pair' && !shutdown) {
        const pairing = await createPairingDisplay(config, store.mintPairing());
        return {
          image: `data:image/png;base64,${(await readFile(pairing.imagePath)).toString('base64')}`,
          expiresAt: pairing.expiresAt,
        };
      }
      throw Error('未知管理操作');
    })().then(
      (value) => send({ id: message.id, value }),
      (error) => send({ id: message.id, error: error.message }),
    );
  });
  process.on('disconnect', () => void close().then(() => process.exit(0)));
}
function close() {
  return (shutdown ??= (async () => {
    clearInterval(desktopTimer);
    host.stop();
    try {
      await registry.stop();
    } finally {
      store.close();
    }
  })());
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
