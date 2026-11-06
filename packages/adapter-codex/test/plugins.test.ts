import { afterEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureConfig } from '../../../test/helpers.js';
import { PluginCatalog } from '../src/plugins.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
it('lists installed packages and rejects disabled, forged or replaced selections', async () => {
  const c = fixtureConfig();
  cleanup.push(() => rmSync(c.desktopRoot, { recursive: true, force: true }));
  const add = (name: string, installed: boolean) => {
    const root = join(c.codexHome, 'plugins/cache/remote', name);
    mkdirSync(join(root, '1.0/.codex-plugin'), { recursive: true });
    writeFileSync(
      join(root, '1.0/.codex-plugin/plugin.json'),
      JSON.stringify({ name, description: 'Fixture plugin', interface: { displayName: `Display ${name}` } }),
    );
    if (installed)
      writeFileSync(
        join(root, '.codex-remote-plugin-install.json'),
        JSON.stringify({ remote_plugin_id: `remote-${name}` }),
      );
  };
  add('one', true);
  add('cached', false);
  add('off', true);
  writeFileSync(join(c.codexHome, 'config.toml'), '[plugins."off@remote"]\nenabled=false\n');
  const catalog = new PluginCatalog(c.codexHome),
    list = await catalog.list(c.desktopRoot);
  expect(list.map((p) => p.name)).toEqual(['Display one']);
  expect(await catalog.selected(c.desktopRoot, [list[0].id, list[0].id])).toEqual([
    { name: 'Display one', path: 'plugin://one@remote' },
  ]);
  await expect(catalog.selected(c.desktopRoot, [list[0].id], ['remote-one'])).rejects.toThrow('停用');
  await expect(catalog.selected(c.desktopRoot, ['0'.repeat(64)])).rejects.toThrow('重新选择');
  writeFileSync(join(c.codexHome, 'config.toml'), '[plugins."one@remote"]\nenabled=false\n');
  await expect(catalog.selected(c.desktopRoot, [list[0].id])).rejects.toThrow('停用');
});
