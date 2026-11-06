import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import type { Config } from '../config.js';
import { BackendRegistry } from '../backends/registry.js';
import { AdapterProxy } from './proxy.js';
import { readAdapterPackage, type AdapterPackage } from './package.js';
import { adapterDirectory, loadCatalog, saveCatalog, catalogLock, writeJson } from './catalog.js';
import { platformRuntime } from '../platform.js';
export class AdapterManager extends BackendRegistry {
  private timer?: NodeJS.Timeout;
  private applying = false;
  private closed = false;
  private supervisorLock?: string;
  private initialBindings: ReturnType<typeof loadCatalog>['instances'] = {};
  constructor(
    private config: Config,
    private supervise = true,
  ) {
    super();
    const catalog = loadCatalog(config);
    for (const instance of config.instances ?? []) {
      const binding = catalog.instances[instance.id] ?? { current: `${instance.plugin}@${instance.version}` };
      const installed = catalog.packages[binding.current];

      const stateDirectory = join(config.stateDir, 'backends', instance.id);
      platformRuntime().privateDirectory(stateDirectory);
      let pack: AdapterPackage, issue: string | undefined;
      try {
        if (!installed) throw Error(`插件 ${binding.current} 尚未安装`);
        pack = readAdapterPackage(installed.root);
        if (`${pack.name}@${pack.version}` !== binding.current)
          throw Error('已安装插件的版本标识发生变化，请恢复对应发布包');
      } catch (error) {
        issue = (error as Error).message;
        pack = {
          name: instance.plugin,
          version: instance.version,
          type: 'module',
          root: '',
          entry: '',
          agentAdapter: {
            sdk: 1,
            entry: '',
            stateVersion: 1,
            product: instance.plugin,
            name: instance.name,
            presentation: {
              creation: { empty: false, permission: 'native', preset: false, plan: false },
              plan: 'none',
              fileReferences: false,
              exportLog: false,
              nativeCommands: false,
            },
          },
        };
      }
      this.register(
        new AdapterProxy(
          pack,
          {
            id: instance.id,
            name: instance.name,
            stateDirectory,
            config: instance.config,
            readOnly: config.readOnly,
          },
          undefined,
          issue,
        ),
      );
      catalog.instances[instance.id] = binding;
    }
    this.initialBindings = catalog.instances;
    for (const name of ['requests', 'results'])
      platformRuntime().privateDirectory(join(adapterDirectory(config), name));
  }
  override async start() {
    if (this.supervise)
      await catalogLock(this.config, () => {
        const path = join(adapterDirectory(this.config), 'supervisor.json');
        if (existsSync(path)) {
          const owner = JSON.parse(readFileSync(path, 'utf8')).pid;
          let alive = false;
          try {
            process.kill(owner, 0);
            alive = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          if (alive) throw Error('An adapter supervisor is already running');
        }
        const catalog = loadCatalog(this.config);
        for (const [id, binding] of Object.entries(this.initialBindings)) catalog.instances[id] ??= binding;
        saveCatalog(this.config, catalog);
        writeJson(path, { pid: process.pid });
        this.supervisorLock = path;
      });
    await super.start();
    if (!this.supervise) return;
    this.writeStatus();
    this.timer = setInterval(() => {
      this.writeStatus();
      void this.applyRequests();
    }, 1000);
    this.timer.unref();
  }
  override stop() {
    this.closed = true;
    clearInterval(this.timer);
    super.stop();
    if (this.supervisorLock) {
      try {
        unlinkSync(this.supervisorLock);
      } catch {}
      this.supervisorLock = undefined;
    }
  }
  private writeStatus() {
    writeJson(join(adapterDirectory(this.config), 'status.json'), {
      updatedAt: Date.now(),
      pid: process.pid,
      instances: this.all().map((raw) => {
        const p = raw as AdapterProxy;
        return {
          id: p.id,
          plugin: p.packageInfo.name,
          version: p.packageInfo.version,
          pid: p.pid,
          connected: p.status().connected,
          reason: p.status().reason,
          activeWrites: p.activeWrites,
        };
      }),
    });
  }
  private async applyRequests() {
    if (this.applying || this.closed) return;
    this.applying = true;
    try {
      const directory = adapterDirectory(this.config);
      for (const name of readdirSync(join(directory, 'requests'))
        .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))
        .sort()) {
        if (this.closed) break;
        const result = join(directory, 'results', name);
        if (existsSync(result)) continue;
        try {
          const { instanceId, target } = JSON.parse(readFileSync(join(directory, 'requests', name), 'utf8'));
          const proxy = this.get(instanceId) as AdapterProxy,
            catalog = loadCatalog(this.config),
            installed = catalog.packages[target];
          if (!installed) throw Error('Requested plugin package is not installed');
          const next = readAdapterPackage(installed.root);
          if (`${next.name}@${next.version}` !== target) throw Error('Installed package identity changed');
          if (catalog.instances[instanceId]?.current !== target) {
            await proxy.replace(next);
            await catalogLock(this.config, () => {
              const current = loadCatalog(this.config),
                old = current.instances[instanceId];
              current.instances[instanceId] = { current: target, previous: old?.current };
              saveCatalog(this.config, current);
            });
          }
          writeJson(result, { ok: true, instanceId, target, finishedAt: Date.now() });
        } catch (error) {
          writeJson(result, { ok: false, error: (error as Error).message, finishedAt: Date.now() });
        }
      }
    } finally {
      this.applying = false;
      this.writeStatus();
    }
  }
}
