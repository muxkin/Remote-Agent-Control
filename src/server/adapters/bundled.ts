import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdapterPackage } from './package.js';
/** Snapshot shipped packages and their resolved runtime dependency graph before binding a version.
 * A subsequent gateway build must not silently replace a pinned official plugin. */
export function snapshotBundled(pack: AdapterPackage, directory: string): string {
  const destination = join(directory, 'bundled', pack.name.replace(/[^a-z0-9._-]/gi, '_'), pack.version);
  const root = join(destination, 'node_modules', pack.name);
  if (existsSync(join(root, 'package.json'))) return root;
  const stage = `${destination}.${randomUUID()}.tmp`;
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const installed = new Map<string, string>();
  function locate(from: string, name: string): string | undefined {
    let current = from;
    while (true) {
      const candidate = join(current, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
  function copy(source: string, target: string) {
    if (installed.get(target) === source) return;
    installed.set(target, source);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, {
      recursive: true,
      dereference: true,
      filter: (path) =>
        path === source ||
        !path
          .slice(source.length + 1)
          .split(/[\\/]/)
          .includes('node_modules'),
    });
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    for (const name of Object.keys(dependencies)) {
      const resolved = locate(source, name);
      if (!resolved) {
        if (manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional)
          continue;
        throw Error(`Bundled dependency missing: ${name}`);
      }
      const reachable = locate(target, name);
      if (reachable && installed.get(reachable) === resolved) continue;
      const preferred = join(stage, 'node_modules', name),
        existing = installed.get(preferred);
      const child = existing && existing !== resolved ? join(target, 'node_modules', name) : preferred;
      // Dependencies already copied at the same lookup path also terminate cycles.
      if (installed.get(child) !== resolved) copy(resolved, child);
    }
  }
  try {
    copy(pack.root, join(stage, 'node_modules', pack.name));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      renameSync(stage, destination);
    } catch (error) {
      if (!existsSync(root)) throw error;
    }
    return root;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
