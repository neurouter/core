# @neurouter/web

The Neurouter console: Vite 8, React 19, TanStack Router and Query, Tailwind 4 and shadcn on Base UI
(copied from Neurouter Hub's console, see the frontend spec §7). The contract comes from
`@neurouter/shared`; every response is validated against it.

## Run

| Command (from the repo root) | What it does |
|---|---|
| `NEUROUTER_DEV_API_URL=http://<host>:<port> npm run dev -w @neurouter/web` | Console against a running `@neurouter/server` (Vite proxies `/api`, `/mcp`, `/oauth`, `/.well-known`, `/public`, `/metrics`). |
| `npm run dev:mock -w @neurouter/web` | Console with read-write in-memory MSW mocks (no backend). |
| `npm run build -w @neurouter/web` | Production build → `apps/web/dist` (served by the server). |
| `npm run build:demo -w @neurouter/web` | Static read-only demo → `apps/web/dist-demo` (MSW + simulated traffic). |
| `npm run build:mock -w @neurouter/web` | Read-write mock build → `apps/web/dist-mock` (the e2e "mock" project). |
| `npm run test -w @neurouter/web` | Vitest (jsdom + MSW node server). |
| `npm run test:e2e -w @neurouter/web` | Playwright against `vite preview` of `dist-mock` (and `dist-demo` for the demo spec). |
| `npm run size -w @neurouter/web` | Initial-bundle budget (≤ 250 KiB JS gzip, ≤ 40 KiB CSS). |

Demo dataset: `src/mocks/demo-data.ts` (fictional Acme Corp). The mock backend is `src/mocks/db.ts` +
`src/mocks/fixtures.ts`; handlers are generated from `ALL_ENDPOINTS` and validate every fixture.
