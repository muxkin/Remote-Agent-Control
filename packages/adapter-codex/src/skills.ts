import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as toml } from 'smol-toml';
import { parse as yaml } from 'yaml';
import type { SkillChoice } from '../../../src/shared/types.js';
import { SelectionError } from '../../../src/server/selection-error.js';

export interface InstalledSkill extends SkillChoice {
  path: string;
  nativeName: string;
  pluginId?: string;
}
/** On-demand local catalog. No background polling, remote fetches, or agent process. */
export class SkillCatalog {
  private cache = new Map<string, { at: number; skills: InstalledSkill[] }>();
  constructor(private codexHome: string) {}
  async list(cwd: string, force = false): Promise<InstalledSkill[]> {
    const cached = this.cache.get(cwd);
    if (!force && cached && Date.now() - cached.at < 15000) return cached.skills;
    const skills = await this.scan(cwd);
    if (this.cache.size > 20) this.cache.clear();
    this.cache.set(cwd, { at: Date.now(), skills });
    return skills;
  }
  async selected(cwd: string, ids: string[], disabledPlugins: string[] = []) {
    if (!ids.length) return [];
    const catalog = await this.list(cwd, true);
    return [...new Set(ids)].map((id) => {
      const skill = catalog.find((s) => s.id === id && !disabledPlugins.includes(s.pluginId ?? ''));
      if (!skill) throw new SelectionError('所选技能已移除、停用或不属于当前项目，请重新选择');
      return { name: skill.nativeName, path: skill.path };
    });
  }
  private async scan(cwd: string) {
    const directories = async (path: string) =>
      (
        await readdir(path, { withFileTypes: true }).catch((e: any) => {
          if (e.code === 'ENOENT') return [];
          throw e;
        })
      )
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name);
    const ancestors: string[] = [];
    for (let path = resolve(cwd); ; path = dirname(path)) {
      ancestors.push(path);
      if (dirname(path) === path) break;
    }
    const configs = [
      join(this.codexHome, 'config.toml'),
      ...ancestors.toReversed().map((p) => join(p, '.codex/config.toml')),
    ];
    const disabled = new Map<string, boolean>();
    const plugins: Record<string, any> = {};
    for (const path of [...new Set(configs)]) {
      const content = await readFile(path, 'utf8').catch((e: any) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      });
      if (!content) continue;
      const config = toml(content) as any;
      Object.assign(plugins, config.plugins ?? {});
      for (const s of config.skills?.config ?? [])
        if (typeof s.path === 'string') {
          disabled.set(await realpath(s.path).catch(() => resolve(s.path)), s.enabled === false);
        }
    }
    const result = new Map<string, InstalledSkill>();
    const add = async (file: string, source: string, pluginId?: string) => {
      const path = await realpath(file).catch(() => null);
      if (!path || result.has(path) || disabled.get(path) || disabled.get(dirname(path))) return;
      const info = await stat(path);
      if (!info.isFile() || info.size > 512 * 1024) return;
      const text = await readFile(path, 'utf8');
      const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!front) return;
      let meta: any;
      try {
        meta = yaml(front[1], { maxAliasCount: 10 });
      } catch {
        return;
      }
      if (typeof meta?.name !== 'string' || !meta.name.trim() || typeof meta.description !== 'string') return;
      const name = pluginId ? `${source}:${meta.name}` : meta.name;
      const ui = await readFile(join(dirname(path), 'agents/openai.yaml'), 'utf8')
        .then((text) => yaml(text, { maxAliasCount: 10 })?.interface)
        .catch(() => null);
      result.set(path, {
        id: createHash('sha256')
          .update(path + '\0' + name + '\0' + text)
          .digest('hex'),
        name,
        nativeName: meta.name,
        description: meta.description.slice(0, 800),
        source,
        path,
        pluginId,
        displayName: typeof ui?.display_name === 'string' ? ui.display_name.slice(0, 120) : meta.name,
        sourceKind: pluginId
          ? 'plugin'
          : source === '项目'
            ? 'project'
            : source === '系统'
              ? 'system'
              : 'personal',
      });
    };
    const scanRoot = async (root: string, source: string, pluginId?: string) => {
      await add(join(root, 'SKILL.md'), source, pluginId);
      for (const dir of await directories(root)) {
        if (dir.startsWith('.') && dir !== '.system') continue;
        if (dir === '.system') {
          for (const system of await directories(join(root, dir)))
            await add(join(root, dir, system, 'SKILL.md'), '系统');
        } else await add(join(root, dir, 'SKILL.md'), source, pluginId);
      }
    };
    // Closest project first, followed by user skills. Canonical paths deduplicate symlinks.
    for (const root of ancestors)
      for (const dir of ['.agents/skills', '.codex/skills'])
        await scanRoot(join(root, dir), root === dirname(this.codexHome) ? '个人' : '项目');
    await scanRoot(join(this.codexHome, 'skills'), '个人');
    await scanRoot(join(dirname(this.codexHome), '.agents/skills'), '个人');
    const cache = join(this.codexHome, 'plugins/cache');
    for (const market of await directories(cache))
      for (const plugin of await directories(join(cache, market))) {
        const root = join(cache, market, plugin),
          key = `${plugin}@${market}`;
        if (plugins[key]?.enabled === false) continue;
        const installed = await readFile(join(root, '.codex-remote-plugin-install.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        if (!installed && plugins[key]?.enabled !== true) continue;
        const versions = (await directories(root))
          .filter((v) => !v.startsWith('.'))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        if (versions[0])
          await scanRoot(join(root, versions[0], 'skills'), plugin, installed?.remote_plugin_id ?? key);
      }
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
