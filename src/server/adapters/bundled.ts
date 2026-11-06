import pacote from 'pacote';
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { manual as remove } from 'rimraf';
import { readAdapterPackage, type AdapterPackage } from './package.js';

/** Activate a self-contained release archive. The gateway never resolves bundled dependencies. */
export async function snapshotBundled(
  pack: AdapterPackage,
  directory: string,
  archive: string,
): Promise<string> {
  const destination = join(directory, 'bundled', pack.name.replace(/[^a-z0-9._-]/gi, '_'), pack.version);
  const root = join(destination, 'node_modules', pack.name);
  if (existsSync(join(root, 'package.json'))) return root;
  const stage = `${destination}.${randomUUID()}.tmp`;
  try {
    const target = join(stage, 'node_modules', pack.name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await pacote.extract(archive, target, { ignoreScripts: true, offline: true });
    const extracted = readAdapterPackage(target);
    if (extracted.name !== pack.name || extracted.version !== pack.version)
      throw Error('Bundled release identity does not match its manifest');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await rename(stage, destination);
    } catch (error) {
      if (!existsSync(join(root, 'package.json'))) throw error;
    }
    return root;
  } finally {
    await remove(stage);
  }
}
