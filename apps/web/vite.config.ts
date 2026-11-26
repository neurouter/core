import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';
import { buildDevProxy, parseDevPort } from './dev-proxy.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

// https://vite.dev/config/
export default defineConfig(({ command, mode, isPreview }) => {
  // .env lives at the repo root (shared with the server); env files are not in process.env here.
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  const serve = command === 'serve' && mode !== 'test' && !isPreview;
  // `npm run build:demo`: the console against MSW fixtures as a static, read-only demo site
  const demo = env.VITE_DEMO === 'true';
  // `npm run build:mock`: read-write MSW mocks in a production bundle (the e2e "mock" project)
  const mockBuild = command === 'build' && env.VITE_ENABLE_MSW === 'true';
  return {
    plugins: [
      // must come before react() (TanStack Router docs)
      tanstackRouter({ target: 'react', autoCodeSplitting: true, routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts' }),
      react(),
      tailwindcss(),
      // serves the MSW worker in dev (VITE_ENABLE_MSW=true) and emits it into the demo and mock builds only;
      // never part of the production build the gateway serves
      ...((serve && env.VITE_ENABLE_MSW === 'true') || demo || mockBuild ? [msw({ mode: 'worker-only' })] : []),
    ],
    envDir: repoRoot,
    resolve: {
      alias: { '@': resolve(import.meta.dirname, 'src') },
      // consume @neurouter/shared from source (no build step in dev); keep Vite's defaults
      // ('browser' among them) so packages like msw resolve to their browser builds
      conditions: ['@neurouter/source', ...defaultClientConditions],
    },
    server: serve
      ? {
          port: parseDevPort(env.NEUROUTER_WEB_DEV_PORT),
          strictPort: false,
          // with MSW mocks there is no backend to proxy to
          proxy: env.VITE_ENABLE_MSW === 'true' ? {} : buildDevProxy(env.NEUROUTER_DEV_API_URL),
        }
      : {},
    build: { outDir: demo ? 'dist-demo' : mockBuild ? 'dist-mock' : 'dist', emptyOutDir: true, sourcemap: !demo && !mockBuild },
  };
});
