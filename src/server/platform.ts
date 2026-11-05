import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';

/** OS facilities only. Desktop's wire protocol remains in DesktopBackend. */
export interface PlatformRuntime {
  readonly id: string;
  desktopPaths(codexHome: string): { desktopRoot: string; socketPath: string };
  privateDirectory(path: string): void;
  privateFile(path: string): void;
  desktopVersion(root: string): Promise<string | null>;
  verifiedPipe(
    bridge: string,
    socket: string,
    desktopRoot: string,
    appTools?: boolean,
  ): ChildProcessWithoutNullStreams;
  appToolsDirectory(): string;
  openFile(path: string): Promise<void>;
  openThread(id: string): Promise<void>;
}
export class LinuxRuntime implements PlatformRuntime {
  readonly id = 'linux';
  desktopPaths(codexHome: string) {
    return { desktopRoot: '/usr/lib/chatgpt', socketPath: `${codexHome}/ipc/ipc.sock` };
  }
  privateDirectory(path: string) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.uid !== process.getuid?.()) throw Error('Unsafe state directory');
    chmodSync(path, 0o700);
  }
  privateFile(path: string) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.uid !== process.getuid?.()) throw Error('Unsafe private file');
    chmodSync(path, 0o600);
  }
  async desktopVersion(root: string) {
    const meta = JSON.parse(await readFile(`${root}/resources/linux-package-metadata.json`, 'utf8'));
    return typeof meta.version === 'string' ? meta.version : null;
  }
  verifiedPipe(bridge: string, socket: string, desktopRoot: string, appTools = false) {
    return spawn(
      'python3',
      ['-I', '-B', bridge, socket, `${desktopRoot}/ChatGPT`, ...(appTools ? ['--app-tools'] : [])],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }
  appToolsDirectory() {
    return '/tmp/codex-app-tools';
  }
  async openFile(path: string) {
    await promisify(execFile)('xdg-open', [path], { timeout: 5000 });
  }
  async openThread(id: string) {
    const { stdout } = await promisify(execFile)('xdg-mime', ['query', 'default', 'x-scheme-handler/codex'], {
      timeout: 5000,
    });
    if (stdout.trim() !== 'chatgpt.desktop') throw Error('Unsupported desktop URL handler');
    await promisify(execFile)('xdg-open', [`codex://threads/${id}`], { timeout: 10000 });
  }
}
export function platformRuntime(): PlatformRuntime {
  if (process.platform !== 'linux') throw Error('This desktop platform has not been verified yet');
  return new LinuxRuntime();
}
