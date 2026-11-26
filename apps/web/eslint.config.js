// ESLint flat config for the console (the repo-root config ignores apps/web). Copied from the
// apps/web section of Neurouter Hub's root config.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import pluginQuery from '@tanstack/eslint-plugin-query';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-demo/**', 'dist-mock/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'src/routeTree.gen.ts', 'public/mockServiceWorker.js'] },
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
    files: ['*.{js,ts}', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, '@tanstack/query': pluginQuery },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...pluginQuery.configs['flat/recommended'][0]?.rules,
      'no-restricted-syntax': ['error', { selector: 'Literal[value=/localhost|127\\.0\\.0\\.1/]', message: 'No hardcoded hosts in apps/web: the app is same-origin.' }],
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/ai-gateway/**'], message: 'Code is copied from Hub, never imported.' }] }],
    },
  },
  {
    // shadcn-generated code (CLI-owned; keep local edits minimal)
    files: ['src/components/ui/**/*.{ts,tsx}', 'src/hooks/use-mobile.ts'],
    rules: { 'react-hooks/purity': 'off', 'react-hooks/set-state-in-effect': 'off' },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.browser }, sourceType: 'script' },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
