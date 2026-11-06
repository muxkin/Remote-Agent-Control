import { chmodSync, mkdirSync } from 'node:fs';
import type { PlatformRuntime } from '../src/server/platform.js';

/** Disposable business-test storage. Native ACLs are exercised in platform-connectors.test.ts. */
export const temporaryRuntime: PlatformRuntime = {
  id: 'test',
  stateDirectory() {
    throw Error('Tests must provide their own temporary directory');
  },
  privateDirectory(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  },
  privateFile(path) {
    chmodSync(path, 0o600);
  },
  async openFile() {
    throw Error('Business tests must not launch native applications');
  },
};
