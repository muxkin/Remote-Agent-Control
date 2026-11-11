import { builtinBackends } from './backends/builtins.js';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { HostService } from './host-service.js';
import { DesktopPairing } from './desktop-pairing.js';
import { queueBundledUpdates } from './adapters/managed-updates.js';

process.umask(0o077);
const config = readConfig();
const managed = process.env.POCKET_DESKTOP_MANAGED === '1' && typeof process.send === 'function';
const store = new Store(config.stateDir);
const registry = await builtinBackends(config);
const host = await HostService.create(config, { store, registry });
await registry.start(false);
// A desktop manager can exit while the first offline plugin packages are being unpacked.
if (managed && !process.connected) {
  await registry.stop();
  store.close();
  process.exit(0);
}
store.recover();
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
let desktopPairing: DesktopPairing | undefined;
if (managed) {
  const pairing = (desktopPairing = new DesktopPairing(config, store, () => host.refreshPairingRoutes()));
  let draining = false;
  const send = (value: unknown) => {
    if (process.connected) process.send?.(value, () => {});
  };
  const status = () =>
    send({
      type: 'desktop-status',
      safeToRestart: !shutdown && !draining && host.idleForUpdate,
      relayConnected: !draining && host.relayConnected,
      pairing: pairing.status,
      agents: registry.all().map((backend) => {
        const { name } = backend.info();
        const { connected, writesEnabled } = backend.status();
        return { name, connected, writesEnabled };
      }),
      status: draining
        ? '正在停止接入'
        : !host.relayConnected
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
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
      return;
    }
    if (typeof message?.id !== 'string') return;
    void (async () => {
      if (message.type === 'desktop-prepare-update') {
        if (!host.idleForUpdate || shutdown || draining) throw Error('仍有手机连接或操作正在确认');
        draining = true;
        pairing.discard();
        host.stop();
        return { ok: true };
      }
      if (message.type === 'desktop-pair' && !shutdown && !draining) {
        if (!host.relayConnected) throw Error('服务还未连接，请检查诊断');
        return message.format === 'link' ? pairing.create('link') : pairing.create();
      }
      throw Error('未知管理操作');
    })().then(
      (value) => send({ id: message.id, value }),
      (error) => send({ id: message.id, error: error.message }),
    );
  });
  process.on(
    'disconnect',
    () =>
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      ),
  );
}
function close() {
  return (shutdown ??= (async () => {
    clearInterval(desktopTimer);
    host.stop();
    try {
      desktopPairing?.discard();
      await registry.stop();
    } finally {
      store.close();
    }
  })());
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
