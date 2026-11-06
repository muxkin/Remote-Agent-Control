import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Read Desktop's explicit membership, including its not-yet-migrated UI assignments.
 * Never infer membership from cwd: multiple projects may share a root. */
export class ProjectIndex {
  private identity = '';
  private state: any = {};
  constructor(private codexHome: string) {}
  snapshot(db: DatabaseSync) {
    const file = join(this.codexHome, '.codex-global-state.json');
    try {
      const st = statSync(file);
      const identity = `${st.ino}:${st.mtimeMs}:${st.size}`;
      if (identity !== this.identity) {
        this.state = JSON.parse(readFileSync(file, 'utf8'));
        this.identity = identity;
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw new Error('桌面项目目录暂时无法读取，请重试');
      this.state = {};
      this.identity = '';
    }
    const native = db.prepare('SELECT id,name FROM projects ORDER BY position,id').all() as {
      id: string;
      name: string;
    }[];
    const names = new Map(native.map((p) => [p.id, p.name]));
    const aliases =
      this.state['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${this.codexHome}`] ?? {};
    const legacy = this.state['local-projects'] ?? {};
    for (const p of Object.values(legacy) as any[]) {
      const id = aliases[p.id] ?? p.id;
      if (typeof id === 'string' && typeof p.name === 'string' && !names.has(id)) names.set(id, p.name);
    }
    const projectless = new Set(this.state['projectless-thread-ids'] ?? []);
    const memberships: Record<string, string> = {};
    for (const [thread, assignment] of Object.entries(this.state['thread-project-assignments'] ?? {}) as [
      string,
      any,
    ][]) {
      const id = aliases[assignment?.projectId] ?? assignment?.projectId;
      if (!projectless.has(thread) && assignment?.projectKind === 'local' && names.has(id))
        memberships[thread] = id;
    }
    return { names, memberships: JSON.stringify(memberships) };
  }
}
