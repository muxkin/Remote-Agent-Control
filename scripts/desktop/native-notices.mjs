import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function nativeNotices(native, target, features = []) {
  const graph = execFileSync(
    'cargo',
    [
      'tree',
      '--locked',
      '--target',
      target,
      '--edges',
      'normal',
      '--prefix',
      'none',
      '--format',
      '{p}',
      ...features,
    ],
    { cwd: native, encoding: 'utf8' },
  );
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
  const registries = (await readdir(registry)).map((entry) => join(registry, entry));
  const packages = new Set(
    [...graph.matchAll(/^([A-Za-z0-9_-]+) v(\S+)/gm)].map(([, name, version]) => `${name}-${version}`),
  );
  const texts = [];
  for (const pkg of [...packages].sort()) {
    for (const root of registries) {
      const dir = join(root, pkg);
      const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      if (!entries.length) continue;
      for (const entry of entries) {
        if (entry.isFile() && /^(licen[cs]e|copying|notice|ofl)/i.test(entry.name))
          texts.push(`\n${pkg} · ${entry.name}\n\n${await readFile(join(dir, entry.name), 'utf8')}`);
      }
      break;
    }
  }
  assert(texts.length > 0, 'Cannot locate any dependency notices');
  return texts.join('\n');
}
