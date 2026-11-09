import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ReleaseStore } from '../shared/desktop-releases.js';
export function fileReleaseStore(root: string): ReleaseStore {
  const path = async (key: string) => {
    const base = await realpath(root);
    const file = await realpath(resolve(base, key));
    if (!file.startsWith(base + sep)) throw Error('Invalid release path');
    return file;
  };
  return {
    async head(key) {
      try {
        const info = await stat(await path(key));
        return info.isFile() ? { size: info.size, etag: `"${info.size}-${info.mtimeMs}"` } : null;
      } catch {
        return null;
      }
    },
    async read(key, range) {
      try {
        return Readable.toWeb(
          createReadStream(
            await path(key),
            range ? { start: range.offset, end: range.offset + range.length - 1 } : {},
          ),
        ) as ReadableStream<Uint8Array>;
      } catch {
        return null;
      }
    },
  };
}
