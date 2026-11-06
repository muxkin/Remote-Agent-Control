import { readConfig } from '../src/server/config.js';
import { builtinBackends } from '../src/server/backends/builtins.js';
import { DEFAULT_BACKEND } from '../src/shared/backends.js';
const config = { ...readConfig(), readOnly: true };
const registry = builtinBackends(config, false);
const args = process.argv.slice(2),
  backendFlag = args.indexOf('--backend');
const backendId = backendFlag >= 0 ? args.splice(backendFlag, 2)[1] : DEFAULT_BACKEND;
try {
  await registry.start();
  // Public descriptors only: never log addresses, tokens, cookies, prompts or native responses.
  console.log(JSON.stringify({ backends: registry.list() }, null, 2));
  const backend = registry.get(backendId),
    id = args[0];
  try {
    const listed = await backend.history.list(undefined, 30);
    console.log(
      JSON.stringify({
        backendId,
        indexedThreadsOnFirstPage: listed.threads.length,
        hasMore: !!listed.nextCursor,
      }),
    );
  } catch {
    console.log(JSON.stringify({ backendId, historyAvailable: false }));
  }
  if (id) {
    const release = await backend.acquire(id);
    try {
      const view = await backend.waitForView(id);
      console.log(
        JSON.stringify({
          backendId,
          owner: !!view?.owner,
          synchronized: !!view?.synchronized,
          revision: view?.revision,
          messageCount: view?.messages.length,
          runtimeStatus: view?.runtimeStatus,
        }),
      );
    } finally {
      release();
    }
  }
} finally {
  await registry.stop();
}
