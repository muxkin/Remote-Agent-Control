/** Operator-only verified migration. Does not print identifiers, signed URLs or private content. */
import { resolve } from 'node:path';
import { MessagingStore } from './messaging/store.js';
import { MessagingObjects } from './messaging/objects.js';
import { loadStorage } from './object-storage.js';
const path = process.env.POCKET_IM_DATABASE;
const adapterPath = process.env.POCKET_IM_MEDIA_ADAPTER;
if (!path || !adapterPath || !process.env.POCKET_PUBLIC_ORIGIN)
  throw Error('Explicit IM database, private adapter and origin required');
const origin = new URL(process.env.POCKET_PUBLIC_ORIGIN).origin;
const store = new MessagingStore(resolve(path), new URL(origin).host);
try {
  const storage = await loadStorage({ adapterPath: resolve(adapterPath) }, 'media', origin);
  const objects = new MessagingObjects(store, storage, origin);
  console.log(
    JSON.stringify(
      process.argv.includes('--restore-local') ? await objects.restoreLocal() : await objects.migrate(500),
    ),
  );
} finally {
  store.close();
}
