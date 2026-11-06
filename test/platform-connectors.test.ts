import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { platformRuntime, powershell } from '../src/server/platform.js';
import { codexPaths, codexProfile, discoverAppTools } from '../src/server/connectors/codex-local.js';
import { authorizeFile } from '../src/server/media.js';
import { readStorageSettings } from '../src/server/config.js';
const cleanup: (() => void)[] = [];
it.skipIf(process.platform === 'win32')(
  'discovers user-scoped and legacy app sockets without accepting other users or regular files',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pocket-discovery-'));
    const servers: ReturnType<typeof createServer>[] = [];
    cleanup.push(() => {
      servers.forEach((server) => server.close());
      rmSync(root, { recursive: true, force: true });
    });
    const expected: string[] = [];
    for (const name of ['codex-app-tools-1000', 'codex-app-tools', 'codex-app-tools-1001']) {
      const directory = join(root, name);
      mkdirSync(directory);
      const path = join(directory, `${randomUUID()}.sock`);
      const server = createServer();
      servers.push(server);
      server.listen(path);
      await once(server, 'listening');
      writeFileSync(join(directory, `${randomUUID()}.sock`), 'not a socket');
      if (name !== 'codex-app-tools-1001') expected.push(path);
    }
    expect(await discoverAppTools(root, 1000)).toEqual(expected.sort());
    expect(await discoverAppTools(join(root, 'missing'), 1000)).toEqual([]);
  },
);
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
async function fixture(executable: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-ipc-'));
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const path =
    process.platform === 'win32' ? `\\\\.\\pipe\\pocket-test-${randomUUID()}` : join(dir, 'peer.sock');
  const server = createServer((socket) => socket.on('data', (bytes) => socket.write(bytes)));
  server.listen(path);
  await once(server, 'listening');
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', [
    '-I',
    '-B',
    resolve('src/server/peer-bridge.py'),
    path,
    executable,
  ]);
  cleanup.push(() => {
    child.kill();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return child;
}
it('validates the real native Socket/Pipe peer then relays bytes', async () => {
  const child = await fixture(process.execPath);
  let stderr = '';
  child.stderr.on('data', (bytes) => (stderr += bytes));
  await expect.poll(() => stderr, { timeout: 5000 }).toContain('"ready"');
  const data = once(child.stdout, 'data');
  child.stdin.write(Buffer.from([0, 10, 255, 13, 1]));
  expect((await data)[0]).toEqual(Buffer.from([0, 10, 255, 13, 1]));
  child.stdin.end();
});
it('refuses the actual endpoint when its server executable is not the expected product', async () => {
  const child = await fixture(join(tmpdir(), 'wrong-product-executable'));
  let stderr = '';
  child.stderr.on('data', (bytes) => (stderr += bytes));
  await once(child, 'close');
  expect(stderr).toContain('"error"');
  expect(stderr).not.toContain('"ready"');
});
it('creates private storage using native permissions', () => {
  const runtime = platformRuntime(),
    dir = mkdtempSync(join(tmpdir(), 'pocket-private-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  runtime.privateDirectory(dir);
  const file = join(dir, 'secret');
  writeFileSync(file, 'fixture');
  runtime.privateFile(file);
  if (process.platform === 'win32') {
    const permissions = JSON.parse(
      powershell(
        `$acl=Get-Acl -LiteralPath $env:POCKET_PRIVATE_PATH
@{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
protected=$acl.AreAccessRulesProtected;
identities=@($acl.Access | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress`,
        { ...process.env, POCKET_PRIVATE_PATH: file },
      ),
    );
    expect(permissions.owner).toBe(permissions.user);
    expect(permissions.protected).toBe(true);
    expect(new Set(permissions.identities)).toEqual(new Set(['S-1-5-18', permissions.user]));
  } else {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
});
it('keeps build verification separate from controls and platform support', () => {
  expect(codexProfile('win32', 'unknown').controls).toBe(true);
  expect(codexProfile('win32', 'unknown').verified).toBe(false);
  expect(codexProfile('linux', null).nativeOpen).toBe(true);
  expect(codexProfile('darwin', '26.1029.61003').experimental).toBe(true);
  expect(codexPaths('linux', '/home/test/.codex').socketPath).toBe(
    join('/home/test/.codex', 'ipc', 'ipc.sock'),
  );
});
it('accepts native drive/space paths and file URLs without treating them as remote schemes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-path-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'attachment with spaces.txt');
  writeFileSync(file, 'fixture');
  const url = pathToFileURL(file).href;
  expect(
    await authorizeFile(url, directory, [{ id: 'message', role: 'assistant', text: `[file](${url})` }]),
  ).toBe(realpathSync.native(file));
  const previous = process.env.POCKET_MEDIA_ADAPTER;
  try {
    process.env.POCKET_MEDIA_ADAPTER = join(directory, 'adapter with spaces.mjs');
    expect(readStorageSettings('media')?.adapterPath).toBe(join(directory, 'adapter with spaces.mjs'));
  } finally {
    if (previous === undefined) delete process.env.POCKET_MEDIA_ADAPTER;
    else process.env.POCKET_MEDIA_ADAPTER = previous;
  }
});
