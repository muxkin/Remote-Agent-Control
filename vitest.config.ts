import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['test/adapter-packages.test.ts'],
    // Native Windows ACL setup and host launches share CPU/PowerShell startup resources.
    // Parallel files multiplied those subprocesses and produced unrelated startup timeouts.
    maxWorkers: process.platform === 'win32' ? 1 : undefined,
    testTimeout: process.platform === 'win32' ? 30000 : 10000,
  },
});
