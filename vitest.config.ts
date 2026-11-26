import { defineConfig } from 'vitest/config';

/** Root Vitest config: one project per workspace (unit tests only). apps/web adds its own project later. */
export default defineConfig({
  test: {
    projects: [
      'packages/shared/vitest.config.ts',
      'packages/compiler/vitest.config.ts',
      'packages/evals/vitest.config.ts',
      'apps/executor/vitest.config.ts',
      'apps/server/vitest.config.ts',
      'packages/cli/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      exclude: ['**/dist/**', '**/*.test.*', '**/test/**'],
    },
  },
});
