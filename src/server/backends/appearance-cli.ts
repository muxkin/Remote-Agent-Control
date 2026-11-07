import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { readConfig } from '../config.js';
import { Store } from '../store.js';
import { appearanceImage, normalizeAppearancePatch } from './appearance.js';
import type { BackendAppearancePatch } from '../../shared/backends.js';

const usage = `实例显示设置（与工作台“编辑实例”共用，自动同步到已配对设备）
npm run instance -- list
npm run instance -- show <id>
npm run instance -- set <id> [--name 名称] [--description 说明]
  [--icon code|terminal|puzzle|chat|monitor|book|folder|sun | --emoji 🦄 | --image /path/icon.png]
  [--revision <当前版本>]
npm run instance -- reset <id> [--revision <当前版本>]
空说明使用 --description ''；reset 恢复接入插件的默认名称、说明和图标。`;
process.umask(0o077);
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      ['name', 'description', 'icon', 'emoji', 'image', 'revision'].map((key) => [
        key,
        { type: 'string' as const },
      ]),
    ),
  });
  const [command = 'help', id] = positionals;
  if (command === 'help') console.log(usage);
  else {
    if (!['list', 'show', 'set', 'reset'].includes(command)) throw Error(usage);
    const config = readConfig(),
      instances = config.instances ?? [];
    if (command !== 'list' && !instances.some((i) => i.id === id)) throw Error('找不到此 Agent 实例');
    const store = new Store(config.stateDir);
    try {
      if (command === 'list')
        console.log(
          JSON.stringify(
            instances.map((i) => ({ id: i.id, configuredName: i.name, ...store.backendAppearance(i.id) })),
            null,
            2,
          ),
        );
      else if (command === 'show')
        console.log(JSON.stringify({ id, ...store.backendAppearance(id) }, null, 2));
      else {
        const revision = values.revision === undefined ? undefined : Number(values.revision);
        if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0))
          throw Error('revision 必须为非负安全整数');
        let patch: BackendAppearancePatch;
        if (command === 'reset') patch = { name: null, description: null, icon: null };
        else {
          if (['icon', 'emoji', 'image'].filter((key) => values[key] !== undefined).length > 1)
            throw Error('icon、emoji、image 一次只选一种');
          const input: Record<string, unknown> = {};
          if (values.name !== undefined) input.name = values.name;
          if (values.description !== undefined) input.description = values.description;
          if (values.icon !== undefined) input.icon = { kind: 'builtin', value: values.icon };
          if (values.emoji !== undefined) input.icon = { kind: 'emoji', value: values.emoji };
          if (values.image !== undefined) {
            if ((await stat(values.image)).size > 5 * 1024 ** 2) throw Error('图片不能超过 5 MB');
            input.icon = { kind: 'image', value: await appearanceImage(await readFile(values.image)) };
          }
          patch = await normalizeAppearancePatch(input);
        }
        const saved = store.updateBackendAppearance(id, patch, revision);
        console.log(JSON.stringify({ id, revision: saved.revision, saved: true }));
      }
    } finally {
      store.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '设置未保存');
  process.exitCode = 1;
}
