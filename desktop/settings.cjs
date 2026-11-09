const { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } = require('node:fs');
const { join, dirname, isAbsolute } = require('node:path');
function httpsOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error('请输入 HTTPS 服务地址，例如 https://agent.example.com');
  return url.origin;
}
function updateURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /(^|\.)(github\.com|githubusercontent\.com|githubassets\.com)$/.test(url.hostname)
  )
    throw Error('更新源必须是自有 HTTPS 服务');
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}
// An empty override follows the configured service, regardless of its hosting runtime.
function resolveUpdateFeed(settings, platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch))
    throw Error('此平台尚不支持自动更新');
  const base = settings.updateBaseURL
    ? updateURL(settings.updateBaseURL)
    : settings.origin
      ? `${httpsOrigin(settings.origin)}/downloads/desktop/`
      : '';
  return base ? updateURL(`${base}${platform}/${arch}/`) : '';
}
function loadSettings(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    const legacy = v.legacyGateway;
    if (
      legacy !== undefined &&
      ![legacy?.environmentFile, legacy?.workingDirectory].every(
        (path) => typeof path === 'string' && !path.includes('\0') && isAbsolute(path),
      )
    )
      throw Error('Invalid legacy gateway paths');
    return {
      autoStart: v.autoStart !== false,
      autoUpdate: v.autoUpdate !== false,
      origin: v.origin ? httpsOrigin(v.origin) : '',
      updateBaseURL: v.updateBaseURL ? updateURL(v.updateBaseURL) : '',
      ...(typeof v.enrollment === 'string' ? { enrollment: v.enrollment } : {}),
      ...(legacy
        ? {
            legacyGateway: {
              environmentFile: legacy.environmentFile,
              workingDirectory: legacy.workingDirectory,
            },
          }
        : {}),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { autoStart: true, autoUpdate: true, origin: '', updateBaseURL: '' };
    throw Error('设置文件无法读取；请保留原文件后修复');
  }
}
function saveSettings(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}
function desktopEntry(executable) {
  if (/[\r\n\x00]/.test(executable)) throw Error('Invalid executable path');
  const escaped = executable.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&');
  return `[Desktop Entry]\nType=Application\nName=Agent 空间适配器\nExec="${escaped}" --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
}
function setAutoStart(app, enabled, platform = process.platform, env = process.env) {
  if (platform === 'linux') {
    // An AppImage's mount path is temporary; always use the persistent AppImage file.
    const executable = env.APPIMAGE || app.getPath('exe');
    const file = join(
      env.XDG_CONFIG_HOME || join(app.getPath('home'), '.config'),
      'autostart',
      'agent-space.desktop',
    );
    if (enabled) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, desktopEntry(executable), { mode: 0o600 });
    } else rmSync(file, { force: true });
  } else app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe'), args: ['--background'] });
}
module.exports = {
  httpsOrigin,
  updateURL,
  resolveUpdateFeed,
  loadSettings,
  saveSettings,
  desktopEntry,
  setAutoStart,
};
