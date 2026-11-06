import { afterEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureConfig } from '../../../test/helpers.js';
import { SkillCatalog } from '../src/skills.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function setup() {
  const c = fixtureConfig();
  mkdirSync(c.codexHome, { recursive: true });
  cleanup.push(() => rmSync(c.desktopRoot, { recursive: true, force: true }));
  return { ...c, catalog: new SkillCatalog(c.codexHome) };
}
function skill(path: string, name = 'sample') {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: >-\n  Use this skill to inspect a fixture.\n---\nDo not change files.\n`,
  );
  return join(path, 'SKILL.md');
}
it('scopes skills by cwd, deduplicates links and rejects stale or forged choices before send', async () => {
  const c = setup(),
    project = join(c.desktopRoot, 'project'),
    other = join(c.desktopRoot, 'other');
  const file = skill(join(project, '.agents/skills/a'));
  skill(join(other, '.agents/skills/unrelated'), 'unrelated');
  mkdirSync(join(c.codexHome, 'skills'), { recursive: true });
  symlinkSync(join(project, '.agents/skills/a'), join(c.codexHome, 'skills/a'));
  const catalog = await c.catalog.list(project);
  expect(catalog).toHaveLength(1);
  expect(catalog[0].description).toContain('inspect a fixture');
  expect(await c.catalog.selected(project, [catalog[0].id])).toEqual([{ name: 'sample', path: file }]);
  await expect(c.catalog.selected(project, ['0'.repeat(64)])).rejects.toThrow('重新选择');
  writeFileSync(file, '---\nname: renamed\ndescription: changed\n---\n');
  await expect(c.catalog.selected(project, [catalog[0].id])).rejects.toThrow('重新选择');
});
it('respects disabled skills and installed plugin metadata instead of exposing arbitrary caches', async () => {
  const c = setup(),
    cwd = join(c.desktopRoot, 'work');
  const file = skill(join(c.codexHome, 'skills/off'), 'off');
  const root = join(c.codexHome, 'plugins/cache/remote/installed');
  skill(join(root, '1.0/skills/one'), 'one');
  writeFileSync(
    join(root, '.codex-remote-plugin-install.json'),
    JSON.stringify({ remote_plugin_id: 'remote-id' }),
  );
  skill(join(c.codexHome, 'plugins/cache/remote/uninstalled/1.0/skills/no'), 'no');
  writeFileSync(
    join(c.codexHome, 'config.toml'),
    `[[skills.config]]\npath = ${JSON.stringify(file)}\nenabled = false\n`,
  );
  const list = await c.catalog.list(cwd);
  expect(list.map((s) => s.name)).toEqual(['installed:one']);
  await expect(c.catalog.selected(cwd, [list[0].id], ['remote-id'])).rejects.toThrow('停用');
  expect(await c.catalog.selected(cwd, [list[0].id])).toEqual([{ name: 'one', path: list[0].path }]);
});
