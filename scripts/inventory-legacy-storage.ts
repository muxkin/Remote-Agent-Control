/** Inventory only by default; --clean-verified removes objects with a hashed local copy. */
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readConfig } from '../src/server/config.js';
import { loadStorage } from '../src/server/object-storage.js';
import { privateOutput } from './private-output.js';
const config = readConfig();
if (!config.media) throw Error('No storage configured');
const storage = await loadStorage(config.media, 'media', config.origin);
if (!storage.list) throw Error('Adapter does not support inventory');
const prefix = config.media.prefix ?? 'codex-pocket',
  copies = new Map<string, { path: string; hash: string }>();
async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
for (const name of await readdir(join(config.stateDir, 'uploads')).catch(() => [])) {
  if (!name.endsWith('.json')) continue;
  try {
    const u = JSON.parse(await readFile(join(config.stateDir, 'uploads', name), 'utf8'));
    if (!u.complete || !u.file || !u.key || !u.key.startsWith(`${prefix}/private-uploads/`)) continue;
    if ((await stat(u.file)).size === u.size && (await hashFile(u.file)) === u.sha256)
      copies.set(u.key, { path: u.file, hash: u.sha256 });
  } catch {}
}
for (const name of await readdir(join(config.stateDir, 'media')).catch(() => [])) {
  const path = join(config.stateDir, 'media', name);
  try {
    const hash = await hashFile(path);
    copies.set(`${prefix}/private-media/${name}`, { path, hash });
  } catch {}
}
const entries = [];
for (const part of ['private-uploads', 'private-media']) {
  const allowed = `${prefix}/${part}/`;
  let marker: string | undefined;
  do {
    const page = await storage.list(allowed, marker);
    for (const key of page.keys) {
      if (!key.startsWith(allowed)) throw Error('Storage returned an unrelated key');
      const copy = copies.get(key),
        entry = { key, verified: !!copy, local: copy?.path, sha256: copy?.hash, removed: false };
      if (copy && process.argv.includes('--clean-verified')) {
        if (!storage.remove) throw Error('Adapter removal unavailable');
        await storage.remove(key);
        entry.removed = true;
      }
      entries.push(entry);
    }
    marker = page.marker;
  } while (marker);
}
await privateOutput('.deploy');
await writeFile(
  '.deploy/legacy-object-inventory.json',
  JSON.stringify({ date: new Date().toISOString(), entries }, null, 2),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    objects: entries.length,
    verified: entries.filter((e) => e.verified).length,
    removed: entries.filter((e) => e.removed).length,
    retainedUnverified: entries.filter((e) => !e.verified).length,
    publicAssetsExcluded: true,
  }),
);
