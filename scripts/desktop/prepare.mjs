import { cp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import Arborist from '@npmcli/arborist';
import { manual as remove } from 'rimraf';

// Build on the destination OS/architecture. Never distribute developer files or credentials.
const source = resolve('.'),
  target = resolve('dist/desktop-payload');
const python = process.env.POCKET_DESKTOP_PYTHON;
if (!python)
  throw Error(
    'Set POCKET_DESKTOP_PYTHON to a relocatable CPython runtime directory (bin/python3 or python.exe).',
  );
const executable = join(python, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
if (!existsSync(executable)) throw Error('Python runtime is missing');
execFileSync(executable, [
  '-I',
  '-c',
  'import socket,struct,json,ctypes,plistlib; assert __import__("sys").version_info >= (3,11)',
]);
// The gateway does not serve HTTP or web pages. Only package its entry and the adapter
// host it launches, plus the one branded asset used by the desktop manager.
const entries = ['dist/server/main.js', 'dist/server/adapters/host.js', 'dist/server/adapters/cli.js'];
const resources = [...entries, 'dist/web/app-icon-192.png'];
for (const file of [...resources, 'dist/server/build-meta.json', 'dist/adapters/SHA256SUMS'])
  if (!existsSync(file)) throw Error(`Build the application first: missing ${file}`);
const { outputs } = JSON.parse(await readFile('dist/server/build-meta.json', 'utf8'));
const builtEntries = new Map(
  Object.entries(outputs).map(([path, metadata]) => [path.replaceAll('\\', '/'), metadata]),
);
await remove(target);
await mkdir(target, { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
delete manifest.devDependencies;
delete manifest.workspaces;
delete manifest.scripts;
const used = new Set();
for (const entry of entries) {
  const imports = builtEntries.get(entry)?.imports;
  if (!imports) throw Error(`No dependency metadata for desktop entry ${entry}`);
  for (const { path, external } of imports) {
    if (isBuiltin(path)) continue;
    const name = path
      .split('/')
      .slice(0, path.startsWith('@') ? 2 : 1)
      .join('/');
    if (!external || !Object.hasOwn(manifest.dependencies, name))
      throw Error(`Desktop entry ${entry} has an undeclared dependency: ${path}`);
    used.add(name);
  }
}
manifest.dependencies = Object.fromEntries(
  Object.entries(manifest.dependencies).filter(([name]) => used.has(name)),
);
await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2));
await cp('package-lock.json', join(target, 'package-lock.json'));
await new Arborist({
  path: target,
  ignoreScripts: true,
  omit: ['dev'],
  audit: false,
  workspacesEnabled: false,
  packageLock: true,
}).reify();
for (const path of resources) {
  await mkdir(join(target, dirname(path)), { recursive: true });
  await cp(join(source, path), join(target, path));
}
await cp(join(source, 'dist/adapters'), join(target, 'dist/adapters'), { recursive: true });
await mkdir(join(target, 'scripts'), { recursive: true });
for (const file of ['env.mjs', 'native-manager.mjs', 'native-update.mjs', 'native-update-apply.mjs']) {
  await cp(join('scripts', file === 'env.mjs' ? '' : 'desktop', file), join(target, 'scripts', file));
}
for (const name of ['sdk', 'codex', 'dsh']) {
  const path = `packages/adapter-${name}`;
  await mkdir(join(target, path), { recursive: true });
  for (const file of ['package.json', 'README.md', 'dist'])
    await cp(join(source, path, file), join(target, path, file), { recursive: true });
}
await mkdir(join(target, 'runtime'), { recursive: true });
const node = await realpath(process.execPath);
await cp(
  node,
  join(target, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
);
for (const license of [join(dirname(node), 'LICENSE'), join(dirname(node), '../LICENSE')]) {
  if (!existsSync(license)) continue;
  await cp(license, join(target, 'runtime/LICENSE'));
  break;
}
await cp(resolve(python), join(target, 'python'), {
  recursive: true,
  verbatimSymlinks: true,
  filter: (path) => !/(?:^|[\\/])(?:__pycache__|site-packages|include)(?:[\\/]|$)/.test(path),
});
const bundledPython = join(target, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
execFileSync(
  bundledPython,
  ['-I', '-c', 'import socket,struct,json,ctypes,plistlib; print("Bundled Python ready")'],
  { stdio: 'inherit' },
);
execFileSync(
  join(target, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  [
    '--input-type=module',
    '-e',
    'import { DatabaseSync } from "node:sqlite"; import {createZstdDecompress} from "node:zlib"; new DatabaseSync(":memory:").close(); createZstdDecompress(); console.log("Bundled Node ready")',
  ],
  { stdio: 'inherit' },
);
await cp('LICENSE', join(target, 'LICENSE'));
console.log(`Prepared ${process.platform}/${process.arch}: ${target}`);
