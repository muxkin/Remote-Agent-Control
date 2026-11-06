import { spawn, execFile } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { powershell } from '../platform.js';
import type { Config } from '../config.js';

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
    const directory = join(this.platform === 'linux' ? '/tmp' : tmpdir(), 'codex-app-tools');
    return (await readdir(directory).catch(() => []))
      .filter((name) => /^[a-f0-9-]{36}\.sock$/i.test(name))
      .map((name) => join(directory, name));
  }
  async openThread(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid Codex thread');
    if (this.platform !== 'linux')
      throw Error('Open this chat in Codex first; native activation is unverified on this platform');
    const { stdout } = await promisify(execFile)('xdg-mime', ['query', 'default', 'x-scheme-handler/codex'], {
      timeout: 5000,
    });
    if (stdout.trim() !== 'chatgpt.desktop') throw Error('Unsupported Codex URL handler');
    await promisify(execFile)('xdg-open', [`codex://threads/${id}`], { timeout: 10000 });
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
