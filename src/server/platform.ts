import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** OS facilities only. Product paths and protocols belong to their connectors. */
export interface PlatformRuntime {
  readonly id: string;
  stateDirectory(): string;
  privateDirectory(path: string): void;
  privateFile(path: string): void;
  openFile(path: string): Promise<void>;
}
export class LinuxRuntime implements PlatformRuntime {
  readonly id: string = 'linux';
  stateDirectory() {
    return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'codex-pocket-remote');
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
  async openFile(path: string) {
    await promisify(execFile)('xdg-open', [path], { timeout: 5000 });
  }
}
export class MacRuntime extends LinuxRuntime {
  readonly id = 'darwin';
  stateDirectory() {
    return join(homedir(), 'Library', 'Application Support', 'codex-pocket-remote');
  }
  async openFile(path: string) {
    await promisify(execFile)('open', [path], { timeout: 5000 });
  }
}
export function powershell(script: string, env: NodeJS.ProcessEnv = process.env) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', env, timeout: 10000, windowsHide: true },
  ).trim();
}
export class WindowsRuntime implements PlatformRuntime {
  readonly id = 'win32';
  stateDirectory() {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'codex-pocket-remote');
  }
  privateDirectory(path: string) {
    mkdirSync(path, { recursive: true });
    this.privateFile(path);
  }
  privateFile(path: string) {
    if (lstatSync(path).isSymbolicLink()) throw Error('Unsafe private path');
    powershell(
      `$ErrorActionPreference='Stop'
$p=$env:POCKET_PRIVATE_PATH
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $p
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {throw 'Unexpected private path owner'}
$acl.SetAccessRuleProtection($true,$false)
foreach($r in @($acl.Access)) {$acl.RemoveAccessRuleSpecific($r)}
$inherit=if(Test-Path -LiteralPath $p -PathType Container){'ContainerInherit,ObjectInherit'}else{'None'}
foreach($id in @($sid,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl',$inherit,'None','Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $p -AclObject $acl`,
      { ...process.env, POCKET_PRIVATE_PATH: path },
    );
  }
  async openFile(path: string) {
    powershell("$ErrorActionPreference='Stop'; Start-Process -FilePath $env:POCKET_OPEN_PATH", {
      ...process.env,
      POCKET_OPEN_PATH: path,
    });
  }
}
export function platformRuntime(): PlatformRuntime {
  if (process.platform === 'linux') return new LinuxRuntime();
  if (process.platform === 'darwin') return new MacRuntime();
  if (process.platform === 'win32') return new WindowsRuntime();
  throw Error(`Unsupported operating system: ${process.platform}`);
}
