import { cp, mkdir, readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
for (const file of ['dist/server/main.js', 'dist/web/index.html', 'dist/adapters/SHA256SUMS'])
  if (!existsSync(file)) throw Error(`Build the application first: missing ${file}`);
await remove(target);
await mkdir(target, { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
delete manifest.devDependencies;
delete manifest.workspaces;
delete manifest.scripts;
const used = new Set();
async function imports(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await imports(path);
    else if (entry.name.endsWith('.js')) {
      const code = await readFile(path, 'utf8');
      for (const match of code.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])([^'"\n]+)\1/g)) {
        const id = match[2];
        if (id.startsWith('.') || id.startsWith('node:')) continue;
        used.add(id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]);
      }
    }
  }
}
await imports('dist/server');
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
for (const path of ['dist/server', 'dist/web', 'dist/adapters'])
  await cp(join(source, path), join(target, path), { recursive: true });
await mkdir(join(target, 'scripts'), { recursive: true });
await cp('scripts/env.mjs', join(target, 'scripts/env.mjs'));
for (const name of ['sdk', 'codex', 'dsh']) {
  const path = `packages/adapter-${name}`;
  await mkdir(join(target, path), { recursive: true });
  for (const file of ['package.json', 'README.md', 'dist'])
    await cp(join(source, path, file), join(target, path, file), { recursive: true });
}
await mkdir(join(target, 'runtime'), { recursive: true });
await cp(
  await realpath(process.execPath),
  join(target, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
);
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
