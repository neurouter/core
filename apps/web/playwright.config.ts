/**
 * Console e2e (frontend spec §14). Projects:
 * - `mock`: desktop Chrome 1440×900 against `vite preview` of a `build:mock` bundle (read-write
 *   MSW mocks, no backend). Available before the backend.
 * - `mobile`: the same build at 390×844 (read flows).
 * - `demo`: the `build:demo` bundle (read-only demo + simulator).
 * The `full` project (real server + fixture upstream) is added once the backend e2e harness exists.
 */
import { defineConfig, devices } from '@playwright/test';

const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 4310);
const DEMO_PORT = Number(process.env.E2E_DEMO_PORT ?? 4311);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', timezoneId: 'UTC', colorScheme: 'light' },
  projects: [
    { name: 'mock', testIgnore: ['**/demo.spec.ts', '**/mobile.spec.ts'], use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${MOCK_PORT}` } },
    { name: 'mobile', testMatch: ['**/mobile.spec.ts'], use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, baseURL: `http://localhost:${MOCK_PORT}` } },
    { name: 'demo', testMatch: ['**/demo.spec.ts'], use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${DEMO_PORT}` } },
  ],
  webServer: [
    { command: `VITE_ENABLE_MSW=true npx vite build --logLevel error && npx vite preview --outDir dist-mock --port ${MOCK_PORT} --strictPort`, url: `http://localhost:${MOCK_PORT}`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
    { command: `VITE_DEMO=true npx vite build --logLevel error && npx vite preview --outDir dist-demo --port ${DEMO_PORT} --strictPort`, url: `http://localhost:${DEMO_PORT}`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
  ],
});
