// ESLint flat config (ESLint 10 + typescript-eslint 8.74, TS 6.0.3). Copied from Neurouter Hub, plus
// the data plane / control plane boundary (backend spec §2, A1).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'apps/web/**', 'apps/server/data/**', '**/data/**', 'tmp/**', 'out/**', '.agent/**', '.claude/**', '.neurouter/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
    },
  },
  {
    files: ['apps/**/*.ts', 'packages/{compiler,evals,cli}/**/*.ts', 'scripts/**/*.{js,mjs}', '*.{js,ts}', 'packages/shared/vitest.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // packages/shared is isomorphic: no Node built-ins, no server-only libraries (the console imports it).
    files: ['packages/shared/src/**/*.ts'],
    ignores: ['packages/shared/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/shared must stay isomorphic (no Node built-ins).' },
            { group: ['fs', 'path', 'crypto', 'os', 'child_process', 'http', 'https', 'net', 'url', 'stream', 'buffer'], message: 'packages/shared must stay isomorphic.' },
            { group: ['fastify*', 'kysely*', 'pg', 'better-sqlite3', 'pino*', 'react*'], message: 'packages/shared may only depend on zod.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', { name: 'Buffer', message: 'Not available in browsers.' }, { name: 'process', message: 'Not available in browsers.' }],
    },
  },
  {
    // Data plane must not import the control plane (A1). It reads config through RuntimeConfigSource.
    files: ['apps/server/src/dataplane/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/controlplane/**', '**/controlplane'], message: 'dataplane must not import controlplane (use kernel interfaces such as RuntimeConfigSource).' }] },
      ],
    },
  },
  {
    // Control plane must not import the data plane (A1). Wiring happens in deps.ts / app.ts.
    files: ['apps/server/src/controlplane/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/dataplane/**', '**/dataplane'], message: 'controlplane must not import dataplane (inject through kernel interfaces in deps.ts).' }] },
      ],
    },
  },
  {
    // The kernel is shared by both planes and imports neither.
    files: ['apps/server/src/kernel/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/dataplane/**', '**/controlplane/**', '**/dataplane', '**/controlplane'], message: 'kernel must not import either plane.' }] },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/test-utils/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
