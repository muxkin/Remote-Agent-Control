const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const {
  loadSettings,
  saveSettings,
  setAutoStart,
  httpsOrigin,
  updateURL,
  resolveUpdateFeed,
} = require('./settings.cjs');
const { setupUpdater } = require('./updater.cjs');
let window,
  tray,
  child,
  updater,
  settings,
  file,
  release,
  quitting = false,
  stoppedForUpdate = false,
  saving = false;
let status = '尚未连接',
  update = '自动更新已启用',
  safeToRestart = false,
  restart;
const pending = new Map();
const page = pathToFileURL(join(__dirname, 'index.html')).href;
function show() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 620,
    height: 740,
    minWidth: 420,
    minHeight: 580,
    title: 'Agent 空间适配器',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  void window.loadURL(page);
}
function request(type) {
  return new Promise((resolve, reject) => {
    const gateway = child;
    if (!gateway?.connected) return reject(Error('适配器尚未连接'));
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('适配器响应超时，请重试'));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    gateway.send({ type, id }, (error) => {
      if (!error || !pending.delete(id)) return;
      clearTimeout(timer);
      reject(Error('适配器已断开'));
    });
  });
}
function start() {
  if (child || !settings.origin || quitting || stoppedForUpdate) return;
  const root = process.env.POCKET_DESKTOP_PAYLOAD || join(process.resourcesPath, 'gateway');
  const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const python = join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  let enrollment;
  try {
    enrollment = settings.enrollment
      ? safeStorage.decryptString(Buffer.from(settings.enrollment, 'base64'))
      : process.env.POCKET_RELAY_ENROLLMENT || '';
  } catch {
    status = '无法读取已保存的接入密钥，请解锁系统密钥环或重新保存密钥';
    return;
  }
  status = '正在连接';
  safeToRestart = false;
  const gateway = spawn(
    node,
    ['--import', join(root, 'scripts/env.mjs'), join(root, 'dist/server/main.js')],
    {
      cwd: settings.legacyGateway?.workingDirectory ?? root,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        ...(settings.legacyGateway ? { POCKET_ENV_FILE: settings.legacyGateway.environmentFile } : {}),
        POCKET_PUBLIC_ORIGIN: settings.origin,
        POCKET_PYTHON: python,
        ...(enrollment ? { POCKET_RELAY_ENROLLMENT: enrollment } : {}),
        POCKET_DESKTOP_MANAGED: '1',
        POCKET_MANAGED_ADAPTERS: '1',
      },
    },
  );
  child = gateway;
  gateway.on('message', (message) => {
    if (message.type === 'desktop-status') {
      status = message.status;
      safeToRestart = message.safeToRestart === true;
    }
    const call = pending.get(message.id);
    if (call) {
      clearTimeout(call.timer);
      pending.delete(message.id);
      message.error ? call.reject(Error(message.error)) : call.resolve(message.value);
    }
  });
  let launchFailed = false;
  gateway.on('error', () => {
    if (child !== gateway) return;
    launchFailed = gateway.pid === undefined;
    status = '运行环境无法启动，请重新安装适配器';
  });
  gateway.on('close', () => {
    child = undefined;
    safeToRestart = false;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(Error('适配器已断开'));
    }
    pending.clear();
    if (!quitting && !stoppedForUpdate) {
      if (!launchFailed) status = '适配器已退出，正在重连；若已有后台服务，请先退出其中一个';
      restart = setTimeout(start, 15000);
    }
  });
}
async function stop() {
  clearTimeout(restart);
  if (!child) return;
  const current = child;
  await new Promise((resolve, reject) => {
    const closed = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      current.off('close', closed);
      reject(Error('适配器仍在退出，请稍候'));
    }, 15000);
    current.once('close', closed);
    if (current.connected) current.send({ type: 'desktop-stop' }, () => {});
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (!quitting && child) {
      event.preventDefault();
      quitting = true;
      void stop()
        .then(() => app.quit())
        .catch(() => {
          quitting = false;
          show();
        });
    } else {
      quitting = true;
      updater?.stop();
    }
  });
  app
    .whenReady()
    .then(() => {
      file = join(app.getPath('userData'), 'settings.json');
      settings = loadSettings(file);
      release = JSON.parse(readFileSync(join(__dirname, 'release.json'), 'utf8'));
      if (!settings.origin && release.origin) settings.origin = httpsOrigin(release.origin);
      // Apply the default once; respect subsequent OS startup settings as well as this switch.
      try {
        readFileSync(file);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (release.updateBaseURL) settings.updateBaseURL = updateURL(release.updateBaseURL);
        if (app.isPackaged) setAutoStart(app, settings.autoStart);
        saveSettings(file, settings);
      }
      const icon = nativeImage.createFromPath(
        join(
          process.env.POCKET_DESKTOP_PAYLOAD || join(process.resourcesPath, 'gateway'),
          'dist/web/app-icon-192.png',
        ),
      );
      tray = new Tray(icon.resize({ width: 20, height: 20 }));
      tray.setToolTip('Agent 空间适配器');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开适配器', click: show },
          { label: '退出', click: () => app.quit() },
        ]),
      );
      tray.on('click', show);
      const handle = (name, callback) =>
        ipcMain.handle(`adapter:${name}`, async (event, value) => {
          if (!window || event.sender !== window.webContents || event.senderFrame?.url !== page)
            throw Error('Invalid sender');
          return callback(value);
        });
      handle('state', () => ({
        origin: settings.origin,
        updateBaseURL: settings.updateBaseURL,
        updateFeed: resolveUpdateFeed(settings),
        autoStart: settings.autoStart,
        autoUpdate: settings.autoUpdate,
        hasEnrollment: !!settings.enrollment,
        status,
        update,
        version: app.getVersion(),
      }));
      handle('save', async (value) => {
        if (saving) throw Error('正在保存，请稍候');
        saving = true;
        try {
          if (typeof value?.autoStart !== 'boolean' || typeof value?.autoUpdate !== 'boolean')
            throw Error('设置无效');
          const next = {
            ...settings,
            origin: httpsOrigin(value.origin),
            updateBaseURL: value.updateBaseURL ? updateURL(value.updateBaseURL) : '',
            autoStart: value.autoStart,
            autoUpdate: value.autoUpdate,
          };
          if (typeof value.enrollment === 'string' && value.enrollment.trim()) {
            if (value.enrollment.length < 32 || value.enrollment.length > 512)
              throw Error('接入密钥长度应为 32–512 字符');
            if (
              !safeStorage.isEncryptionAvailable() ||
              (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
            )
              throw Error('系统密钥环不可用，请先启用系统密钥环后保存接入密钥');
            next.enrollment = safeStorage.encryptString(value.enrollment.trim()).toString('base64');
          }
          if (
            child &&
            (next.origin !== settings.origin || next.enrollment !== settings.enrollment) &&
            !safeToRestart
          )
            throw Error('手机仍在连接，请断开后再修改服务地址');
          if (app.isPackaged) setAutoStart(app, next.autoStart);
          const changed = next.origin !== settings.origin || next.enrollment !== settings.enrollment;
          const previousFeed = resolveUpdateFeed(settings);
          await updater?.setFeed(resolveUpdateFeed(next));
          try {
            saveSettings(file, next);
          } catch (e) {
            await updater?.setFeed(previousFeed);
            throw e;
          }
          settings = next;
          if (changed) {
            stoppedForUpdate = true;
            try {
              await stop();
            } finally {
              stoppedForUpdate = false;
            }
          }
          start();
          return { ok: true };
        } finally {
          saving = false;
        }
      });
      handle('pair', () => request('desktop-pair'));
      handle('check', () => updater?.check());
      handle('open', () => (settings.origin ? shell.openExternal(settings.origin) : undefined));
      if (app.isPackaged && release.updatesEnabled)
        updater = setupUpdater(require('electron-updater').autoUpdater, {
          feed: resolveUpdateFeed(settings),
          enabled: () => settings.autoUpdate,
          idle: () => safeToRestart,
          prepare: async () => {
            stoppedForUpdate = true;
            try {
              await request('desktop-prepare-update');
              await stop();
            } catch (e) {
              stoppedForUpdate = false;
              start();
              throw e;
            }
          },
          notify: (value) => {
            update = value;
          },
        });
      else update = '开发构建：尚未启用发布更新源';
      start();
      const loginLaunch = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
      if ((!process.argv.includes('--background') && !loginLaunch) || !settings.origin) show();
    })
    .catch(() => {
      app.exit(1);
    });
}
