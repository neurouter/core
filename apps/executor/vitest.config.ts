import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: { conditions: ['@neurouter/source'] },
  ssr: { resolve: { conditions: ['@neurouter/source'] } },
  test: {
    name: 'executor',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    env: { NODE_ENV: 'test' },
  },
});
