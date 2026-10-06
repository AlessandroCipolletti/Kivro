import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'security/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', 'tests/e2e/**'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 4,
  },
});
