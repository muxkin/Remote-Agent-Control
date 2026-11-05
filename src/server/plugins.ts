import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as toml } from 'smol-toml';
import type { PluginChoice } from '../shared/types.js';
import { SelectionError } from './selection-error.js';

interface InstalledPlugin extends PluginChoice {
  nativeId: string;
  remoteId: string;
  path: string;
}
/** Installed package metadata only. No account secrets, tool configurations or arbitrary cache entries. */
export class PluginCatalog {
  private cache = new Map<string, { at: number; items: InstalledPlugin[] }>();
  constructor(private codexHome: string) {}
  async list(cwd: string, force = false): Promise<InstalledPlugin[]> {
    const cached = this.cache.get(cwd);
    if (!force && cached && Date.now() - cached.at < 15000) return cached.items;
    const configs: string[] = [];
    for (let p = resolve(cwd); ; p = dirname(p)) {
      configs.unshift(join(p, '.codex/config.toml'));
      if (dirname(p) === p) break;
    }
    const enabled: Record<string, any> = {};
    for (const file of new Set([join(this.codexHome, 'config.toml'), ...configs])) {
      const content = await readFile(file, 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      });
      if (content) Object.assign(enabled, (toml(content) as any).plugins ?? {});
    }
    const dirs = async (p: string) =>
      (
        await readdir(p, { withFileTypes: true }).catch((e) => {
          if (e.code === 'ENOENT') return [];
          throw e;
        })
      )
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    const items: InstalledPlugin[] = [];
    const cache = join(this.codexHome, 'plugins/cache');
    for (const market of await dirs(cache))
      for (const slug of await dirs(join(cache, market))) {
        const root = join(cache, market, slug),
          nativeId = `${slug}@${market}`;
        if (enabled[nativeId]?.enabled === false) continue;
        const install = await readFile(join(root, '.codex-remote-plugin-install.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        if (!install && enabled[nativeId]?.enabled !== true) continue;
        const version = (await dirs(root)).sort((a, b) =>
          b.localeCompare(a, undefined, { numeric: true }),
        )[0];
        if (!version) continue;
        const manifest = await readFile(join(root, version, '.codex-plugin/plugin.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        if (!manifest || typeof manifest.name !== 'string') continue;
        const name = manifest.interface?.displayName || manifest.name;
        const description = manifest.interface?.shortDescription || manifest.description || '';
        if (typeof name !== 'string' || typeof description !== 'string') continue;
        items.push({
          id: createHash('sha256')
            .update(nativeId + '\0' + version)
            .digest('hex'),
          name: name.slice(0, 100),
          description: description.slice(0, 800),
          nativeId,
          remoteId: install?.remote_plugin_id ?? nativeId,
          path: `plugin://${nativeId}`,
        });
      }
    items.sort((a, b) => a.name.localeCompare(b.name));
    if (this.cache.size > 20) this.cache.clear();
    this.cache.set(cwd, { at: Date.now(), items });
    return items;
  }
  async selected(cwd: string, ids: string[], disabled: string[] = []) {
    if (!ids.length) return [];
    const items = await this.list(cwd, true);
    return [...new Set(ids)].map((id) => {
      const plugin = items.find(
        (p) => p.id === id && !disabled.includes(p.remoteId) && !disabled.includes(p.nativeId),
      );
      if (!plugin) throw new SelectionError('所选插件已移除或停用，请重新选择');
      return { name: plugin.name, path: plugin.path };
    });
  }
}
