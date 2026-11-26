import { defineConfig } from 'vitest/config';

/** Root Vitest config: one project per workspace (unit tests only). apps/web runs jsdom under its own config. */
export default defineConfig({
  test: {
    projects: [
      'packages/shared/vitest.config.ts',
      'packages/compiler/vitest.config.ts',
      'packages/evals/vitest.config.ts',
      'apps/executor/vitest.config.ts',
      'apps/server/vitest.config.ts',
      'packages/cli/vitest.config.ts',
      'apps/web/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      exclude: ['**/dist/**', '**/*.test.*', '**/test/**', 'apps/web/src/components/ui/**', 'apps/web/src/routeTree.gen.ts'],
    },
  },
});
