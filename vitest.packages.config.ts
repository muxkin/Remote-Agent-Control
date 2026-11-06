import { defineConfig } from 'vitest/config';
// Release artifact contracts are explicit: ordinary tests never build or install packages.
export default defineConfig({ test: { include: ['test/adapter-packages.test.ts'], testTimeout: 10000 } });
