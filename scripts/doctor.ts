import { readConfig } from '../src/server/config.js';
import { DesktopAdapter } from '../src/server/desktop.js';
import { HistoryIndex } from '../src/server/history.js';
const config = readConfig();
const desktop = new DesktopAdapter({ ...config, readOnly: true });
const history = new HistoryIndex(config.codexHome);
try {
  await desktop.start();
  console.log(JSON.stringify({ status: desktop.status() }, null, 2));
  const listed = history.list();
  console.log(
    JSON.stringify({ indexedThreadsOnFirstPage: listed.threads.length, hasMore: !!listed.nextCursor }),
  );
  const id = process.argv[2];
  if (id) {
    const release = await desktop.acquire(id);
    const view = await desktop.waitForView(id);
    console.log(
      JSON.stringify({
        threadId: id,
        owner: !!view?.owner,
        synchronized: view?.synchronized,
        revision: view?.revision,
        messageCount: view?.messages.length,
        roles: view?.messages.reduce(
          (a, m) => ((a[m.role] = (a[m.role] ?? 0) + 1), a),
          {} as Record<string, number>,
        ),
        runtimeStatus: view?.runtimeStatus,
        activeTurnId: view?.activeTurnId,
        reason: view?.reason ?? desktop.observation(id).reason,
      }),
    );
    release();
  }
} finally {
  desktop.stop();
  history.close();
}
