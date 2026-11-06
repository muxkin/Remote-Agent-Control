import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { adapterDirectory, loadCatalog, saveCatalog, catalogLock, packageKey } from './catalog.js';
import { hostEnvironment, readAdapterPackage } from './package.js';
import { hostLaunch } from './proxy.js';
export async function validatePackage(directory: string) {
  readAdapterPackage(directory);
  const launch = hostLaunch();
  await new Promise<void>((resolve, reject) => {
    const child = fork(launch.path, [directory, '--check'], {
      execArgv: launch.execArgv,
      env: hostEnvironment(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    });
    let valid = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('Adapter import check timed out'));
    }, 20000);
    child.on('message', (message: any) => {
      if (message?.type === 'validated' && message.sdk === 1) valid = true;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      valid && code === 0 ? resolve() : reject(Error('Adapter factory or dependency check failed'));
    });
  });
}
export async function installAdapter(config: Config, spec: string) {
  const local = /\.(?:tgz|tar\.gz)$/.test(spec) && existsSync(resolve(spec));
  if (!local && !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(spec))
    throw Error('Use an exact npm version (name@1.2.3) or a local release .tgz');
  const directory = adapterDirectory(config);
  loadCatalog(config);
  const stage = await mkdtemp(join(directory, 'stage-'));
  try {
    const npm =
      process.env.npm_execpath ??
      [
        join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
        '/usr/share/nodejs/npm/bin/npm-cli.js',
      ].find(existsSync);
    if (!npm) throw Error('npm CLI not found; run through npm run adapter');
    await promisify(execFile)(
      process.execPath,
      [
        npm,
        'install',
        '--prefix',
        stage,
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        '--',
        local ? resolve(spec) : spec,
      ],
      { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const installed = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')).dependencies;
    const names = Object.keys(installed ?? {});
    if (names.length !== 1) throw Error('Expected exactly one adapter package');
    const root = join(stage, 'node_modules', names[0]);
    const pack = readAdapterPackage(root);
    await validatePackage(root);
    const key = packageKey(pack);
    await catalogLock(config, async () => {
      const catalog = loadCatalog(config);
      if (catalog.packages[key]) throw Error(`${key} is already installed; published versions are immutable`);
      const destination = join(directory, 'packages', randomUUID());
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rename(stage, destination);
      const finalRoot = join(destination, 'node_modules', pack.name);
      catalog.packages[key] = {
        root: finalRoot,
        name: pack.name,
        version: pack.version,
        stateVersion: pack.agentAdapter.stateVersion,
      };
      saveCatalog(config, catalog);
    });
    return key;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
