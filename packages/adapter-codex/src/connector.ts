import { spawn, execFile, type ExecFileException } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parseEnv, promisify } from 'node:util';
import { powershell } from '../../../src/server/platform.js';
import { DeliveryError } from '../../../src/server/delivery-error.js';
import type { CodexConfig as Config } from './config.js';

/** Product protocols see a byte channel, never a Python subprocess. */
export interface VerifiedPipe {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  kill(): void;
}
export interface CodexConnector {
  version(root: string): Promise<string | null>;
  pipe(config: Config, socket: string, appTools?: boolean): VerifiedPipe;
  appTools(config: Config): Promise<string[]>;
  openThread(id: string): Promise<void>;
}
/** Candidate discovery only; every connection still passes native peer validation. */
export async function discoverAppTools(root: string, uid?: number): Promise<string[]> {
  const directories = [
    ...(uid === undefined ? [] : [join(root, `codex-app-tools-${uid}`)]),
    join(root, 'codex-app-tools'),
  ];
  const entries = await Promise.all(
    directories.map(async (directory) =>
      (
        await readdir(directory, { withFileTypes: true }).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        })
      )
        .filter((entry) => entry.isSocket() && /^[a-f0-9-]{36}\.sock$/i.test(entry.name))
        .map((entry) => join(directory, entry.name)),
    ),
  );
  return [...new Set(entries.flat())].sort();
}
export function codexPaths(platform: string, home: string) {
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Codex.app',
          '/Applications/ChatGPT.app',
          join(homedir(), 'Applications', 'Codex.app'),
        ].filter(existsSync)
      : [];
  if (!process.env.POCKET_CODEX_ROOT && candidates.length > 1)
    throw Error('Multiple Codex installations; set POCKET_CODEX_ROOT');
  let root =
    process.env.POCKET_CODEX_ROOT ??
    (platform === 'linux'
      ? '/usr/lib/chatgpt'
      : platform === 'darwin'
        ? (candidates[0] ?? '/Applications/Codex.app')
        : '');
  if (platform === 'win32' && !root) {
    const paths = powershell(
      '@(Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue | ForEach-Object {$_.Path} | Where-Object {$_} | Select-Object -Unique) | ConvertTo-Json -Compress',
    );
    const parsed = paths ? JSON.parse(paths) : [],
      entries = typeof parsed === 'string' ? [parsed] : parsed;
    if (entries.length > 1)
      throw Error('Multiple Codex executables; set POCKET_CODEX_ROOT and POCKET_CODEX_EXECUTABLE');
    root = entries[0]
      ? dirname(entries[0])
      : join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'Codex');
    if (entries[0] && !process.env.POCKET_CODEX_EXECUTABLE) process.env.POCKET_CODEX_EXECUTABLE = entries[0];
  }
  return {
    desktopRoot: root,
    socketPath:
      process.env.POCKET_CODEX_SOCKET ??
      (platform === 'win32' ? '\\\\.\\pipe\\codex-ipc' : join(home, 'ipc', 'ipc.sock')),
  };
}
async function linuxDesktopEnvironment(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return env;
  // User services can start before the graphical login exports its environment.
  try {
    const { stdout } = await promisify(execFile)(
      'systemctl',
      ['--user', '--output=json', 'show-environment'],
      {
        env,
        timeout: 2000,
      },
    );
    // Older systemd versions report shell-style assignments even with JSON output selected.
    const current = stdout.trimStart().startsWith('{') ? JSON.parse(stdout) : parseEnv(stdout);
    for (const key of [
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XAUTHORITY',
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_CURRENT_DESKTOP',
      'KDE_FULL_SESSION',
      'KDE_SESSION_VERSION',
    ]) {
      if (typeof current?.[key] === 'string' && current[key]) env[key] = current[key];
    }
  } catch {
    // The graphical environment may still be starting, or systemd may be unavailable.
  }
  return env;
}
export class LocalCodexConnector implements CodexConnector {
  constructor(private platform: string = process.platform) {}
  private executable(root: string) {
    if (process.env.POCKET_CODEX_EXECUTABLE) return process.env.POCKET_CODEX_EXECUTABLE;
    const candidates =
      this.platform === 'darwin'
        ? [join(root, 'Contents', 'MacOS', 'Codex'), join(root, 'Contents', 'MacOS', 'ChatGPT')]
        : this.platform === 'win32'
          ? [join(root, 'Codex.exe'), join(root, 'ChatGPT.exe')]
          : [join(root, 'ChatGPT')];
    const found = candidates.filter(existsSync);
    if (found.length > 1) throw Error('Ambiguous Codex executable; set POCKET_CODEX_EXECUTABLE');
    return found[0] ?? candidates[0];
  }
  async version(root: string) {
    if (this.platform === 'linux') {
      const meta = JSON.parse(await readFile(join(root, 'resources', 'linux-package-metadata.json'), 'utf8'));
      return typeof meta.version === 'string' ? meta.version : null;
    }
    if (this.platform === 'darwin') {
      const r = await promisify(execFile)(process.env.POCKET_PYTHON ?? 'python3', [
        '-I',
        '-c',
        'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); print(p.get("CFBundleShortVersionString",p.get("CFBundleVersion","")))',
        join(root, 'Contents', 'Info.plist'),
      ]);
      return r.stdout.trim() || null;
    }
    return (
      powershell('(Get-Item -LiteralPath $env:POCKET_VERSION_FILE).VersionInfo.ProductVersion', {
        ...process.env,
        POCKET_VERSION_FILE: this.executable(root),
      }) || null
    );
  }
  pipe(config: Config, socket: string, appTools = false): VerifiedPipe {
    const child = spawn(
      process.env.POCKET_PYTHON ?? (this.platform === 'win32' ? 'python' : 'python3'),
      [
        '-I',
        '-B',
        config.bridgePath,
        socket,
        this.executable(config.desktopRoot),
        ...(appTools ? ['--app-tools'] : []),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child),
      kill: () => {
        child.kill();
      },
    };
  }
  async appTools(_config: Config) {
    if (process.env.POCKET_CODEX_APP_TOOLS) return [process.env.POCKET_CODEX_APP_TOOLS];
    if (this.platform === 'win32') return [];
    return discoverAppTools(this.platform === 'linux' ? '/tmp' : tmpdir(), process.getuid?.());
  }
  async openThread(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new DeliveryError('无效的 Codex 会话标识', true);
    if (this.platform !== 'linux')
      throw new DeliveryError('桌面导航接口暂不可用，请在电脑上的 Codex 打开此会话', true);
    const env = await linuxDesktopEnvironment();
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY)
      throw new DeliveryError('未找到本机图形会话，请登录电脑并打开 Codex 后重试', true);
    const { stdout } = await promisify(execFile)('xdg-mime', ['query', 'default', 'x-scheme-handler/codex'], {
      env,
      timeout: 5000,
    }).catch(() => {
      throw new DeliveryError('无法查询本机 Codex 链接处理程序，请在电脑上打开此会话', true);
    });
    if (stdout.trim() !== 'chatgpt.desktop')
      throw new DeliveryError('本机未将 Codex 链接关联到桌面应用，请在电脑上打开此会话', true);
    try {
      await promisify(execFile)('xdg-open', [`codex://threads/${id}`], { env, timeout: 10000 });
    } catch (error) {
      if ((error as ExecFileException).killed) throw new DeliveryError('打开桌面链接超时，结果待确认');
      throw new DeliveryError('本机未能打开 Codex 链接，请在电脑上打开此会话', true);
    }
  }
}
export const connectorFor = (config: Config) => config.codexConnector ?? new LocalCodexConnector();
export function codexProfile(platform: string, version: string | null) {
  const supportedPlatform = ['linux', 'darwin', 'win32'].includes(platform);
  return {
    id: `codex/${platform}/${version ?? 'unknown'}/follower-v1`,
    // A product build is diagnostic metadata, not a negotiated protocol version.
    verified: supportedPlatform && version === '26.1029.61003',
    controls: supportedPlatform,
    experimental: platform !== 'linux',
    nativeOpen: platform === 'linux',
  };
}
