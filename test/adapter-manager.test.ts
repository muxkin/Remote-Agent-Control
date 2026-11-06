import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AdapterManager } from '../src/server/adapters/manager.js';
import { adapterDirectory, loadCatalog, saveCatalog, writeJson } from '../src/server/adapters/catalog.js';
import { fixtureConfig } from './helpers.js';
import { readInstances } from '../src/server/adapters/config.js';
const clean: (() => void)[] = [];
afterEach(() =>
  clean
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
it('applies per-instance upgrades and rollback through the supervisor while an incompatible instance stays isolated', async () => {
  const config = fixtureConfig(),
    root = config.desktopRoot;
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const catalog = loadCatalog(config),
    fixture = JSON.parse(readFileSync('test/fixtures/adapter/package.json', 'utf8'));
  for (const version of ['1.0.0', '1.1.0']) {
    const directory = join(root, version);
    mkdirSync(directory);
    cpSync('test/fixtures/adapter/index.mjs', join(directory, 'index.mjs'));
    writeJson(join(directory, 'package.json'), { ...fixture, version });
    catalog.packages[`test-adapter@${version}`] = {
      root: directory,
      name: 'test-adapter',
      version,
      stateVersion: 1,
    };
  }
  saveCatalog(config, catalog);
  config.instances = [
    { id: 'one', name: 'One', plugin: 'test-adapter', version: '1.0.0', config: {} },
    { id: 'two', name: 'Two', plugin: 'test-adapter', version: '1.0.0', config: {} },
    { id: 'missing', name: 'Missing', plugin: 'missing-adapter', version: '1.0.0', config: {} },
  ];
  const manager = new AdapterManager(config);
  clean.push(() => manager.stop());
  await manager.start();
  expect(manager.get('missing').status().connected).toBe(false);
  expect(manager.get('one').status().connected).toBe(true);
  const two = (manager.get('two') as any).pid;
  async function change(target: string) {
    const name = `${randomUUID()}.json`;
    writeJson(join(adapterDirectory(config), 'requests', name), { instanceId: 'one', target });
    await expect
      .poll(
        () => {
          try {
            return JSON.parse(readFileSync(join(adapterDirectory(config), 'results', name), 'utf8'));
          } catch {
            return null;
          }
        },
        { timeout: 20000 },
      )
      .toMatchObject({ ok: true });
  }
  await change('test-adapter@1.1.0');
  expect(loadCatalog(config).instances.one).toEqual({
    current: 'test-adapter@1.1.0',
    previous: 'test-adapter@1.0.0',
  });
  await change('test-adapter@1.0.0');
  expect((manager.get('two') as any).pid).toBe(two);
  const status = readFileSync(join(adapterDirectory(config), 'status.json'), 'utf8');
  expect(status).not.toContain('config');
}, 60000);
it('maps legacy and generic instance configuration without exporting other credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'adapter-config-'));
  clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const previous = { ...process.env };
  clean.push(() => {
    for (const k of Object.keys(process.env)) if (!(k in previous)) delete process.env[k];
    Object.assign(process.env, previous);
  });
  process.env.POCKET_ADAPTERS_FILE = join(directory, 'instances.json');
  process.env.TEST_DSH_SECRET = 'private-fixture';
  process.env.TEST_THIRD_SECRET = 'different-fixture';
  writeFileSync(
    process.env.POCKET_ADAPTERS_FILE,
    JSON.stringify([
      {
        id: 'dsh-old',
        name: 'Old',
        type: 'dsh',
        url: 'http://127.0.0.1:3080',
        tokenEnv: 'TEST_DSH_SECRET',
        version: 'next',
      },
      {
        id: 'third',
        name: 'Third',
        plugin: 'test-adapter',
        version: '1.0.0',
        config: { endpoint: 'http://127.0.0.1:9000' },
        secrets: { token: 'TEST_THIRD_SECRET' },
      },
    ]),
  );
  const instances = readInstances();
  expect(instances.map((i) => i.id)).toEqual(['codex-local', 'dsh-old', 'third']);
  expect(instances[1].config.token).toBe('private-fixture');
  expect(instances[2].config.token).toBe('different-fixture');
  expect(JSON.stringify(instances[2].config)).not.toContain('private-fixture');
});
