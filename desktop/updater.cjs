const { updateURL } = require('./settings.cjs');
function sameOriginFiles(info, feed) {
  const origin = new URL(feed).origin;
  return (
    Array.isArray(info.files) &&
    info.files.length > 0 &&
    info.files.every((file) => {
      try {
        const url = new URL(file.url, feed);
        return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password;
      } catch {
        return false;
      }
    })
  );
}
function setupUpdater(updater, { feed, enabled, idle, prepare, notify }) {
  feed = feed ? updateURL(feed) : '';
  if (feed) updater.setFeedURL({ provider: 'generic', url: feed });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  let downloaded = false,
    installing = false,
    active = true,
    switching = false;
  let generation = 0,
    task,
    cancellation;
  const onError = () => {
    if (active && !switching) notify('更新暂不可用，将在后台重试');
  };
  updater.on('error', onError);
  const check = async () => {
    if (!active || switching || !feed || !enabled() || task || downloaded || installing) return;
    const current = generation;
    task = (async () => {
      try {
        const result = await updater.checkForUpdates();
        if (!active || switching || current !== generation || !enabled() || !result) return;
        if (!result.isUpdateAvailable) {
          notify('已是最新版本');
          return;
        }
        if (!sameOriginFiles(result.updateInfo, feed)) {
          notify('更新包来源与配置不一致，已停止下载');
          return;
        }
        cancellation = result.cancellationToken;
        notify('正在后台下载更新');
        await updater.downloadUpdate(cancellation);
        if (active && !switching && current === generation) {
          downloaded = true;
          notify('更新已下载，等待连接空闲后安装');
        }
      } catch {
        if (active && !switching && current === generation) notify('检查或下载更新失败，将在后台重试');
      } finally {
        cancellation = undefined;
      }
    })();
    try {
      await task;
    } finally {
      task = undefined;
    }
  };
  const install = async () => {
    if (!active || switching || !enabled() || !downloaded || installing || !idle()) return;
    installing = true;
    try {
      await prepare();
      updater.quitAndInstall(true, true);
    } catch {
      installing = false;
      notify('等待适配器安全退出后重试更新');
    }
  };
  const timer = setInterval(check, 4 * 60 * 60 * 1000);
  const idleTimer = setInterval(install, 30000);
  const first = setTimeout(check, 15000);
  return {
    check,
    install,
    async setFeed(value) {
      const next = value ? updateURL(value) : '';
      if (next === feed) return;
      if (installing || switching) throw Error('更新正在切换或安装，请稍后再修改更新源');
      switching = true;
      generation++;
      downloaded = false;
      cancellation?.cancel();
      try {
        // Drain the old request before changing the provider; its result must never install.
        await task;
        if (next) updater.setFeedURL({ provider: 'generic', url: next });
        feed = next;
        notify(next ? '更新源已切换，等待后台检查' : '填写服务地址后启用更新');
      } finally {
        switching = false;
      }
    },
    stop() {
      active = false;
      generation++;
      downloaded = false;
      cancellation?.cancel();
      clearInterval(timer);
      clearInterval(idleTimer);
      clearTimeout(first);
      void Promise.resolve(task).finally(() => updater.off('error', onError));
    },
  };
}
module.exports = { setupUpdater, sameOriginFiles };
