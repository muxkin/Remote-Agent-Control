import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['test/adapter-packages.test.ts'],
    testTimeout: 10000,
  },
});
