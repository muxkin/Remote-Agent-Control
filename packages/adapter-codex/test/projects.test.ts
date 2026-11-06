import { afterEach, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixtureConfig, historyFixture, THREAD } from '../../../test/helpers.js';
import { HistoryIndex } from '../src/history.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
it('merges explicit Desktop membership, filters before pagination and counts without guessing cwd', () => {
  const c = fixtureConfig();
  historyFixture(c);
  const h = new HistoryIndex(c.codexHome);
  const db = new DatabaseSync(join(c.codexHome, 'state_5.sqlite'));
  cleanup.push(() => {
    h.close();
    db.close();
    rmSync(c.desktopRoot, { recursive: true, force: true });
  });
  const a = '11111111-1111-4111-8111-111111111111',
    b = '22222222-2222-4222-8222-222222222222';
  db.prepare('INSERT INTO projects VALUES (?,?,?)').run(a, '项目 A', 0);
  db.prepare('INSERT INTO projects VALUES (?,?,?)').run(b, '项目 B', 1);
  db.prepare(
    'INSERT INTO threads (id,title,cwd,updated_at_ms,archived,thread_source,project_id) VALUES (?,?,?,?,?,?,?)',
  ).run('native', 'native', '/same', 200, 0, 'user', b);
  db.prepare(
    'INSERT INTO threads (id,title,cwd,updated_at_ms,archived,thread_source) VALUES (?,?,?,?,?,?)',
  ).run('none', 'none', '/same', 300, 0, 'user');
  db.prepare(
    'INSERT INTO threads (id,title,cwd,updated_at_ms,archived,thread_source) VALUES (?,?,?,?,?,?)',
  ).run('second', 'second', '/same', 50, 0, 'user');
  const state = {
    'local-projects': { legacy: { id: 'legacy', name: '项目 A' } },
    'app-server-project-id-by-legacy-project-id-by-host': { [`local:${c.codexHome}`]: { legacy: a } },
    'thread-project-assignments': {
      [THREAD]: { projectKind: 'local', projectId: 'legacy' },
      native: { projectKind: 'local', projectId: 'legacy' },
      second: { projectKind: 'local', projectId: 'legacy' },
    },
    'projectless-thread-ids': [],
  };
  writeFileSync(join(c.codexHome, '.codex-global-state.json'), JSON.stringify(state));
  const first = h.list(undefined, 1, a);
  expect(first.threads.map((t) => t.id)).toEqual([THREAD]);
  expect(first.nextCursor).toBeTruthy();
  expect(h.list(first.nextCursor!, 1, a).threads.map((t) => t.id)).toEqual(['second']);
  expect(h.list(undefined, 30, b).threads.map((t) => t.id)).toEqual(['native']);
  expect(h.list(undefined, 30, 'none').threads.map((t) => t.id)).toEqual(['none']);
  expect(h.list(undefined, 30, undefined, '项目 a').threads.map((t) => t.id)).toEqual([THREAD, 'second']);
  expect(h.list(undefined, 30, undefined, 'NATIVE').threads.map((t) => t.id)).toEqual(['native']);
  expect(h.list(undefined, 30, a, 'native').threads).toHaveLength(0);
  expect(h.list(undefined, 30, undefined, "%' OR 1=1 --").threads).toHaveLength(0);
  expect(h.projects()).toEqual({
    projects: [
      { id: a, name: '项目 A', count: 2 },
      { id: b, name: '项目 B', count: 1 },
    ],
    ungrouped: 1,
    total: 4,
  });
  state['projectless-thread-ids'] = [THREAD] as never[];
  writeFileSync(join(c.codexHome, '.codex-global-state.json'), JSON.stringify(state));
  expect(h.list(undefined, 30, 'none').threads.map((t) => t.id)).toEqual(['none', THREAD]);
});
