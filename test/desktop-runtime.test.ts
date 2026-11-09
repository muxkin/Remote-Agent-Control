import { it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const {
  desktopEntry,
  setAutoStart,
  loadSettings,
  saveSettings,
  updateURL,
  resolveUpdateFeed,
} = require('../desktop/settings.cjs');
const { setupUpdater, sameOriginFiles } = require('../desktop/updater.cjs');
afterEach(() => vi.useRealTimers());
it('defaults to automatic startup/update, preserves opt-out and uses persistent Linux AppImage paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-settings-'));
  try {
    const file = join(dir, 'settings.json');
    expect(loadSettings(file)).toMatchObject({ autoStart: true, autoUpdate: true });
    saveSettings(file, { autoStart: false, autoUpdate: false, origin: 'https://example.com' });
    expect(loadSettings(file).autoStart).toBe(false);
    const app = { getPath: () => '/temporary/mount', setLoginItemSettings: vi.fn() };
    setAutoStart(app, true, 'linux', { XDG_CONFIG_HOME: dir, APPIMAGE: '/home/test/Agent Space.AppImage' });
    const entry = join(dir, 'autostart/agent-space.desktop');
    expect(readFileSync(entry, 'utf8')).toContain('Exec="/home/test/Agent Space.AppImage" --background');
    setAutoStart(app, false, 'linux', { XDG_CONFIG_HOME: dir });
    expect(existsSync(entry)).toBe(false);
    for (const platform of ['darwin', 'win32']) setAutoStart(app, false, platform, {});
    expect(app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: false }));
    expect(desktopEntry('/tmp/100%"x')).toContain('100%%\\"x');
    expect(() => desktopEntry('/tmp/a\nExec=evil')).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
function fakeUpdater() {
  return Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: false }),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  });
}
it('preserves an existing gateway environment and working directory without copying credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-legacy-gateway-'));
  try {
    const file = join(dir, 'settings.json');
    const legacyGateway = { environmentFile: join(dir, 'local', 'gateway.env'), workingDirectory: dir };
    saveSettings(file, { origin: 'https://example.com', legacyGateway });
    expect(loadSettings(file)).toMatchObject({ origin: 'https://example.com', legacyGateway });
    expect(loadSettings(file)).not.toHaveProperty('enrollment');
    saveSettings(file, { legacyGateway: { ...legacyGateway, workingDirectory: 'relative/path' } });
    expect(() => loadSettings(file)).toThrow('设置文件无法读取');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('follows migrated service addresses on all platforms while preserving an explicit independent source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-migration-'));
  try {
    const file = join(dir, 'settings.json');
    for (const platform of ['linux', 'darwin', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        const settings = { ...loadSettings(file), origin: 'https://old.example' };
        expect(resolveUpdateFeed(settings, platform, arch)).toBe(
          `https://old.example/downloads/desktop/${platform}/${arch}/`,
        );
        saveSettings(file, { ...settings, origin: 'https://vps.example', autoUpdate: false });
        const migrated = loadSettings(file);
        expect(resolveUpdateFeed(migrated, platform, arch)).toBe(
          `https://vps.example/downloads/desktop/${platform}/${arch}/`,
        );
        expect(migrated.autoUpdate).toBe(false);
        saveSettings(file, { ...migrated, updateBaseURL: 'https://cdn.example/stable' });
        expect(resolveUpdateFeed(loadSettings(file), platform, arch)).toBe(
          `https://cdn.example/stable/${platform}/${arch}/`,
        );
        saveSettings(file, { ...migrated, updateBaseURL: '' });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('uses a same-origin HTTPS feed, respects disabling updates, and installs only after a confirmed idle handoff', async () => {
  vi.useFakeTimers();
  for (const url of [
    'http://example.com',
    'https://github.com/releases',
    'https://raw.githubusercontent.com/x',
  ])
    expect(() => updateURL(url)).toThrow();
  const native = fakeUpdater();
  let enabled = true,
    idle = false;
  const prepare = vi.fn().mockResolvedValue(undefined),
    notify = vi.fn();
  const manager = setupUpdater(native, {
    feed: 'https://updates.example/stable/',
    enabled: () => enabled,
    idle: () => idle,
    prepare,
    notify,
  });
  try {
    await manager.check();
    expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
    native.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { files: [{ url: 'https://github.com/bad.exe' }] },
    } as any);
    await manager.check();
    expect(native.downloadUpdate).not.toHaveBeenCalled();
    native.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { files: [{ url: 'AgentSpace-0.4.0-win-x64.exe' }] },
    } as any);
    await manager.check();
    expect(native.downloadUpdate).toHaveBeenCalledTimes(1);
    await manager.install();
    expect(prepare).not.toHaveBeenCalled();
    idle = true;
    enabled = false;
    await manager.install();
    expect(prepare).not.toHaveBeenCalled();
    enabled = true;
    await manager.install();
    expect(native.quitAndInstall).toHaveBeenCalledWith(true, true);
  } finally {
    manager.stop();
  }
});
it('discards downloaded packages and ignores in-flight old-source results when migrating', async () => {
  vi.useFakeTimers();
  const native = fakeUpdater();
  const prepare = vi.fn().mockResolvedValue(undefined);
  const manager = setupUpdater(native, {
    feed: 'https://old.example/',
    enabled: () => true,
    idle: () => true,
    prepare,
    notify: vi.fn(),
  });
  try {
    const available = {
      isUpdateAvailable: true,
      updateInfo: { files: [{ url: 'AgentSpace-0.5.0-linux-x64.AppImage' }] },
    };
    native.checkForUpdates.mockResolvedValue(available as any);
    await manager.check();
    await manager.setFeed('https://new.example/');
    await manager.install();
    expect(prepare).not.toHaveBeenCalled();
    let resolveCheck!: (value: any) => void;
    native.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const checking = manager.check();
    const switching = manager.setFeed('https://third.example/');
    resolveCheck(available);
    await Promise.all([checking, switching]);
    expect(native.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(native.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://third.example/',
    });
    await manager.install();
    expect(prepare).not.toHaveBeenCalled();
    const cancel = vi.fn();
    let resolveDownload!: () => void;
    native.checkForUpdates.mockResolvedValue({ ...available, cancellationToken: { cancel } } as any);
    native.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const downloading = manager.check();
    await Promise.resolve();
    const changing = manager.setFeed('https://fourth.example/');
    expect(cancel).toHaveBeenCalledTimes(1);
    resolveDownload();
    await Promise.all([downloading, changing]);
    await manager.install();
    expect(prepare).not.toHaveBeenCalled();
    await manager.check();
    await manager.install();
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    manager.stop();
  }
});
