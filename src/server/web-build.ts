import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** A tiny release manifest, checked on the existing status/heartbeat path. No history scans. */
export function webBuildReader(webRoot: string): () => string | null {
  const file = join(webRoot, 'version.json');
  let identity = '',
    version: string | null = null;
  return () => {
    try {
      const info = statSync(file);
      const next = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
      if (next !== identity) {
        const value = JSON.parse(readFileSync(file, 'utf8')).buildId;
        if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)) return version;
        identity = next;
        version = value;
      }
    } catch {
      /* A deployment may briefly rename the directory; retain the last valid version. */
    }
    return version;
  };
}
